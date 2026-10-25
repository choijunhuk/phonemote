import { parseMessage, type Feedback, type ServerMsg } from '@phonemote/protocol';
import {
  AddressTakenError,
  RoomNotFoundError,
  callerAddress,
  dial,
  hostAddress,
  type PeerLink,
  type Signaling,
} from '@phonemote/peer';
import {
  MAX_BUFFERED_BYTES,
  TERMINAL_ERRORS,
  type ControllerLink,
  type TransportHandlers,
} from './transport.js';

/**
 * The phone's link to the game page in the web build (ARCHITECTURE.md D60).
 *
 * Says exactly what the relay transport says — hello, pong — over a WebRTC
 * data channel instead of a socket, and sends sensor frames over a second,
 * unordered channel that never retransmits. Reconnects on its own after a
 * drop, as the relay transport does; the room keeps the seat warm meanwhile.
 */

export interface PeerTransportOptions {
  readonly signaling: (address: string) => Signaling;
  readonly iceServers: readonly RTCIceServer[];
}

const RETRY_MS = 1500;
/** How long to try a room the broker says does not exist. */
const ABSENT_ROOM_TIMEOUT_MS = 6000;
/** Calls in a row that never got through before a first join, before giving up. */
const MAX_FAILED_CALLS = 4;

export class PeerTransport implements ControllerLink {
  private signaling: Signaling | null = null;
  private link: PeerLink | null = null;
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
    const channel = this.link?.sensor;
    if (!channel || channel.readyState !== 'open') return false;
    // Backpressure, as on the socket: a channel already behind skips the frame.
    if (channel.bufferedAmount > MAX_BUFFERED_BYTES) return false;
    channel.send(buffer);
    return true;
  }

  close(): void {
    this.closedByUs = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.link?.connection.close();
    this.link = null;
    this.signaling?.close();
    this.signaling = null;
    this.playerId = null;
  }

  private async call(): Promise<void> {
    this.handlers.onState(this.everJoined ? 'reconnecting' : 'connecting');
    try {
      const signaling = await this.openSignaling();
      // A room announces its code. When the broker says nobody holds this
      // one, the call is still tried — a wrong "no" would lock the phone out —
      // but briefly, so a mistyped code fails in seconds, not after retries.
      const present = await signaling.exists?.(hostAddress(this.roomCode));
      const link = await dial(signaling, hostAddress(this.roomCode), {
        iceServers: this.options.iceServers,
        ...(present === false ? { timeoutMs: ABSENT_ROOM_TIMEOUT_MS } : {}),
      }).catch((error: unknown) => {
        throw present === false ? new RoomNotFoundError() : error;
      });
      if (this.closedByUs) {
        link.connection.close();
        return;
      }
      this.adopt(link);
    } catch (error) {
      if (this.closedByUs) return;
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

  private adopt(link: PeerLink): void {
    this.link = link;
    this.failures = 0;
    const { control, connection } = link;

    control.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      const message = parseMessage(event.data);
      if (!message) return;

      if (message.type === 'joined') {
        this.playerId = message.playerId;
        this.everJoined = true;
        this.handlers.onJoined(message.playerId, message.color, message.resumed === true);
        return;
      }
      if (message.type === 'ping') {
        // Echoed at once; the game measures round trips, never one way.
        control.send(JSON.stringify({ ...message, type: 'pong' }));
        return;
      }
      if (message.type === 'error' && TERMINAL_ERRORS.has(message.code)) {
        this.giveUp(message.message);
        return;
      }
      this.handlers.onServerMessage(message as ServerMsg | Feedback);
    });

    control.send(
      JSON.stringify({
        type: 'hello',
        role: 'controller',
        roomCode: this.roomCode,
        ...(this.name ? { name: this.name } : {}),
        ...(this.clientId ? { clientId: this.clientId } : {}),
      }),
    );

    const lost = (): void => {
      if (this.link !== link) return;
      this.link = null;
      connection.close();
      if (this.closedByUs) return;
      this.handlers.onState('reconnecting', `${RETRY_MS / 1000}초 후 재시도`);
      this.scheduleRetry();
    };
    control.addEventListener('close', lost);
    connection.addEventListener('connectionstatechange', () => {
      const state = connection.connectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') lost();
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
