import { describe, expect, it } from 'vitest';
import type { Grip } from '../../../input/grip.js';
import { rotateAbout } from '../../../input/pose.js';
import type { CanonicalVector } from '../../../input/types.js';
import {
  ABANDON_SECONDS,
  AUTO_GRIP_SECONDS,
  GRIP_STILL_MS,
  MAX_TILT_DEG,
  biasDeg,
  configFor,
  createTable,
  drivingPlayers,
  findPlayer,
  medalFor,
  readPose,
  readStillness,
  regrip,
  ringHold,
  stepTable,
  syncPlayers,
  wobbleRms,
  type Course,
  type TableConfig,
  type TableEvent,
  type TablePlayer,
  type TableState,
} from '../tableState.js';

/**
 * The rules of Together Table, driven with a clock we control.
 *
 * Every test holds the board by feeding each phone the exact gravity vector its
 * hand would report at the lean being asked for, which is the only thing this
 * game ever reads.
 */

const FRAME = 1 / 60;

/** A phone held upright, screen towards the player: gravity-up is its own +Y. */
const LEVEL: CanonicalVector = { x: 0, y: 1, z: 0 };

/**
 * The gravity a phone would report at this lean away from that grip.
 *
 * tiltVector reads the forward (-Z) and right (+X) parts of the rotation axis
 * carrying the grip's gravity onto the measured one, so an axis built from
 * exactly those two components and turned the other way inverts it.
 */
function upFor(grip: Grip, rollDeg: number, pitchDeg: number): CanonicalVector {
  const angle = Math.hypot(rollDeg, pitchDeg);
  if (angle === 0) return grip.up;
  return rotateAbout(grip.up, { x: pitchDeg, y: 0, z: -rollDeg }, -angle);
}

function table(
  mode: string,
  players = 1,
  overrides: Partial<TableConfig> = {},
  seed = 1,
): TableState {
  const state = createTable(mode, overrides, seed);
  syncPlayers(
    state,
    Array.from({ length: players }, (_, index) => ({ id: index + 1, present: true })),
  );
  return state;
}

/** Hold every phone still until the game adopts its grip, and start the round. */
function settle(state: TableState, at = 0): void {
  for (const player of state.players) {
    if (!player.present) continue;
    for (let i = 0; i < 30; i++) readPose(state, player.id, LEVEL, at + i);
    readStillness(state, player.id, GRIP_STILL_MS + 100, false);
  }
  stepTable(state, FRAME, at + 40);
}

/** What one phone is doing this frame; null means it is sending nothing. */
type Lean = (player: TablePlayer, seconds: number) => { x: number; y: number } | null;

const level: Lean = () => ({ x: 0, y: 0 });

/** Run until something happens, so a test does not have to guess the timing. */
function runUntil(
  state: TableState,
  lean: Lean,
  stop: (events: readonly TableEvent[]) => boolean,
  limitSeconds = 20,
): TableEvent[] {
  const all: TableEvent[] = [];
  const frames = Math.round(limitSeconds / FRAME);
  for (let i = 0; i < frames; i++) {
    const step = run(state, FRAME, lean, 1000 + i * FRAME * 1000);
    all.push(...step);
    if (stop(step)) break;
  }
  return all;
}

function run(
  state: TableState,
  seconds: number,
  lean: Lean = level,
  startMs = 1000,
  dt = FRAME,
): TableEvent[] {
  const events: TableEvent[] = [];
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    const now = startMs + i * dt * 1000;
    for (const player of state.players) {
      if (!player.present || !player.grip) continue;
      const want = lean(player, i * dt);
      if (!want) continue;
      readPose(state, player.id, upFor(player.grip, want.x, want.y), now);
      readStillness(state, player.id, 0, false);
    }
    events.push(...stepTable(state, dt, now));
  }
  return events;
}

/** A one-course mode built for a test, so a rule is not read through a maze. */
function courseWith(holes: Course['holes'], overrides: Partial<Course> = {}): Course {
  return {
    key: 'test',
    label: '시험판',
    start: { x: 0.2, y: 0.5 },
    holes,
    walls: [],
    seconds: 0,
    onTimeout: 'fail',
    shrinkPerSecond: 0,
    medals: [],
    ...overrides,
  };
}

