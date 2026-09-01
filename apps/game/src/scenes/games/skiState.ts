import { captureGrip, gripQuality, signedRoll } from '../../input/grip.js';
import type { Grip } from '../../input/grip.js';
import type { CanonicalVector } from '../../input/types.js';

/**
 * Alpine Ski rules, with no Phaser in sight (ARCHITECTURE.md 8).
 *
 * The only signal is gravity, read continuously. `signedRoll` against the grip
 * this player chose is the edge angle, and its rate of change is the turn.
 * Nothing here detects an event, so nothing here can fail to detect one: a
 * 200 ms wifi stall costs 200 ms of steering, which the racer can watch happen
 * and correct, rather than an input the game silently never counted.
 *
 * Two lines carry the whole sport, and they are in `simulate`: the edge steers
 * in proportion to speed, and the edge also costs speed. Carve hard and you
 * turn but arrive slow; run straight and you arrive fast but wide of the gate.
 *
 * Two deliberate departures from the design note:
 *
 * - The design puts re-zeroing on HOME. HOME is the way back to the lobby in
 *   every game (BaseGameScene), and a player holding a phone across a room
 *   cannot be asked to remember that one game means something else by it. A is
 *   the re-zero here; `regrip` is what the scene calls.
 * - The design describes a gate as a pole with a required side plus a width,
 *   and counts "wrong side" and "outside the width" as two failures. A real
 *   slalom gate is two flags, so both are one test: the crossing is inside the
 *   corridor or it is not. `side` survives as the direction the course turns
 *   there, which is what the arrow on screen and the one-gate drill need.
 */

export type SkiPhase = 'ready' | 'run' | 'finish';
export type SkiSide = 'left' | 'right';
/** Practice is two drills, told apart by data rather than by a branch. */
export type SkiDrill = 'lane' | 'gate';

export interface Gate {
  /** Distance down the hill, metres. Gates are ordered by this. */
  readonly y: number;
  /** Middle of the corridor, metres across the slope, + is right. */
  readonly x: number;
  /** Half the gap between the flags. */
  readonly halfWidth: number;
  /** Which way the course turns here. Drawn; never judged. */
  readonly side: SkiSide;
}

export interface SkiConfig {
  /** Shown as the name of this drill or race. */
  readonly label: string;
  readonly gates: readonly Gate[];
  /** Where the finish line sits, metres down the hill. */
  readonly courseLength: number;
  /** Half the width of the piste; a racer cannot leave it. */
  readonly laneHalfWidth: number;
  /** False in the carving drill, where the gates only define the line. */
  readonly judgeGates: boolean;
  /** Seconds added per missed gate. 0 in practice, where nothing is scored. */
  readonly penaltySeconds: number;
  /** Whether the clock is the score. Practice runs without one. */
  readonly timed: boolean;
  /** Whether a recorded run is replayed alongside. */
  readonly ghostEnabled: boolean;
  /** Whether the screen draws the line and the edge angle it asks for. */
  readonly showsLine: boolean;
  readonly countdownSeconds: number;
  /** Stillness needed before a grip is taken, per the design note. */
  readonly gripStillMs: number;
  /** Nobody waits on the start line forever because a phone never went still. */
  readonly autoStartSeconds: number;
  /** A run that cannot end on its own is a dead screen (requirement 3). */
  readonly timeLimitSeconds: number;
  /** How long a phone may be gone before its racer is retired from the run. */
  readonly absentGraceSeconds: number;
}

export interface GhostSample {
  readonly x: number;
  readonly y: number;
}

export interface GhostRun {
  readonly samples: readonly GhostSample[];
  /** Samples per second; fixed, so a replay does not depend on frame rate. */
  readonly hz: number;
  readonly seconds: number;
}

export interface GateResult {
  readonly index: number;
  readonly passed: boolean;
  /** Metres from the middle of the corridor at the crossing, signed. */
  readonly offBy: number;
  /** True when the gate went by while this phone was not steering. */
  readonly offline: boolean;
}

