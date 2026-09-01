import { captureGrip, signedRoll } from '../../input/grip.js';
import type { Grip } from '../../input/grip.js';
import type { CanonicalAngles, CanonicalVector } from '../../input/types.js';
import { assignSeats } from './seats.js';
import {
  advance,
  createTurnOrder,
  currentPlayer,
  reorder,
  setAbsent,
  tickTurn,
  type TurnEvent,
  type TurnOrder,
} from './turnOrder.js';

/**
 * Golf rules, with no Phaser in sight (ARCHITECTURE.md 8).
 *
 * The two numbers golf actually asks for are how hard the club was moving and
 * where its face was pointing, and both come out of the same burst: peakRate
 * and rotation.roll. Neither needs a heading, so nothing here reads yaw and a
 * phone that has drifted forty degrees since the last HOME aims the same as one
 * that has not. Aim is signedRoll against the grip this player chose, which is
 * gravity and therefore exact.
 *
 * The field is metres. x is across the hole, + to the right of the player;
 * y runs from the tee at 0 to the pin at hole.lengthM. Headings are degrees
 * from straight at the pin, + right, so a heading turns into a step with
 * (sin, cos) and never needs an atan2.
 */

export type GolfMode = 'practice' | 'solo' | 'versus';
/** The two practice screens. Which one is showing is a room-wide choice. */
export type GolfDrill = 'range' | 'putting';
export type Lie = 'tee' | 'fairway' | 'rough' | 'bunker' | 'green';
export type Club = 'driver' | 'iron' | 'wedge' | 'putter';
export type GolfPhase = 'aim' | 'flight' | 'hole_over' | 'over';
export type ShotKind = 'full' | 'half' | 'putt';
export type HoleTerm = 'albatross' | 'eagle' | 'birdie' | 'par' | 'bogey' | 'double' | 'other';

/**
 * Why a shot did nothing.
 *
 * Tennis learned this as SwingMiss: a swing that is silently dropped is
 * indistinguishable from one the detector never saw, and the room reads the
 * second as a broken game. Every refusal here reaches the screen.
 */
export type RefusedReason =
  | 'not_your_turn'
  | 'no_grip'
  | 'ball_moving'
  | 'green_needs_putt'
  | 'too_small'
  | 'hole_finished';

export interface Bunker {
  readonly x: number;
  readonly y: number;
  readonly radiusM: number;
}

export interface GolfHole {
  readonly par: number;
  readonly lengthM: number;
  /** 0 means this hole has no cup — the driving range, where nothing holes out. */
  readonly greenRadiusM: number;
  readonly greenSpeed: number;
  /** Degrees of heading change per metre rolled on the green, + bends right. */
  readonly slopeDegPerM: number;
  /** Crosswind in m/s, + pushes the ball right. */
  readonly wind: number;
  readonly bunkers: readonly Bunker[];
}

/** This player's own soft-to-hard range, so power means the same to everyone. */
export interface PowerScale {
  readonly softRate: number;
  readonly hardRate: number;
}

export interface GolfConfig {
  readonly mode: GolfMode;
  /** 0 means practice: no card, no last hole, unlimited balls. */
  readonly holes: number;
  readonly turnBased: boolean;
  /** Which practice screens this mode offers; empty for a real round. */
  readonly drills: readonly GolfDrill[];
  readonly holeOverSeconds: number;
  readonly turnSeconds: number;
  /** Strokes over par at which the hole is picked up, so it always ends. */
  readonly strokesOverPar: number;
  /** Turns a present player may let expire before the hole moves on without them. */
  readonly timeoutsPerHole: number;
  readonly power: PowerScale;
  /** Shots kept per player for the range's dispersion ellipse. */
  readonly shotHistory: number;
}

/**
 * Where the swing detector's power scale starts and ends, deg/s.
 *
 * The same measurements tennisState cites: a hand trying to hold still reads
 * 3.3 deg/s and six recorded hard swings peaked between 297 and 1211. Anything
 * under 350 is not a golf swing and anything over 1250 is everything the player
 * has. Per player, because that spread is between people as much as within one.
 */
export const DEFAULT_POWER: PowerScale = { softRate: 350, hardRate: 1250 };

const BASE_CONFIG: GolfConfig = {
  mode: 'solo',
  holes: 9,
  turnBased: true,
  drills: [],
  holeOverSeconds: 3,
  turnSeconds: 60,
  strokesOverPar: 5,
  timeoutsPerHole: 2,
  power: DEFAULT_POWER,
  shotHistory: 15,
};

/**
 * The modes, as data.
 *
 * Practice is not the round with the scoring switched off — it is a different
 * hole, a different set of readouts and no card at all — but every one of those
 * differences is a field here rather than a branch in the scene.
 */
export const GOLF_MODES: Record<GolfMode, GolfConfig> = {
  practice: {
    ...BASE_CONFIG,
    mode: 'practice',
    holes: 0,
    turnBased: false,
    drills: ['range', 'putting'],
  },
  solo: { ...BASE_CONFIG, mode: 'solo', holes: 9, turnBased: true },
  versus: { ...BASE_CONFIG, mode: 'versus', holes: 9, turnBased: true },
};

/** Carry in metres at full power, before the lie takes its cut. */
export const CLUB_CARRY_M: Record<Club, number> = {
  driver: 210,
  iron: 150,
  wedge: 70,
  putter: 0,
};

/** What each lie does to the carry. From the design; bunker is a half shot out. */
const LIE_CARRY: Record<Lie, number> = {
  tee: 1,
  fairway: 1,
  rough: 0.82,
  bunker: 0.6,
  green: 1,
};

/**
 * What each lie does to the player's own error.
 *
 * The design asks for +40% dispersion out of rough and +60% out of sand. With
 * no rng allowed in this module (and none wanted — a ball that goes somewhere
 * the player cannot account for is the complaint this project keeps hearing)
 * the honest reading of dispersion is that a bad lie multiplies the error the
 * player already made, rather than inventing one. An open face costs more from
 * the rough because the grass turns the club, which is also what happens.
 */
const LIE_SPREAD: Record<Lie, number> = {
  tee: 1,
  fairway: 1,
  rough: 1.4,
  bunker: 1.6,
  green: 1,
};

/** How much of the carry the ball runs out after it lands, by landing lie. */
const ROLL_FRACTION: Record<Lie, number> = {
  tee: 0.16,
  fairway: 0.16,
  rough: 0.05,
  bunker: 0.01,
  green: 0.07,
};

/** Rolling deceleration in m/s^2, by the surface the ball landed on. */
const ROLL_DECEL: Record<Lie, number> = {
  tee: 3.5,
  fairway: 3.5,
  rough: 6,
  bunker: 9,
  green: 1,
};