describe('taking a grip', () => {
  it('waits for the hand to stop before deciding what level means', () => {
    const state = table('practice');
    for (let i = 0; i < 30; i++) readPose(state, 1, LEVEL, i);
    readStillness(state, 1, GRIP_STILL_MS - 100, false);
    stepTable(state, FRAME, 40);
    expect(findPlayer(state, 1)?.grip).toBeNull();
    expect(state.phase).toBe('grip');

    readStillness(state, 1, GRIP_STILL_MS + 10, false);
    stepTable(state, FRAME, 60);
    expect(findPlayer(state, 1)?.grip).not.toBeNull();
    expect(state.phase).toBe('play');
  });

  it('never leaves the room staring at the setup screen', () => {
    // A phone sending poses but never reporting itself still: without the
    // timeout this room waits forever for a message that is not coming.
    const state = table('practice');
    for (let i = 0; i < 30; i++) readPose(state, 1, LEVEL, i);
    for (let i = 0; i < (AUTO_GRIP_SECONDS + 1) * 60; i++) stepTable(state, FRAME, 40 + i * 16);

    expect(findPlayer(state, 1)?.grip).not.toBeNull();
    expect(state.phase).toBe('play');
  });

  it('gives a player who joins late nothing to say until their hand settles', () => {
    const state = table('practice');
    settle(state);
    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
    ]);

    run(state, 0.5, (player) => (player.id === 1 ? { x: 10, y: 0 } : null));
    expect(findPlayer(state, 2)?.share).toBe(0);
    expect(state.table.x).toBeCloseTo(10, 0);

    // Now the newcomer holds still, is heard, and the board is shared.
    for (let i = 0; i < 30; i++) readPose(state, 2, LEVEL, 2000 + i);
    readStillness(state, 2, GRIP_STILL_MS + 10, false);
    run(state, 1.5, () => ({ x: 10, y: 0 }), 2100);
    expect(findPlayer(state, 2)?.grip).not.toBeNull();
    expect(findPlayer(state, 2)?.share).toBeGreaterThan(0.4);
  });

  it('re-levels one player without touching anybody else', () => {
    const state = table('practice', 2);
    settle(state);
    run(state, 1, () => ({ x: 12, y: 0 }));
    const other = findPlayer(state, 2)?.grip;

    regrip(state, 1);
    expect(findPlayer(state, 1)?.grip).toBeNull();
    expect(findPlayer(state, 1)?.tilt.x).toBe(0);
    expect(findPlayer(state, 2)?.grip).toBe(other);
    expect(findPlayer(state, 2)?.tilt.x).toBeCloseTo(12, 0);
  });
});

describe('the board being the mean of the room', () => {
  it('leans where two hands agree', () => {
    const state = table('practice', 2);
    settle(state);
    run(state, 1, () => ({ x: 12, y: -6 }));
    expect(state.table.x).toBeCloseTo(12, 0);
    expect(state.table.y).toBeCloseTo(-6, 0);
  });

  it('goes nowhere when two hands fight', () => {
    const state = table('practice', 2);
    settle(state);
    run(state, 3, (player) => ({ x: player.id === 1 ? 20 : -20, y: 0 }));

    expect(Math.abs(state.table.x)).toBeLessThan(0.5);
    // The whole promise of the mode: without talking to each other, nothing.
    expect(Math.abs(state.ball.x - state.course.start.x)).toBeLessThan(0.02);
  });

  it('splits the difference when one player leans and the other does not', () => {
    const state = table('practice', 2);
    settle(state);
    run(state, 1, (player) => ({ x: player.id === 1 ? 20 : 0, y: 0 }));
    expect(state.table.x).toBeCloseTo(10, 0);
    expect(findPlayer(state, 1)?.share).toBeCloseTo(0.5, 1);
  });

  it('never tilts further diagonally than it does straight', () => {
    const state = table('practice');
    settle(state);
    run(state, 1, () => ({ x: 40, y: 40 }));
    expect(Math.hypot(state.table.x, state.table.y)).toBeCloseTo(MAX_TILT_DEG, 5);
  });
});

