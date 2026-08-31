import { describe, expect, it } from 'vitest';
import { assignSeats, seatOf } from '../seats.js';
import {
  DEFAULT_TURN_SECONDS,
  advance,
  createTurnOrder,
  currentPlayer,
  reorder,
  setAbsent,
  tickTurn,
  type TurnEvent,
  type TurnOrder,
} from '../turnOrder.js';

/** Everything the shot clock sees over a stretch of play. */
function tickFor(order: TurnOrder, seconds: number, dt = 1 / 60): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) events.push(...tickTurn(order, dt));
  return events;
}

/** When the clock gave up, in seconds of play rather than in frames. */
function secondsUntilTimeout(order: TurnOrder, dt: number): number {
  let elapsed = 0;
  for (let frame = 0; frame < 10000; frame++) {
    elapsed += dt;
    if (tickTurn(order, dt).some((event) => event.kind === 'turn_timed_out')) return elapsed;
  }
  return Number.POSITIVE_INFINITY;
}

describe('taking turns', () => {
  it('starts with the player in the first seat', () => {
    const order = createTurnOrder([7, 3, 5]);

    expect(currentPlayer(order)).toBe(7);
    expect(order.timeoutSeconds).toBe(DEFAULT_TURN_SECONDS);
  });

  it('goes round the room and back to the top', () => {
    const order = createTurnOrder([7, 3, 5]);

    expect(advance(order)).toEqual([{ kind: 'turn_changed', playerId: 3 }]);
    expect(advance(order)).toEqual([{ kind: 'turn_changed', playerId: 5 }]);
    expect(advance(order)).toEqual([{ kind: 'turn_changed', playerId: 7 }]);
  });

  it('announces every frame of a solo game, not just the first', () => {
    const order = createTurnOrder([7]);

    expect(advance(order)).toEqual([{ kind: 'turn_changed', playerId: 7 }]);
    expect(currentPlayer(order)).toBe(7);
  });

  it('has nobody to play when nobody is seated', () => {
    const order = createTurnOrder([]);

    expect(currentPlayer(order)).toBe(null);
    expect(advance(order)).toEqual([]);
    expect(tickFor(order, 5 * DEFAULT_TURN_SECONDS)).toEqual([]);
  });
});

describe('a phone that drops out', () => {
  it('is stepped over instead of holding the game up', () => {
    const order = createTurnOrder([1, 2, 3]);

    // Not their turn yet, so nothing on screen should change.
    expect(setAbsent(order, 2, true)).toEqual([]);
    expect(currentPlayer(order)).toBe(1);

    expect(advance(order)).toEqual([{ kind: 'turn_changed', playerId: 3 }]);
  });

  it('hands the turn straight on when it drops while holding it', () => {
    const order = createTurnOrder([1, 2, 3]);

    expect(setAbsent(order, 1, true)).toEqual([{ kind: 'turn_changed', playerId: 2 }]);
    expect(currentPlayer(order)).toBe(2);
    expect(order.elapsed).toBe(0);
  });

  it('keeps its place in the order, so its turn comes back when it does', () => {
    const seats = assignSeats([1, 2, 3]);
    const order = createTurnOrder(seats);
    setAbsent(order, 2, true);
    advance(order);
    advance(order);
    expect(currentPlayer(order)).toBe(1);

    // Back mid-way through somebody else's turn: they wait, they do not barge in.
    expect(setAbsent(order, 2, false)).toEqual([]);
    expect(currentPlayer(order)).toBe(1);

    expect(advance(order)).toEqual([{ kind: 'turn_changed', playerId: 2 }]);
    // And the seat it came back to is the seat it left, so the score card still
    // holds the frames it bowled before the phone dropped.
    expect(order.seats).toEqual([1, 2, 3]);
    expect(seatOf(seats, 2)).toBe(2);
  });

  it('ignores a player who is not in this match at all', () => {
    const order = createTurnOrder([1, 2]);

    expect(setAbsent(order, 99, true)).toEqual([]);
    expect(order.absent).toEqual([]);
  });
});