/** A putt's deceleration on a green, m/s^2: 10 m takes about 4.5 seconds. */
const PUTT_DECEL = 1;

const FAIRWAY_HALF_WIDTH_M = 18;

/** Straight from the design: face angle is capped at a full slice either way. */
const FACE_LIMIT_DEG = 12;
/**
 * The pitch integral below which rotation.roll stops being a face angle.
 *
 * rotation.roll on its own says nothing about the club face unless the burst
 * was actually a swing through the ball; dividing by the pitch integral is what
 * keeps a flick of the wrist from reading as a full slice, and the floor keeps
 * a level swing from dividing by nearly zero.
 */
const FACE_PITCH_FLOOR_DEG = 30;

/** How much of the face angle shows up in the start line rather than the curve. */
const FACE_START_SHARE = 0.35;
/**
 * Degrees of bend per metre of carry, per degree of face.
 *
 * A full 12 degree face over a 210 m drive turns the heading by 8.8 degrees and
 * finishes about 16 m offline, which is a hook you can see and still play from.
 * Sign follows the face: closed bends left, open pushes right.
 */
const CURVE_PER_FACE_DEG = 0.0035;
/** Bend per metre, per m/s of crosswind: 4 m/s moves a drive about 6 m. */
const WIND_CURVE_PER_MS = 0.004;

/** Aim: half the roll off the grip, capped, exactly as the design has it. */
const AIM_GAIN = 0.5;
const AIM_LIMIT_DEG = 15;

/** Pitch integral, in degrees, that counts as swinging down into the sand. */
const BUNKER_DIG_DEG = 20;
/** Carry multiplier for a bunker shot that was struck downwards. */
const BUNKER_DIG_CARRY = 0.85;

/** The cup, in metres. Real size; the concession below is what makes it play. */
export const CUP_RADIUS_M = 0.055;
/** Above this the ball is travelling too fast to drop, m/s. */
const CUP_CAPTURE_SPEED = 1.4;
/**
 * A ball that stops this close is conceded.
 *
 * A 55 mm cup asks for 0.6 degrees of line from five metres, which no hand
 * holding a phone across a room is going to produce; without a concession every
 * hole would end in the pick-up rule instead of in the cup. 0.45 m from five
 * metres is a 9% distance error, and the practice green draws its target band
 * at exactly this radius so the number the player is being asked for is on
 * screen rather than implied.
 *
 * It costs the tap-in stroke, because the player would have had to make it.
 * This also replaces the design's "theta < 3 degrees is a conceded tap-in": a
 * ball that has already stopped inside the radius never gets the chance to be
 * tapped, and conceding a hole because somebody twitched from ten metres would
 * be a stroke given away by accident.
 */
export const GIMME_RADIUS_M = 0.45;

/** Metres per degree of putting stroke, before the green's speed. */
const PUTT_M_PER_DEG = 0.09;
/** Below this a stroke is a twitch, not a putt. */
const PUTT_MIN_DEG = 3;

/** The stroke angle that plays a club its full carry, from the design. */
const HALF_SHOT_FULL_DEG = 140;

/**
 * How long a shot stays open to being replaced by the burst that follows it.
 *
 * This is the failure the whole shot pipeline is built around, and tennis found
 * it first: a swing is a backswing and then a strike, the detector fires on
 * both, and the backswing arrives first. Every stroke-driven shot here is
 * already immune because a stroke says whether it reversed the one before it,
 * so a backswing arms and only a reversal fires. A backswing snatched back
 * above 300 deg/s has no such flag — it arrives as a swing, and the real one
 * lands a moment later. Within this window the harder burst replays the shot
 * from where the ball was struck, which is tennis's COMMIT_SECONDS with the
 * ball put back.
 *
 * 400 ms: a quarter second from the top of the backswing to the peak of the
 * downswing, plus the 50 to 102 ms the swing event itself takes to arrive on
 * the 20 Hz recordings.
 */
const STRIKE_WINDOW_S = 0.4;

/**
 * How long an armed backswing is still the shot that is about to be played.
 *
 * Rehearsal strokes are normal in golf, and a backswing taken a minute ago must
 * not decide the length of the putt somebody finally makes.
 */
const BACKSWING_LIFE_S = 3;

/** Milliseconds of stillness that count as a settled grip, from the design. */
const GRIP_STEADY_MS = 400;
/** Half a second of `up`, which is what captureGrip wants to average over. */
const GRIP_SAMPLES = 30;

/** The band the stroke detector works in; the live backstroke bar reads it. */
const STROKE_MIN_RATE = 40;
/** A hand trying to hold still reads 3.3 deg/s, max 14. */
const STILL_RATE = 15;

/**
 * The physics step, in seconds.
 *
 * Fixed because the frame rate is unknown and varies: at 15 Hz a per-frame
 * curve integration would bend a drive twice as far as at 100 Hz. Small because
 * the cup is 55 mm across — a putt arriving at the capture speed of 1.4 m/s
 * moves 12 mm per step, so it cannot step over the hole.
 */
const FLIGHT_STEP = 1 / 120;
/** Time beyond this is dropped rather than simulated, so a stall cannot spiral. */
const MAX_CATCH_UP = 0.25;

/** Flags on the driving range, in metres. Scenery; nothing scores against them. */
export const RANGE_FLAGS_M: readonly number[] = [100, 150, 200];
/** The putting ladder, in metres, from the design. */
export const PUTT_LADDER_M: readonly number[] = [2, 5, 10];

/**
 * Practice green speed.
 *
 * The design's distanceM = theta * 0.09 * greenSpeed has to put the 2/5/10 m
 * ladder inside the 4-45 degree band the stroke detector reports. At 2.6 those
 * three putts ask for 8.5, 21 and 43 degrees; at a green speed of 1 the ten
 * metre putt would have asked for 111 degrees, which is not a stroke the
 * detector can express.
 */
const PRACTICE_GREEN_SPEED = 2.6;

const DEG = Math.PI / 180;

export interface Flight {
  /** Degrees off the line to the pin, + right. */
  headingDeg: number;
  speed: number;
  airborne: boolean;
  /** Metres of carry left before it lands. */
  carryLeft: number;
  curveDegPerM: number;
  decel: number;
}

