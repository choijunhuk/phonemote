import { describe, expect, it } from 'vitest';
import { rotateAbout } from '../../../input/pose.js';
import type { CanonicalVector } from '../../../input/types.js';
import {
  EDGE_FULL_DEG,
  MAX_SIM_STEPS,
  PRACTICE_GATE,
  PRACTICE_LANE,
  SOLO_RACE,
  STANDARD_SPEC,
  VERSUS_RACE,
  buildCourse,
  createSki,
  findRacer,
  ghostPositionAt,
  idealEdgeDeg,
  idealX,
  readPose,
  readStillness,
  recordedGhost,
  regrip,
  SIM_STEP,
  resultSeconds,
  skiConfigFor,
  standings,
  stepSki,
  syncRacers,
  type Gate,
  type SkiConfig,
  type SkiEvent,
  type SkiState,
} from '../skiState.js';

/**
 * The rules of Alpine Ski, driven at a frame rate we choose with a clock we
 * control.
 *
 * Every test steers by feeding the gravity vector a phone rolled that far from
 * its grip would report, which is the only input this game has.
 */

const FRAME = 1 / 60;

/** Held upright, screen towards the player: gravity-up is the phone's own +Y. */
const GRIP: CanonicalVector = { x: 0, y: 1, z: 0 };
/** The phone's aiming axis; rolling turns about this (types.ts 5.2). */
const FORWARD: CanonicalVector = { x: 0, y: 0, z: -1 };

/**
 * What a phone reports once it has been rolled this far from GRIP. Turning the
 * phone by R moves gravity in its own frame by R inverse, hence the negation.
 */
function rolled(deg: number): CanonicalVector {
  return rotateAbout(GRIP, FORWARD, -deg);
}

/** Degrees of roll to feed, or null for a phone that has stopped sending. */
type Plan = (racer: { readonly y: number; readonly id: number }, state: SkiState) => number | null;

const straight: Plan = () => 0;

/** A player who is exactly on the line the practice screen draws. */
function onTheLine(config: SkiConfig): Plan {
  return (racer) => idealEdgeDeg(config, racer.y);
}

function field(config: SkiConfig, ids: readonly number[] = [1]): SkiState {
  // Each test starts its own phone clock, so one test's elapsed time cannot
  // make the next one's first reading look stale.
  clockMs = 1000;
  const state = createSki(config);
  syncRacers(
    state,
    ids.map((id) => ({ id, present: true })),
  );
  return state;
}

/** Run frames until `until` says stop, or the cap is hit. */
/**
 * Shared across calls, because it is one phone's clock.
 *
 * Defaulting each call to the same start time rewound it, and a reading
 * timestamped before the previous one reads as fresher than fresh — so a test
 * that stopped sending poses to prove steering was lost proved the opposite.
 */
let clockMs = 1000;

function drive(
  state: SkiState,
  plan: Plan,
  seconds: number,
  startMs = clockMs,
  frame = FRAME,
): SkiEvent[] {
  const events: SkiEvent[] = [];
  const frames = Math.round(seconds / frame);
  for (let i = 0; i < frames; i++) {
    const now = startMs + i * frame * 1000;
    clockMs = now + frame * 1000;
    for (const racer of state.racers) {
      const deg = plan(racer, state);
      if (deg === null) continue;
      readPose(state, racer.id, rolled(deg), now);
      readStillness(state, racer.id, 500, false, now);
    }
    events.push(...stepSki(state, frame, now));
    if (state.phase === 'finish') break;
  }
  return events;
}

/** Grip everybody and get through the countdown. */
function begin(state: SkiState, startMs = clockMs): SkiEvent[] {
  const events = drive(state, straight, state.config.countdownSeconds + 1, startMs);
  expect(state.phase).toBe('run');
  return events;
}

/**
 * A short course with gates a racer running dead straight passes, misses and
 * clips exactly on the flag, so each verdict can be checked against a position
 * that is known rather than simulated.
 */