describe('the drift that makes the board feel broken', () => {
  /**
   * The risk the design names: one grip slides over a minute, the board is
   * permanently off, and nobody in the room can tell whose fault it is. There
   * is no automatic correction — it would fight a player leaning slowly on
   * purpose — so the defence is that the numbers behind every hand are on the
   * record for the screen to draw.
   */
  it('says which hand is holding the board over, and by how much', () => {
    const state = table('practice', 2);
    settle(state);
    run(state, 40, (player) => ({ x: player.id === 2 ? 8 : 0, y: 0 }));

    const steady = findPlayer(state, 1);
    const drifting = findPlayer(state, 2);
    expect(state.table.x).toBeCloseTo(4, 0);
    expect(biasDeg(steady ?? nobody())).toBeLessThan(1);
    expect(biasDeg(drifting ?? nobody())).toBeGreaterThan(6);
    expect(drifting?.bias.x).toBeGreaterThan(0);
  });

  it('does not quietly correct it, because leaning slowly is a legal move', () => {
    const state = table('practice');
    settle(state);
    run(state, 60, () => ({ x: 8, y: 0 }));
    // Sixty seconds in, an eight degree lean still means an eight degree lean.
    expect(state.table.x).toBeCloseTo(8, 0);
  });
});

describe('a phone that drops out mid-game', () => {
  it('holds its last lean through a hiccup rather than dumping the board', () => {
    const state = table('practice', 2);
    settle(state);
    run(state, 1, () => ({ x: 20, y: 0 }));
    // Player 2 goes quiet for a second and a half, under the two second line.
    run(state, 1.5, (player) => (player.id === 1 ? { x: 20, y: 0 } : null), 2000);

    expect(state.table.x).toBeCloseTo(20, 0);
    expect(findPlayer(state, 2)?.stalled).toBe(true);
    expect(findPlayer(state, 2)?.share).toBeGreaterThan(0.4);
  });

  it('hands the board over without a lurch when the phone is really gone', () => {
    const state = table('practice', 2);
    settle(state);
    run(state, 1, (player) => ({ x: player.id === 1 ? 0 : 20, y: 0 }));
    expect(state.table.x).toBeCloseTo(10, 0);

    let biggestJump = 0;
    let previous = state.table.x;
    for (let i = 0; i < 5 * 60; i++) {
      const now = 3000 + i * FRAME * 1000;
      const one = findPlayer(state, 1);
      if (one?.grip) readPose(state, 1, upFor(one.grip, 0, 0), now);
      stepTable(state, FRAME, now);
      biggestJump = Math.max(biggestJump, Math.abs(state.table.x - previous));
      previous = state.table.x;
    }

    expect(state.table.x).toBeCloseTo(0, 1);
    expect(drivingPlayers(state).map((player) => player.id)).toEqual([1]);
    // Dropping the absent hand outright would move the board ten degrees in one
    // frame and throw the ball off the course.
    expect(biggestJump).toBeLessThan(1.5);
  });

  it('keeps their grip and their goals for when they come back', () => {
    const state = table('versus', 2);
    settle(state);
    run(state, 6, () => ({ x: -25, y: 0 }));
    const scorer = findPlayer(state, 1);
    expect(scorer?.goals).toBeGreaterThan(0);
    const goals = scorer?.goals ?? 0;
    const grip = scorer?.grip;

    syncPlayers(state, [
      { id: 1, present: false },
      { id: 2, present: true },
    ]);
    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
    ]);

    expect(findPlayer(state, 1)?.goals).toBe(goals);
    expect(findPlayer(state, 1)?.grip).toBe(grip);
  });

  it('keeps the hole belonging to the seat, not to a place in the roster', () => {
    // The relay hands a rejoining phone the lowest free slot, so a roster that
    // reshuffles used to move somebody else's goal under a new player's arrow.
    const state = table('versus', 2);
    settle(state);
    run(state, 1);
    const seats = state.seats;

    syncPlayers(state, [
      { id: 1, present: false },
      { id: 2, present: true },
      { id: 3, present: true },
    ]);
    run(state, 1, () => ({ x: 0, y: 0 }), 3000);
    expect(state.seats).toEqual(seats);
    expect(state.holes.filter((hole) => hole.seat !== null)).toHaveLength(2);
  });

  it('gives up on a round nobody is playing any more', () => {
    // Versus has no clock of its own; without this the last ball of an
    // abandoned match sits on the screen until somebody finds a keyboard.
    const state = table('versus', 2);
    settle(state);
    const events = run(state, ABANDON_SECONDS + 4, () => null);

    expect(state.phase).toBe('failed');
    expect(events).toContainEqual({ kind: 'failed', reason: 'abandoned' });
  });
});

