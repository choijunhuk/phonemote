import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  REJOIN_GRACE_MS,
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
  /** Set when the phone identified itself, which is what makes rejoin work. */
  readonly clientId?: string;
}

/** A slot held open for a phone that just vanished. */
interface Reservation {
  readonly playerId: number;
  readonly name: string;
  readonly expiresAt: number;
}

export type Clock = () => number;

export type JoinResult = { ok: true; player: Player } | { ok: false; code: ErrorCode };

function send(connection: Connection, message: ServerMsg): void {
  connection.send(JSON.stringify(message));
}

export class Room {
  private readonly players = new Map<number, Player>();
  /** clientId -> the slot being kept warm for it. */
  private readonly reserved = new Map<string, Reservation>();

  constructor(
    readonly code: string,
    readonly game: Connection,
    private readonly now: Clock = Date.now,
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

  private pruneReservations(): void {
    const now = this.now();
    for (const [clientId, reservation] of this.reserved) {
      if (reservation.expiresAt <= now) this.reserved.delete(clientId);
    }
  }

  private isHeldByAnotherClient(slot: number, clientId: string | undefined): boolean {
    for (const [reservedFor, reservation] of this.reserved) {
      if (reservation.playerId === slot && reservedFor !== clientId) return true;
    }
    return false;
  }

  /** Lowest free slot first, so a leaver's colour gets reused. */
  private nextFreeSlot(clientId: string | undefined): number | null {
    for (let id = 1; id <= MAX_PLAYERS; id++) {
      if (this.players.has(id)) continue;
      if (this.isHeldByAnotherClient(id, clientId)) continue;
      return id;
    }
    return null;
  }

  addController(connection: Connection, name?: string, clientId?: string): JoinResult {
    this.pruneReservations();

    const reservation = clientId === undefined ? undefined : this.reserved.get(clientId);
    const resumed = reservation !== undefined && !this.players.has(reservation.playerId);
    const id = resumed ? reservation.playerId : this.nextFreeSlot(clientId);
    if (id === null) return { ok: false, code: 'ROOM_FULL' };
    if (clientId !== undefined) this.reserved.delete(clientId);

    const color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length] ?? PLAYER_COLORS[0];
    const player: Player = {
      id,
      // A rejoining phone keeps the name it had, even if it sent none.
      name: name?.trim() || reservation?.name || `P${id}`,
      color,
      connection,
      ...(clientId === undefined ? {} : { clientId }),
    };
    this.players.set(id, player);

    send(connection, { type: 'joined', playerId: id, color, resumed });
    send(this.game, {
      type: 'player_join',
      playerId: id,
      name: player.name,
      color,
      resumed,
    });
    return { ok: true, player };
  }

  removeController(connection: Connection): Player | undefined {
    const player = this.findPlayerByConnection(connection);
    if (!player) return undefined;
    this.players.delete(player.id);

    // Hold the slot briefly: a phone that drops off Wi-Fi should come back as
    // the same player rather than as a stranger in the next free seat.
    if (player.clientId !== undefined) {
      this.reserved.set(player.clientId, {
        playerId: player.id,
        name: player.name,
        expiresAt: this.now() + REJOIN_GRACE_MS,
      });
    }

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

  constructor(
    private readonly generateCode: CodeGenerator = randomRoomCode,
    private readonly now: Clock = Date.now,
  ) {}

  get size(): number {
    return this.rooms.size;
  }

  create(game: Connection): Room {
    let code: string;
    do {
      code = this.generateCode();
    } while (this.rooms.has(code));

    const room = new Room(code, game, this.now);
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