const TEST_GATES: readonly Gate[] = [
  { y: 20, x: 0, halfWidth: 4.5, side: 'right' },
  { y: 40, x: 6, halfWidth: 4.5, side: 'right' },
  { y: 60, x: 4.5, halfWidth: 4.5, side: 'right' },
];

function testConfig(overrides: Partial<SkiConfig> = {}): SkiConfig {
  return {
    ...SOLO_RACE,
    gates: TEST_GATES,
    courseLength: 100,
    ghostEnabled: false,
    ...overrides,
  };
}

describe('taking a grip', () => {
  it('waits for the hand to settle before adopting one', () => {
    const state = field(SOLO_RACE);
    for (let i = 0; i < 10; i++) {
      readPose(state, 1, GRIP, i * 16);
      readStillness(state, 1, 120, false, i * 16);
      stepSki(state, FRAME, i * 16);
    }
    expect(findRacer(state, 1)?.grip).toBeNull();

    readStillness(state, 1, 450, false, 200);
    const events = stepSki(state, FRAME, 200);
    expect(events.some((event) => event.kind === 'grip')).toBe(true);
    expect(findRacer(state, 1)?.grip).not.toBeNull();
  });

  it('starts anyway for a player who never holds still', () => {
    // Nobody should be stuck on a start line because their hand shook.
    const state = field(SOLO_RACE);
    drive(state, () => 12, SOLO_RACE.autoStartSeconds + SOLO_RACE.countdownSeconds + 1);
    expect(state.phase).toBe('run');
    expect(findRacer(state, 1)?.grip).not.toBeNull();
  });

  it('measures every angle from the grip the player chose, not from upright', () => {
    // A player holding the phone rolled 30 degrees over is not turning.
    const state = field(SOLO_RACE);
    drive(state, () => 30, SOLO_RACE.countdownSeconds + 1);
    const racer = findRacer(state, 1);
    expect(racer?.edgeDeg ?? 99).toBeCloseTo(0, 3);
    expect(racer?.x ?? 99).toBeCloseTo(0, 6);
  });
});

describe('the scoring rule', () => {
  it('charges two seconds a gate, so the fastest run is not always the winner', () => {
    const state = field(testConfig(), [1, 2]);
    begin(state);
    // P1 runs straight and skips the gate that is set out to the right; P2
    // holds a gentle edge, passes everything, and pays for it in speed.
    drive(state, (racer) => (racer.id === 1 ? 0 : 8), 30);

    const first = findRacer(state, 1);
    const second = findRacer(state, 2);
    if (!first || !second) throw new Error('nobody raced');

    expect(first.missed).toBe(1);
    expect(second.missed).toBe(0);
    expect(first.penaltySeconds).toBe(2);
    expect(second.penaltySeconds).toBe(0);

    // Faster on the clock, beaten on the result.
    expect(first.finishSeconds ?? 99).toBeLessThan(second.finishSeconds ?? 0);
    expect(resultSeconds(first) ?? 0).toBe((first.finishSeconds ?? 0) + 2);
    expect(resultSeconds(first) ?? 0).toBeGreaterThan(resultSeconds(second) ?? 99);
    expect(standings(state)[0]?.id).toBe(2);
  });

  it('counts a flag clipped exactly on the line as through', () => {
    const state = field(testConfig());
    begin(state);
    drive(state, straight, 30);

    const racer = findRacer(state, 1);
    // Gate 0 dead centre, gate 1 missed by 1.5 m, gate 2 exactly on the flag.
    expect(racer?.gateResults.map((gate) => gate.passed)).toEqual([true, false, true]);
    expect(racer?.gateResults[2]?.offBy ?? 0).toBeCloseTo(-4.5, 6);
    expect(racer?.gateResults[1]?.offBy ?? 0).toBeCloseTo(-6, 6);
  });

  it('judges the crossing at the gate line, not wherever the step ended', () => {
    // Same course, same steering, four times the step size. A verdict that
    // depended on where the frames happened to fall would drift by a fifth of a
    // metre a step and would eventually change one of these answers.
    const fast = field(testConfig());
    begin(fast);
    drive(fast, straight, 30, 1000, FRAME);
    const slow = field(testConfig());
    begin(slow, 0);
    drive(slow, straight, 30, 1000, 1 / 15);

    const a = findRacer(fast, 1)?.gateResults ?? [];
    const b = findRacer(slow, 1)?.gateResults ?? [];
    expect(a.map((gate) => gate.passed)).toEqual(b.map((gate) => gate.passed));
    for (let i = 0; i < a.length; i++) {
      expect(a[i]?.offBy ?? 0).toBeCloseTo(b[i]?.offBy ?? 99, 6);
    }
  });

  it('ranks a racer who never finished behind everyone who did', () => {
    const state = field(testConfig({ courseLength: 400 }), [1, 2]);
    begin(state);
    // P2 puts the phone down after five seconds and is retired ten seconds later.
    drive(state, (racer) => (racer.id === 1 ? 0 : 0), 5);
    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    drive(state, (racer) => (racer.id === 1 ? 0 : null), 60);

    const order = standings(state);
    expect(order[0]?.id).toBe(1);
    expect(resultSeconds(order[1] ?? order[0] ?? findRacer(state, 2)!)).toBeNull();
  });
});