describe('the tug of war', () => {
  it('pays the seat whose hole the ball fell into, and only that seat', () => {
    const state = table('versus', 2);
    settle(state);
    const events = run(state, 3, () => ({ x: -25, y: 0 }));

    const goals = events.filter((event) => event.kind === 'goal');
    expect(goals.length).toBeGreaterThan(0);
    expect(goals[0]).toEqual({ kind: 'goal', playerId: 1, goals: 1 });
    expect(findPlayer(state, 2)?.goals).toBe(0);
  });

  it('puts the ball back on the board after a goal instead of ending there', () => {
    const state = table('versus', 2);
    settle(state);
    // Checked at the moment of the goal rather than three seconds later: the
    // board is still tilted, so by then the ball has legitimately rolled off
    // again and the reset would be invisible.
    runUntil(
      state,
      () => ({ x: -25, y: 0 }),
      (events) => events.some((event) => event.kind === 'goal'),
    );
    expect(state.phase).toBe('play');
    // Back near the middle, not left sitting in the hole it just fell into.
    expect(state.ball.x).toBeGreaterThan(0.4);
  });

  it('counts to three and stops', () => {
    const state = table('versus', 2);
    settle(state);
    const events = run(state, 12, () => ({ x: -25, y: 0 }));

    expect(findPlayer(state, 1)?.goals).toBe(3);
    expect(state.phase).toBe('cleared');
    expect(state.winner).toBe(1);
    expect(events.filter((event) => event.kind === 'goal').map((event) => event.goals)).toEqual([
      1, 2, 3,
    ]);
    // Nothing keeps running once it is over.
    const after = run(state, 2, () => ({ x: -25, y: 0 }), 20_000);
    expect(after.filter((event) => event.kind === 'goal')).toHaveLength(0);
  });

  it('costs the ball and not the match when it falls in a trap', () => {
    const trap = courseWith([{ x: 0.6, y: 0.5, r: 0.06, kind: 'trap', seat: null }]);
    const state = table('versus', 2, { courses: [trap] });
    settle(state);
    const events = run(state, 4, () => ({ x: 25, y: 0 }));

    expect(events.some((event) => event.kind === 'trap')).toBe(true);
    expect(state.phase).toBe('play');
    expect(findPlayer(state, 1)?.goals).toBe(0);
  });
});

