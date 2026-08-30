import {
  PORTS,
  SENSOR_FRAME_BYTES,
  parseMessage,
  type Feedback,
  type ServerMsg,
} from '@phonemote/protocol';

/**
 * The phone's link to the relay (ARCHITECTURE.md 7.2).
 *
 * Reconnects on its own every second, because a phone screen going off or a
 * Wi-Fi hiccup should not end the session — but only while there is something
 * to reconnect to. A room that no longer exists is a dead end, and retrying it
 * forever left the phone stuck on a screen it could not leave.
 */

export type ConnectionState = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'failed';

export interface TransportHandlers {
  onState(state: ConnectionState, detail?: string): void;
  onJoined(playerId: number, color: string): void;
  /** Everything the phone still cares about: errors and haptics. */
  onServerMessage(message: ServerMsg | Feedback): void;
  /** The room is gone for good; the player has to pick a new one. */
  onGiveUp(reason: string): void;
}

const RECONNECT_DELAY_MS = 1000;
/**
 * Three frames. The old 4096 was 73 frames — over a second of backlog that the
 * player would feel as lag long before anything was dropped.
 */
const MAX_BUFFERED_BYTES = SENSOR_FRAME_BYTES * 3;

/** Errors that mean "stop trying", as opposed to "try again in a second". */
const TERMINAL_ERRORS = new Set(['ROOM_NOT_FOUND', 'ROOM_FULL', 'GAME_LEFT']);

export class Transport {
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private reconnectTimer: number | null = null;
  private playerId: number | null = null;

  constructor(
    private readonly roomCode: string,
    private readonly handlers: TransportHandlers,
    private readonly name?: string,
    private readonly clientId?: string,
    private readonly url = `wss://${window.location.hostname}:${PORTS.relay}`,
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
          ...(this.clientId ? { clientId: this.clientId } : {}),
        }),
      );
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const message = parseMessage(String(event.data));
      if (!message) return;

      if (message.type === 'joined') {
        this.playerId = message.playerId;
        this.handlers.onState('joined', message.resumed === true ? '복귀' : undefined);
        this.handlers.onJoined(message.playerId, message.color);
        return;
      }
      if (message.type === 'ping') {
        // Echo immediately; the game measures round trip, never one-way.
        socket.send(JSON.stringify({ ...message, type: 'pong' }));
        return;
      }
      if (message.type === 'error' && TERMINAL_ERRORS.has(message.code)) {
        this.giveUp(message.message);
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

  private giveUp(reason: string): void {
    this.close();
    this.handlers.onState('failed', reason);
    this.handlers.onGiveUp(reason);
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