describe('the practice screens', () => {
  it('asks for an edge angle that actually holds the line', () => {
    // The number the carving drill puts on screen is only worth showing if a
    // player who matches it goes where the line goes.
    const config = testConfig({ gates: SOLO_RACE.gates, courseLength: SOLO_RACE.courseLength });
    const state = field(config);
    begin(state);
    drive(state, onTheLine(config), 90);

    const racer = findRacer(state, 1);
    expect(racer?.finished).toBe(true);
    expect(racer?.missed).toBe(0);
    for (const gate of racer?.gateResults ?? []) {
      expect(Math.abs(gate.offBy)).toBeLessThan(1);
    }
  });

  it('never asks for more edge than a player has', () => {
    for (let y = 0; y <= SOLO_RACE.courseLength; y += 3) {
      expect(Math.abs(idealEdgeDeg(SOLO_RACE, y))).toBeLessThanOrEqual(EDGE_FULL_DEG);
      // The steepest part of the standard course, measured: 0.65 of full edge.
      expect(Math.abs(idealEdgeDeg(SOLO_RACE, y))).toBeLessThan(0.7 * EDGE_FULL_DEG);
    }
  });

  it('draws the line through the middle of every gate', () => {
    for (const gate of SOLO_RACE.gates) {
      expect(idealX(SOLO_RACE, gate.y)).toBeCloseTo(gate.x, 6);
    }
  });

  it('fails nobody in the carving lane and charges nothing in the gate drill', () => {
    const lane = field(PRACTICE_LANE);
    begin(lane);
    drive(lane, straight, 90);
    expect(findRacer(lane, 1)?.gateResults).toEqual([]);
    expect(findRacer(lane, 1)?.penaltySeconds).toBe(0);

    const drill = field(PRACTICE_GATE);
    begin(drill);
    drive(drill, straight, 120);
    const racer = findRacer(drill, 1);
    // The same turn, over and over: missed gates are counted and shown, and
    // cost nothing, because a drill that fines you is a race.
    expect(racer?.missed ?? 0).toBeGreaterThan(0);
    expect(racer?.penaltySeconds).toBe(0);
  });

  it('is the same game in practice as in a race, only scored differently', () => {
    expect(skiConfigFor('practice', 'lane')).toBe(PRACTICE_LANE);
    expect(skiConfigFor('practice', 'gate')).toBe(PRACTICE_GATE);
    expect(skiConfigFor('solo')).toBe(SOLO_RACE);
    expect(skiConfigFor('versus')).toBe(VERSUS_RACE);
    // An unrecognised mode lands somewhere that cannot fail a player.
    expect(skiConfigFor('coop').judgeGates).toBe(false);
    expect(PRACTICE_LANE.gates).toBe(SOLO_RACE.gates);
  });
});