export interface Racer {
  readonly id: number;
  /** False while this phone is not answering. Kept, not deleted (D48). */
  present: boolean;
  grip: Grip | null;
  /** Recent gravity readings, averaged into a grip on demand. */
  recent: CanonicalVector[];
  lastPoseAt: number;
  /** What the input layer last said about this phone having stopped. */
  stalledReport: boolean;
  steadyMs: number;
  /** Whether this racer is being steered right now. */
  steering: boolean;
  /** Roll away from the grip, in degrees. The number practice shows. */
  edgeDeg: number;
  /** The same thing as -1..1, which is what the physics uses. */
  edge: number;
  /** How much roll this grip leaves readable, 0 to 1. */
  gripPower: number;
  x: number;
  y: number;
  speed: number;
  nextGate: number;
  missed: number;
  penaltySeconds: number;
  finished: boolean;
  /** Retired without finishing: the time ran out, or the phone stayed away. */
  dnf: boolean;
  finishSeconds: number | null;
  /** Seconds the edge has sat on one side without ever coming back. */
  biasSeconds: number;
  /** The grip has slipped, and the racer is being pushed one way. */
  driftWarning: boolean;
  /** Which side the edge has been held on, for the slipped-grip alarm. */
  biasSign: number;
  absentSeconds: number;
  gateResults: GateResult[];
  trail: GhostSample[];
}

export interface SkiState {
  readonly config: SkiConfig;
  phase: SkiPhase;
  /** Seconds of simulated run time. The clock, and in timed modes the score. */
  t: number;
  countdown: number;
  readyFor: number;
  racers: Racer[];
  ghost: GhostRun | null;
  ghostPos: GhostSample | null;
  /** Left over from the last frame, carried into the next fixed step. */
  accumulator: number;
  /** Fixed steps run so far, which is what the ghost recorder counts. */
  ticks: number;
}

export type SkiEvent =
  | { readonly kind: 'grip'; readonly playerId: number; readonly power: number }
  | { readonly kind: 'start' }
  | {
      readonly kind: 'gate';
      readonly playerId: number;
      readonly index: number;
      readonly passed: boolean;
      /** Seconds this gate actually cost, which is 0 in practice. */
      readonly penalty: number;
    }
  | { readonly kind: 'steering'; readonly playerId: number; readonly lost: boolean }
  | { readonly kind: 'drift'; readonly playerId: number; readonly edgeDeg: number }
  | {
      readonly kind: 'finish';
      readonly playerId: number;
      readonly seconds: number;
      readonly penaltySeconds: number;
    }
  | { readonly kind: 'retired'; readonly playerId: number }
  | { readonly kind: 'over' };

/**
 * Roll, in degrees, that counts as everything this player has.
 *
 * The design note's figure. It is also about the largest roll a hand will hold
 * through a whole run: the standing risk in this game is range of motion rather
 * than precision, so full deflection has to sit inside what an arm will still
 * be doing forty seconds in.
 */
export const EDGE_FULL_DEG = 45;

/** Slope of the piste; only its gravity component is ever used. */
const SLOPE_DEG = 20;
/** 9.81 sin 20, m/s^2: what pulls a racer down the hill. */
const GRAVITY_ALONG = 9.81 * Math.sin((SLOPE_DEG * Math.PI) / 180);

/**
 * How much of the speed a full edge turns sideways.
 *
 * Set from the course rather than by feel. The line through the standard gates
 * needs dx/dy of 0.52 at its steepest, so this decides the roll that line asks
 * for: at 0.8 it is 0.65 of full edge, about 29 degrees. At the 0.55 tried
 * first it came out at 0.95 — the ideal line demanded a near-maximum edge at
 * every gate, which leaves a player nothing in hand for a turn entered late.
 */
export const CARVE = 0.8;

/**
 * How far across the fall line a full edge points the skis, in degrees.
 *
 * Half of gravity reaches a racer standing fully on edge (cos 60), which is the
 * "carve hard, arrive slow" half of the sport.
 */
const CARVE_ANGLE_DEG = 60;

/** Air drag. Straight running settles at sqrt(GRAVITY_ALONG / DRAG) = 21.9 m/s. */
const DRAG = 0.007;

/**
 * What a full edge costs, m/s^2.
 *
 * Half an edge still cruises: 3.36 cos 24 - 0.9 leaves 2.0, which balances drag
 * at 16.9 m/s. A full edge never balances, so a racer leaning on one bleeds
 * speed for as long as they hold it. That is the trade the game is.
 */
