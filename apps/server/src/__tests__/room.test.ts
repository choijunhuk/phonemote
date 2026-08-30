import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  REJOIN_GRACE_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '@phonemote/protocol';
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

    // resumed distinguishes a fresh join from a phone reclaiming its slot.
    expect(phone.messages()).toEqual([
      { type: 'joined', playerId: 1, color: PLAYER_COLORS[0], resumed: false },
    ]);
    expect(game.messages()).toEqual([
      { type: 'player_join', playerId: 1, name: 'junhuk', color: PLAYER_COLORS[0], resumed: false },
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

describe('rejoining after a drop', () => {
  /** Controllable clock: the grace period is a rule, not a race. */
  function fixtures() {
    let now = 1_000_000;
    const registry = new RoomRegistry(
      () => 'TEST',
      () => now,
    );
    const game = new FakeConnection();
    const room = registry.create(game);
    return { room, game, advance: (ms: number) => (now += ms) };
  }

  it('gives a returning phone its old slot back', () => {
    const { room, advance } = fixtures();
    const first = new FakeConnection();
    room.addController(first, 'junhuk', 'client-a');
    // Someone else takes a seat while the first phone is still connected.
    room.addController(new FakeConnection(), 'other', 'client-b');

    room.removeController(first);
    advance(REJOIN_GRACE_MS - 1);

    const back = new FakeConnection();
    const result = room.addController(back, undefined, 'client-a');
    expect(result.ok && result.player.id).toBe(1);
    expect(back.messages().at(-1)).toMatchObject({ type: 'joined', playerId: 1, resumed: true });
  });

  it('keeps the name of a phone that rejoins silently', () => {
    const { room } = fixtures();
    const phone = new FakeConnection();
    room.addController(phone, 'junhuk', 'client-a');
    room.removeController(phone);

    const result = room.addController(new FakeConnection(), undefined, 'client-a');
    expect(result.ok && result.player.name).toBe('junhuk');
  });

  it('will not hand the held slot to a different phone', () => {
    const { room } = fixtures();
    const phone = new FakeConnection();
    room.addController(phone, undefined, 'client-a');
    room.removeController(phone);

    const stranger = room.addController(new FakeConnection(), undefined, 'client-b');
    expect(stranger.ok && stranger.player.id).toBe(2);
  });

  it('releases the slot once the grace period expires', () => {
    const { room, advance } = fixtures();
    const phone = new FakeConnection();
    room.addController(phone, undefined, 'client-a');
    room.removeController(phone);
    advance(REJOIN_GRACE_MS + 1);

    const stranger = room.addController(new FakeConnection(), undefined, 'client-b');
    expect(stranger.ok && stranger.player.id).toBe(1);
  });

  it('treats a phone with no client id as a new player', () => {
    const { room } = fixtures();
    const phone = new FakeConnection();
    room.addController(phone, 'anon');
    room.removeController(phone);

    const back = room.addController(new FakeConnection());
    expect(back.ok && back.player.id).toBe(1);
    // Nothing was reserved, so this is a fresh join rather than a resume.
    expect(back.ok && back.player.name).toBe('P1');
  });

  it('reclaims its own slot from a connection that has not died yet', () => {
    // The phone retries every second; the server only notices the dead socket
    // on its own heartbeat. Both are "connected" at once.
    const { room } = fixtures();
    const zombie = new FakeConnection();
    room.addController(zombie, 'junhuk', 'client-a');
    room.addController(new FakeConnection(), 'other', 'client-b');

    const returning = new FakeConnection();
    const result = room.addController(returning, undefined, 'client-a');

    expect(result.ok && result.player.id).toBe(1);
    expect(zombie.closed).toBe(true);
    expect(room.playerCount).toBe(2);
  });

  it('still refuses a fifth controller while a slot is held', () => {
    const { room } = fixtures();
    const phones = [1, 2, 3, 4].map(() => new FakeConnection());
    phones.forEach((phone, index) => room.addController(phone, undefined, `client-${index}`));
    room.removeController(phones[0]!);

    const stranger = room.addController(new FakeConnection(), undefined, 'client-new');
    expect(stranger).toEqual({ ok: false, code: 'ROOM_FULL' });
  });
});