describe('a grip that slipped', () => {
  /** Wide enough that the drift is visible before the piste edge stops it. */
  const WIDE = testConfig({ laneHalfWidth: 400, courseLength: 4000, gates: [] });

  it('says so, instead of pushing the racer sideways in silence', () => {
    // The failure mode the design names: the phone is re-seated in the hand,
    // every reading is now measured from a zero that has moved, and the racer
    // slides one way with nothing on screen explaining it.
    const state = field(WIDE);
    begin(state);
    const events = drive(state, () => 20, 6);

    const racer = findRacer(state, 1);
    expect(racer?.driftWarning).toBe(true);
    expect(events.some((event) => event.kind === 'drift')).toBe(true);
    expect(racer?.x ?? 0).toBeGreaterThan(10);
  });

  it('is fixed by re-zeroing, without ending the run', () => {
    const state = field(WIDE);
    begin(state);
    drive(state, () => 20, 6);

    // A is the re-zero: HOME belongs to the lobby in every game.
    expect(regrip(state, 1, 9000)).toBe(true);
    const racer = findRacer(state, 1);
    expect(racer?.driftWarning).toBe(false);

    const before = racer?.x ?? 0;
    drive(state, () => 20, 3, 9000);
    expect(racer?.edgeDeg ?? 99).toBeCloseTo(0, 3);
    expect(Math.abs((racer?.x ?? 0) - before)).toBeLessThan(0.5);
    expect(state.phase).toBe('run');
  });

  it('does not cry drift at somebody who is simply turning', () => {
    // A turn comes back through neutral; a slipped grip never does.
    const state = field(WIDE);
    begin(state);
    let flips = 0;
    drive(
      state,
      (racer) => {
        flips = Math.floor(racer.y / 40);
        return flips % 2 === 0 ? 30 : -30;
      },
      12,
    );
    expect(findRacer(state, 1)?.driftWarning).toBe(false);
  });
});