const EDGE_DRAG = 1.8;

/**
 * Speed a racer cannot fall below, m/s.
 *
 * A slope keeps feeding gravity in, so skis pointing downhill do not stop. It
 * also matters when a phone stalls with the edge frozen hard over: without it
 * that racer decelerates towards zero and their run has no way to end.
 */
const MIN_SPEED = 3;

/**
 * The physics step, seconds.
 *
 * The frame rate is unknown and varies (ARCHITECTURE.md 5): the same input has
 * to produce the same finish time at 15 Hz as at 100. Everything below runs at
 * this rate and the leftover is carried, never scaled.
 */
export const SIM_STEP = 1 / 120;

/**
 * Fixed steps a single frame may run.
 *
 * BaseGameScene already clamps its delta to 1/30, which is four of these, so
 * this only bites on a tab that was backgrounded. Simulating that whole gap
 * would fly a racer through a row of gates nobody skied, so the excess is
 * dropped, and the clock — which counts only steps actually run — drops with it.
 */
export const MAX_SIM_STEPS = 8;

/**
 * A pose reading older than this is not steering.
 *
 * The figure freezeState uses, for the same reason: at any plausible send rate
 * it is several frames of silence rather than one late frame.
 */
const POSE_FRESH_MS = 300;

/** Ghost sample rate, Hz. 20 is the poll rate the recordings were taken at. */
const GHOST_HZ = 20;
const GHOST_EVERY = Math.round(1 / (GHOST_HZ * SIM_STEP));

/** Readings kept for a grip: half a second at any rate that matters. */
const GRIP_SAMPLES = 24;

/**
 * The drift alarm. An edge this far over, held this long without once coming
 * back through neutral, is a grip that has slipped rather than a turn.
 *
 * The design names this the failure mode of the game: a player who re-seats the
 * phone in their hand and is then pushed steadily to one side with nothing on
 * screen saying why. No real turn holds 16 degrees of edge for four seconds —
 * the standard course turns every 42 m, under three seconds at racing speed, so
 * a bias outlasting a whole gate interval is not being skied.
 */
const DRIFT_EDGE = 0.35;
const DRIFT_SECONDS = 4;
/** Where the alarm lets go: near enough to neutral to be a real release. */
const DRIFT_RELEASE = 0.15;

/** Below this a grip has almost no roll left in it — grip.ts calls it flat. */
export const POOR_GRIP = 0.35;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Deterministic per-gate variation, standing in for a random number generator.
 *
 * A course has to be identical every time it is played or no two runs can be
 * compared, and no rule here may call Math.random (requirement 4). A hash of
 * the seed and the gate index gives variety between courses and none within one.
 */
