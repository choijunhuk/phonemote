import { parseMessage, type Feedback, type ServerMsg } from '@phonemote/protocol';
import {
  AddressTakenError,
  RoomNotFoundError,
  callerAddress,
  dial,
  directLink,
  hostAddress,
  relayLink,
  type Link,
  type Signaling,
} from '@phonemote/peer';
import {
  MAX_BUFFERED_BYTES,
  TERMINAL_ERRORS,
  type ControllerLink,
  type TransportHandlers,
} from './transport.js';

/**
 * The phone's link to the game page in the web build (ARCHITECTURE.md D60,
 * D63).
 *
 * Says exactly what the relay transport says — hello, pong — over whichever
 * link it gets: a WebRTC connection straight to the page, or, when no direct
 * route exists, the PhoneMote server relaying over WebSockets. Reconnects on
 * its own after a drop; the room keeps the seat warm meanwhile.
 */

export interface PeerTransportOptions {
  readonly signaling: (address: string) => Signaling;
  readonly iceServers: readonly RTCIceServer[];
  /** The server relay to fall back on. */
  readonly relayUrl?: string;
  /** Skip the direct attempt (for testing the relay). */
  readonly relayOnly?: boolean;
}

const RETRY_MS = 1500;
/** Calls in a row that never got through before a first join, before giving up. */
const MAX_FAILED_CALLS = 4;
/** How long to keep calling a room the broker says does not exist. */
const ABSENT_ROOM_GRACE_MS = 6000;

export class PeerTransport implements ControllerLink {
  private signaling: Signaling | null = null;
  private link: Link | null = null;
  private playerId: number | null = null;
  private everJoined = false;
  private closedByUs = false;
  private retryTimer: number | null = null;
  private failures = 0;

  constructor(
    private readonly roomCode: string,
    private readonly handlers: TransportHandlers,
    private readonly name: string | undefined,
    private readonly clientId: string | undefined,
    private readonly options: PeerTransportOptions,
  ) {}

  get currentPlayerId(): number | null {
    return this.playerId;
  }

  connect(): void {
    this.closedByUs = false;
    void this.call();
  }

  sendFrame(buffer: ArrayBuffer): boolean {
    return this.link?.sendSensor(buffer) ?? false;
  }

  close(): void {
    this.closedByUs = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.link?.close();
    this.link = null;
    this.signaling?.close();
    this.signaling = null;
    this.playerId = null;
  }

  private async call(): Promise<void> {
    this.handlers.onState(this.everJoined ? 'reconnecting' : 'connecting');
    const started = performance.now();
    const since = (): string => `${Math.round(performance.now() - started)} ms`;
    const room = hostAddress(this.roomCode);
    try {
      const link = this.options.relayOnly ? await this.viaRelay(room) : await this.direct(room, since);
      console.info(`[link] ${link.kind} link open after ${since()}`);
      if (this.closedByUs) {
        link.close();
        return;
      }
      this.adopt(link);
    } catch (error) {
      if (this.closedByUs) return;
      console.info(`[link] call failed after ${since()}: ${String(error)}`);
      if (error instanceof RoomNotFoundError) {
        this.giveUp(
          this.everJoined
            ? '게임 화면이 닫혔습니다'
            : '그 코드의 방이 없습니다 — PC 화면의 코드를 확인하세요',
        );
        return;
      }
      this.failures++;
      if (!this.everJoined && this.failures >= MAX_FAILED_CALLS) {
        this.giveUp('연결하지 못했습니다 — 코드와 인터넷 연결을 확인하세요');
        return;
      }
      this.handlers.onState('reconnecting', `${RETRY_MS / 1000}초 후 재시도`);
      this.scheduleRetry();
    }
  }

  /**
   * Straight to the page over WebRTC, and through the server if that fails:
   * a network that blocks the direct route still lets 443 out.
   */
  private async direct(room: string, since: () => string): Promise<Link> {
    const signaling = await this.openSignaling();
    console.info(`[link] signaling open after ${since()}`);
    // The room's claim is looked up while the call is already being made.
    // When nobody holds the code, the call is still given a few seconds — a
    // wrong "no" must not lock a phone out — and then abandoned.
    const lookup = signaling.exists?.(room) ?? Promise.resolve(null);
    const abandon = lookup.then(
      (present) =>
        new Promise<Error>((resolve) => {
          if (present === false) {
            window.setTimeout(() => resolve(new RoomNotFoundError()), ABSENT_ROOM_GRACE_MS);
          }
        }),
    );
    try {
      const peer = await dial(signaling, room, { iceServers: this.options.iceServers, abandon });
      return directLink(peer, MAX_BUFFERED_BYTES);
    } catch (error) {
      if (error instanceof RoomNotFoundError || !this.options.relayUrl) throw error;
      console.info(`[link] no direct route (${String(error)}), trying the relay`);
      return this.viaRelay(room);
    }
  }

  private viaRelay(room: string): Promise<Link> {
    const url = this.options.relayUrl;
    if (!url) return Promise.reject(new Error('No relay configured.'));
    return relayLink(url, room, MAX_BUFFERED_BYTES);
  }

  /** One signaling address for the life of this transport, kept between calls. */
  private async openSignaling(): Promise<Signaling> {
    if (this.signaling) return this.signaling;
    for (let attempt = 0; attempt < 3; attempt++) {
      const signaling = this.options.signaling(callerAddress());
      try {
        await signaling.open();
      } catch (error) {
        signaling.close();
        if (error instanceof AddressTakenError) continue;
        throw error;
      }
      signaling.onClose(() => {
        if (this.signaling === signaling) this.signaling = null;
      });
      this.signaling = signaling;
      return signaling;
    }
    throw new Error('No free signaling address.');
  }

  private adopt(link: Link): void {
    this.link = link;
    this.failures = 0;

    link.onControl((text) => {
      const message = parseMessage(text);
      if (!message) return;

      if (message.type === 'joined') {
        this.playerId = message.playerId;
        this.everJoined = true;
        this.handlers.onJoined(message.playerId, message.color, message.resumed === true);
        return;
      }
      if (message.type === 'ping') {
        // Echoed at once; the game measures round trips, never one way.
        link.sendControl(JSON.stringify({ ...message, type: 'pong' }));
        return;
      }
      if (message.type === 'error' && TERMINAL_ERRORS.has(message.code)) {
        this.giveUp(message.message);
        return;
      }
      this.handlers.onServerMessage(message as ServerMsg | Feedback);
    });

    link.sendControl(
      JSON.stringify({
        type: 'hello',
        role: 'controller',
        roomCode: this.roomCode,
        ...(this.name ? { name: this.name } : {}),
        ...(this.clientId ? { clientId: this.clientId } : {}),
      }),
    );

    link.onEnd(() => {
      if (this.link !== link) return;
      this.link = null;
      if (this.closedByUs) return;
      this.handlers.onState('reconnecting', `${RETRY_MS / 1000}초 후 재시도`);
      this.scheduleRetry();
    });
  }

  private giveUp(reason: string): void {
    this.close();
    this.handlers.onState('failed', reason);
    this.handlers.onGiveUp(reason);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.call();
    }, RETRY_MS);
  }
}