describe('a phone that drops out mid-run', () => {
  it('costs steering, not score', () => {
    const state = field(testConfig({ courseLength: 400 }));
    begin(state);
    drive(state, straight, 3);
    const before = findRacer(state, 1);
    const penalty = before?.penaltySeconds ?? 0;
    expect(before?.gateResults.length ?? 0).toBeGreaterThan(0);

    syncRacers(state, [{ id: 1, present: false }]);
    drive(state, () => null, 4);

    const racer = findRacer(state, 1);
    expect(racer?.steering).toBe(false);
    expect(racer?.penaltySeconds).toBe(penalty);
    expect(racer?.grip).not.toBeNull();
    // Gates that went by while the phone was away are recorded and not charged.
    for (const gate of racer?.gateResults ?? []) {
      if (gate.offline) expect(gate.passed).toBe(false);
    }
    expect(racer?.penaltySeconds).toBe(penalty);
  });

  it('keeps the last edge rather than snapping the racer straight', () => {
    const state = field(testConfig({ laneHalfWidth: 400, courseLength: 4000, gates: [] }));
    begin(state);
    drive(state, () => 25, 2);
    const moving = findRacer(state, 1);
    const edge = moving?.edge ?? 0;
    expect(edge).toBeGreaterThan(0.5);

    drive(state, () => null, 1.5);
    // A stall is 200 ms of lost steering, not a turn the player never made.
    expect(findRacer(state, 1)?.edge).toBe(edge);
    expect(findRacer(state, 1)?.steering).toBe(false);
  });

  it('waits out a hiccup and retires a phone that stays away', () => {
    const state = field(testConfig({ courseLength: 4000, gates: [] }));
    begin(state);
    syncRacers(state, [{ id: 1, present: false }]);

    // Two seconds of silence, the outage that used to knock a player out (D48).
    drive(state, () => null, 2);
    expect(findRacer(state, 1)?.dnf).toBe(false);
    expect(state.phase).toBe('run');

    const events = drive(state, () => null, 12);
    expect(findRacer(state, 1)?.dnf).toBe(true);
    expect(events.some((event) => event.kind === 'retired')).toBe(true);
    expect(state.phase).toBe('finish');
  });

  it('lets the rest of the field race on', () => {
    const state = field(testConfig(), [1, 2]);
    begin(state);
    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    drive(state, (racer) => (racer.id === 1 ? 0 : null), 30);

    expect(findRacer(state, 1)?.finished).toBe(true);
    expect(findRacer(state, 1)?.missed).toBe(1);
    expect(state.phase).toBe('finish');
  });

  it('gives a rejoining phone back its own run', () => {
    const state = field(testConfig({ courseLength: 400 }));
    begin(state);
    drive(state, straight, 3);
    const distance = findRacer(state, 1)?.y ?? 0;
    const gates = findRacer(state, 1)?.gateResults.length ?? 0;

    syncRacers(state, [{ id: 1, present: false }]);
    syncRacers(state, [{ id: 1, present: true }]);
    const racer = findRacer(state, 1);
    expect(racer?.y).toBe(distance);
    expect(racer?.gateResults.length).toBe(gates);
    expect(racer?.grip).not.toBeNull();
    expect(racer?.dnf).toBe(false);
  });
});

describe('the end of a run', () => {
  it('ends by itself when everybody is down', () => {
    const state = field(testConfig(), [1, 2]);
    begin(state);
    const events = drive(state, straight, 30);

    expect(state.phase).toBe('finish');
    expect(events.filter((event) => event.kind === 'finish')).toHaveLength(2);
    expect(events.some((event) => event.kind === 'over')).toBe(true);
  });

  it('ends by itself when nobody can finish', () => {
    // A phone stalled on a full edge bleeds speed to the floor and would
    // otherwise sit on the hill forever.
    const state = field(testConfig({ courseLength: 4000, gates: [], timeLimitSeconds: 20 }));
    begin(state);
    const events = drive(state, () => 60, 40);

    expect(state.t).toBeGreaterThanOrEqual(20);
    expect(state.phase).toBe('finish');
    expect(findRacer(state, 1)?.dnf).toBe(true);
    expect(events.some((event) => event.kind === 'over')).toBe(true);
  });

  it('stops the clock at the finish line rather than at the end of a frame', () => {
    const state = field(testConfig());
    begin(state);
    drive(state, straight, 30);
    const racer = findRacer(state, 1);
    expect(racer?.y).toBe(100);
    expect(racer?.finishSeconds ?? 0).toBeGreaterThan(0);
    expect(racer?.finishSeconds ?? 0).toBeLessThan(state.t);
  });
});

describe('the ghost', () => {
  it('replays the run that was recorded, and stops when it ended', () => {
    const state = field(SOLO_RACE);
    begin(state);
    drive(state, onTheLine(SOLO_RACE), 90);

    const ghost = recordedGhost(state, 1);
    if (!ghost) throw new Error('no ghost recorded');
    expect(ghost.seconds).toBe(findRacer(state, 1)?.finishSeconds);

    const early = ghostPositionAt(ghost, 5);
    const late = ghostPositionAt(ghost, ghost.seconds - 1);
    expect(early?.y ?? 0).toBeLessThan(late?.y ?? 0);
    expect(ghostPositionAt(ghost, ghost.seconds + 5)).toBeNull();
  });

  it('runs alongside the second attempt rather than being drawn from nothing', () => {
    const first = field(SOLO_RACE);
    begin(first);
    drive(first, onTheLine(SOLO_RACE), 90);
    const ghost = recordedGhost(first, 1);
    if (!ghost) throw new Error('no ghost recorded');

    const second = createSki(SOLO_RACE, ghost);
    syncRacers(second, [{ id: 1, present: true }]);
    begin(second);
    drive(second, onTheLine(SOLO_RACE), 5);
    expect(second.ghostPos).not.toBeNull();
    // Alongside, not identical. The two runs step their fixed-step simulation
    // on different frame boundaries, so the same driving lands the ghost within
    // a fraction of a second of the racer rather than exactly on them — which
    // is all this is for: something to chase that is visibly where you were.
    const gap = Math.abs((second.ghostPos?.y ?? 0) - (findRacer(second, 1)?.y ?? 0));
    expect(gap).toBeLessThan(1.5);
  });
});

