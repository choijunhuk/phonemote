import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_PLAYERS, PLAYER_COLORS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@phonemote/protocol';
import { RoomRegistry, randomRoomCode, type Connection } from '../room.js';

class FakeConnection implements Connection {
  readonly sent: string[] = [];
  readonly binary: ArrayBuffer[] = [];
  closed = false;

  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.sent.push(data);
    else this.binary.push(data);
  }

  close(): void {
    this.closed = true;
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

describe('room codes', () => {
  it('uses the confusable-free alphabet and fixed length', () => {
    for (let i = 0; i < 200; i++) {
      const code = randomRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      for (const char of code) expect(ROOM_CODE_ALPHABET).toContain(char);
    }
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[IO01]/);
  });

  it('skips a code that is already taken', () => {
    const codes = ['AAAA', 'AAAA', 'BBBB'];
    let index = 0;
    const registry = new RoomRegistry(() => codes[index++] ?? 'ZZZZ');

    expect(registry.create(new FakeConnection()).code).toBe('AAAA');
    // Second draw collides and must be discarded, not reused.
    expect(registry.create(new FakeConnection()).code).toBe('BBBB');
    expect(registry.size).toBe(2);
  });

  it('looks rooms up case-insensitively', () => {
    const registry = new RoomRegistry(() => 'WXYZ');
    registry.create(new FakeConnection());
    expect(registry.get('wxyz')?.code).toBe('WXYZ');
    expect(registry.get('QQQQ')).toBeUndefined();
  });
});

describe('joining', () => {
  let registry: RoomRegistry;
  let game: FakeConnection;

  beforeEach(() => {
    registry = new RoomRegistry(() => 'TEST');
    game = new FakeConnection();
  });

  it('assigns slots and colours in order', () => {
    const room = registry.create(game);
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      const result = room.addController(new FakeConnection());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.player.id).toBe(i);
      expect(result.player.color).toBe(PLAYER_COLORS[i - 1]);
    }
  });

  it('tells the controller and the game about the join', () => {
    const room = registry.create(game);
    const phone = new FakeConnection();
    room.addController(phone, 'junhuk');

    expect(phone.messages()).toEqual([{ type: 'joined', playerId: 1, color: PLAYER_COLORS[0] }]);
    expect(game.messages()).toEqual([
      { type: 'player_join', playerId: 1, name: 'junhuk', color: PLAYER_COLORS[0] },
    ]);
  });

  it('rejects the fifth controller', () => {
    const room = registry.create(game);
    for (let i = 0; i < MAX_PLAYERS; i++) room.addController(new FakeConnection());

    const result = room.addController(new FakeConnection());
    expect(result).toEqual({ ok: false, code: 'ROOM_FULL' });
    expect(room.playerCount).toBe(MAX_PLAYERS);
  });

  it('reuses the slot of a controller that left', () => {
    const room = registry.create(game);
    const first = new FakeConnection();
    room.addController(first);
    room.addController(new FakeConnection());

    expect(room.removeController(first)?.id).toBe(1);
    expect(game.messages().at(-1)).toEqual({ type: 'player_leave', playerId: 1 });

    const rejoin = room.addController(new FakeConnection());
    expect(rejoin.ok && rejoin.player.id).toBe(1);
  });

  it('ignores a disconnect from a connection that never joined', () => {
    const room = registry.create(game);
    expect(room.removeController(new FakeConnection())).toBeUndefined();
  });
});

describe('the game leaving', () => {
  it('tells every controller and closes them', () => {
    const registry = new RoomRegistry(() => 'TEST');
    const game = new FakeConnection();
    const room = registry.create(game);
    const phones = [new FakeConnection(), new FakeConnection()];
    for (const phone of phones) room.addController(phone);

    room.closeWithGameGone();
    registry.remove(room.code);

    for (const phone of phones) {
      expect(phone.messages().at(-1)).toMatchObject({ type: 'error', code: 'GAME_LEFT' });
      expect(phone.closed).toBe(true);
    }
    expect(room.playerCount).toBe(0);
    expect(registry.get('TEST')).toBeUndefined();
  });
});

describe('routing', () => {
  it('forwards binary frames to the game socket untouched', () => {
    const registry = new RoomRegistry(() => 'TEST');
    const game = new FakeConnection();
    const room = registry.create(game);
    const frame = new ArrayBuffer(56);

    room.toGame(frame);
    expect(game.binary).toEqual([frame]);
  });

  it('routes to a single player and reports unknown ids', () => {
    const registry = new RoomRegistry(() => 'TEST');
    const room = registry.create(new FakeConnection());
    const phone = new FakeConnection();
    room.addController(phone);

    expect(room.toPlayer(1, '{"type":"ping"}')).toBe(true);
    expect(phone.messages().at(-1)).toEqual({ type: 'ping' });
    expect(room.toPlayer(3, '{"type":"ping"}')).toBe(false);
  });

  it('finds the room a socket belongs to', () => {
    const registry = new RoomRegistry(() => 'TEST');
    const game = new FakeConnection();
    const room = registry.create(game);
    const phone = new FakeConnection();
    room.addController(phone);

    expect(registry.findByGame(game)?.code).toBe('TEST');
    expect(registry.findByController(phone)?.code).toBe('TEST');
    expect(registry.findByController(new FakeConnection())).toBeUndefined();
  });
});
