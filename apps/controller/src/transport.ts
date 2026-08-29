import { parseMessage, type Feedback, type ServerMsg } from '@phonemote/protocol';

/**
 * The phone's link to the relay (ARCHITECTURE.md 7.2).
 *
 * Reconnects on its own every second, because a phone screen going off or a
 * Wi-Fi hiccup should not end the session. Until Phase 4 a reconnect rejoins
 * as a new player.
 */

export type ConnectionState = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'failed';

export interface TransportHandlers {
  onState(state: ConnectionState, detail?: string): void;
  onJoined(playerId: number, color: string): void;
  /** Everything the phone still cares about: errors and haptics. */
  onServerMessage(message: ServerMsg | Feedback): void;
}

const RECONNECT_DELAY_MS = 1000;
/** Drop frames rather than queue them: a stale frame is worse than no frame. */
const MAX_BUFFERED_BYTES = 4096;

export class Transport {
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private reconnectTimer: number | null = null;
  private playerId: number | null = null;

  constructor(
    private readonly url: string,
    private readonly roomCode: string,
    private readonly handlers: TransportHandlers,
    private readonly name?: string,
  ) {}

  get currentPlayerId(): number | null {
    return this.playerId;
  }

  get isJoined(): boolean {
    return this.playerId !== null && this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closedByUs = false;
    this.handlers.onState(this.playerId === null ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          role: 'controller',
          roomCode: this.roomCode,
          ...(this.name ? { name: this.name } : {}),
        }),
      );
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const message = parseMessage(String(event.data));
      if (!message) return;

      if (message.type === 'joined') {
        this.playerId = message.playerId;
        this.handlers.onState('joined');
        this.handlers.onJoined(message.playerId, message.color);
        return;
      }
      if (message.type === 'ping') {
        // Echo immediately; the game measures round trip, never one-way.
        socket.send(JSON.stringify({ ...message, type: 'pong' }));
        return;
      }
      this.handlers.onServerMessage(message as ServerMsg | Feedback);
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      if (this.closedByUs) return;
      this.handlers.onState('reconnecting', `${RECONNECT_DELAY_MS / 1000}초 후 재시도`);
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' always follows; reconnection is handled there.
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  sendFrame(buffer: ArrayBuffer): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    // Backpressure: if the socket is already behind, skip this frame entirely.
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return false;
    socket.send(buffer);
    return true;
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.playerId = null;
  }
}