describe('determinism', () => {
  it('lays out the same course for the same seed, and a different one otherwise', () => {
    expect(buildCourse(STANDARD_SPEC)).toEqual(buildCourse({ ...STANDARD_SPEC }));
    expect(buildCourse({ ...STANDARD_SPEC, seed: 2 })).not.toEqual(buildCourse(STANDARD_SPEC));
    // Whatever the seed, the course still has to be skiable.
    for (const seed of [0, 1, 2, 3, 77]) {
      const gates = buildCourse({ ...STANDARD_SPEC, seed });
      const config = { ...SOLO_RACE, gates };
      for (const gate of gates) {
        expect(Math.abs(idealEdgeDeg(config, gate.y))).toBeLessThanOrEqual(EDGE_FULL_DEG);
      }
    }
  });

  it('gives the same run the same time, to the microsecond', () => {
    const once = field(testConfig());
    begin(once);
    drive(once, onTheLine(testConfig()), 30);
    const twice = field(testConfig());
    begin(twice);
    drive(twice, onTheLine(testConfig()), 30);

    expect(findRacer(twice, 1)?.finishSeconds).toBe(findRacer(once, 1)?.finishSeconds);
    expect(findRacer(twice, 1)?.penaltySeconds).toBe(findRacer(once, 1)?.penaltySeconds);
    expect(findRacer(twice, 1)?.x).toBe(findRacer(once, 1)?.x);
  });

  it('finishes in the same time at 15 Hz as at 100', () => {
    // The frame rate is unknown and varies. A constant edge isolates the
    // integrator from the sampling: the two runs are the same run.
    const slow = field(testConfig({ gates: [] }));
    begin(slow, 0);
    drive(slow, () => 15, 40, 1000, 1 / 15);
    const fast = field(testConfig({ gates: [] }));
    begin(fast, 0);
    drive(fast, () => 15, 40, 1000, 1 / 100);

    const a = findRacer(slow, 1)?.finishSeconds ?? 0;
    const b = findRacer(fast, 1)?.finishSeconds ?? 0;
    expect(a).toBeGreaterThan(0);
    expect(Math.abs(a - b)).toBeLessThan(0.02);
    expect(Math.abs((findRacer(slow, 1)?.x ?? 0) - (findRacer(fast, 1)?.x ?? 0))).toBeLessThan(0.2);
  });

  it('drops a frame it cannot simulate instead of teleporting through gates', () => {
    // A backgrounded tab hands back a ten-second delta. Simulating it whole
    // would fly the racer down the course and judge gates nobody skied.
    const state = field(testConfig());
    begin(state);
    for (const racer of state.racers) readPose(state, racer.id, rolled(0), clockMs);
    const before = state.t;
    stepSki(state, 10, clockMs);

    const racer = findRacer(state, 1);
    // What it may simulate is the step budget, not the delta it was handed.
    expect(state.t - before).toBeLessThanOrEqual(MAX_SIM_STEPS * SIM_STEP + 1e-9);
    expect(racer?.gateResults.length ?? 99).toBe(0);
  });
});