describe('a turn nobody takes', () => {
  it('ends by itself rather than freezing the game', () => {
    const order = createTurnOrder([1, 2], 5);

    expect(tickFor(order, 5.5)).toEqual([
      { kind: 'turn_timed_out', playerId: 1 },
      { kind: 'turn_changed', playerId: 2 },
    ]);
    expect(currentPlayer(order)).toBe(2);
  });

  it('gives up once per turn, not once per frame after the deadline', () => {
    const order = createTurnOrder([1, 2], 5);
    tickFor(order, 5.5);

    // Still inside the next player's own minute, so the clock stays quiet.
    expect(tickFor(order, 4)).toEqual([]);
  });

  it('runs on the clock, not on the frame rate', () => {
    for (const dt of [1 / 15, 1 / 100]) {
      const order = createTurnOrder([1, 2], 5);

      expect(Math.abs(secondsUntilTimeout(order, dt) - 5)).toBeLessThanOrEqual(dt);
    }
  });

  it('does not run at all when there is nobody to run it on', () => {
    const order = createTurnOrder([1], 5);
    setAbsent(order, 1, true);

    expect(tickFor(order, 30)).toEqual([]);
  });
});

describe('a room that empties', () => {
  it('says so once, however long it is left running', () => {
    const order = createTurnOrder([1, 2], 5);

    expect(setAbsent(order, 2, true)).toEqual([]);
    expect(setAbsent(order, 1, true)).toEqual([{ kind: 'order_empty' }]);
    expect(currentPlayer(order)).toBe(null);

    expect(advance(order)).toEqual([]);
    expect(tickFor(order, 30)).toEqual([]);
    expect(setAbsent(order, 1, true)).toEqual([]);
  });

  it('says so again only after somebody has been back in the meantime', () => {
    const order = createTurnOrder([1, 2]);
    setAbsent(order, 2, true);
    setAbsent(order, 1, true);

    expect(setAbsent(order, 1, false)).toEqual([{ kind: 'turn_changed', playerId: 1 }]);
    expect(setAbsent(order, 1, true)).toEqual([{ kind: 'order_empty' }]);
  });

  it('gives the turn back to whoever was holding it when the last phone left', () => {
    const order = createTurnOrder([1, 2]);
    setAbsent(order, 2, true);
    setAbsent(order, 1, true);

    expect(setAbsent(order, 1, false)).toEqual([{ kind: 'turn_changed', playerId: 1 }]);
    expect(currentPlayer(order)).toBe(1);
  });

  it('lets whoever reconnects first play, rather than waiting for the last one', () => {
    const order = createTurnOrder([1, 2]);
    setAbsent(order, 2, true);
    setAbsent(order, 1, true);

    expect(setAbsent(order, 2, false)).toEqual([{ kind: 'turn_changed', playerId: 2 }]);
    expect(currentPlayer(order)).toBe(2);
  });
});

describe('re-sorting who plays next', () => {
  it('sends the furthest ball first without taking the turn off the player holding it', () => {
    const order = createTurnOrder([1, 2, 3]);
    advance(order);
    expect(currentPlayer(order)).toBe(2);

    const metresFromHole = new Map([
      [1, 4],
      [2, 12],
      [3, 30],
    ]);
    reorder(order, (playerId) => -(metresFromHole.get(playerId) ?? 0));

    expect(order.seats).toEqual([3, 2, 1]);
    expect(currentPlayer(order)).toBe(2);
    expect(advance(order)).toEqual([{ kind: 'turn_changed', playerId: 1 }]);
  });

  it('leaves players where they were when their balls are level', () => {
    const order = createTurnOrder([5, 6, 7]);

    reorder(order, () => 0);

    expect(order.seats).toEqual([5, 6, 7]);
    expect(currentPlayer(order)).toBe(5);
  });

  it('does not make an empty room report itself empty a second time', () => {
    const order = createTurnOrder([1, 2]);
    setAbsent(order, 2, true);
    expect(setAbsent(order, 1, true)).toEqual([{ kind: 'order_empty' }]);

    reorder(order, (playerId) => playerId);

    expect(currentPlayer(order)).toBe(null);
    expect(advance(order)).toEqual([]);
  });

  it('leaves the seating alone, so seat numbers and score cards stay put', () => {
    const seats = assignSeats([11, 22, 33]);
    const order = createTurnOrder(seats);

    reorder(order, (playerId) => -playerId);

    expect(order.seats).toEqual([33, 22, 11]);
    expect(seats).toEqual([11, 22, 33]);
    expect(seatOf(seats, 33)).toBe(3);
  });
});