describe('a course being cleared or lost', () => {
  it('moves to the next course and remembers what the last one took', () => {
    const first = courseWith([{ x: 0.7, y: 0.5, r: 0.06, kind: 'goal', seat: null }], {
      key: 'one',
    });
    const second = courseWith([{ x: 0.7, y: 0.5, r: 0.06, kind: 'goal', seat: null }], {
      key: 'two',
    });
    const state = table('solo', 1, { courses: [first, second] });
    settle(state);

    // Stopped at the course change: both of these courses are cleared in well
    // under the four seconds the run used to take, so it went through the
    // second one too and the assertion below counted two.
    const events = runUntil(
      state,
      () => ({ x: 25, y: 0 }),
      (step) => step.some((event) => event.kind === 'course'),
    );
    expect(events).toContainEqual({ kind: 'course', index: 1 });
    expect(state.course.key).toBe('two');
    expect(state.courseTimes).toHaveLength(1);
    expect(state.courseTimes[0]).toBeGreaterThan(0);

    const rest = run(state, 4, () => ({ x: 25, y: 0 }), 6000);
    expect(state.phase).toBe('cleared');
    expect(rest).toContainEqual({ kind: 'cleared', winner: null });
  });

  it('ends the run in a trap', () => {
    const course = courseWith([{ x: 0.6, y: 0.5, r: 0.06, kind: 'trap', seat: null }]);
    const state = table('coop', 2, { courses: [course] });
    settle(state);
    const events = run(state, 4, () => ({ x: 25, y: 0 }));

    expect(state.phase).toBe('failed');
    expect(events).toContainEqual({ kind: 'failed', reason: 'trap' });
  });

  it('ends the run when the clock does', () => {
    const course = courseWith([], { seconds: 1.5 });
    const state = table('coop', 2, { courses: [course] });
    settle(state);
    const events = run(state, 3);

    expect(state.phase).toBe('failed');
    expect(events).toContainEqual({ kind: 'failed', reason: 'time' });
  });

  it('turns the same clock into the win when the course is a survival one', () => {
    // The variant is one flag, not a second rules module.
    const course = courseWith([], { seconds: 1.5, onTimeout: 'clear', shrinkPerSecond: 0.02 });
    const state = table('solo', 1, { courses: [course] });
    settle(state);
    const events = run(state, 3);

    expect(state.phase).toBe('cleared');
    expect(events).toContainEqual({ kind: 'cleared', winner: null });
    expect(state.bounds.minX).toBeGreaterThan(0);
  });

  it('hands out a medal by the time it took, or none at all', () => {
    const course = courseWith([], { medals: [10, 20, 30] });
    expect(medalFor(course, 9.5)).toBe('gold');
    expect(medalFor(course, 10)).toBe('gold');
    expect(medalFor(course, 10.1)).toBe('silver');
    expect(medalFor(course, 20)).toBe('silver');
    expect(medalFor(course, 29.9)).toBe('bronze');
    expect(medalFor(course, 30.1)).toBeNull();
    // A course nobody is racing has no medals to give.
    expect(medalFor(courseWith([]), 1)).toBeNull();
  });
});

describe('the tower coming down', () => {
  it('falls when the board is shoved, and names the hand that shoved it', () => {
    const state = table('coop', 2, { courses: [courseWith([])] });
    settle(state);
    // One player saws the board back and forth; the other holds it.
    const events = run(state, 2, (player, seconds) =>
      player.id === 2 ? { x: 0, y: 0 } : { x: 25 * Math.sin(seconds * 12), y: 0 },
    );

    const collapse = events.find((event) => event.kind === 'collapse');
    expect(collapse).toBeDefined();
    expect(collapse?.kind === 'collapse' && collapse.playerId).toBe(1);
    expect(state.collapses).toBeGreaterThan(0);
  });

  it('leaves a hard but steady lean alone', () => {
    const state = table('coop', 2, { courses: [courseWith([])] });
    settle(state);
    // All the way over to the clamp, taken two seconds to get there.
    const events = run(state, 3, (_player, seconds) => ({
      x: Math.min(25, seconds * 12),
      y: 0,
    }));

    expect(events.some((event) => event.kind === 'collapse')).toBe(false);
    expect(state.collapses).toBe(0);
  });

  it('is not the rule in any other mode', () => {
    expect(configFor('coop').collapseDegPerSecond).toBeGreaterThan(0);
    expect(configFor('solo').collapseDegPerSecond).toBe(0);
    expect(configFor('versus').collapseDegPerSecond).toBe(0);
    expect(configFor('practice').collapseDegPerSecond).toBe(0);
  });
});