function hashUnit(seed: number, index: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface CourseSpec {
  readonly seed: number;
  readonly gates: number;
  /** Metres between gates down the hill. */
  readonly spacing: number;
  /** How far a gate sits from the middle of the piste. */
  readonly amplitude: number;
  readonly halfWidth: number;
  /** Run-in before the first gate, so nobody is judged from a standing start. */
  readonly startY: number;
  /** Run-out after the last one. */
  readonly runOut: number;
}

export const STANDARD_SPEC: CourseSpec = {
  seed: 1,
  gates: 16,
  spacing: 42,
  amplitude: 7,
  halfWidth: 4.5,
  startY: 45,
  runOut: 55,
};

/**
 * Lay out a course, alternating sides down the hill.
 *
 * The variation is deliberately narrow: spacing within a tenth, amplitude
 * between 0.7 and 1.05 of nominal. The worst pair those allow needs dx/dy of
 * 0.61, which is 0.76 of full edge — hard, and still inside what a hand holds.
 * Widening either bound produces a course that cannot be skied cleanly at all,
 * which reads to a player as the game being broken rather than as a hard course.
 */
export function buildCourse(spec: CourseSpec): readonly Gate[] {
  const gates: Gate[] = [];
  let y = spec.startY;
  for (let index = 0; index < spec.gates; index++) {
    const amplitude = spec.amplitude * (0.7 + 0.35 * hashUnit(spec.seed, index));
    const x = index % 2 === 0 ? amplitude : -amplitude;
    gates.push({ y, x, halfWidth: spec.halfWidth, side: x >= 0 ? 'right' : 'left' });
    y += spec.spacing * (0.9 + 0.2 * hashUnit(spec.seed, index + 500));
  }
  return Object.freeze(gates);
}

export function courseLengthFor(spec: CourseSpec, gates: readonly Gate[]): number {
  const last = gates[gates.length - 1];
  return (last?.y ?? spec.startY) + spec.runOut;
}

const STANDARD_GATES = buildCourse(STANDARD_SPEC);
const STANDARD_LENGTH = courseLengthFor(STANDARD_SPEC, STANDARD_GATES);

/**
 * One gate, over and over, so the same turn can be practised without paying for
 * it with the rest of the run.
 */
function repeatedGate(count: number): readonly Gate[] {
  const gates: Gate[] = [];
  for (let index = 0; index < count; index++) {
    const x = index % 2 === 0 ? STANDARD_SPEC.amplitude : -STANDARD_SPEC.amplitude;
    gates.push({
      y: STANDARD_SPEC.startY + index * STANDARD_SPEC.spacing,
      x,
      halfWidth: STANDARD_SPEC.halfWidth,
      side: x >= 0 ? 'right' : 'left',
    });
  }
  return Object.freeze(gates);
}

const GATE_DRILL_GATES = repeatedGate(20);

const SHARED = {
  laneHalfWidth: 16,
  countdownSeconds: 3,
  // The design note's figure. A hand trying to hold still reads 3.3 deg/s
  // (ARCHITECTURE.md 5), so 400 ms of it is something a player can actually do.
  gripStillMs: 400,
  autoStartSeconds: 8,
  // Ten seconds is five times the two-second outage that used to knock a player
  // out of Freeze Frame (D48), and short enough that a phone left in a pocket
  // cannot hold the finish screen hostage.
  absentGraceSeconds: 10,
} as const;

/**
 * The carving drill: no gates to fail, no clock, just the line and the edge
 * angle it asks for. The gates are still here because they are what defines the
 * line — practising a line other than the one the race uses teaches the wrong
 * turn — but nothing judges a crossing.
 */
export const PRACTICE_LANE: SkiConfig = {
  ...SHARED,
  label: '카빙 레인',
  gates: STANDARD_GATES,
  courseLength: STANDARD_LENGTH,
  judgeGates: false,
  penaltySeconds: 0,
  timed: false,
  ghostEnabled: false,
  showsLine: true,
  laneHalfWidth: 22,
  timeLimitSeconds: 180,
};

/** The same turn twenty times. Missed gates are counted and shown, never charged. */
export const PRACTICE_GATE: SkiConfig = {
  ...SHARED,
  label: '한 게이트씩',
  gates: GATE_DRILL_GATES,
  courseLength: STANDARD_SPEC.startY + 20 * STANDARD_SPEC.spacing,
  judgeGates: true,
  // A drill that fines you is a race.
  penaltySeconds: 0,
  timed: false,
  ghostEnabled: false,
  showsLine: true,
  timeLimitSeconds: 180,
};

export const SOLO_RACE: SkiConfig = {
  ...SHARED,
  label: '타임 트라이얼',
  gates: STANDARD_GATES,
  courseLength: STANDARD_LENGTH,
  judgeGates: true,
  penaltySeconds: 2,
  timed: true,
  ghostEnabled: true,
  showsLine: false,
  timeLimitSeconds: 120,
};

/**
 * Four racers on one course with no contact and no shared physics. The only
 * thing they share is the clock, which is what makes running them at the same
 * time safe.
 */
export const VERSUS_RACE: SkiConfig = {
  ...SOLO_RACE,
  label: '대전',
  ghostEnabled: false,
};

/**
 * Every mode as data. Practice differs from a race by these fields and nothing
 * else, so no scene has to ask which mode it is in to know what to draw.
 */
export function skiConfigFor(mode: string, drill: SkiDrill = 'lane'): SkiConfig {
  if (mode === 'solo') return SOLO_RACE;
  if (mode === 'versus') return VERSUS_RACE;
  // Anything unrecognised lands in the drill that cannot fail anybody.
  return drill === 'gate' ? PRACTICE_GATE : PRACTICE_LANE;
}

export function createSki(config: SkiConfig, ghost: GhostRun | null = null): SkiState {
  return {
    config,
    phase: 'ready',
    t: 0,
    countdown: config.countdownSeconds,
    readyFor: 0,
    racers: [],
    ghost: config.ghostEnabled ? ghost : null,
    ghostPos: null,
    accumulator: 0,
    ticks: 0,
  };
}

export function findRacer(state: SkiState, id: number): Racer | undefined {
  return state.racers.find((racer) => racer.id === id);
}

/**
 * Bring the field in line with who is connected.
 *
 * Everybody already racing keeps their record — grip, gates, penalties,
 * distance. A phone that drops and comes back finds its own run still there
 * (requirement 2), and a phone joining mid-race starts from the top of the hill
 * without resetting the room.
 */
export function syncRacers(
  state: SkiState,
  roster: ReadonlyArray<{ readonly id: number; readonly present: boolean }>,
): void {
  state.racers = roster.map(({ id, present }) => {
    const existing = findRacer(state, id);
    if (existing) {
      if (present) existing.absentSeconds = 0;
      existing.present = present;
      return existing;
    }
    return {
      id,
      present,
      grip: null,
      recent: [],
      lastPoseAt: 0,
      stalledReport: false,
      steadyMs: 0,
      steering: false,
      edgeDeg: 0,
      edge: 0,
      gripPower: 0,
      x: 0,
      y: 0,
      // A racer pushes off the gate rather than starting from rest.
      speed: MIN_SPEED,
      nextGate: 0,
      missed: 0,
      penaltySeconds: 0,
      finished: false,
      dnf: false,
      finishSeconds: null,
      biasSeconds: 0,
      driftWarning: false,
      biasSign: 0,
      absentSeconds: 0,
      gateResults: [],
      trail: [],
    };
  });
}

/** A gravity reading: kept for calibration, and turned into an edge once calibrated. */
export function readPose(state: SkiState, id: number, up: CanonicalVector, nowMs: number): void {
  const racer = findRacer(state, id);
  if (!racer) return;

  racer.lastPoseAt = nowMs;
  racer.stalledReport = false;
  racer.recent.push(up);
  if (racer.recent.length > GRIP_SAMPLES) racer.recent.shift();

  const grip = racer.grip;
  if (!grip) return;
  racer.edgeDeg = signedRoll(grip, up);
  racer.edge = clamp(racer.edgeDeg / EDGE_FULL_DEG, -1, 1);
}

/**
 * What the input layer knows about this phone holding still, and about it
 * having stopped altogether.
 *
 * A stalled phone is not a phone being held still, and only that layer can tell
 * the two apart, so a stall is recorded here rather than inferred from readings.
 */
export function readStillness(
  state: SkiState,
  id: number,
  steadyMs: number,
  stalled: boolean,
  nowMs: number,
): void {
  const racer = findRacer(state, id);
  if (!racer) return;
  racer.steadyMs = steadyMs;
  racer.stalledReport = stalled;
  // The event itself is proof the phone is still sending.
  if (!stalled) racer.lastPoseAt = nowMs;
}

/**
 * Adopt the hold this player is in right now.
 *
 * Called on the start line, and again on A at any point during a run. The
 * second case is the one that matters: a player who shifts the phone in their
 * hand has moved the zero of every reading in the game, and without this they
 * are pushed steadily to one side for the rest of the run with nothing they can
 * do about it.
 */
export function regrip(state: SkiState, id: number, nowMs: number): boolean {
  const racer = findRacer(state, id);
  if (!racer || racer.recent.length === 0) return false;

  racer.grip = captureGrip(racer.recent, nowMs);
  racer.gripPower = gripQuality(racer.grip.up);
  racer.edgeDeg = 0;
  racer.edge = 0;
  racer.biasSeconds = 0;
  racer.driftWarning = false;
  return true;
}

export function presentRacers(state: SkiState): Racer[] {
  return state.racers.filter((racer) => racer.present);
}

/** Everyone still on the hill: not finished, not retired. */
export function runningRacers(state: SkiState): Racer[] {
  return state.racers.filter((racer) => !racer.finished && !racer.dnf);
}

/**
 * The line through the gates.
 *
 * A cosine ease from one gate to the next, starting from the middle of the
 * piste at the top, so it passes through every corridor by construction. The
 * carving drill draws it, and the race is the same line without the drawing.
 */
export function idealX(config: SkiConfig, y: number): number {
  const gates = config.gates;
  const first = gates[0];
  if (!first) return 0;
  if (y <= 0) return 0;
  if (y <= first.y) return ease(0, first.x, y / first.y);

  for (let index = 0; index < gates.length - 1; index++) {
    const from = gates[index];
    const to = gates[index + 1];
    if (!from || !to) break;
    if (y <= to.y) return ease(from.x, to.x, (y - from.y) / (to.y - from.y));
  }
  return gates[gates.length - 1]?.x ?? 0;
}

function ease(from: number, to: number, u: number): number {
  const t = clamp(u, 0, 1);
  return from + (to - from) * ((1 - Math.cos(Math.PI * t)) / 2);
}

/**
 * The edge, in degrees, that the line asks for at this point on the hill.
 *
 * Straight out of the steering equation rather than tuned: dx/dt is
 * edge * CARVE * speed and dy/dt is speed, so speed cancels and the slope of the
 * line names the edge. A player matching this number is on the line at any
 * speed, which is the pair of numbers the practice screen exists to show — an
 * edge angle on its own says nothing about whether it was the right one.
 */
export function idealEdgeDeg(config: SkiConfig, y: number): number {
  // A metre either side. The line is smooth, so a symmetric difference reads
  // true to well under a degree and cannot be caught out at a gate.
  const slope = (idealX(config, y + 1) - idealX(config, y - 1)) / 2;
  return clamp(slope / CARVE, -1, 1) * EDGE_FULL_DEG;
}

/** Where a recorded run was at this time, or null once it has finished. */
export function ghostPositionAt(ghost: GhostRun, seconds: number): GhostSample | null {
  if (seconds < 0) return null;
  const position = seconds * ghost.hz;
  const index = Math.floor(position);
  const from = ghost.samples[index];
  const to = ghost.samples[index + 1];
  if (!from) return null;
  if (!to) return from;
  const u = position - index;
  return { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u };
}

/**
 * The run just skied, in the form it would be handed back in as a ghost.
 *
 * Only a finished run: half a run replayed against a whole one is a ghost that
 * vanishes at the point the player gave up, which reads as the ghost winning.
 */
export function recordedGhost(state: SkiState, id: number): GhostRun | null {
  const racer = findRacer(state, id);
  if (!racer || racer.trail.length === 0) return null;
  const seconds = racer.finishSeconds;
  if (seconds === null) return null;
  return { samples: racer.trail, hz: GHOST_HZ, seconds };
}

/** Elapsed plus penalties, or null for a racer who never finished. */
export function resultSeconds(racer: Racer): number | null {
  return racer.finishSeconds === null ? null : racer.finishSeconds + racer.penaltySeconds;
}

/**
 * Finishers by time, then everyone else by how far they got.
 *
 * Ties break on player id so the order is stable: a leaderboard that reshuffles
 * two equal times between frames looks like a bug.
 */
export function standings(state: SkiState): Racer[] {
  return [...state.racers].sort((a, b) => {
    const left = resultSeconds(a);
    const right = resultSeconds(b);
    if (left !== null && right !== null) return left - right || a.id - b.id;
    if (left !== null) return -1;
    if (right !== null) return 1;
    return b.y - a.y || a.id - b.id;
  });
}

/**
 * One frame.
 *
 * `nowMs` is a clock, compared only against the timestamps on incoming
 * readings: a phone that stopped sending is not steering, however good its last
 * reading was.
 */
export function stepSki(state: SkiState, dt: number, nowMs: number): SkiEvent[] {
  const events: SkiEvent[] = [];
  if (state.phase === 'finish') return events;

  updateSteering(state, nowMs, events);

  if (state.phase === 'ready') {
    state.readyFor += dt;
    takeGrips(state, nowMs, events);

    // Nobody to start: the scene says who it is waiting for rather than
    // counting a room of one absent phone down to a race it cannot run.
    const waiting = presentRacers(state);
    if (waiting.length === 0) return events;

    const ready = waiting.every((racer) => racer.grip !== null);
    if (!ready && state.readyFor < state.config.autoStartSeconds) return events;

    state.countdown -= dt;
    if (state.countdown <= 0) {
      state.countdown = 0;
      state.phase = 'run';
      events.push({ kind: 'start' });
    }
    return events;
  }

  state.accumulator += dt;
  let steps = 0;
  while (state.accumulator >= SIM_STEP && steps < MAX_SIM_STEPS && state.phase === 'run') {
    state.accumulator -= SIM_STEP;
    steps++;
    simulate(state, events);
  }
  // Whatever could not be simulated is dropped rather than banked, so a tab
  // that slept for ten seconds does not ski the whole course the moment it wakes.
  if (state.accumulator > SIM_STEP * MAX_SIM_STEPS) state.accumulator = 0;

  const ghost = state.ghost;
  if (ghost) state.ghostPos = ghostPositionAt(ghost, state.t);
  return events;
}

function updateSteering(state: SkiState, nowMs: number, events: SkiEvent[]): void {
  for (const racer of state.racers) {
    const fresh = nowMs - racer.lastPoseAt <= POSE_FRESH_MS;
    const steering = racer.present && racer.grip !== null && fresh && !racer.stalledReport;
    if (steering === racer.steering) continue;
    racer.steering = steering;
    // Worth an event on both edges: the screen greys the arrow when steering is
    // lost and has to put it back when the phone returns.
    events.push({ kind: 'steering', playerId: racer.id, lost: !steering });
  }
}

function takeGrips(state: SkiState, nowMs: number, events: SkiEvent[]): void {
  const late = state.readyFor >= state.config.autoStartSeconds;
  for (const racer of state.racers) {
    if (racer.grip || !racer.present) continue;
    // Either the hand has settled, or the start has waited long enough that
    // holding the whole room up has become the worse failure. A grip taken late
    // can be poor; `gripPower` says so and A takes another one at any time.
    if (racer.steadyMs < state.config.gripStillMs && !late) continue;
    if (!regrip(state, racer.id, nowMs)) continue;
    events.push({ kind: 'grip', playerId: racer.id, power: racer.gripPower });
  }
}

/** One fixed step of the hill. */
function simulate(state: SkiState, events: SkiEvent[]): void {
  const { config } = state;
  const tBefore = state.t;
  state.t += SIM_STEP;
  state.ticks++;

  for (const racer of state.racers) {
    if (racer.finished || racer.dnf) continue;
    if (!racer.present) racer.absentSeconds += SIM_STEP;
    trackDrift(racer, events);

    const fromX = racer.x;
    const fromY = racer.y;

    // A phone that is not steering keeps its last edge rather than snapping to
    // neutral: a stall costs the seconds it lasted, and does not put the racer
    // into a turn they never made.
    racer.x = clamp(
      racer.x + racer.edge * CARVE * racer.speed * SIM_STEP,
      -config.laneHalfWidth,
      config.laneHalfWidth,
    );
    const along = GRAVITY_ALONG * Math.cos((racer.edge * CARVE_ANGLE_DEG * Math.PI) / 180);
    const accel = along - DRAG * racer.speed * racer.speed - EDGE_DRAG * Math.abs(racer.edge);
    racer.speed = Math.max(MIN_SPEED, racer.speed + accel * SIM_STEP);
    racer.y += racer.speed * SIM_STEP;

    if (state.ticks % GHOST_EVERY === 0) racer.trail.push({ x: racer.x, y: racer.y });

    judgeGates(state, racer, fromX, fromY, events);
    crossFinish(state, racer, fromY, tBefore, events);
  }

  retireAbsent(state, events);
  if (state.t >= config.timeLimitSeconds) retireEveryone(state, events);
  if (runningRacers(state).length === 0) {
    state.phase = 'finish';
    events.push({ kind: 'over' });
  }
}

/**
 * The grip-has-slipped alarm.
 *
 * Armed only while the racer is actually steering. A frozen edge on a stalled
 * phone is already reported as a stall, and reporting it twice would tell a
 * player to re-grip a phone that is not connected.
 */
function trackDrift(racer: Racer, events: SkiEvent[]): void {
  if (!racer.steering || Math.abs(racer.edge) < DRIFT_RELEASE) {
    racer.biasSeconds = 0;
    racer.biasSign = 0;
    racer.driftWarning = false;
    return;
  }
  if (Math.abs(racer.edge) < DRIFT_EDGE) return;

  // A slipped grip biases the neutral point to one side, so the edge stays on
  // that side. Carving back the other way proves the neutral point is fine,
  // even if the racer never lingers near zero between turns — a fast slalom
  // crosses through in a fraction of a step, and the old rule read that as a
  // grip that had slipped and told the player to re-grip mid-run.
  const sign = Math.sign(racer.edge);
  if (sign !== racer.biasSign) {
    racer.biasSign = sign;
    racer.biasSeconds = 0;
    racer.driftWarning = false;
    return;
  }

  racer.biasSeconds += SIM_STEP;
  if (racer.biasSeconds < DRIFT_SECONDS || racer.driftWarning) return;
  racer.driftWarning = true;
  events.push({ kind: 'drift', playerId: racer.id, edgeDeg: racer.edgeDeg });
}

/**
 * Judge every gate this step went past.
 *
 * The crossing is interpolated rather than sampled after the step: at 22 m/s a
 * fixed step covers 0.18 m, so reading the position at the end of the step
 * instead of at the gate line puts the verdict a fifth of a metre off the
 * truth, in a corridor 9 m wide, by a different amount at every step size. A
 * loop rather than an if, because one step can pass two gates on the tightest
 * spacing this course generator allows.
 */
function judgeGates(
  state: SkiState,
  racer: Racer,
  fromX: number,
  fromY: number,
  events: SkiEvent[],
): void {
  if (!state.config.judgeGates) return;
  const span = racer.y - fromY;

  while (racer.nextGate < state.config.gates.length) {
    const gate = state.config.gates[racer.nextGate];
    if (!gate || gate.y > racer.y) break;

    const u = span > 0 ? clamp((gate.y - fromY) / span, 0, 1) : 0;
    const crossX = fromX + (racer.x - fromX) * u;
    const offBy = crossX - gate.x;
    const passed = Math.abs(offBy) <= gate.halfWidth;
    // A gate missed while the phone was not answering costs nothing. That
    // player has already lost the line and the speed to the stall; putting it on
    // the scoreboard as well is charging them for a wifi hiccup (D48).
    const offline = !passed && !racer.steering;
    const penalty = passed || offline ? 0 : state.config.penaltySeconds;

    racer.gateResults.push({ index: racer.nextGate, passed, offBy, offline });
    if (!passed) racer.missed++;
    racer.penaltySeconds += penalty;
    events.push({ kind: 'gate', playerId: racer.id, index: racer.nextGate, passed, penalty });
    racer.nextGate++;
  }
}

function crossFinish(
  state: SkiState,
  racer: Racer,
  fromY: number,
  tBefore: number,
  events: SkiEvent[],
): void {
  if (racer.y < state.config.courseLength) return;

  // Interpolated for the reason the gates are: a finish time must not depend on
  // where the step boundaries happened to fall.
  const span = racer.y - fromY;
  const u = span > 0 ? clamp((state.config.courseLength - fromY) / span, 0, 1) : 0;
  racer.finishSeconds = tBefore + u * SIM_STEP;
  racer.y = state.config.courseLength;
  racer.finished = true;
  events.push({
    kind: 'finish',
    playerId: racer.id,
    seconds: racer.finishSeconds,
    penaltySeconds: racer.penaltySeconds,
  });
}

/**
 * Retire a racer whose phone has been gone too long.
 *
 * They keep everything they had — gates, penalties, distance, grip — and only
 * stop being somebody the rest of the field is waiting for. This is also what
 * decides whether the run waits at all: a two-second outage is waited out on
 * the racer's frozen edge, ten seconds of silence is not.
 */
function retireAbsent(state: SkiState, events: SkiEvent[]): void {
  for (const racer of runningRacers(state)) {
    if (racer.present || racer.absentSeconds < state.config.absentGraceSeconds) continue;
    racer.dnf = true;
    events.push({ kind: 'retired', playerId: racer.id });
  }
}

/** The backstop: a run that nobody can finish still has to end (requirement 3). */
function retireEveryone(state: SkiState, events: SkiEvent[]): void {
  for (const racer of runningRacers(state)) {
    racer.dnf = true;
    events.push({ kind: 'retired', playerId: racer.id });
  }
}
