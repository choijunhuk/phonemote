import { captureGrip, gripQuality, tiltVector, type Grip } from '../../input/grip.js';
import type { CanonicalVector } from '../../input/types.js';
import { assignSeats, playerAt } from './seats.js';

/**
 * Together Table rules, with no Phaser in sight (ARCHITECTURE.md 8).
 *
 * One board, and its angle is the mean of every hand holding it. That single
 * decision is the game: nobody can steer alone, the ball only moves where the
 * room agrees it should, and a player leaning the wrong way is not a private
 * mistake but a visible one.
 *
 * It reads `up` and nothing else. No integration, no heading, no acceleration —
 * gravity is exact, has no singular pose and does not drift, and every hand is
 * measured against the grip that hand chose, so four people holding their
 * phones four different ways all read zero when the table is level.
 *
 * The structural risk is the mean itself. One player whose grip slides over a
 * minute biases the board permanently and the rest of the room has no way to
 * know why. The defence is that every number behind a hand is on this record —
 * `tilt`, `bias`, `share`, `rate` — for the screen to draw as that player's own
 * arrow. There is deliberately no automatic recentring: a slow correction
 * cannot be told apart from somebody deliberately leaning slowly, which is a
 * legal move here.
 */

export type TablePhase = 'grip' | 'play' | 'cleared' | 'failed';
export type TableModeKey = 'practice' | 'solo' | 'coop' | 'versus';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned, in board units. The maze is made of these. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Hole {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly kind: 'goal' | 'trap';
  /** Versus only: the seat that scores when the ball drops in here. */
  readonly seat: number | null;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Course {
  readonly key: string;
  /** Shown to the room. */
  readonly label: string;
  readonly start: Point;
  readonly holes: readonly Hole[];
  readonly walls: readonly Rect[];
  /** 0 for a course with no clock. */
  readonly seconds: number;
  /** What running out of time means — survival inverts it. */
  readonly onTimeout: 'fail' | 'clear';
  /** Board units per second the play area closes in from every side. */
  readonly shrinkPerSecond: number;
  /** Seconds for gold, silver, bronze. Empty when the course is not raced. */
  readonly medals: readonly number[];
}

export interface TableConfig {
  readonly mode: TableModeKey;
  readonly courses: readonly Course[];
  /** Goals one seat needs to win the tug of war; 0 when nobody is scoring. */
  readonly goalsToWin: number;
  /** Whether each seat gets a hole of its own, generated from the seating. */
  readonly seatGoals: boolean;
  /** Table rate that brings the tower down, deg/s. 0 turns the hazard off. */
  readonly collapseDegPerSecond: number;
  /** How much longer than life the practice screen draws each arrow. */
  readonly arrowGain: number;
  /** Whether the screen shows the measurements rather than a game. */
  readonly showNumbers: boolean;
  /** The circle the practice drill asks the ball to stay inside, board units. */
  readonly ringRadius: number;
}

export interface TablePlayer {
  readonly id: number;
  /** From the session roster. Kept, never deleted (ARCHITECTURE.md D48). */
  present: boolean;
  /** This player's own level. Survives a drop, so a rejoin costs nothing. */
  grip: Grip | null;
  /** How much of the game this grip can see, 0 to 1. */
  quality: number;
  /** Degrees from their grip: x right edge down, y aiming up. */
  tilt: { x: number; y: number };
  /** Slow mean of that. A hand that has drifted reads non-zero here. */
  bias: { x: number; y: number };
  /** How fast this hand is moving, deg/s, smoothed. */
  rate: number;
  /** Raw rate of the newest pose pair, before smoothing. */
  rateSample: number;
  /** This hand's pull on the board right now, 0 to 1. */
  weight: number;
  /** Its share of the mean, 0 to 1 — what the arrow length means. */
  share: number;
  /** Whether the board is currently listening to this hand at all. */
  driving: boolean;
  /** Frames have stopped arriving. The arrow greys; the tilt is held. */
  stalled: boolean;
  reportedStalled: boolean;
  /** Clock of the newest pose reading, ms. */
  lastFrameAt: number;
  /** Continuous stillness reported by the input layer, ms. */
  steadyMs: number;
  /** Recent `up` readings, averaged into a grip when the hand settles. */
  samples: CanonicalVector[];
  /** Versus: goals into this player's own hole. */
  goals: number;
  /** Drill accumulators: degrees squared, weighted by the time they lasted. */
  wobbleSum: number;
  wobbleTime: number;
}

export interface TableState {
  readonly config: TableConfig;
  phase: TablePhase;
  /** Frozen when play starts; a hole belongs to a seat, never to an index. */
  seats: readonly number[];
  courseIndex: number;
  course: Course;
  /** The course's own holes plus whatever the seating added. */
  holes: readonly Hole[];
  bounds: Bounds;
  ball: Ball;
  /** The mean of the driving hands, clamped, in degrees. */
  table: { x: number; y: number };
  /** How fast that mean is moving, deg/s, smoothed. */
  tableRate: number;
  /** Seconds the mean has stayed above the collapse line. */
  overRate: number;
  collapses: number;
  elapsed: number;
  timeLeft: number;
  /** Seconds the ball is held still after a goal or a collapse. */
  pause: number;
  /** Seconds nobody at all has been driving. */
  idleFor: number;
  /** Seconds spent waiting for the room to take its grips. */
  gripFor: number;
  players: TablePlayer[];
  /** Whoever won, by player id. Null when nobody did. */
  winner: number | null;
  /** Seconds each cleared course took, in the order they were played. */
  courseTimes: number[];
  /** Drill: squared distance from the ring centre, weighted by time. */
  ringSum: number;
  ringTime: number;
  ringInside: number;
  /** Left-over simulation time, so the fixed step survives an odd frame. */
  accumulator: number;
  seed: number;
}

export type TableEvent =
  | { readonly kind: 'grip'; readonly playerId: number }
  | { readonly kind: 'joined'; readonly playerId: number }
  | { readonly kind: 'left'; readonly playerId: number }
  | { readonly kind: 'rim'; readonly speed: number }
  | { readonly kind: 'goal'; readonly playerId: number | null; readonly goals: number }
  | { readonly kind: 'trap' }
  | { readonly kind: 'collapse'; readonly playerId: number | null; readonly rate: number }
  | { readonly kind: 'course'; readonly index: number }
  | { readonly kind: 'cleared'; readonly winner: number | null }
  | { readonly kind: 'failed'; readonly reason: 'trap' | 'time' | 'abandoned' };

/**
 * The simulation step, in seconds.
 *
 * The frame rate is unknown and varies, so the ball is never integrated with a
 * frame's own delta: a 15 Hz frame and a 100 Hz frame have to roll the ball the
 * same distance or the same lean would mean different things on different
 * machines. Left-over time is carried in the accumulator.
 */
export const STEP = 1 / 120;

/** Never simulate more than this in one call; a backgrounded tab hands us seconds. */
const MAX_CATCHUP = 0.25;

/**
 * The steepest the board will tilt, in degrees, however hard the room leans.
 *
 * Clamped on the magnitude rather than per axis: clamping x and y separately
 * lets a diagonal reach 35 degrees, so the board would be measurably faster
 * corner to corner than edge to edge for no reason a player could see.
 */
export const MAX_TILT_DEG = 25;

/**
 * Gravity, in board units per second squared.
 *
 * The board is one unit across, and this is the design's 9.8 * 0.6 read as a
 * board-unit gravity: acceleration is g * sin(tilt), which at the 25 degree
 * clamp is 5.88 * 0.423 = 2.48 units/s^2. From rest at full lean the ball
 * crosses the board in about 1.3 seconds, which is a marble you can steer.
 */
const BOARD_GRAVITY = 9.8 * 0.6;

/**
 * Linear drag, per second.
 *
 * The design says 0.15/s. That is a drag time constant of nearly seven seconds
 * and a terminal speed of 2.48 / 0.15 = 16 boards per second: the ball reaches
 * the far wall before the room can react and never slows down again. 2.2/s puts
 * terminal speed at 1.1 boards per second and stops the ball in about half a
 * second of levelling, which is what makes the ball answer to the table instead
 * of only remembering it.
 */
const DRAG = 2.2;

/** How much of its speed the ball keeps off a rail. A marble on wood, by ear. */
const RESTITUTION = 0.55;

export const BALL_RADIUS = 0.02;

/** Below this an impact is a scrape, not a knock worth a sound. */
const RIM_SPEED = 0.15;

/**
 * How long a hand has to be still before the game adopts it as that hand's
 * level. The design's number: long enough that the phone is not still merely
 * because it happened to be turning around.
 */
export const GRIP_STILL_MS = 400;

/** About half a second of readings, the window captureGrip is built for. */
const GRIP_SAMPLES = 30;

/** Nobody stares at a setup screen because a phone never reported still. */
export const AUTO_GRIP_SECONDS = 6;

/**
 * How long a phone may go quiet before its lean stops counting.
 *
 * The design's two seconds. Under it the last tilt is held, because a phone
 * whose frames hiccuped is still being held the way it was; over it the reading
 * is a guess about a room that has moved on.
 */
const STALE_MS = 2000;

/** Eight missed frames at the 20 Hz poll: enough to grey the arrow. */
const STALL_MS = 400;

/**
 * How long a hand takes to fade in or out of the mean, in seconds.
 *
 * The design drops a stale phone from the average outright, so that the board
 * does not lurch. Dropping is itself a lurch: two hands at +20 and -10 average
 * to +5, and removing the first snaps the board fifteen degrees in one frame
 * and throws the ball. Fading the weight instead reaches the same average over
 * a third of a second, which is the outcome the design asked for.
 */
const BLEND_SECONDS = 0.35;

/**
 * Time constant of the drift readout, in seconds.
 *
 * Long enough that leaning to steer does not show up as bias, short enough that
 * a grip that slid a minute ago is visible now. Display only — nothing in the
 * rules reads it, because subtracting it would fight a player leaning slowly on
 * purpose.
 */
const BIAS_SECONDS = 15;

/** Smoothing for both hand and board rates. Covers several pose frames. */
const RATE_SECONDS = 0.1;

/**
 * A pose gap wider than this is a reconnect, not a fast hand.
 *
 * Dividing a whole reconnect's worth of tilt change by the gap that produced it
 * would read as a hand moving at hundreds of degrees a second and, in coop,
 * bring the tower down on a player whose wifi blinked.
 */
const RATE_GAP_MS = 200;

/**
 * How long the board has to stay over the collapse rate before the tower goes.
 *
 * The design says three consecutive 1/120 steps. Pose frames arrive at 20 to
 * 50 Hz, so per-step differences are a comb of spikes and zeros and three in a
 * row essentially never happen; the rate here is smoothed over RATE_SECONDS,
 * which recovers the rate the design meant, and 0.15 s of it is the same test
 * that this was a shove and not one noisy frame.
 */
const COLLAPSE_HOLD = 0.15;

/** Seconds the ball waits after a goal or a collapse, so the room can see it. */
const RESET_PAUSE = 0.9;

/**
 * Seconds with nobody driving before the round gives up.
 *
 * Versus has no clock of its own, so without this a room that all walked away
 * mid-match would leave a ball sitting on a screen forever.
 */
export const ABANDON_SECONDS = 20;

const PRACTICE_COURSE: Course = {
  key: 'flat',
  label: '평평한 판',
  start: { x: 0.5, y: 0.5 },
  holes: [],
  walls: [],
  seconds: 0,
  onTimeout: 'fail',
  shrinkPerSecond: 0,
  medals: [],
};

const COOP_COURSE: Course = {
  key: 'gate',
  label: '문 통과',
  start: { x: 0.12, y: 0.5 },
  holes: [
    { x: 0.9, y: 0.5, r: 0.06, kind: 'goal', seat: null },
    { x: 0.6, y: 0.16, r: 0.05, kind: 'trap', seat: null },
    { x: 0.6, y: 0.84, r: 0.05, kind: 'trap', seat: null },
    { x: 0.76, y: 0.34, r: 0.05, kind: 'trap', seat: null },
    { x: 0.76, y: 0.66, r: 0.05, kind: 'trap', seat: null },
  ],
  walls: [
    { x: 0.44, y: 0, w: 0.05, h: 0.36 },
    { x: 0.44, y: 0.64, w: 0.05, h: 0.36 },
  ],
  seconds: 75,
  onTimeout: 'fail',
  shrinkPerSecond: 0,
  medals: [25, 40, 60],
};

/**
 * The solo courses, hardest last.
 *
 * Geometry is data on purpose: these are first guesses at widths and gaps, and
 * the only way to learn that a gate is too tight is to play it.
 */
const SOLO_COURSES: readonly Course[] = [
  {
    key: 'first',
    label: '첫 판',
    start: { x: 0.12, y: 0.14 },
    holes: [
      { x: 0.88, y: 0.14, r: 0.06, kind: 'goal', seat: null },
      { x: 0.5, y: 0.5, r: 0.05, kind: 'trap', seat: null },
      { x: 0.28, y: 0.72, r: 0.05, kind: 'trap', seat: null },
    ],
    walls: [{ x: 0.47, y: 0, w: 0.06, h: 0.34 }],
    seconds: 45,
    onTimeout: 'fail',
    shrinkPerSecond: 0,
    medals: [8, 14, 25],
  },
  {
    key: 'corridor',
    label: '좁은 길',
    start: { x: 0.1, y: 0.5 },
    holes: [
      { x: 0.9, y: 0.5, r: 0.06, kind: 'goal', seat: null },
      { x: 0.16, y: 0.18, r: 0.05, kind: 'trap', seat: null },
      { x: 0.16, y: 0.82, r: 0.05, kind: 'trap', seat: null },
    ],
    walls: [
      { x: 0.24, y: 0.3, w: 0.56, h: 0.12 },
      { x: 0.24, y: 0.58, w: 0.56, h: 0.12 },
    ],
    seconds: 60,
    onTimeout: 'fail',
    shrinkPerSecond: 0,
    medals: [12, 20, 35],
  },
  {
    // The survival variant the design asks for, which is one flag and one rate:
    // the walls close in and running the clock out is the win, not the loss.
    key: 'survive',
    label: '버티기',
    start: { x: 0.5, y: 0.22 },
    holes: [
      { x: 0.35, y: 0.5, r: 0.05, kind: 'trap', seat: null },
      { x: 0.65, y: 0.5, r: 0.05, kind: 'trap', seat: null },
      { x: 0.5, y: 0.37, r: 0.05, kind: 'trap', seat: null },
      { x: 0.5, y: 0.63, r: 0.05, kind: 'trap', seat: null },
    ],
    walls: [],
    seconds: 40,
    onTimeout: 'clear',
    shrinkPerSecond: 0.006,
    medals: [],
  },
];

const VERSUS_COURSE: Course = {
  key: 'tug',
  label: '줄다리기',
  start: { x: 0.5, y: 0.5 },
  holes: [],
  walls: [],
  seconds: 0,
  onTimeout: 'fail',
  shrinkPerSecond: 0,
  medals: [],
};

/**
 * Where each seat's own hole goes, by how many seats there are.
 *
 * Spread as far apart as the board allows: two holes near each other means one
 * player's pull helps their neighbour, which is the opposite of a tug of war.
 */
const SEAT_HOLES: Readonly<Record<number, readonly Point[]>> = {
  1: [{ x: 0.5, y: 0.12 }],
  2: [
    { x: 0.12, y: 0.5 },
    { x: 0.88, y: 0.5 },
  ],
  3: [
    { x: 0.5, y: 0.12 },
    { x: 0.14, y: 0.85 },
    { x: 0.86, y: 0.85 },
  ],
  4: [
    { x: 0.14, y: 0.15 },
    { x: 0.86, y: 0.15 },
    { x: 0.14, y: 0.85 },
    { x: 0.86, y: 0.85 },
  ],
};

/**
 * The modes, as data.
 *
 * Practice is not the game with the scoring switched off. It is the only screen
 * that shows a player what their own hand measured, which is the difference
 * between "my lean is too small" and "the game never saw me" — so it keeps the
 * numbers, drops the clock, and asks for one thing (hold the ball in the ring)
 * that has an answer in degrees.
 */
export const TABLE_MODES: Readonly<Record<TableModeKey, TableConfig>> = {
  practice: {
    mode: 'practice',
    courses: [PRACTICE_COURSE],
    goalsToWin: 0,
    seatGoals: false,
    collapseDegPerSecond: 0,
    // Ten times life size: a steady hand moves the board about a degree, and a
    // one-degree arrow on a television across a room is nothing at all.
    arrowGain: 10,
    showNumbers: true,
    ringRadius: 0.12,
  },
  solo: {
    mode: 'solo',
    courses: SOLO_COURSES,
    goalsToWin: 0,
    seatGoals: false,
    collapseDegPerSecond: 0,
    arrowGain: 3,
    showNumbers: false,
    ringRadius: 0,
  },
  coop: {
    mode: 'coop',
    courses: [COOP_COURSE],
    goalsToWin: 0,
    seatGoals: false,
    // The tower hazard rides on coop and nowhere else. The design leaves the
    // question open; coop is where it says something, because the mean can look
    // calm while two people fight, and this is the rule that makes the roughest
    // hand in the room everybody's problem.
    collapseDegPerSecond: 90,
    arrowGain: 3,
    showNumbers: false,
    ringRadius: 0,
  },
  versus: {
    mode: 'versus',
    courses: [VERSUS_COURSE],
    goalsToWin: 3,
    seatGoals: true,
    collapseDegPerSecond: 0,
    arrowGain: 3,
    showNumbers: false,
    ringRadius: 0,
  },
};

/** Anything the lobby can hand over; 'party' is not a table mode. */
export function configFor(mode: string): TableConfig {
  const known = (Object.keys(TABLE_MODES) as TableModeKey[]).find((key) => key === mode);
  return TABLE_MODES[known ?? 'practice'];
}

export function createTable(
  mode: string,
  overrides: Partial<TableConfig> = {},
  seed = 1,
): TableState {
  const config: TableConfig = { ...configFor(mode), ...overrides };
  const course = config.courses[0] ?? PRACTICE_COURSE;
  return {
    config,
    phase: 'grip',
    seats: [],
    courseIndex: 0,
    course,
    holes: course.holes,
    bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    ball: { x: course.start.x, y: course.start.y, vx: 0, vy: 0 },
    table: { x: 0, y: 0 },
    tableRate: 0,
    overRate: 0,
    collapses: 0,
    elapsed: 0,
    timeLeft: course.seconds,
    pause: 0,
    idleFor: 0,
    gripFor: 0,
    players: [],
    winner: null,
    courseTimes: [],
    ringSum: 0,
    ringTime: 0,
    ringInside: 0,
    accumulator: 0,
    seed,
  };
}

export function findPlayer(state: TableState, id: number): TablePlayer | undefined {
  return state.players.find((player) => player.id === id);
}

/**
 * Bring the roster in line with who is connected.
 *
 * Records are keyed by player id and kept, never rebuilt: a phone that drops
 * and comes back finds its grip and its goals where it left them, which is the
 * whole reason a two-second outage is allowed to be boring.
 */
export function syncPlayers(
  state: TableState,
  roster: ReadonlyArray<{ readonly id: number; readonly present: boolean }>,
): void {
  state.players = roster.map(({ id, present }) => {
    const existing = findPlayer(state, id);
    if (existing) {
      existing.present = present;
      return existing;
    }
    return {
      id,
      present,
      grip: null,
      quality: 0,
      tilt: { x: 0, y: 0 },
      bias: { x: 0, y: 0 },
      rate: 0,
      rateSample: 0,
      weight: 0,
      share: 0,
      driving: false,
      stalled: false,
      reportedStalled: false,
      lastFrameAt: 0,
      steadyMs: 0,
      samples: [],
      goals: 0,
      wobbleSum: 0,
      wobbleTime: 0,
    };
  });
}

/**
 * A `pose` reading from one phone.
 *
 * The tilt is recomputed here rather than in the step, so a phone sending at
 * 50 Hz is read fifty times a second whatever the screen is doing.
 */
export function readPose(
  state: TableState,
  id: number,
  up: CanonicalVector,
  nowMs: number,
): void {
  const player = findPlayer(state, id);
  if (!player) return;

  const gapMs = player.lastFrameAt > 0 ? nowMs - player.lastFrameAt : 0;
  player.lastFrameAt = nowMs;
  player.samples.push(up);
  if (player.samples.length > GRIP_SAMPLES) player.samples.shift();

  const grip = player.grip;
  if (!grip) return;

  const next = tiltVector(grip, up);
  if (gapMs > 0 && gapMs <= RATE_GAP_MS) {
    const moved = Math.hypot(next.x - player.tilt.x, next.y - player.tilt.y);
    player.rateSample = moved / (gapMs / 1000);
  }
  player.tilt = { x: next.x, y: next.y };
}

/** A `stillness` reading: what the grip waits for, and how the stall is known. */
export function readStillness(
  state: TableState,
  id: number,
  steadyMs: number,
  stalled: boolean,
): void {
  const player = findPlayer(state, id);
  if (!player) return;
  player.steadyMs = steadyMs;
  player.reportedStalled = stalled;
}

/**
 * Throw away one player's level and take it again from their next still moment.
 *
 * The design puts this on HOME. HOME belongs to the platform — it is the way
 * out of every game on this console and a player across a room cannot be asked
 * to remember which game made it mean something else — so the scene binds this
 * to A instead. Only that player's grip moves; the rest of the room keeps
 * holding the same board.
 */
export function regrip(state: TableState, id: number): void {
  const player = findPlayer(state, id);
  if (!player) return;
  player.grip = null;
  player.tilt = { x: 0, y: 0 };
  player.bias = { x: 0, y: 0 };
  player.rate = 0;
  player.rateSample = 0;
  player.steadyMs = 0;
  player.samples = [];
}

/** Whose lean is reaching the board right now. */
export function drivingPlayers(state: TableState): TablePlayer[] {
  return state.players.filter((player) => player.driving);
}

/** How far this hand has wandered from where it started, in degrees. */
export function biasDeg(player: TablePlayer): number {
  return Math.hypot(player.bias.x, player.bias.y);
}

/**
 * The drill's answer, in degrees: how far this hand was from level, on average.
 *
 * Accumulated as degrees squared weighted by the time each reading lasted, so
 * the number a player is shown does not depend on how many frames their phone
 * happened to send.
 */
export function wobbleRms(player: TablePlayer): number {
  if (player.wobbleTime <= 0) return 0;
  return Math.sqrt(player.wobbleSum / player.wobbleTime);
}

/** The same for the ball: how far outside the ring it lived, in board units. */
export function ringRms(state: TableState): number {
  if (state.ringTime <= 0) return 0;
  return Math.sqrt(state.ringSum / state.ringTime);
}

/** The fraction of the drill the ball spent inside the ring, 0 to 1. */
export function ringHold(state: TableState): number {
  if (state.ringTime <= 0) return 0;
  return state.ringInside / state.ringTime;
}

/** Which medal a time earns on this course, or null for none of them. */
export function medalFor(course: Course, seconds: number): 'gold' | 'silver' | 'bronze' | null {
  const [gold, silver, bronze] = course.medals;
  if (gold !== undefined && seconds <= gold) return 'gold';
  if (silver !== undefined && seconds <= silver) return 'silver';
  if (bronze !== undefined && seconds <= bronze) return 'bronze';
  return null;
}

/** Who is winning the tug of war, or who won it. */
export function leader(state: TableState): TablePlayer | null {
  return [...state.players].sort((a, b) => b.goals - a.goals)[0] ?? null;
}

/**
 * One frame.
 *
 * `nowMs` is a clock, compared only against the timestamps on incoming
 * readings: a phone that stopped sending is not a phone holding the board
 * steady, however level its last reading was.
 */
export function stepTable(state: TableState, dt: number, nowMs: number): TableEvent[] {
  const events: TableEvent[] = [];
  events.push(...updateHands(state, dt, nowMs));

  if (state.phase === 'grip') {
    state.gripFor += dt;
    // The room is ready, or it has waited long enough that waiting is the bug.
    if (readyToPlay(state) || state.gripFor >= AUTO_GRIP_SECONDS) {
      events.push(...beginPlay(state, nowMs));
    }
    return events;
  }
  if (state.phase !== 'play') return events;

  state.idleFor = drivingPlayers(state).length > 0 ? 0 : state.idleFor + dt;
  if (state.idleFor >= ABANDON_SECONDS) return [...events, ...fail(state, 'abandoned')];

  events.push(...checkCollapse(state, dt));
  if (state.phase !== 'play') return events;

  state.accumulator = Math.min(state.accumulator + dt, MAX_CATCHUP);
  while (state.accumulator >= STEP) {
    state.accumulator -= STEP;
    events.push(...simulate(state, STEP));
    if (state.phase !== 'play') break;
  }
  return events;
}

/**
 * Presence, grips, weights and every number the practice screen draws.
 *
 * Deliberately outside the fixed step: all of it is either exponential in dt or
 * weighted by dt, so it gives the same answer at any frame rate, and reading
 * the hands on the real clock rather than in 1/120 slices keeps the arrows in
 * step with the phones instead of with the simulation.
 */
function updateHands(state: TableState, dt: number, nowMs: number): TableEvent[] {
  const events: TableEvent[] = [];
  const blend = 1 - Math.exp(-dt / BLEND_SECONDS);
  const biasBlend = 1 - Math.exp(-dt / BIAS_SECONDS);
  const rateBlend = 1 - Math.exp(-dt / RATE_SECONDS);
  const playing = state.phase === 'play';

  for (const player of state.players) {
    const age = nowMs - player.lastFrameAt;
    const heard = player.lastFrameAt > 0 && age < STALE_MS;
    player.stalled = player.reportedStalled || (player.lastFrameAt > 0 && age >= STALL_MS);

    if (!player.grip && player.present && player.samples.length > 0) {
      // A grip is taken from stillness, not from a button: somebody who joined
      // halfway through gets their level the first time their hand settles, and
      // pulls nothing until then.
      if (player.steadyMs >= GRIP_STILL_MS) {
        takeGrip(player, nowMs);
        events.push({ kind: 'grip', playerId: player.id });
      }
    }

    const driving = player.present && player.grip !== null && heard;
    if (driving !== player.driving) {
      player.driving = driving;
      events.push(driving ? { kind: 'joined', playerId: player.id } : { kind: 'left', playerId: player.id });
    }

    player.weight += ((driving ? 1 : 0) - player.weight) * blend;
    if (!driving && player.weight < 0.002) player.weight = 0;

    // A hand that stopped reporting is not a hand that stopped moving, but it
    // is a hand nothing is known about; its rate decays rather than freezing.
    player.rate += ((player.stalled ? 0 : player.rateSample) - player.rate) * rateBlend;
    player.bias.x += (player.tilt.x - player.bias.x) * biasBlend;
    player.bias.y += (player.tilt.y - player.bias.y) * biasBlend;

    if (playing && driving) {
      const off = Math.hypot(player.tilt.x, player.tilt.y);
      player.wobbleSum += off * off * dt;
      player.wobbleTime += dt;
    }
  }

  applyMean(state, dt, rateBlend);
  return events;
}

function takeGrip(player: TablePlayer, nowMs: number): void {
  const grip = captureGrip(player.samples, nowMs);
  player.grip = grip;
  player.quality = gripQuality(grip.up);
  player.tilt = { x: 0, y: 0 };
  player.bias = { x: 0, y: 0 };
  player.rateSample = 0;
  player.rate = 0;
}

/** The board angle: the weighted mean of the hands, clamped, plus its rate. */
function applyMean(state: TableState, dt: number, rateBlend: number): void {
  let x = 0;
  let y = 0;
  let total = 0;
  for (const player of state.players) {
    if (player.weight <= 0) continue;
    x += player.tilt.x * player.weight;
    y += player.tilt.y * player.weight;
    total += player.weight;
  }

  for (const player of state.players) {
    player.share = total > 0 ? player.weight / total : 0;
  }

  const mean = total > 0 ? clampTilt(x / total, y / total) : { x: 0, y: 0 };
  const moved = Math.hypot(mean.x - state.table.x, mean.y - state.table.y);
  state.table = mean;
  if (dt > 0) state.tableRate += (moved / dt - state.tableRate) * rateBlend;
}

function clampTilt(x: number, y: number): { x: number; y: number } {
  const size = Math.hypot(x, y);
  if (size <= MAX_TILT_DEG || size === 0) return { x, y };
  const scale = MAX_TILT_DEG / size;
  return { x: x * scale, y: y * scale };
}

function readyToPlay(state: TableState): boolean {
  const present = state.players.filter((player) => player.present);
  return present.length > 0 && present.every((player) => player.grip !== null);
}

function beginPlay(state: TableState, nowMs: number): TableEvent[] {
  // Seats are frozen here and never derived from the live roster again: a phone
  // that joins mid-match must not be able to take somebody's hole (seats.ts).
  // It can still tilt the board — a latecomer is a pair of hands immediately
  // and a competitor at the next match.
  for (const player of state.players) {
    if (player.present && !player.grip && player.samples.length > 0) takeGrip(player, nowMs);
  }
  state.seats = assignSeats(state.players.filter((player) => player.present).map((p) => p.id));
  return startCourse(state, 0);
}

function startCourse(state: TableState, index: number): TableEvent[] {
  const course = state.config.courses[index] ?? state.course;
  state.courseIndex = index;
  state.course = course;
  state.holes = [...course.holes, ...seatHoles(state)];
  state.bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  state.ball = { x: course.start.x, y: course.start.y, vx: 0, vy: 0 };
  state.timeLeft = course.seconds;
  state.elapsed = 0;
  state.pause = RESET_PAUSE;
  state.accumulator = 0;
  state.phase = 'play';
  return index === 0 ? [] : [{ kind: 'course', index }];
}

function seatHoles(state: TableState): Hole[] {
  if (!state.config.seatGoals) return [];
  const layout = SEAT_HOLES[state.seats.length] ?? [];
  return layout.map((point, index) => ({
    x: point.x,
    y: point.y,
    r: 0.06,
    kind: 'goal' as const,
    seat: index + 1,
  }));
}

/**
 * The tower: the board being shoved rather than tilted.
 *
 * Blame goes to the fastest hand and not to the mean, because the mean is what
 * looks innocent — two people yanking in opposite directions average to a board
 * that is barely moving, and the point of the rule is that the room can see who
 * did it.
 */
function checkCollapse(state: TableState, dt: number): TableEvent[] {
  const limit = state.config.collapseDegPerSecond;
  if (limit <= 0 || state.pause > 0) return [];

  state.overRate = state.tableRate > limit ? state.overRate + dt : 0;
  if (state.overRate < COLLAPSE_HOLD) return [];

  state.overRate = 0;
  state.collapses++;
  const roughest = drivingPlayers(state).sort((a, b) => b.rate - a.rate)[0] ?? null;
  resetBall(state, state.course.start);
  return [{ kind: 'collapse', playerId: roughest?.id ?? null, rate: state.tableRate }];
}

function simulate(state: TableState, h: number): TableEvent[] {
  const course = state.course;
  state.elapsed += h;

  if (course.shrinkPerSecond > 0) {
    const step = course.shrinkPerSecond * h;
    state.bounds.minX += step;
    state.bounds.minY += step;
    state.bounds.maxX -= step;
    state.bounds.maxY -= step;
  }

  if (course.seconds > 0) {
    state.timeLeft = Math.max(0, state.timeLeft - h);
    if (state.timeLeft === 0) {
      return course.onTimeout === 'clear' ? clearCourse(state) : fail(state, 'time');
    }
  }

  if (state.pause > 0) {
    state.pause = Math.max(0, state.pause - h);
    return [];
  }

  const ball = state.ball;
  const ax = BOARD_GRAVITY * Math.sin((state.table.x * Math.PI) / 180);
  const ay = BOARD_GRAVITY * Math.sin((state.table.y * Math.PI) / 180);
  // Drag as a decay rather than a subtraction: it can never turn the ball round
  // on a slow frame, which a linear v -= c*v*h does as soon as c*h passes 1.
  const decay = Math.exp(-DRAG * h);
  ball.vx = (ball.vx + ax * h) * decay;
  ball.vy = (ball.vy + ay * h) * decay;
  ball.x += ball.vx * h;
  ball.y += ball.vy * h;

  const events: TableEvent[] = [];
  events.push(...collideWalls(state));
  events.push(...collideBounds(state));
  measureDrill(state, h);
  events.push(...checkHoles(state));
  return events;
}

/** The practice ring, measured on the ball rather than on the hands. */
function measureDrill(state: TableState, h: number): void {
  if (state.config.ringRadius <= 0) return;
  const centre = state.course.start;
  const off = Math.hypot(state.ball.x - centre.x, state.ball.y - centre.y);
  state.ringSum += off * off * h;
  state.ringTime += h;
  if (off <= state.config.ringRadius) state.ringInside += h;
}

function collideBounds(state: TableState): TableEvent[] {
  const ball = state.ball;
  const { minX, minY, maxX, maxY } = state.bounds;
  let hardest = 0;

  if (ball.x - BALL_RADIUS < minX) {
    ball.x = minX + BALL_RADIUS;
    hardest = Math.max(hardest, Math.abs(ball.vx));
    if (ball.vx < 0) ball.vx = -ball.vx * RESTITUTION;
  } else if (ball.x + BALL_RADIUS > maxX) {
    ball.x = maxX - BALL_RADIUS;
    hardest = Math.max(hardest, Math.abs(ball.vx));
    if (ball.vx > 0) ball.vx = -ball.vx * RESTITUTION;
  }

  if (ball.y - BALL_RADIUS < minY) {
    ball.y = minY + BALL_RADIUS;
    hardest = Math.max(hardest, Math.abs(ball.vy));
    if (ball.vy < 0) ball.vy = -ball.vy * RESTITUTION;
  } else if (ball.y + BALL_RADIUS > maxY) {
    ball.y = maxY - BALL_RADIUS;
    hardest = Math.max(hardest, Math.abs(ball.vy));
    if (ball.vy > 0) ball.vy = -ball.vy * RESTITUTION;
  }

  return hardest > RIM_SPEED ? [{ kind: 'rim', speed: hardest }] : [];
}

function collideWalls(state: TableState): TableEvent[] {
  const events: TableEvent[] = [];
  const ball = state.ball;

  for (const wall of state.course.walls) {
    const nearX = Math.min(Math.max(ball.x, wall.x), wall.x + wall.w);
    const nearY = Math.min(Math.max(ball.y, wall.y), wall.y + wall.h);
    let dx = ball.x - nearX;
    let dy = ball.y - nearY;
    let distance = Math.hypot(dx, dy);

    if (distance === 0) {
      // The centre is inside the rectangle, which at 1/120 and a board a second
      // wide takes a teleport to reach — a course whose start sits in a wall,
      // say. Out through the nearest face, so it never happens twice.
      const left = ball.x - wall.x;
      const right = wall.x + wall.w - ball.x;
      const top = ball.y - wall.y;
      const bottom = wall.y + wall.h - ball.y;
      const shallowest = Math.min(left, right, top, bottom);
      dx = shallowest === left ? -1 : shallowest === right ? 1 : 0;
      dy = dx !== 0 ? 0 : shallowest === top ? -1 : 1;
      distance = 1;
    } else if (distance >= BALL_RADIUS) {
      continue;
    }

    const nx = dx / distance;
    const ny = dy / distance;
    ball.x = nearX + nx * BALL_RADIUS;
    ball.y = nearY + ny * BALL_RADIUS;

    const into = ball.vx * nx + ball.vy * ny;
    if (into >= 0) continue;
    ball.vx -= (1 + RESTITUTION) * into * nx;
    ball.vy -= (1 + RESTITUTION) * into * ny;
    if (-into > RIM_SPEED) events.push({ kind: 'rim', speed: -into });
  }
  return events;
}

/** A marble falls in when its centre crosses the rim, not when it touches it. */
function holeUnder(state: TableState): Hole | null {
  for (const hole of state.holes) {
    if (Math.hypot(state.ball.x - hole.x, state.ball.y - hole.y) < hole.r) return hole;
  }
  return null;
}

function checkHoles(state: TableState): TableEvent[] {
  const hole = holeUnder(state);
  if (!hole) return [];

  if (hole.kind === 'trap') {
    // In a tug of war a trap costs the ball, not the match: ending a four-player
    // game on one bad bounce is a punishment nobody in the room chose.
    if (state.config.seatGoals) {
      resetBall(state, state.course.start);
      return [{ kind: 'trap' }];
    }
    return [{ kind: 'trap' }, ...fail(state, 'trap')];
  }

  if (hole.seat === null) return clearCourse(state);

  const id = playerAt(state.seats, hole.seat);
  const scorer = id === null ? undefined : findPlayer(state, id);
  if (!scorer) {
    // A hole belonging to a seat nobody is sitting in. Reachable only if the
    // roster emptied mid-match; it is scenery, not a goal.
    resetBall(state, state.course.start);
    return [];
  }

  scorer.goals++;
  const events: TableEvent[] = [{ kind: 'goal', playerId: scorer.id, goals: scorer.goals }];
  if (scorer.goals >= state.config.goalsToWin) {
    state.phase = 'cleared';
    state.winner = scorer.id;
    return [...events, { kind: 'cleared', winner: scorer.id }];
  }
  resetBall(state, state.course.start);
  return events;
}

function clearCourse(state: TableState): TableEvent[] {
  state.courseTimes.push(state.elapsed);
  const next = state.courseIndex + 1;
  if (next < state.config.courses.length) return startCourse(state, next);
  state.phase = 'cleared';
  return [{ kind: 'cleared', winner: state.winner }];
}

function fail(state: TableState, reason: 'trap' | 'time' | 'abandoned'): TableEvent[] {
  state.phase = 'failed';
  return [{ kind: 'failed', reason }];
}

/**
 * Put the ball back, a little off centre.
 *
 * Exactly centred it leaves every restart identical, and in a tug of war
 * between symmetric holes that means the same player scores the same way three
 * times. The jitter comes from the state's own seed so a match can be replayed.
 */
function resetBall(state: TableState, at: Point): void {
  const jitter = 0.03;
  state.ball = {
    x: at.x + (nextRandom(state) - 0.5) * jitter,
    y: at.y + (nextRandom(state) - 0.5) * jitter,
    vx: 0,
    vy: 0,
  };
  state.pause = RESET_PAUSE;
}

function nextRandom(state: TableState): number {
  state.seed = (state.seed * 1664525 + 1013904223) % 4294967296;
  return state.seed / 4294967296;
}