describe('practice, where the numbers are the point', () => {
  it('reports each hand separately, in degrees', () => {
    const state = table('practice', 2);
    settle(state);
    run(state, 10, (player) => ({ x: player.id === 1 ? 0 : 5, y: 0 }));

    expect(wobbleRms(findPlayer(state, 1) ?? nobody())).toBeLessThan(0.5);
    expect(wobbleRms(findPlayer(state, 2) ?? nobody())).toBeCloseTo(5, 0);
  });

  it('reports the same number at 15 Hz as at 60', () => {
    // The frame rate is unknown and varies; a wobble that reads differently on
    // a slow machine is a measurement a player cannot use.
    const fast = table('practice');
    settle(fast);
    run(fast, 6, () => ({ x: 4, y: 0 }), 1000, 1 / 60);

    const slow = table('practice');
    settle(slow);
    run(slow, 6, () => ({ x: 4, y: 0 }), 1000, 1 / 15);

    const a = wobbleRms(fast.players[0] ?? nobody());
    const b = wobbleRms(slow.players[0] ?? nobody());
    expect(Math.abs(a - b)).toBeLessThan(0.2);
  });

  it('says how much of the drill the ball stayed in the ring', () => {
    const state = table('practice');
    settle(state);
    run(state, 6);
    expect(ringHold(state)).toBeGreaterThan(0.95);

    const leaning = table('practice');
    settle(leaning);
    run(leaning, 6, () => ({ x: 15, y: 0 }));
    expect(ringHold(leaning)).toBeLessThan(0.6);
  });

  it('has no clock and no way to lose', () => {
    const state = table('practice');
    settle(state);
    run(state, 30, () => ({ x: 20, y: 12 }));
    expect(state.phase).toBe('play');
    expect(configFor('practice').courses[0]?.seconds).toBe(0);
  });

  it('draws the arrows bigger than life, because a degree is invisible', () => {
    expect(configFor('practice').arrowGain).toBeGreaterThan(1);
    expect(configFor('practice').showNumbers).toBe(true);
    expect(configFor('solo').showNumbers).toBe(false);
  });
});

describe('the board itself', () => {
  it('rolls the ball the same distance whatever the frame rate', () => {
    const fast = table('solo', 1, { courses: [courseWith([], { start: { x: 0.5, y: 0.5 } })] });
    settle(fast);
    run(fast, 3, () => ({ x: 20, y: 0 }), 1000, 1 / 60);

    const slow = table('solo', 1, { courses: [courseWith([], { start: { x: 0.5, y: 0.5 } })] });
    settle(slow);
    run(slow, 3, () => ({ x: 20, y: 0 }), 1000, 1 / 15);

    expect(Math.abs(fast.ball.x - slow.ball.x)).toBeLessThan(0.02);
  });

  it('keeps the ball on the board', () => {
    const state = table('solo', 1, { courses: [courseWith([])] });
    settle(state);
    run(state, 6, () => ({ x: 25, y: 25 }));
    expect(state.ball.x).toBeLessThanOrEqual(1);
    expect(state.ball.y).toBeLessThanOrEqual(1);
    expect(state.ball.x).toBeGreaterThanOrEqual(0);
  });

  it('bounces the ball off a wall instead of letting it through', () => {
    const course = courseWith([], {
      start: { x: 0.2, y: 0.5 },
      walls: [{ x: 0.6, y: 0, w: 0.05, h: 1 }],
    });
    const state = table('solo', 1, { courses: [course] });
    settle(state);
    run(state, 4, () => ({ x: 25, y: 0 }));
    expect(state.ball.x).toBeLessThan(0.6);
  });

  it('does nothing at all when no phone is driving', () => {
    const state = table('practice');
    run(state, 1, () => null);
    expect(state.table.x).toBe(0);
    expect(state.ball.x).toBe(state.course.start.x);
    expect(Number.isFinite(state.ball.vx)).toBe(true);
  });
});

describe('replaying a match', () => {
  it('gives the same match twice from the same seed', () => {
    const played = (seed: number): { ball: string; goals: number[] } => {
      const state = table('versus', 2, {}, seed);
      settle(state);
      const events = run(state, 8, () => ({ x: -25, y: 0 }));
      return {
        ball: `${state.ball.x.toFixed(9)},${state.ball.y.toFixed(9)}`,
        goals: events.filter((event) => event.kind === 'goal').map((event) => event.goals),
      };
    };

    expect(played(42)).toEqual(played(42));
    // And the seed is doing something: the restart spot moves with it.
    expect(played(42).ball).not.toEqual(played(9001).ball);
  });
});

/** A stand-in so a lookup that cannot fail does not need a non-null assertion. */
function nobody(): TablePlayer {
  throw new Error('the player under test is missing from the roster');
}
