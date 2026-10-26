import {
  Room,
  SENSOR_FRAME_BYTES,
  decodeSensor,
  isClientHello,
  isPong,
  parseMessage,
  randomRoomCode,
  type Connection,
  type ServerMsg,
} from '@phonemote/protocol';
import {
  AddressTakenError,
  LatestOnly,
  RelayHost,
  answer,
  directLink,
  hostAddress,
  type IncomingCall,
  type Link,
  type SignalMessage,
  type Signaling,
} from '@phonemote/peer';
import { deliverToGame, type GameClientHandlers, type GameLink, type PlayerInfo } from './client.js';

/**
 * The game page as the host for phones joining from the web (ARCHITECTURE.md
 * D60, D63).
 *
 * What the relay does on the LAN, done here instead: hand out a room code, seat
 * the phones, route pings and haptics, and pass sensor frames to the session.
 * The rules are the relay's own — the same `Room`, from @phonemote/protocol —
 * with each phone's link behind a `Connection` where the relay has a socket.
 *
 * A phone arrives over one of two links: a WebRTC peer connection, or the
 * PhoneMote server relaying for a phone that could not reach this page
 * directly. Both are a `Link`, and the room treats them the same.
 */

export interface PeerHostOptions {
  /** A signaling channel at this address. */
  readonly signaling: (address: string) => Signaling;
  readonly iceServers: readonly RTCIceServer[];
  /** The page a phone opens to join this room. */
  readonly controllerUrl: (roomCode: string) => string;
  /** The server relay, and the token this page's server signaling holds the room with. */
  readonly relay?: { readonly url: string; readonly token: string };
  readonly randomCode?: () => string;
}

/** Codes are four characters from 32; a few collisions in a row means something else is wrong. */
const MAX_CODE_ATTEMPTS = 6;
const RETRY_MS = 3000;
const MAX_NAME = 16;
const MAX_CLIENT_ID = 64;

export class PeerHost implements GameLink {
  private readonly room: Room;
  private signaling: Signaling | null = null;
  private code: string | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** Whether the session has been told the room's code yet. */
  private announced = false;
  private relayHost: RelayHost | null = null;
  private relayed = 0;
  /** Phones mid-handshake, by signaling address. */
  private readonly calls = new Map<string, IncomingCall>();
  /** Phones whose links are open, by signaling address or relay tunnel. */
  private readonly links = new Map<string, () => void>();
  private readonly latest = new LatestOnly();

  constructor(
    private readonly handlers: GameClientHandlers,
    private readonly options: PeerHostOptions,
  ) {
    // The game end of the room is this page: what the relay would have sent
    // down a socket is handed straight to the session.
    const game: Connection = {
      send: (data) => {
        if (typeof data === 'string') deliverToGame(this.handlers, data);
      },
      close: () => undefined,
    };
    // Created now rather than once a code is registered, so keyboard players
    // can be seated, and play, even when no signaling server is reachable.
    this.room = new Room('', game);
  }

  connect(): void {
    void this.register();
  }

  ping(playerId: number, id: number): void {
    this.room.toPlayer(playerId, JSON.stringify({ type: 'ping', id, playerId }));
  }

  vibrate(playerId: number, pattern: number[]): void {
    this.room.toPlayer(playerId, JSON.stringify({ type: 'vibrate', playerId, pattern }));
  }

  claimLocalSeat(name: string): PlayerInfo | null {
    // Nothing to send a keyboard: pings and haptics for it go nowhere.
    const local: Connection = { send: () => undefined, close: () => undefined };
    const joined = this.room.addController(local, name);
    if (!joined.ok) return null;
    return { id: joined.player.id, name: joined.player.name, color: joined.player.color };
  }