/** What the swing measured, decided at contact and shown on the range. */
export interface ShotPlan {
  readonly playerId: number;
  readonly kind: ShotKind;
  readonly club: Club;
  readonly lie: Lie;
  readonly peakRate: number;
  readonly power: number;
  readonly faceDeg: number;
  readonly aimDeg: number;
  /** 0 for a full swing; the integrated stroke angle otherwise. */
  readonly strokeAngleDeg: number;
  readonly carryM: number;
  readonly startHeadingDeg: number;
  readonly curveDegPerM: number;
  /**
   * Backswing over downswing duration. Shown, never scored: the recordings are
   * a 19 Hz poll, so each boundary is a +/-53 ms guess and a real 3:1 tempo
   * reads anywhere from 2.4:1 to 3.8:1. A native-rate trace proving +/-17 ms
   * would be the thing that promotes this to a bonus band.
   */
  readonly tempoRatio: number | null;
  readonly startX: number;
  readonly startY: number;
  /** Distance to the cup when it was struck; null on a hole with no cup. */
  readonly targetM: number | null;
  /** Unit vector from the ball towards the pin at address. */
  readonly aimX: number;
  readonly aimY: number;
}

/** The plan plus where the ball actually finished. */
export interface ShotRecord extends ShotPlan {
  readonly endLie: Lie;
  /** Metres travelled from where it was struck. */
  readonly distanceM: number;
  /** Along the intended line, + past the target. */
  readonly distanceErrorM: number | null;
  /** Across the intended line, + right. */
  readonly lineErrorM: number;
  readonly holed: boolean;
}

export interface GolfPlayer {
  readonly id: number;
  /** False while this phone is not answering. Kept, never deleted (D48). */
  present: boolean;
  grip: Grip | null;
  recent: CanonicalVector[];
  aimDeg: number;
  /** Smoothed |omega| from the stillness channel, deg/s. */
  rate: number;
  /** Degrees swept since the phone was last still; the live backstroke bar. */
  sweptDeg: number;
  stalled: boolean;
  lastPoseAt: number;
  club: Club;
  /** True while the player has overridden the suggested club for this shot. */
  clubChosen: boolean;
  power: PowerScale;
  ball: { x: number; y: number };
  lie: Lie;
  flight: Flight | null;
  plan: ShotPlan | null;
  /** A stroke waiting to see whether a swing follows it. */
  pending: { stroke: StrokeInput; wait: number } | null;
  /** The last shot played, so a harder swing moments later can take it back. */
  lastStrike: { at: number; peakRate: number; ball: { x: number; y: number } } | null;
  strokes: number;
  holedOut: boolean;
  pickedUp: boolean;
  /** Their hole ended without them finishing it: absent, or out of turns. */
  abandoned: boolean;
  timeouts: number;
  /** One entry per hole; null is a hole this player never got to finish. */
  card: Array<number | null>;
  /** Which rung of the practice putting ladder they are on. */
  ladder: number;
  shots: ShotRecord[];
  lastShot: ShotRecord | null;
}

export interface GolfState {
  readonly config: GolfConfig;
  readonly seed: number;
  /** Frozen at match start; a mid-match join is a spectator until the next one. */
  readonly seats: readonly number[];
  readonly course: readonly GolfHole[];
  order: TurnOrder;
  phase: GolfPhase;
  /** 1-based. Always 1 in practice, where there is no card. */
  hole: number;
  /** Seconds left in the scorecard pause between holes. */
  timer: number;
  drill: GolfDrill;
  players: GolfPlayer[];
  /** Physics time not yet simulated, seconds. */
  accumulator: number;
  /** Seconds since the round began, for windows measured in time. */
  elapsed: number;
}

export type GolfEvent =
  | { readonly kind: 'grip'; readonly playerId: number }
  | { readonly kind: 'struck'; readonly playerId: number; readonly plan: ShotPlan }
  | { readonly kind: 'landed'; readonly playerId: number; readonly lie: Lie }
  | { readonly kind: 'rested'; readonly playerId: number; readonly record: ShotRecord }
  | { readonly kind: 'refused'; readonly playerId: number; readonly reason: RefusedReason }
  | {
      readonly kind: 'holed';
      readonly playerId: number;
      readonly strokes: number;
      readonly par: number;
      readonly term: HoleTerm;
      readonly conceded: boolean;
    }
  | { readonly kind: 'picked_up'; readonly playerId: number; readonly strokes: number }
  | { readonly kind: 'turn'; readonly playerId: number }
  | { readonly kind: 'target'; readonly playerId: number; readonly distanceM: number }
  | { readonly kind: 'hole_started'; readonly hole: number; readonly par: number }
  | { readonly kind: 'hole_over'; readonly hole: number }
  | { readonly kind: 'over' };

/** What the swing action carries that the rules care about. */
export interface SwingInput {
  readonly peakRate: number;
  readonly rotation: CanonicalAngles;
  readonly durationMs: number;
  readonly timestamp: number;
}

/** What the stroke action carries that the rules care about. */
export interface StrokeInput {
  readonly angleDeg: number;
  readonly durationMs: number;
  readonly peakRate: number;
  readonly reversedFromPrevious: boolean;
  readonly timestamp: number;
}

