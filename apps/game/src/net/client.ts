import {
  PORTS,
  decodeSensor,
  parseMessage,
  type Feedback,
  type Ping,
  type SensorFrame,
} from '@phonemote/protocol';

/**
 * The game's link to the relay (ARCHITECTURE.md 7.4).
 *
 * Owns the socket and nothing else: decoding happens here, interpretation
 * happens in the input layer, and scenes see neither.
 */

export interface RoomInfo {
  readonly roomCode: string;
  readonly wsUrl: string;
  readonly controllerUrl: string;
}

export interface PlayerInfo {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface GameClientHandlers {
  onRoom(room: RoomInfo): void;
  onPlayerJoin(player: PlayerInfo): void;
  onPlayerLeave(playerId: number): void;
  onFrame(frame: SensorFrame): void;
  onPong(playerId: number, id: number): void;
  onDisconnect(): void;
}

const RECONNECT_DELAY_MS = 1000;

export class GameClient {
  private socket: WebSocket | null = null;

  constructor(
    private readonly handlers: GameClientHandlers,
    private readonly url = `wss://${window.location.hostname}:${PORTS.relay}`,
  ) {}

  connect(): void {
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'game' }));
    });

    socket.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
      if (event.data instanceof ArrayBuffer) {
        this.handlers.onFrame(decodeSensor(event.data));
        return;
      }
      const message = parseMessage(event.data);
      if (!message) return;

      switch (message.type) {
        case 'room':
          this.handlers.onRoom(message);
          break;
        case 'player_join':
          this.handlers.onPlayerJoin({
            id: message.playerId,
            name: message.name,
            color: message.color,
          });
          break;
        case 'player_leave':
          this.handlers.onPlayerLeave(message.playerId);
          break;
        case 'pong':
          this.handlers.onPong(message.playerId, message.id);
          break;
        default:
          break;
      }
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      this.handlers.onDisconnect();
      // A new socket means a new room code; the lobby will show it.
      window.setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });
  }

  private send(message: Ping | Feedback): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  ping(playerId: number, id: number): void {
    this.send({ type: 'ping', id, playerId });
  }

  vibrate(playerId: number, pattern: number[]): void {
    this.send({ type: 'vibrate', playerId, pattern });
  }
}