  /** Claim an address for a room code, picking a new code if it is taken. */
  private async register(): Promise<void> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = this.code ?? (this.options.randomCode ?? randomRoomCode)();
      // The same channel object reconnects with the same token, which is what
      // lets it reclaim its own address after a drop instead of being refused.
      const signaling = this.signaling ?? this.listen(this.options.signaling(hostAddress(code)));
      this.signaling = signaling;
      try {
        await signaling.open();
      } catch (error) {
        if (error instanceof AddressTakenError) {
          // Somebody else's room. A new code, and a new channel to go with it.
          signaling.close();
          this.signaling = null;
          this.code = null;
          continue;
        }
        // Unreachable. Keep the code, so phones already holding it still fit.
        this.code = code;
        this.retryLater();
        return;
      }
      if (this.code !== code || !this.announced) {
        this.code = code;
        this.announced = true;
        this.startRelay(code);
        this.handlers.onRoom({
          roomCode: code,
          wsUrl: '',
          controllerUrl: this.options.controllerUrl(code),
        });
      }
      return;
    }
    this.retryLater();
  }

  /** Offer to carry phones that cannot reach this page directly. */
  private startRelay(code: string): void {
    const relay = this.options.relay;
    if (!relay) return;
    this.relayHost?.stop();
    this.relayHost = new RelayHost(relay.url, hostAddress(code), relay.token, (link) => {
      this.relayed++;
      this.adopt(`relay-${this.relayed}`, link);
    });
    this.relayHost.start();
  }

  private listen(signaling: Signaling): Signaling {
    signaling.onMessage((from, message) => this.onSignal(signaling, from, message));
    signaling.onClose(() => this.retryLater());
    return signaling;
  }

  private retryLater(): void {
    if (this.retry !== null) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.register();
    }, RETRY_MS);
  }

  private onSignal(signaling: Signaling, from: string, message: SignalMessage): void {
    if (message.kind === 'offer') {
      // A phone calling again — after a drop, or a reload — replaces its old call.
      this.calls.get(from)?.close();
      this.links.get(from)?.();
      const call = answer(signaling, from, message.sdp, { iceServers: this.options.iceServers });
      this.calls.set(from, call);
      call.link
        .then((peer) => {
          if (this.calls.get(from) !== call) {
            peer.connection.close();
            return;
          }
          this.calls.delete(from);
          this.adopt(from, directLink(peer, SENSOR_FRAME_BYTES * 3));
        })
        .catch(() => {
          if (this.calls.get(from) === call) this.calls.delete(from);
        });
      return;
    }
    if (message.kind === 'candidate') {
      this.calls.get(from)?.addCandidate(message.candidate);
      return;
    }
    // 'gone': the phone left before its call was answered.
    this.calls.get(from)?.close();
    this.calls.delete(from);
  }

  /** A phone's link is open: give it the relay's treatment. */
  private adopt(key: string, link: Link): void {
    let ended = false;

    const connection: Connection = {
      // The room only ever sends a phone JSON.
      send: (data) => {
        if (typeof data === 'string') link.sendControl(data);
      },
      close: () => link.close(),
      get bufferedAmount() {
        return link.bufferedAmount;
      },
    };

    const end = (): void => {
      if (ended) return;
      ended = true;
      this.links.delete(key);
      // A phone that drops keeps its seat for the rejoin window (D48).
      this.room.removeController(connection);
      link.close();
    };
    this.links.set(key, end);

    link.onControl((text) => {
      const message = parseMessage(text);
      if (!message) return;

      if (isClientHello(message) && message.role === 'controller') {
        // From a stranger on the internet: the shapes are checked, and the
        // lengths capped, before any of it reaches a seat or the screen.
        const name = typeof message.name === 'string' ? message.name.slice(0, MAX_NAME) : undefined;
        const clientId =
          typeof message.clientId === 'string' ? message.clientId.slice(0, MAX_CLIENT_ID) : undefined;
        const joined = this.room.addController(connection, name, clientId);
        if (!joined.ok) {
          connection.send(
            JSON.stringify({
              type: 'error',
              code: joined.code,
              message: 'That room already has four controllers.',
            } satisfies ServerMsg),
          );
          end();
          return;
        }
        // A reloaded page counts its frames from zero again.
        this.latest.forget(joined.player.id);
        return;
      }

      if (isPong(message)) {
        const player = this.room.findPlayerByConnection(connection);
        // Stamped with the seat it came from, so one phone cannot skew another's latency.
        if (player) this.room.toGame(JSON.stringify({ ...message, playerId: player.id }));
      }
    });

    link.onSensor((data) => {
      const player = this.room.findPlayerByConnection(connection);
      if (!player) return;
      let frame;
      try {
        frame = decodeSensor(data);
      } catch {
        return;
      }
      // A phone speaks for its own seat, and a frame that arrives behind a
      // newer one is dropped rather than replayed into the past.
      if (frame.playerId !== player.id) return;
      if (!this.latest.accept(player.id, frame.seq)) return;
      this.handlers.onFrame(frame);
    });

    link.onEnd(end);
  }
}