/** Korean because the room reads it; the key stays English like everything else. */
export const HOLE_TERMS: Record<HoleTerm, string> = {
  albatross: '알바트로스',
  eagle: '이글',
  birdie: '버디',
  par: '파',
  bogey: '보기',
  double: '더블 보기',
  other: '오버',
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * The course generator's randomness, and the only randomness in the file.
 *
 * Seeded so a nine hole round can be replayed shot for shot, which is what the
 * design asks for and what the tests depend on.
 */
function seededRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Pars, as a fixed multiset that is shuffled rather than rolled hole by hole.
 *
 * Rolling each hole independently produces courses of eight par 5s, and a round
 * whose par depends on the seed cannot be compared with another round. This is
 * always 36 for nine holes.
 */
const PAR_POOL: readonly number[] = [4, 4, 3, 5, 4, 4, 3, 5, 4];

function makeCourse(holes: number, seed: number): readonly GolfHole[] {
  const rng = seededRng(seed);
  const pars: number[] = [];
  for (let i = 0; i < holes; i++) pars.push(PAR_POOL[i % PAR_POOL.length] ?? 4);
  // Fisher-Yates, so the par 3s land somewhere different on each seed while the
  // total stays put.
  for (let i = pars.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = pars[i];
    const b = pars[j];
    if (a === undefined || b === undefined) continue;
    pars[i] = b;
    pars[j] = a;
  }
  return Object.freeze(pars.map((par) => makeHole(par, rng)));
}

function makeHole(par: number, rng: () => number): GolfHole {
  const lengthM = par === 3 ? 130 + rng() * 60 : par === 5 ? 440 + rng() * 90 : 300 + rng() * 100;
  const greenSpeed = 2.3 + rng() * 0.6;
  const slopeDegPerM = (rng() * 2 - 1) * 1.2;
  const wind = (rng() * 2 - 1) * 4;
  const count = rng() < 0.35 ? 0 : rng() < 0.8 ? 1 : 2;
  const bunkers: Bunker[] = [];
  for (let i = 0; i < count; i++) {
    bunkers.push({
      x: (rng() * 2 - 1) * 22,
      y: lengthM - (8 + rng() * 30),
      radiusM: 5 + rng() * 4,
    });
  }
  return {
    par,
    lengthM,
    greenRadiusM: 14,
    greenSpeed,
    slopeDegPerM,
    wind,
    bunkers: Object.freeze(bunkers),
  };
}

/**
 * The driving range: no cup, no wind, no slope.
 *
 * The range exists so the player can read what their own swing did. A crosswind
 * would put a couple of metres into every shot that belongs to nobody, which is
 * the opposite of the point.
 */
const RANGE_HOLE: GolfHole = {
  par: 0,
  lengthM: 250,
  greenRadiusM: 0,
  greenSpeed: PRACTICE_GREEN_SPEED,
  slopeDegPerM: 0,
  wind: 0,
  bunkers: [],
};

/** Ladder greens are flat for the same reason: the line error has to be theirs. */
const PUTT_HOLES: readonly GolfHole[] = Object.freeze(
  PUTT_LADDER_M.map((lengthM) => ({
    par: 0,
    lengthM,
    greenRadiusM: lengthM + 3,
    greenSpeed: PRACTICE_GREEN_SPEED,
    slopeDegPerM: 0,
    wind: 0,
    bunkers: [],
  })),
);

export interface GolfOptions {
  readonly mode?: GolfMode;
  readonly playerIds?: readonly number[];
  readonly seed?: number;
  readonly config?: Partial<GolfConfig>;
}

export function createGolf(options: GolfOptions = {}): GolfState {
  const mode = options.mode ?? 'solo';
  const config: GolfConfig = { ...GOLF_MODES[mode], ...options.config };
  const seed = options.seed ?? 1;
  const seats = assignSeats(options.playerIds ?? []);
  const state: GolfState = {
    config,
    seed,
    seats,
    course: makeCourse(config.holes, seed),
    order: createTurnOrder(seats, config.turnSeconds),
    phase: 'aim',
    hole: 1,
    timer: 0,
    drill: config.drills[0] ?? 'range',
    players: [],
    accumulator: 0,
    elapsed: 0,
  };
  syncPlayers(
    state,
    seats.map((id) => ({ id, present: true })),
  );
  return state;
}

export function findPlayer(state: GolfState, id: number): GolfPlayer | undefined {
  return state.players.find((player) => player.id === id);
}

/**
 * Bring the roster in line with who is connected.
 *
 * Everyone already here keeps their record — grip, card, ball, shot history —
 * because a phone that drops for two seconds has not stopped playing, and a
 * scene that rebuilt its players on every roster change is how a wifi hiccup
 * used to cost somebody their calibration (D48).
 */
export function syncPlayers(
  state: GolfState,
  roster: ReadonlyArray<{ readonly id: number; readonly present: boolean }>,
): GolfEvent[] {
  const events: GolfEvent[] = [];
  state.players = roster.map(({ id, present }) => {
    const existing = findPlayer(state, id);
    if (existing) {
      existing.present = present;
      return existing;
    }
    return newPlayer(state, id);
  });

  if (!state.config.turnBased) return events;
  for (const player of state.players) {
    events.push(...applyTurnEvents(state, setAbsent(state.order, player.id, !player.present)));
  }
  return events;
}

function newPlayer(state: GolfState, id: number): GolfPlayer {
  const player: GolfPlayer = {
    id,
    present: true,
    grip: null,
    recent: [],
    aimDeg: 0,
    rate: 0,
    sweptDeg: 0,
    stalled: false,
    lastPoseAt: 0,
    club: 'driver',
    clubChosen: false,
    power: state.config.power,
    ball: { x: 0, y: 0 },
    lie: 'tee',
    flight: null,
    plan: null,
    pending: null,
    lastStrike: null,
    strokes: 0,
    holedOut: false,
    pickedUp: false,
    abandoned: false,
    timeouts: 0,
    card: Array.from({ length: state.config.holes }, () => null),
    ladder: 0,
    shots: [],
    lastShot: null,
  };
  placeForHole(state, player);
  return player;
}

/** Adopt this player's own soft-to-hard range, from the calibration screen. */
export function setPowerScale(state: GolfState, id: number, scale: PowerScale): void {
  const player = findPlayer(state, id);
  if (player) player.power = scale;
}

/** A reading of gravity: kept for the grip, and turned into aim once gripped. */
export function readPose(state: GolfState, id: number, up: CanonicalVector, nowMs: number): void {
  const player = findPlayer(state, id);
  if (!player) return;
  player.lastPoseAt = nowMs;
  player.recent.push(up);
  if (player.recent.length > GRIP_SAMPLES) player.recent.shift();
  if (!player.grip) return;
  player.aimDeg = clamp(signedRoll(player.grip, up) * AIM_GAIN, -AIM_LIMIT_DEG, AIM_LIMIT_DEG);
}

/**
 * How still the phone is, which is how a grip gets taken without asking.
 *
 * A stalled phone is not a phone being held still, so it never sets a grip; the
 * player would otherwise be calibrated on whatever pose their phone was in when
 * the connection went.
 */
export function readStillness(
  state: GolfState,
  id: number,
  reading: { readonly rate: number; readonly steadyMs: number; readonly stalled: boolean },
): GolfEvent[] {
  const player = findPlayer(state, id);
  if (!player) return [];
  player.rate = reading.rate;
  player.stalled = reading.stalled;
  if (reading.stalled) return [];
  if (player.grip || reading.steadyMs < GRIP_STEADY_MS) return [];
  return setGrip(state, id, reading.steadyMs);
}

/** Take the grip this player is holding now. Also the re-grip button. */
export function setGrip(state: GolfState, id: number, atMs: number): GolfEvent[] {
  const player = findPlayer(state, id);
  if (!player || player.recent.length === 0) return [];
  player.grip = captureGrip(player.recent, atMs);
  player.aimDeg = 0;
  return [{ kind: 'grip', playerId: id }];
}

/** The club this distance asks for, before the player overrules it. */
export function suggestClub(distanceM: number, lie: Lie): Club {
  if (lie === 'green') return 'putter';
  if (distanceM <= 80) return 'wedge';
  if (distanceM <= 175) return 'iron';
  return 'driver';
}

export function setClub(state: GolfState, id: number, club: Club): void {
  const player = findPlayer(state, id);
  if (!player) return;
  player.club = club;
  player.clubChosen = true;
}

/** Switch practice screens. Every ball goes back to its start. */
export function setDrill(state: GolfState, drill: GolfDrill): void {
  if (!state.config.drills.includes(drill) || state.drill === drill) return;
  state.drill = drill;
  for (const player of state.players) {
    player.flight = null;
    player.plan = null;
    player.pending = null;
    placeForHole(state, player);
  }
}

/** The hole this player is playing: the course's, or the practice screen's. */
export function holeFor(state: GolfState, player: GolfPlayer): GolfHole {
  if (state.config.holes === 0) {
    if (state.drill === 'range') return RANGE_HOLE;
    return PUTT_HOLES[player.ladder % PUTT_HOLES.length] ?? RANGE_HOLE;
  }
  return state.course[state.hole - 1] ?? RANGE_HOLE;
}

export function pinOf(state: GolfState, player: GolfPlayer): { x: number; y: number } {
  return { x: 0, y: holeFor(state, player).lengthM };
}

export function distanceToPin(state: GolfState, player: GolfPlayer): number {
  const pin = pinOf(state, player);
  return Math.hypot(player.ball.x - pin.x, player.ball.y - pin.y);
}

function lieAt(hole: GolfHole, x: number, y: number): Lie {
  if (hole.greenRadiusM > 0 && Math.hypot(x, y - hole.lengthM) <= hole.greenRadiusM) return 'green';
  for (const bunker of hole.bunkers) {
    if (Math.hypot(x - bunker.x, y - bunker.y) <= bunker.radiusM) return 'bunker';
  }
  if (y >= -5 && y <= hole.lengthM && Math.abs(x) <= FAIRWAY_HALF_WIDTH_M) return 'fairway';
  return 'rough';
}

function placeForHole(state: GolfState, player: GolfPlayer): void {
  const hole = holeFor(state, player);
  player.ball = { x: 0, y: 0 };
  // The putting ladder starts on the green by definition; every other hole
  // starts on a tee, which plays like a fairway but is never a bunker.
  player.lie = hole.greenRadiusM >= hole.lengthM ? 'green' : 'tee';
  player.strokes = 0;
  player.holedOut = false;
  player.pickedUp = false;
  player.abandoned = false;
  player.timeouts = 0;
  player.clubChosen = false;
  player.club = suggestClub(hole.lengthM, player.lie);
}

/** Whether this player may hit right now, and if not the screen can say why. */
export function refusalFor(state: GolfState, player: GolfPlayer): RefusedReason | null {
  if (!player.grip) return 'no_grip';
  if (player.flight || player.pending) return 'ball_moving';
  if (player.holedOut || player.pickedUp || player.abandoned) return 'hole_finished';
  if (state.config.turnBased && currentPlayer(state.order) !== player.id) return 'not_your_turn';
  return null;
}

/** Who is on the clock, or null in practice and while nobody is answering. */
export function shooter(state: GolfState): number | null {
  return state.config.turnBased ? currentPlayer(state.order) : null;
}

/** 0 for this player's gentlest swing, 1 for everything they have. */
export function powerOf(player: GolfPlayer, peakRate: number): number {
  const { softRate, hardRate } = player.power;
  if (hardRate <= softRate) return peakRate >= hardRate ? 1 : 0;
  return clamp01((peakRate - softRate) / (hardRate - softRate));
}

/**
 * The club face, in degrees, + open.
 *
 * The design's formula: the roll integral over the burst, scaled by how much
 * the burst actually swung through, capped at a full slice either way.
 */
export function faceAngle(rotation: CanonicalAngles): number {
  const through = Math.max(Math.abs(rotation.pitch), FACE_PITCH_FLOOR_DEG);
  return clamp(
    (rotation.roll / through) * FACE_LIMIT_DEG,
    -FACE_LIMIT_DEG,
    FACE_LIMIT_DEG,
  );
}

/**
 * A full swing.
 *
 * The action's own `power` is deliberately not read here. The practice screen
 * has to show the player the numbers the rules used, and those numbers live on
 * this player's record where the scene can reach them; a scale kept in the
 * input layer would leave the range printing a peakRate next to a power it
 * could not explain.
 */
export function applySwing(state: GolfState, id: number, swing: SwingInput): GolfEvent[] {
  const player = findPlayer(state, id);
  if (!player) return [];

  // The backswing this swing belongs to. Consumed before any refusal, so a
  // swing that is turned away does not leave its own backswing armed to play a
  // half shot half a second later.
  const backswing = player.pending;
  player.pending = null;

  if (player.lie === 'green') return [{ kind: 'refused', playerId: id, reason: 'green_needs_putt' }];

  // The strike catching up with its own backswing. The detector fires on both
  // and the softer one arrives first, so without this the shot that counts is
  // the wind-up and the real swing then lands as a refusal — the failure D29
  // fixed for tennis, where the ball left on the backswing and the strike was
  // reported as too late.
  const replaces =
    player.lastStrike !== null &&
    state.elapsed - player.lastStrike.at <= STRIKE_WINDOW_S &&
    swing.peakRate > player.lastStrike.peakRate;
  if (replaces) rewindStrike(player);

  const refusal = replaces ? null : refusalFor(state, player);
  if (refusal) return [{ kind: 'refused', playerId: id, reason: refusal }];

  const tempoRatio =
    backswing && swing.durationMs > 0 ? backswing.stroke.durationMs / swing.durationMs : null;
  const power = powerOf(player, swing.peakRate);
  const lie = player.lie;
  const dug = lie === 'bunker' && swing.rotation.pitch <= -BUNKER_DIG_DEG;
  const carryScale = dug ? BUNKER_DIG_CARRY : LIE_CARRY[lie];
  const spread = LIE_SPREAD[lie];
  const faceDeg = faceAngle(swing.rotation);

  return strike(state, player, {
    kind: 'full',
    peakRate: swing.peakRate,
    power,
    faceDeg,
    strokeAngleDeg: 0,
    carryM: CLUB_CARRY_M[player.club] * (0.35 + 0.65 * power) * carryScale,
    spread,
    tempoRatio,
  });
}

/**
 * A stroke: a putt on the green, or a half swing anywhere else.
 *
 * Off the green it waits HALF_SHOT_COMMIT_MS to see whether it was the
 * backswing of something faster. On the green there is nothing to wait for —
 * a putt never reaches the swing detector's 300 deg/s floor.
 */
/**
 * How long a half shot waits before it counts.
 *
 * A stroke off the green arrives as a backswing and then the shot itself, and
 * the backswing gets there first — the same problem tennis had, where the
 * softer burst put the ball in play and the real swing then landed out of the
 * window (ARCHITECTURE.md D29). Waiting this long lets the larger of the two
 * replace the smaller before anything is committed.
 */
const HALF_SHOT_COMMIT_MS = 150;

export function applyStroke(state: GolfState, id: number, stroke: StrokeInput): GolfEvent[] {
  const player = findPlayer(state, id);
  if (!player) return [];

  if (player.lie !== 'green') {
    const refusal = refusalFor(state, player);
    if (refusal) return [{ kind: 'refused', playerId: id, reason: refusal }];
    player.pending = { stroke, wait: HALF_SHOT_COMMIT_MS / 1000 };
    return [];
  }

  const refusal = refusalFor(state, player);
  if (refusal) return [{ kind: 'refused', playerId: id, reason: refusal }];
  // A twitch is not a putt. Burning a stroke on one is worse than ignoring it,
  // and the refusal reaches the screen so it is not a silent miss either.
  if (stroke.angleDeg < PUTT_MIN_DEG) {
    return [{ kind: 'refused', playerId: id, reason: 'too_small' }];
  }

  const hole = holeFor(state, player);
  return strike(state, player, {
    kind: 'putt',
    peakRate: stroke.peakRate,
    power: 0,
    faceDeg: 0,
    strokeAngleDeg: stroke.angleDeg,
    carryM: stroke.angleDeg * PUTT_M_PER_DEG * hole.greenSpeed,
    spread: 1,
    tempoRatio: null,
  });
}

function playHalfShot(state: GolfState, player: GolfPlayer, stroke: StrokeInput): GolfEvent[] {
  const refusal = refusalFor(state, player);
  if (refusal) return [{ kind: 'refused', playerId: player.id, reason: refusal }];

  const lie = player.lie;
  // The design draws the half shot line at 70 degrees. Below it this is exactly
  // the design's angle/140; above it the same line continues to a full carry at
  // 140 rather than refusing, because a 90 degree stroke that produced nothing
  // is the silent miss this game is trying not to have.
  const reach = clamp01(stroke.angleDeg / HALF_SHOT_FULL_DEG);
  return strike(state, player, {
    kind: 'half',
    peakRate: stroke.peakRate,
    power: reach,
    // A half shot is aimed, not shaped: a stroke carries one angle about one
    // axis and says nothing about the face.
    faceDeg: 0,
    strokeAngleDeg: stroke.angleDeg,
    carryM: CLUB_CARRY_M[player.club] * reach * LIE_CARRY[lie],
    spread: LIE_SPREAD[lie],
    tempoRatio: null,
  });
}

interface StrikeInput {
  readonly kind: ShotKind;
  readonly peakRate: number;
  readonly power: number;
  readonly faceDeg: number;
  readonly strokeAngleDeg: number;
  readonly carryM: number;
  readonly spread: number;
  readonly tempoRatio: number | null;
}

function strike(state: GolfState, player: GolfPlayer, shot: StrikeInput): GolfEvent[] {
  const hole = holeFor(state, player);
  const pin = pinOf(state, player);
  const toPinX = pin.x - player.ball.x;
  const toPinY = pin.y - player.ball.y;
  const toPin = Math.hypot(toPinX, toPinY) || 1;

  const startHeadingDeg = player.aimDeg + shot.faceDeg * FACE_START_SHARE * shot.spread;
  const curveDegPerM =
    shot.kind === 'putt'
      ? hole.slopeDegPerM
      : shot.faceDeg * CURVE_PER_FACE_DEG * shot.spread + hole.wind * WIND_CURVE_PER_MS;

  const plan: ShotPlan = {
    playerId: player.id,
    kind: shot.kind,
    club: player.club,
    lie: player.lie,
    peakRate: shot.peakRate,
    power: shot.power,
    faceDeg: shot.faceDeg,
    aimDeg: player.aimDeg,
    strokeAngleDeg: shot.strokeAngleDeg,
    carryM: shot.carryM,
    startHeadingDeg,
    curveDegPerM,
    tempoRatio: shot.tempoRatio,
    startX: player.ball.x,
    startY: player.ball.y,
    targetM: hole.greenRadiusM > 0 ? toPin : null,
    aimX: toPinX / toPin,
    aimY: toPinY / toPin,
  };

  player.strokes++;
  player.plan = plan;
  // Kept so a harder swing arriving moments later can take this shot back.
  player.lastStrike = { at: state.elapsed, peakRate: shot.peakRate, ball: { ...player.ball } };
  player.sweptDeg = 0;
  player.clubChosen = false;
  player.flight =
    shot.kind === 'putt'
      ? {
          // The heading a putt starts on is the aim and nothing else; the green
          // does the rest, integrated metre by metre below.
          headingDeg: player.aimDeg,
          speed: Math.sqrt(2 * PUTT_DECEL * Math.max(0, shot.carryM)),
          airborne: false,
          carryLeft: 0,
          curveDegPerM,
          decel: PUTT_DECEL,
        }
      : {
          headingDeg: startHeadingDeg,
          // Long shots hang longer, which is only about how it looks: the carry
          // is already decided and the speed never feeds back into it.
          speed: 26 + 0.09 * shot.carryM,
          airborne: true,
          carryLeft: Math.max(0, shot.carryM),
          curveDegPerM,
          decel: 0,
        };

  return [{ kind: 'struck', playerId: player.id, plan }];
}

/**
 * One frame.
 *
 * Physics runs on a fixed step and the clocks run on the real one: a turn
 * timeout is a promise about seconds, while a curve integrated per frame would
 * bend twice as far at 15 Hz as at 100.
 */
export function stepGolf(state: GolfState, dt: number): GolfEvent[] {
  const events: GolfEvent[] = [];
  if (state.phase === 'over') return events;

  state.elapsed += dt;
  for (const player of state.players) {
    // A shot only stays takeable-back for as long as a strike could still be
    // arriving. A rehearsal swing a minute later is a new shot, not a correction
    // to the last one.
    if (player.lastStrike && state.elapsed - player.lastStrike.at > BACKSWING_LIFE_S) {
      player.lastStrike = null;
    }
  }

  for (const player of state.players) {
    // The live backstroke bar. The stroke action only exists once the motion has
    // turned around, so the bar has to be integrated from the smoothed rate,
    // which is unsigned — exactly right for a backswing that only goes one way.
    if (player.stalled || player.rate < STILL_RATE) player.sweptDeg = 0;
    else if (player.rate >= STROKE_MIN_RATE) player.sweptDeg += player.rate * dt;

    if (player.pending) {
      player.pending.wait -= dt;
      if (player.pending.wait <= 0) {
        const waited = player.pending.stroke;
        player.pending = null;
        events.push(...playHalfShot(state, player, waited));
      }
    }
  }

  state.accumulator = Math.min(state.accumulator + dt, MAX_CATCH_UP);
  while (state.accumulator >= FLIGHT_STEP) {
    state.accumulator -= FLIGHT_STEP;
    for (const player of state.players) {
      if (player.flight) events.push(...advanceFlight(state, player, FLIGHT_STEP));
    }
  }

  if (state.phase === 'hole_over') {
    state.timer -= dt;
    if (state.timer <= 0) events.push(...nextHole(state));
    return events;
  }

  if (state.config.turnBased) {
    events.push(...applyTurnEvents(state, tickTurn(state.order, dt)));
    events.push(...closeHoleIfDone(state));
  }

  // Read through a function so control flow cannot narrow it: the two calls
  // above can end the hole or the round, and the narrowing carried down from
  // the early return above is no longer true by the time we get here.
  const phase = phaseOf(state);
  if (phase !== 'hole_over' && phase !== 'over') {
    state.phase = state.players.some((player) => player.flight) ? 'flight' : 'aim';
  }
  return events;
}

/**
 * Undo a shot that turned out to be its successor's backswing.
 *
 * The ball goes back where it was struck and the stroke is handed back. A
 * rehearsal from a minute ago must not do this, which is what the window on the
 * caller is for; BACKSWING_LIFE_S is the same idea applied to a pending half
 * shot that nobody ever completed.
 */
function rewindStrike(player: GolfPlayer): void {
  const last = player.lastStrike;
  if (!last) return;
  player.strokes = Math.max(0, player.strokes - 1);
  player.ball = { ...player.ball, x: last.ball.x, y: last.ball.y };
  player.flight = null;
  player.plan = null;
  player.lastStrike = null;
}

function phaseOf(state: GolfState): GolfPhase {
  return state.phase;
}

function advanceFlight(state: GolfState, player: GolfPlayer, h: number): GolfEvent[] {
  const flight = player.flight;
  if (!flight) return [];
  const hole = holeFor(state, player);
  const events: GolfEvent[] = [];

  const stepM = flight.speed * h;
  flight.headingDeg += flight.curveDegPerM * stepM;
  const rad = flight.headingDeg * DEG;
  player.ball = {
    x: player.ball.x + Math.sin(rad) * stepM,
    y: player.ball.y + Math.cos(rad) * stepM,
  };

  if (flight.airborne) {
    flight.carryLeft -= stepM;
    if (flight.carryLeft > 0) return events;

    const lie = lieAt(hole, player.ball.x, player.ball.y);
    player.lie = lie;
    flight.airborne = false;
    // Friction is set by where the ball landed, which is where nearly all of
    // the run happens; a ball that trickles onto the green from the fringe has
    // almost no speed left to care about the change.
    flight.decel = ROLL_DECEL[lie];
    flight.curveDegPerM = lie === 'green' ? hole.slopeDegPerM : 0;
    const rollM = (player.plan?.carryM ?? 0) * ROLL_FRACTION[lie];
    flight.speed = Math.sqrt(2 * flight.decel * rollM);
    events.push({ kind: 'landed', playerId: player.id, lie });
    if (flight.speed > 0) return events;
  } else {
    flight.speed = Math.max(0, flight.speed - flight.decel * h);
  }

  const pin = pinOf(state, player);
  const toPin = Math.hypot(player.ball.x - pin.x, player.ball.y - pin.y);
  if (hole.greenRadiusM > 0 && toPin <= CUP_RADIUS_M && flight.speed <= CUP_CAPTURE_SPEED) {
    return [...events, ...rest(state, player, true, false)];
  }
  if (flight.speed <= 0) {
    player.lie = lieAt(hole, player.ball.x, player.ball.y);
    // A ball at rest inside the concession radius is in. See GIMME_RADIUS_M for
    // why the cup alone is not enough, and for the tap-in stroke it costs.
    const conceded = player.lie === 'green' && toPin <= GIMME_RADIUS_M;
    if (conceded) player.strokes++;
    return [...events, ...rest(state, player, conceded, conceded)];
  }
  return events;
}

function rest(
  state: GolfState,
  player: GolfPlayer,
  holed: boolean,
  conceded: boolean,
): GolfEvent[] {
  const plan = player.plan;
  player.flight = null;
  player.plan = null;
  if (!plan) return [];

  const dx = player.ball.x - plan.startX;
  const dy = player.ball.y - plan.startY;
  const along = dx * plan.aimX + dy * plan.aimY;
  // Right of the intended line: the right-perpendicular of (aimX, aimY).
  const across = dx * plan.aimY - dy * plan.aimX;
  const record: ShotRecord = {
    ...plan,
    endLie: player.lie,
    distanceM: Math.hypot(dx, dy),
    distanceErrorM: plan.targetM === null ? null : along - plan.targetM,
    lineErrorM: across,
    holed,
  };
  player.shots.push(record);
  if (player.shots.length > state.config.shotHistory) player.shots.shift();
  player.lastShot = record;

  const events: GolfEvent[] = [{ kind: 'rested', playerId: player.id, record }];
  const hole = holeFor(state, player);

  if (holed) {
    player.holedOut = true;
    if (state.config.holes > 0) {
      player.card[state.hole - 1] = player.strokes;
      events.push({
        kind: 'holed',
        playerId: player.id,
        strokes: player.strokes,
        par: hole.par,
        term: termFor(player.strokes, hole.par),
        conceded,
      });
    }
  } else if (state.config.holes > 0 && player.strokes >= hole.par + state.config.strokesOverPar) {
    // Golf's pick-up, and the thing that guarantees a hole ends: without it a
    // player who cannot reach the green keeps the room in front of a hole that
    // never finishes.
    player.pickedUp = true;
    player.card[state.hole - 1] = player.strokes;
    events.push({ kind: 'picked_up', playerId: player.id, strokes: player.strokes });
  }

  if (state.config.holes === 0) {
    events.push(...resetPractice(state, player, holed));
  } else {
    if (!player.clubChosen) {
      player.club = suggestClub(distanceToPin(state, player), player.lie);
    }
    if (state.config.turnBased) events.push(...passTurn(state, player));
  }
  return events;
}

/** The range hands out another ball; the ladder moves on once the putt drops. */
function resetPractice(state: GolfState, player: GolfPlayer, holed: boolean): GolfEvent[] {
  if (state.drill === 'range') {
    placeForHole(state, player);
    return [];
  }
  if (!holed) {
    player.holedOut = false;
    player.club = 'putter';
    return [];
  }
  player.ladder = (player.ladder + 1) % PUTT_HOLES.length;
  placeForHole(state, player);
  return [{ kind: 'target', playerId: player.id, distanceM: holeFor(state, player).lengthM }];
}

/**
 * Hand play to whoever is furthest from the cup.
 *
 * turnOrder.reorder plays the lowest rank first, so the rank is minus the
 * distance. A player who has finished ranks above everybody so the order stops
 * stopping on them.
 */
function passTurn(state: GolfState, player: GolfPlayer): GolfEvent[] {
  player.timeouts = 0;
  reorder(state.order, (id) => {
    const other = findPlayer(state, id);
    if (!other || other.holedOut || other.pickedUp || other.abandoned) return 1;
    return -distanceToPin(state, other);
  });
  return applyTurnEvents(state, advance(state.order));
}

function applyTurnEvents(state: GolfState, turnEvents: readonly TurnEvent[]): GolfEvent[] {
  const events: GolfEvent[] = [];
  for (const event of turnEvents) {
    if (event.kind === 'turn_changed') {
      events.push({ kind: 'turn', playerId: event.playerId });
      continue;
    }
    if (event.kind !== 'turn_timed_out') continue;
    const player = findPlayer(state, event.playerId);
    if (!player) continue;
    player.timeouts++;
    // A player who is there but not playing cannot hold the hole open forever.
    // Their card records the hole as unplayed rather than as a score they never
    // made, which is the same answer a dropped phone gets.
    if (player.timeouts >= state.config.timeoutsPerHole && !player.holedOut && !player.pickedUp) {
      player.abandoned = true;
    }
  }
  return events;
}

function isDone(player: GolfPlayer): boolean {
  return player.holedOut || player.pickedUp || player.abandoned;
}

function closeHoleIfDone(state: GolfState): GolfEvent[] {
  if (state.phase === 'hole_over' || state.phase === 'over') return [];
  const seated = state.seats
    .map((id) => findPlayer(state, id))
    .filter((player): player is GolfPlayer => player !== undefined);
  const here = seated.filter((player) => player.present);
  // An empty room does not finish holes. Without this the whole course would
  // play itself out in a second while everybody's phone was reconnecting.
  if (here.length === 0) return [];
  if (!here.every((player) => isDone(player) && !player.flight && !player.pending)) return [];

  state.phase = 'hole_over';
  state.timer = state.config.holeOverSeconds;
  return [{ kind: 'hole_over', hole: state.hole }];
}

function nextHole(state: GolfState): GolfEvent[] {
  if (state.hole >= state.config.holes) {
    state.phase = 'over';
    return [{ kind: 'over' }];
  }

  // Honours: the lowest score on the hole just played tees off first. A hole
  // nobody finished ranks last, which puts the players who were there in front.
  const previous = state.hole - 1;
  reorder(state.order, (id) => findPlayer(state, id)?.card[previous] ?? 99);

  state.hole++;
  state.order.index = 0;
  state.order.elapsed = 0;
  for (const player of state.players) {
    player.flight = null;
    player.plan = null;
    player.pending = null;
    placeForHole(state, player);
  }
  state.phase = 'aim';
  const hole = state.course[state.hole - 1];
  const events: GolfEvent[] = [
    { kind: 'hole_started', hole: state.hole, par: hole?.par ?? 4 },
  ];
  const first = currentPlayer(state.order);
  if (first !== null) events.push({ kind: 'turn', playerId: first });
  return events;
}

export function termFor(strokes: number, par: number): HoleTerm {
  const over = strokes - par;
  if (over <= -3) return 'albatross';
  if (over === -2) return 'eagle';
  if (over === -1) return 'birdie';
  if (over === 0) return 'par';
  if (over === 1) return 'bogey';
  if (over === 2) return 'double';
  return 'other';
}

export interface Card {
  readonly playerId: number;
  readonly total: number;
  readonly toPar: number;
  readonly holesPlayed: number;
}

/**
 * The scorecard.
 *
 * Only holes this player finished are counted, on both sides of the sum: a
 * dropped phone must not lose a score, and inventing one for a hole they were
 * never allowed to finish would either flatter or punish them. holesPlayed is
 * reported alongside so the card cannot be read as a total it is not.
 */
export function cardOf(state: GolfState, player: GolfPlayer): Card {
  let total = 0;
  let par = 0;
  let holesPlayed = 0;
  for (let index = 0; index < player.card.length; index++) {
    const strokes = player.card[index];
    if (strokes === null || strokes === undefined) continue;
    total += strokes;
    par += state.course[index]?.par ?? 0;
    holesPlayed++;
  }
  return { playerId: player.id, total, toPar: total - par, holesPlayed };
}

/** Best score first; a player who has played more holes breaks the tie. */
export function leaderboard(state: GolfState): readonly Card[] {
  return state.seats
    .map((id) => findPlayer(state, id))
    .filter((player): player is GolfPlayer => player !== undefined)
    .map((player) => cardOf(state, player))
    .sort((a, b) => a.toPar - b.toPar || b.holesPlayed - a.holesPlayed);
}

export interface PuttBand {
  /** The stroke angle that leaves the ball in the cup, degrees. */
  readonly targetDeg: number;
  readonly minDeg: number;
  readonly maxDeg: number;
  readonly distanceM: number;
}

/**
 * What the practice green draws over the live backstroke bar.
 *
 * Backswing size is the ninety percent of putting that nobody can see, which is
 * the whole reason this screen exists: the bar is the angle being swept right
 * now and the band is the angle that holes it.
 */
export function puttBand(state: GolfState, player: GolfPlayer): PuttBand | null {
  if (player.lie !== 'green') return null;
  const perDeg = PUTT_M_PER_DEG * holeFor(state, player).greenSpeed;
  if (perDeg <= 0) return null;
  const distanceM = distanceToPin(state, player);
  return {
    targetDeg: distanceM / perDeg,
    minDeg: Math.max(PUTT_MIN_DEG, (distanceM - GIMME_RADIUS_M) / perDeg),
    maxDeg: (distanceM + GIMME_RADIUS_M) / perDeg,
    distanceM,
  };
}

export interface Dispersion {
  readonly count: number;
  /** Metres right of the aim line, averaged. */
  readonly meanLine: number;
  readonly sdLine: number;
  readonly meanDistance: number;
  readonly sdDistance: number;
}

/** The range's scatter ellipse, over the shots still in the history. */
export function dispersionOf(player: GolfPlayer): Dispersion {
  const shots = player.shots;
  const count = shots.length;
  if (count === 0) {
    return { count: 0, meanLine: 0, sdLine: 0, meanDistance: 0, sdDistance: 0 };
  }
  let line = 0;
  let distance = 0;
  for (const shot of shots) {
    line += shot.lineErrorM;
    distance += shot.distanceM;
  }
  const meanLine = line / count;
  const meanDistance = distance / count;
  let lineVar = 0;
  let distanceVar = 0;
  for (const shot of shots) {
    lineVar += (shot.lineErrorM - meanLine) ** 2;
    distanceVar += (shot.distanceM - meanDistance) ** 2;
  }
  return {
    count,
    meanLine,
    sdLine: Math.sqrt(lineVar / count),
    meanDistance,
    sdDistance: Math.sqrt(distanceVar / count),
  };
}
