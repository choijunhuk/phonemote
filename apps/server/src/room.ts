import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type ErrorCode,
  type ServerMsg,
} from '@phonemote/protocol';

/**
 * Room bookkeeping (ARCHITECTURE.md 7.1).
 *
 * The relay never looks inside a sensor packet: it only needs to know which
 * socket to hand it to. Sockets are behind this narrow interface so the rules
 * can be tested without a network.
 */

export interface Connection {
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export interface Player {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly connection: Connection;
}

export type JoinResult = { ok: true; player: Player } | { ok: false; code: ErrorCode };

function send(connection: Connection, message: ServerMsg): void {
  connection.send(JSON.stringify(message));
}

export class Room {
  private readonly players = new Map<number, Player>();

  constructor(
    readonly code: string,
    readonly game: Connection,
  ) {}

  get playerCount(): number {
    return this.players.size;
  }

  listPlayers(): Player[] {
    return [...this.players.values()];
  }

  getPlayer(id: number): Player | undefined {
    return this.players.get(id);
  }

  findPlayerByConnection(connection: Connection): Player | undefined {
    return this.listPlayers().find((player) => player.connection === connection);
  }

  /** Slots are handed out lowest-first so a leaver's colour gets reused. */
  private nextFreeSlot(): number | null {
    for (let id = 1; id <= MAX_PLAYERS; id++) {
      if (!this.players.has(id)) return id;
    }
    return null;
  }

  addController(connection: Connection, name?: string): JoinResult {
    const id = this.nextFreeSlot();
    if (id === null) return { ok: false, code: 'ROOM_FULL' };

    const color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length] ?? PLAYER_COLORS[0];
    const player: Player = { id, name: name?.trim() || `P${id}`, color, connection };
    this.players.set(id, player);

    send(connection, { type: 'joined', playerId: id, color });
    send(this.game, { type: 'player_join', playerId: id, name: player.name, color });
    return { ok: true, player };
  }

  removeController(connection: Connection): Player | undefined {
    const player = this.findPlayerByConnection(connection);
    if (!player) return undefined;
    this.players.delete(player.id);
    send(this.game, { type: 'player_leave', playerId: player.id });
    return player;
  }

  /** The game left: nobody has anything to control, so the room ends. */
  closeWithGameGone(): void {
    for (const player of this.players.values()) {
      send(player.connection, {
        type: 'error',
        code: 'GAME_LEFT',
        message: 'The game disconnected.',
      });
      player.connection.close();
    }
    this.players.clear();
  }

  toGame(data: string | ArrayBuffer): void {
    this.game.send(data);
  }

  toPlayer(playerId: number, data: string | ArrayBuffer): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    player.connection.send(data);
    return true;
  }
}

export type CodeGenerator = () => string;

export function randomRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const index = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[index] ?? ROOM_CODE_ALPHABET[0];
  }
  return code;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly generateCode: CodeGenerator = randomRoomCode) {}

  get size(): number {
    return this.rooms.size;
  }

  create(game: Connection): Room {
    let code: string;
    do {
      code = this.generateCode();
    } while (this.rooms.has(code));

    const room = new Room(code, game);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  findByGame(game: Connection): Room | undefined {
    return [...this.rooms.values()].find((room) => room.game === game);
  }

  findByController(connection: Connection): Room | undefined {
    return [...this.rooms.values()].find(
      (room) => room.findPlayerByConnection(connection) !== undefined,
    );
  }

  remove(code: string): void {
    this.rooms.delete(code);
  }
}
