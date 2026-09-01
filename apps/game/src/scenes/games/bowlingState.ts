import { captureGrip, gripQuality, signedRoll, type Grip } from '../../input/grip.js';
import { isFlatGrip } from '../../input/pose.js';
import type { CanonicalAngles, CanonicalVector } from '../../input/types.js';
import { assignSeats, seatOf } from './seats.js';
import {
  advance,
  createTurnOrder,
  currentPlayer,
  setAbsent,
  tickTurn,
  type TurnEvent,
  type TurnOrder,
} from './turnOrder.js';

/**
 * Bowling rules, with no Phaser in sight (ARCHITECTURE.md 8).
 *
 * Three signals and nothing else, because those three are the ones this
 * platform actually has: gravity against the grip the player chose (where they
 * stand), |omega| at the instant the trigger is let go (how hard the ball is
 * rolled), and the per-axis integral of that burst (the hook). No absolute
 * heading is asked for anywhere — yaw drifts and there is nothing to face.
 *
 * The release is a button edge rather than a detected swing on purpose. One of
 * six recorded "hard" swings peaked at 297 deg/s and produced no swing event at
 * all, and a bowling delivery is the gentlest motion in the whole set — a game
 * that silently does nothing on a shot the player felt was good is the single
 * complaint this project hears most. TRIGGER up has no recall problem: it is a
 * mask comparison in InputMapper and the keep-alive carries it even when the
 * sensor stream stalls. Players who never press the trigger are still served,
 * by the burst pairing in `readSwing` below.
 */

/** Which mode is being played. Kept as its own union so this file imports no registry. */
export type BowlingModeKey = 'practice' | 'solo' | 'versus';

/**
 * Where one player is in their own throw.
 *
 * Per player rather than one global phase, because practice is four people
 * rolling at once on four private lanes. A turn-based mode is then the same
 * machine with `canThrow` closed for everybody who is not on turn, rather than
 * a second state machine.
 */
export type BowlingPlayerPhase = 'grip' | 'aim' | 'armed' | 'roll' | 'pins' | 'done';

export type DrillKey = 'seven' | 'ten' | 'split-4-6' | 'split-3-6-10';

export interface Drill {
  readonly key: DrillKey;
  /** Read by a player, so Korean. */
  readonly label: string;
  /** Pin numbers, 1-10, left standing at the start of every attempt. */
  readonly standing: readonly number[];
}

/**
 * The spare drills, in the order the design sets: a corner on each side, then
 * two splits. The corner pins teach stance, and 3-6-10 cannot be cleared by any
 * straight ball, so it is the one that forces a hook.
 */
export const DRILLS: readonly Drill[] = Object.freeze([
  { key: 'seven', label: '7번 핀', standing: [7] },
  { key: 'ten', label: '10번 핀', standing: [10] },
  { key: 'split-4-6', label: '4-6 스플릿', standing: [4, 6] },
  { key: 'split-3-6-10', label: '3-6-10 스플릿', standing: [3, 6, 10] },
]);

export interface BowlingConfig {
  readonly mode: BowlingModeKey;
  /** 10 for a real game; 0 in practice, which is not scored by frames. */
  readonly frames: number;
  /** Whether one player at a time holds the lane. */
  readonly turnBased: boolean;
  readonly turnSeconds: number;
  readonly drills: readonly Drill[];
  /** Clears needed before the drill moves on. */
  readonly drillClears: number;
  /**
   * Balls allowed at one drill before it moves on regardless.
   *
   * The 4-6 split cannot be cleared: the two pins are 0.17 of a lane apart, the
   * ball knocks anything within 0.055 of its line, and they are too far apart
   * to pass the hit on to each other (NEIGHBOUR_RADIUS). Without a cap the
   * practice screen is a room nobody can leave, which is the dead screen this
   * project forbids. The drill is still worth showing — a split you cannot make
   * is a real thing to have seen — so it is capped rather than removed.
   */
  readonly drillAttempts: number;
  /** How many throws are kept with their numbers, for the lane-reading screen. */
  readonly traceCount: number;
  /** Whether the screen draws the numbers behind each throw. */
  readonly diagnostics: boolean;
  /** Milliseconds of stillness before a grip is taken without asking. */
  readonly gripSteadyMs: number;
  /** Nobody waits on the grip screen forever, however badly they are holding it. */
  readonly autoGripSeconds: number;
  /** How long the pins stay down on screen before the next ball. */
  readonly settleSeconds: number;
  /** Seeds the pin-collision jitter. Same seed, same rack, every time. */
  readonly seed: number;
}

const SHARED: Omit<BowlingConfig, 'mode' | 'frames' | 'turnBased' | 'drills' | 'traceCount' | 'diagnostics'> = {
  turnSeconds: 60,
  drillClears: 3,
  drillAttempts: 5,
  gripSteadyMs: 400,
  autoGripSeconds: 8,
  settleSeconds: 1.4,
  seed: 1,
};

/**
 * Practice is not the game with the scoring switched off.
 *
 * It keeps five throws instead of one and turns `diagnostics` on, which is what
 * the lane-reading screen draws: the aim in degrees, the rate at release, and
 * the hook ratio, next to the path each of them produced. A player who cannot
 * see what their delivery measured has no way to tell a bad ball from one the
 * game never saw, and that is the complaint this whole screen answers.
 */
export const BOWLING_MODES: Readonly<Record<BowlingModeKey, BowlingConfig>> = Object.freeze({
  practice: {
    ...SHARED,
    mode: 'practice',
    frames: 0,
    turnBased: false,
    drills: DRILLS,
    traceCount: 5,
    diagnostics: true,
  },
  solo: {
    ...SHARED,
    mode: 'solo',
    frames: 10,
    turnBased: true,
    drills: [],
    traceCount: 1,
    diagnostics: false,
  },
  versus: {
    ...SHARED,
    mode: 'versus',
    frames: 10,
    turnBased: true,
    drills: [],
    traceCount: 1,
    diagnostics: false,
  },
});

/**
 * The config for a lobby mode key. Anything unrecognised is practice, which is
 * the mode that cannot go wrong: no turns to hand out, nothing to score.
 */
export function bowlingConfigFor(mode: string): BowlingConfig {
  if (mode === 'solo') return BOWLING_MODES.solo;
  if (mode === 'versus') return BOWLING_MODES.versus;
  return BOWLING_MODES.practice;
}

// -- The lane -----------------------------------------------------------------

/** Where the ball may start, as a fraction of the lane's width. */
export const STAND_MIN = 0.15;
export const STAND_SPAN = 0.7;
/** Wrist angle, in degrees, that reaches each end of that range. */
export const AIM_LIMIT = 20;
/**
 * Wrist angle ignored around the grip, in degrees.
 *
 * Subtracted rather than cut out. A hand trying to hold still reads 3.3 deg/s
 * and drifts a degree or two, so some deadzone is needed; but a hard one makes
 * the stance jump 0.035 of a lane — about half a pin spacing — the instant the
 * wrist crosses 2 degrees, and a stance that teleports is worse than one that
 * wanders.
 */
export const AIM_DEADZONE = 2;

/** Lane length per second at the slowest and fastest release. */
export const MIN_SPEED = 0.45;
export const MAX_SPEED = 1;
/**
 * Release rates, deg/s, that map onto those speeds.
 *
 * 220 rather than the swing detector's 300: this is the rate at the exact
 * instant of the button edge, not the peak of a burst, and a delivery that
 * peaked at 300 is already well below that by the time the hand opens.
 */
export const SOFT_RATE = 220;
export const HARD_RATE = 1000;
/**
 * Below this the release was not a delivery at all — the phone was barely
 * moving. It still rolls, at the minimum speed, and the screen says so. A
 * silent nothing is indistinguishable from a game that is broken.
 */
export const WEAK_RATE = 120;

/** How far down the lane the ball starts to bend. */
export const HOOK_START = 0.6;
/** Sideways acceleration at full hook, lane widths per second squared. */
export const HOOK_ACCEL = 0.9;
/**
 * Pitch, in degrees, that a hook ratio is measured against at minimum.
 *
 * The ratio is roll over pitch because an arm swing is nearly pure pitch and a
 * wrist turn is nearly pure roll, so their ratio is the part of the delivery
 * the player chose. The floor keeps a delivery with almost no pitch in it —
 * a flick of the wrist, or a phone dropped — from reading as infinite hook.
 */
export const HOOK_PITCH_FLOOR = 30;

/** Outside this the ball is in the gutter and nothing else happens. */
export const GUTTER_LEFT = 0.05;
export const GUTTER_RIGHT = 0.95;

/** Fixed simulation step. The frame rate is unknown and varies; this does not. */
export const ROLL_STEP = 1 / 120;
/** One path sample per this many steps, which is 30 Hz worth of trail. */
const PATH_EVERY = 4;
/** A stutter must not be integrated whole. */
const MAX_STEPS_PER_FRAME = 60;

export const PIN_COUNT = 10;
/** Centre-to-centre pin spacing, as a fraction of the lane's width. */
export const PIN_SPACING = 0.085;
/** The rack is equilateral, so the rows sit a spacing times cos 30 apart. */
const ROW_GAP = PIN_SPACING * Math.cos(Math.PI / 6);
/** Where the head pin stands; the foul line is y = 0. */
export const PIN_HEAD_Y = 1;
const PIN_ROWS = 4;
/** The ball is done once it is past the back row. */
const DECK_END = PIN_HEAD_Y + PIN_ROWS * ROW_GAP;

export interface PinSpot {
  readonly x: number;
  readonly y: number;
  readonly row: number;
}

/** Index 0 is pin 1, index 9 is pin 10 — the numbering a bowler already knows. */
export const PIN_SPOTS: readonly PinSpot[] = buildRack();

function buildRack(): readonly PinSpot[] {
  const spots: PinSpot[] = [];
  for (let row = 0; row < PIN_ROWS; row++) {
    for (let place = 0; place <= row; place++) {
      spots.push({
        x: 0.5 + (place - row / 2) * PIN_SPACING,
        y: PIN_HEAD_Y + row * ROW_GAP,
        row,
      });
    }
  }
  return Object.freeze(spots);
}

/** How close the ball's line has to pass for a pin to go down on its own. */
export const HIT_RADIUS = 0.055;
/**
 * How far a falling pin can reach. Exactly the six neighbours of a triangular
 * lattice at PIN_SPACING: the next ring out is spacing times root three, 0.147.
 */
export const NEIGHBOUR_RADIUS = 0.11;

/**
 * The three collision constants, and why they are not the design's.
 *
 * The design proposed a 0.6 transfer against a 0.25 threshold, which caps the
 * chain at two hops from a full-energy hit (0.6, then 0.36, then 0.216 — under
 * the threshold). The 7 pin is three hops from the pocket, so no shot could
 * ever strike. It also had the ball arrive at every row at full strength, and a
 * line straight down the middle passes dead centre through pins 1, 5 and 8 at
 * once, which made the centre line an automatic strike — the opposite of the
 * nose hit, which in bowling is the classic way to leave a split.
 *
 * So the ball spends itself as it goes (LOSS per pin it knocks directly), and
 * the numbers were fitted to two outcomes any bowler would recognise:
 *   - a hooking ball into the 1-3 pocket takes all ten;
 *   - a straight ball dead on the nose leaves the 4-6-7-10, the Big Four.
 * Both hold at either end of the +-8% jitter, so neither is a coincidence of
 * one seed.
 */
export const TRANSFER = 0.7;
export const KNOCK_THRESHOLD = 0.18;
const PUNCH_LOSS = 0.6;
/** Collision jitter, so two identical racks do not fall identically. */
const JITTER = 0.08;
/** The chain is at most three hops long: head pin to a corner. */
const WAVES = 3;

// -- What a throw was ---------------------------------------------------------

export interface LanePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Everything measurable about one delivery.
 *
 * This is the practice screen's whole reason to exist, so it carries the raw
 * axis integrals as well as the ratio derived from them: a player whose hook is
 * pinned at 1.00 needs to see that their pitch was 12 degrees, not that the
 * hook was large.
 */
export interface ThrowReading {
  readonly aimDeg: number;
  readonly standX: number;
  /** |omega| at the instant of release, deg/s. */
  readonly rate: number;
  readonly rollDeg: number;
  readonly pitchDeg: number;
  /** -1 (bends hard left) to 1 (bends hard right). */
  readonly hook: number;
  readonly speed: number;
  /** Whether this came from the trigger or from the burst-pairing fallback. */
  readonly source: 'release' | 'swing';
  /** The release was too slow to be a delivery; it rolled at minimum speed. */
  readonly weak: boolean;
  /** How well the grip this was measured against can see a wrist turn, 0 to 1. */
  readonly gripQuality: number;
}

export interface Trace extends ThrowReading {
  readonly path: readonly LanePoint[];
  readonly gutter: boolean;
  readonly pinsDown: number;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  readonly speed: number;
  readonly hook: number;
}

interface Burst {
  readonly rate: number;
  readonly rotation: CanonicalAngles;
}

export interface BowlingPlayer {
  readonly id: number;
  /** False while this phone is not answering. Kept, never deleted. */
  present: boolean;
  grip: Grip | null;
  gripQuality: number;
  gripWait: number;
  /** Recent `up` readings, averaged into a grip once the hand settles. */
  recent: CanonicalVector[];
  /** A flat grip has been refused and not yet corrected; do not nag twice. */
  flatRefused: boolean;
  phase: BowlingPlayerPhase;
  /** Live wrist angle. Frozen into `lockedAim` the moment the throw is armed. */
  aimDeg: number;
  standX: number;
  lockedAim: number;
  lockedStandX: number;
  /** True where a pin is still standing. */
  pins: boolean[];
  /** Pinfall per ball, one array per frame started. */
  frames: number[][];
  score: number;
  ball: Ball | null;
  /** Left-over time from the last frame, so the fixed step never loses any. */
  accumulator: number;
  settle: number;
  path: LanePoint[];
  /** Where the ball's line crossed each pin row. */
  crossings: number[];
  throws: number;
  lastThrow: ThrowReading | null;
  traces: Trace[];
  /** Index into config.drills. */
  drill: number;
  drillClears: number;
  drillAttempts: number;
  /** The unpaired burst waiting to become a delivery, and when it arrived. */
  backswing: Burst | null;
  backswingAt: number;
}

export interface BowlingState {
  readonly config: BowlingConfig;
  /** Frozen at match start. Never an index into a live roster. */
  readonly seats: readonly number[];
  turn: TurnOrder | null;
  over: boolean;
  players: BowlingPlayer[];
}

export type BowlingEvent =
  | { readonly kind: 'grip_set'; readonly playerId: number; readonly quality: number }
  | { readonly kind: 'grip_refused'; readonly playerId: number }
  | { readonly kind: 'armed'; readonly playerId: number }
  | { readonly kind: 'released'; readonly playerId: number; readonly weak: boolean }
  | { readonly kind: 'gutter'; readonly playerId: number }
  | {
      readonly kind: 'pins';
      readonly playerId: number;
      readonly down: number;
      readonly standing: number;
    }
  | { readonly kind: 'strike'; readonly playerId: number }
  | { readonly kind: 'spare'; readonly playerId: number }
  | {
      readonly kind: 'frame';
      readonly playerId: number;
      readonly frame: number;
      readonly score: number;
    }
  | {
      readonly kind: 'drill_cleared';
      readonly playerId: number;
      readonly drill: DrillKey;
      readonly clears: number;
    }
  | {
      readonly kind: 'drill_next';
      readonly playerId: number;
      readonly drill: DrillKey | null;
    }
  | { readonly kind: 'turn'; readonly playerId: number }
  | { readonly kind: 'timed_out'; readonly playerId: number }
  | { readonly kind: 'over' };

// -- Setting up ---------------------------------------------------------------

export function createBowling(
  mode: string,
  playerIds: readonly number[],
  overrides: Partial<BowlingConfig> = {},
): BowlingState {
  const config: BowlingConfig = { ...bowlingConfigFor(mode), ...overrides };
  const seats = assignSeats(playerIds);
  const state: BowlingState = {
    config,
    seats,
    turn: config.turnBased ? createTurnOrder(seats, config.turnSeconds) : null,
    over: false,
    players: [],
  };
  syncPlayers(
    state,
    seats.map((id) => ({ id, present: true })),
  );
  return state;
}

export function findPlayer(state: BowlingState, id: number): BowlingPlayer | undefined {
  return state.players.find((player) => player.id === id);
}

function newPlayer(state: BowlingState, id: number, present: boolean): BowlingPlayer {
  return {
    id,
    present,
    grip: null,
    gripQuality: 0,
    gripWait: 0,
    recent: [],
    flatRefused: false,
    phase: 'grip',
    aimDeg: 0,
    standX: STAND_MIN + STAND_SPAN / 2,
    lockedAim: 0,
    lockedStandX: STAND_MIN + STAND_SPAN / 2,
    pins: rackFor(state, 0),
    frames: state.config.frames > 0 ? [[]] : [],
    score: 0,
    ball: null,
    accumulator: 0,
    settle: 0,
    path: [],
    crossings: [],
    throws: 0,
    lastThrow: null,
    traces: [],
    drill: 0,
    drillClears: 0,
    drillAttempts: 0,
    backswing: null,
    backswingAt: 0,
  };
}

/**
 * Bring the roster in line with who is connected.
 *
 * Everybody already here keeps their record — grip, frames, score, drill
 * progress. A phone that drops is marked absent and the turn steps over it; it
 * is not deleted, so nothing it earned is lost and it resumes where it was.
 * A phone that joins a match already in progress gets a record but no seat, and
 * `canThrow` keeps it out of the turn-based modes until the next match.
 */
export function syncPlayers(
  state: BowlingState,
  roster: ReadonlyArray<{ readonly id: number; readonly present: boolean }>,
): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  const kept: BowlingPlayer[] = [];

  for (const entry of roster) {
    const existing = findPlayer(state, entry.id);
    if (existing) {
      existing.present = entry.present;
      kept.push(existing);
    } else {
      kept.push(newPlayer(state, entry.id, entry.present));
    }
  }
  // Anybody the roster forgot entirely is still a player of this match; their
  // score card stays on screen and their seat stays theirs.
  for (const player of state.players) {
    if (!kept.includes(player)) {
      player.present = false;
      kept.push(player);
    }
  }
  state.players = kept;

  if (state.turn) {
    for (const player of state.players) {
      events.push(...fromTurn(state, setAbsent(state.turn, player.id, !player.present)));
    }
  }
  return events;
}

function fromTurn(state: BowlingState, turnEvents: readonly TurnEvent[]): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  for (const event of turnEvents) {
    if (event.kind === 'turn_changed') {
      events.push({ kind: 'turn', playerId: event.playerId });
      continue;
    }
    if (event.kind !== 'turn_timed_out') continue;
    // The turn is handed on, but the frame is not forfeited: an expired turn is
    // usually a phone put down, and charging it a zero would mean coming back to
    // a card somebody else's inattention had written on. Whatever they had armed
    // is dropped, so the ball cannot arrive on a lane that has moved on.
    const player = findPlayer(state, event.playerId);
    if (player && (player.phase === 'armed' || player.phase === 'aim')) {
      player.phase = 'aim';
      player.backswing = null;
    }
    events.push({ kind: 'timed_out', playerId: event.playerId });
  }
  return events;
}

/** Whether this player may arm a throw right now. */
export function canThrow(state: BowlingState, id: number): boolean {
  const player = findPlayer(state, id);
  if (!player || player.phase === 'done' || state.over) return false;
  if (!state.config.turnBased) return true;
  if (seatOf(state.seats, id) === null) return false;
  return state.turn !== null && currentPlayer(state.turn) === id;
}

// -- Reading the phone --------------------------------------------------------

/**
 * A gravity reading: kept for the grip capture, and read as aim once there is
 * a grip to read it against.
 */
export function readPose(state: BowlingState, id: number, up: CanonicalVector): void {
  const player = findPlayer(state, id);
  if (!player) return;

  player.recent.push(up);
  // Half a second at 60 Hz, which is what captureGrip's rejection window wants.
  if (player.recent.length > 30) player.recent.shift();

  if (player.flatRefused && !isFlatGrip(up)) player.flatRefused = false;
  if (!player.grip) return;

  player.aimDeg = signedRoll(player.grip, up);
  // The aim is frozen at the moment the throw is armed, so the wrist turning
  // through the delivery does not also move the feet.
  if (player.phase === 'aim') player.standX = standXFor(player.aimDeg);
}

/**
 * Stillness, which is how a grip gets taken without asking for a button press.
 *
 * `stalled` is the reason this is not just `still`: a phone that stopped
 * sending reads perfectly steady and is not being held at all, and calibrating
 * off its last frame would fix the whole game to a pose nobody chose.
 */
export function readStillness(
  state: BowlingState,
  id: number,
  reading: { readonly still: boolean; readonly steadyMs: number; readonly stalled: boolean },
  nowMs: number,
): BowlingEvent[] {
  const player = findPlayer(state, id);
  if (!player || player.phase !== 'grip' || reading.stalled) return [];
  if (!reading.still || reading.steadyMs < state.config.gripSteadyMs) return [];
  return takeGrip(state, player, true, nowMs);
}

/**
 * Adopt the hold this player is using.
 *
 * `refusable` is the difference between the stillness gate offering a grip and
 * the timeout giving up on them. A phone held flat has gravity along the axis
 * every wrist turn happens about, so the stance would barely move and the hook
 * would read enormous for a delivery that did nothing unusual. Worth refusing
 * once, with a reason. Never worth leaving somebody in front of a screen that
 * will not proceed.
 */
function takeGrip(
  state: BowlingState,
  player: BowlingPlayer,
  refusable: boolean,
  nowMs: number,
): BowlingEvent[] {
  if (player.recent.length === 0) return [];
  const grip = captureGrip(player.recent, nowMs);

  if (refusable && isFlatGrip(grip.up)) {
    if (player.flatRefused) return [];
    player.flatRefused = true;
    return [{ kind: 'grip_refused', playerId: player.id }];
  }

  player.grip = grip;
  player.gripQuality = gripQuality(grip.up);
  player.flatRefused = false;
  player.phase = 'aim';
  player.aimDeg = 0;
  player.standX = standXFor(0);
  return [{ kind: 'grip_set', playerId: player.id, quality: player.gripQuality }];
}

/** Wrist angle to a place on the lane. See AIM_DEADZONE for the subtraction. */
export function standXFor(aimDeg: number): number {
  const clamped = Math.min(AIM_LIMIT, Math.max(-AIM_LIMIT, aimDeg));
  const span = AIM_LIMIT - AIM_DEADZONE;
  const past = Math.sign(clamped) * Math.max(0, Math.abs(clamped) - AIM_DEADZONE);
  return STAND_MIN + STAND_SPAN * ((past / span + 1) / 2);
}

/** The trigger going down: the aim is locked and the backswing may begin. */
export function pressTrigger(state: BowlingState, id: number): BowlingEvent[] {
  const player = findPlayer(state, id);
  if (!player || player.phase !== 'aim' || !canThrow(state, id)) return [];
  lockAim(player);
  player.phase = 'armed';
  return [{ kind: 'armed', playerId: player.id }];
}

function lockAim(player: BowlingPlayer): void {
  player.lockedAim = player.aimDeg;
  player.lockedStandX = standXFor(player.aimDeg);
  player.standX = player.lockedStandX;
}

/** The trigger being let go: the exact instant the ball leaves the hand. */
export function release(
  state: BowlingState,
  id: number,
  rate: number,
  rotation: CanonicalAngles,
): BowlingEvent[] {
  const player = findPlayer(state, id);
  if (!player || player.phase !== 'armed' || !canThrow(state, id)) return [];
  return startRoll(state, player, { rate, rotation }, 'release');
}

/**
 * The fallback for a player who never touches the trigger.
 *
 * A delivery is two bursts: the arm going back, then the arm coming through.
 * The detector fires on both and the backswing arrives first, so taking the
 * first burst would roll the ball backwards at the speed of a windup. The first
 * burst is therefore held, and the next one inside PAIR_MS is the delivery. If
 * no second burst arrives, GIVE_UP_MS rolls the held one rather than swallowing
 * the shot — a half swing that never reversed is still a throw the player made.
 *
 * The design put this in an input/StrokeGate.ts. It lives here instead because
 * this file may not import anything the human has not wired yet, and because
 * the pairing is a rule about what counts as a throw, which is exactly what
 * this module is for. The scene feeds it swing events; nothing else changes.
 */
export function readSwing(
  state: BowlingState,
  id: number,
  peakRate: number,
  rotation: CanonicalAngles,
  nowMs: number,
): BowlingEvent[] {
  const player = findPlayer(state, id);
  if (!player || player.phase !== 'aim' || !canThrow(state, id)) return [];

  const held = player.backswing;
  if (held && nowMs - player.backswingAt <= PAIR_MS) {
    player.backswing = null;
    return startRoll(state, player, { rate: peakRate, rotation }, 'swing');
  }

  // Either the first burst of a delivery or one so late that the burst before
  // it was something else entirely. Both mean: this is the backswing now.
  player.backswing = { rate: peakRate, rotation };
  player.backswingAt = nowMs;
  // The feet stop moving when the arm starts, exactly as the trigger would.
  lockAim(player);
  return [];
}

/** How long after a backswing a burst still counts as the delivery. */
export const PAIR_MS = 1200;
/** After this, a held backswing is rolled rather than thrown away. */
export const GIVE_UP_MS = 1500;

export function speedFor(rate: number): number {
  const normalised = Math.min(1, Math.max(0, (rate - SOFT_RATE) / (HARD_RATE - SOFT_RATE)));
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * normalised;
}

/**
 * How much the ball bends, -1 to 1.
 *
 * Positive roll is the right edge going down and bends the ball right, the same
 * direction that leaning the wrist right moves the feet. There is nothing in
 * this platform that knows which hand the phone is in, so a mapping that
 * matched a right-hander's hook would be backwards for everybody else; a
 * consistent "turn it that way, it goes that way" is learnable by both.
 */
export function hookFor(rotation: CanonicalAngles): number {
  const pitch = Math.max(Math.abs(rotation.pitch), HOOK_PITCH_FLOOR);
  return Math.min(1, Math.max(-1, rotation.roll / pitch));
}

function startRoll(
  state: BowlingState,
  player: BowlingPlayer,
  burst: Burst,
  source: 'release' | 'swing',
): BowlingEvent[] {
  const weak = burst.rate < WEAK_RATE;
  const speed = speedFor(burst.rate);
  const hook = hookFor(burst.rotation);

  player.lastThrow = {
    aimDeg: player.lockedAim,
    standX: player.lockedStandX,
    rate: burst.rate,
    rollDeg: burst.rotation.roll,
    pitchDeg: burst.rotation.pitch,
    hook,
    speed,
    source,
    weak,
    gripQuality: player.gripQuality,
  };
  player.ball = { x: player.lockedStandX, y: 0, vx: 0, speed, hook };
  player.path = [{ x: player.lockedStandX, y: 0 }];
  player.crossings = [];
  player.accumulator = 0;
  player.backswing = null;
  player.phase = 'roll';
  // The shot clock is per ball, not per frame: a frame is two balls and a
  // player who has just rolled one is plainly still there.
  if (state.turn) state.turn.elapsed = 0;
  return [{ kind: 'released', playerId: player.id, weak }];
}

// -- The roll -----------------------------------------------------------------

/**
 * One frame of the game.
 *
 * `nowMs` is only ever compared against the timestamps of incoming bursts, for
 * the pairing fallback. Everything else runs on `dt`, and the physics runs on a
 * fixed step inside it, so a 15 Hz screen and a 100 Hz screen roll the same
 * ball.
 */
export function stepBowling(state: BowlingState, dt: number, nowMs: number): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  if (state.over) return events;

  for (const player of state.players) {
    if (player.phase === 'grip') {
      events.push(...tickGrip(state, player, dt, nowMs));
      continue;
    }
    if (player.phase === 'aim') {
      events.push(...tickPairing(state, player, nowMs));
      continue;
    }
    if (player.phase === 'roll') {
      events.push(...tickRoll(state, player, dt));
      continue;
    }
    if (player.phase === 'pins') {
      player.settle -= dt;
      if (player.settle <= 0) events.push(...nextBall(state, player));
    }
  }

  if (state.turn) events.push(...fromTurn(state, tickTurn(state.turn, dt)));
  events.push(...checkOver(state));
  return events;
}

function tickGrip(
  state: BowlingState,
  player: BowlingPlayer,
  dt: number,
  nowMs: number,
): BowlingEvent[] {
  // A phone that is not answering is not keeping anybody waiting; its clock
  // starts again when it comes back.
  if (!player.present) return [];
  player.gripWait += dt;
  if (player.gripWait < state.config.autoGripSeconds) return [];
  // Out of patience, so the flat grip is taken rather than refused again.
  return takeGrip(state, player, false, nowMs);
}

function tickPairing(state: BowlingState, player: BowlingPlayer, nowMs: number): BowlingEvent[] {
  const held = player.backswing;
  if (!held) return [];
  // The rule the shot clock already applies to an armed throw, applied to the
  // other way a turn ends: a ball must not arrive on a lane that has moved on.
  // A phone that drops between its backswing and its delivery has had the turn
  // passed over it by setAbsent, and firing the held burst anyway writes a ball
  // into a frame its owner never finished throwing.
  if (!player.present) {
    player.backswing = null;
    return [];
  }
  if (nowMs - player.backswingAt < GIVE_UP_MS) return [];
  player.backswing = null;
  return startRoll(state, player, held, 'swing');
}

function tickRoll(state: BowlingState, player: BowlingPlayer, dt: number): BowlingEvent[] {
  const ball = player.ball;
  if (!ball) return [];

  player.accumulator += dt;
  let steps = 0;
  while (player.accumulator >= ROLL_STEP && steps < MAX_STEPS_PER_FRAME) {
    player.accumulator -= ROLL_STEP;
    steps++;
    const before = { x: ball.x, y: ball.y };

    ball.y += ball.speed * ROLL_STEP;
    // The bend is back-of-the-lane only, which is what a hook looks like: the
    // ball skids straight, then grips and turns in.
    const grip = Math.max(0, (ball.y - HOOK_START) / (1 - HOOK_START));
    ball.vx += ball.hook * HOOK_ACCEL * grip * ROLL_STEP;
    ball.x += ball.vx * ROLL_STEP;

    recordCrossings(player, before, ball);
    // Sampled by how far down the lane the ball has gone, not by how many steps
    // this frame has taken: `steps` restarts every frame, so at 60 Hz it only
    // ever reached 2 and the trail the practice screen overlays was the two ends
    // of a straight line — which draws a hook as a diagonal.
    if (ball.y >= player.path.length * PATH_EVERY * ROLL_STEP * ball.speed) {
      player.path.push({ x: ball.x, y: ball.y });
    }

    if (ball.x <= GUTTER_LEFT || ball.x >= GUTTER_RIGHT) {
      player.path.push({ x: ball.x, y: ball.y });
      return finishRoll(state, player, true);
    }
    if (ball.y >= DECK_END) {
      player.path.push({ x: ball.x, y: ball.y });
      return finishRoll(state, player, false);
    }
  }
  return [];
}

/** Where the ball's line sat as it passed each row of pins. */
function recordCrossings(player: BowlingPlayer, before: LanePoint, after: Ball): void {
  for (let row = player.crossings.length; row < PIN_ROWS; row++) {
    const y = PIN_HEAD_Y + row * ROW_GAP;
    if (after.y < y) break;
    const span = after.y - before.y;
    const t = span <= 0 ? 1 : (y - before.y) / span;
    player.crossings.push(before.x + (after.x - before.x) * t);
  }
}

function finishRoll(state: BowlingState, player: BowlingPlayer, gutter: boolean): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  const standing = [...player.pins];
  const knocked = gutter
    ? standing.map(() => false)
    : knockPins(standing, player.crossings, seededRandom(throwSeed(state, player)));

  let down = 0;
  for (let pin = 0; pin < PIN_COUNT; pin++) {
    if (!knocked[pin]) continue;
    player.pins[pin] = false;
    down++;
  }

  player.throws++;
  player.ball = null;
  player.phase = 'pins';
  player.settle = state.config.settleSeconds;

  const reading = player.lastThrow;
  if (reading) {
    player.traces.unshift({ ...reading, path: [...player.path], gutter, pinsDown: down });
    while (player.traces.length > state.config.traceCount) player.traces.pop();
  }

  if (gutter) events.push({ kind: 'gutter', playerId: player.id });
  events.push({
    kind: 'pins',
    playerId: player.id,
    down,
    standing: player.pins.filter(Boolean).length,
  });
  events.push(...recordBall(state, player, down));
  return events;
}

/**
 * The rack this ball falls on, as a seed.
 *
 * The design's frame*100+ball, with the mode's seed added so a whole session
 * can be replayed and the practice drills — which have no frame number — use
 * the throw count in its place. Nothing here calls Math.random.
 */
function throwSeed(state: BowlingState, player: BowlingPlayer): number {
  const frame = state.config.frames > 0 ? player.frames.length : player.throws + 1;
  const ball = currentFrame(player)?.length ?? 0;
  return state.config.seed + player.id * 10_000 + frame * 100 + ball;
}

function currentFrame(player: BowlingPlayer): number[] | undefined {
  return player.frames[player.frames.length - 1];
}

// -- Pins ---------------------------------------------------------------------

/**
 * Which of the standing pins this ball takes down.
 *
 * `lineX` is where the ball crossed each row, so a hooking ball presents a
 * different line to the back row than to the head pin — which is the entire
 * reason a hook strikes and a straight ball leaves corners. `rng` is a
 * parameter rather than Math.random so a rack can be replayed exactly.
 */
export function knockPins(
  standing: readonly boolean[],
  lineX: readonly number[],
  rng: () => number,
): boolean[] {
  const down = new Array<boolean>(PIN_COUNT).fill(false);
  const energy = new Array<number>(PIN_COUNT).fill(0);
  let wave: number[] = [];

  // The ball spends itself on every pin it hits, so it arrives at the back row
  // weaker than it met the head pin. Without this a straight ball passes dead
  // centre through pins 1, 5 and 8 at full strength and strikes every time.
  let punch = 1;
  for (let row = 0; row < PIN_ROWS; row++) {
    const line = lineX[row];
    if (line === undefined) break;
    const hits: number[] = [];
    for (let pin = 0; pin < PIN_COUNT; pin++) {
      const spot = PIN_SPOTS[pin];
      if (!spot || spot.row !== row || !standing[pin] || down[pin]) continue;
      const miss = Math.abs(line - spot.x);
      if (miss > HIT_RADIUS) continue;
      hits.push(pin);
      down[pin] = true;
      energy[pin] = punch * (1 - miss / HIT_RADIUS);
    }
    wave.push(...hits);
    punch *= PUNCH_LOSS ** hits.length;
  }

  for (let round = 0; round < WAVES && wave.length > 0; round++) {
    const next = new Map<number, number>();
    for (const source of wave) {
      const from = PIN_SPOTS[source];
      const carried = energy[source];
      if (!from || carried === undefined) continue;
      for (let pin = 0; pin < PIN_COUNT; pin++) {
        const spot = PIN_SPOTS[pin];
        if (!spot || pin === source || !standing[pin] || down[pin]) continue;
        if (Math.hypot(spot.x - from.x, spot.y - from.y) > NEIGHBOUR_RADIUS) continue;
        const passed = carried * TRANSFER * (1 + (rng() * 2 - 1) * JITTER);
        if (passed <= KNOCK_THRESHOLD) continue;
        next.set(pin, Math.max(next.get(pin) ?? 0, passed));
      }
    }
    wave = [];
    // Applied after the whole wave, so a pin knocked from two sides carries the
    // harder of the two onward rather than whichever was iterated first.
    for (const [pin, received] of next) {
      down[pin] = true;
      energy[pin] = received;
      wave.push(pin);
    }
    wave.sort((a, b) => a - b);
  }
  return down;
}

/** The standard LCG this repo already uses in tests, exposed so rolls replay. */
export function seededRandom(seed: number): () => number {
  let state = Math.trunc(Math.abs(seed)) >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function fullRack(): boolean[] {
  return new Array<boolean>(PIN_COUNT).fill(true);
}

/** The rack this drill sets up, or all ten where there is no drill. */
function rackFor(state: BowlingState, drillIndex: number): boolean[] {
  const drill = state.config.drills[drillIndex];
  if (!drill) return fullRack();
  const pins = new Array<boolean>(PIN_COUNT).fill(false);
  for (const number of drill.standing) pins[number - 1] = true;
  return pins;
}

// -- Scoring ------------------------------------------------------------------

/**
 * Ten-pin scoring, in full: a strike is ten plus the next two balls, a spare is
 * ten plus the next one, and the tenth frame runs to three balls when it earns
 * them. Frames are flattened first because that is what the bonus rules index —
 * "the next two balls" crosses a frame boundary and sometimes two.
 */
export function scoreFrames(frames: ReadonlyArray<readonly number[]>): number {
  const rolls = frames.flat();
  let total = 0;
  let at = 0;
  for (let frame = 0; frame < 10; frame++) {
    const first = rolls[at];
    if (first === undefined) break;
    if (first === PIN_COUNT) {
      total += PIN_COUNT + (rolls[at + 1] ?? 0) + (rolls[at + 2] ?? 0);
      at += 1;
      continue;
    }
    const second = rolls[at + 1] ?? 0;
    total += first + second === PIN_COUNT ? PIN_COUNT + (rolls[at + 2] ?? 0) : first + second;
    at += 2;
  }
  return total;
}

/**
 * The running total to print under each frame, or null where the bonus balls
 * have not been rolled yet. A scoreboard that guesses at a strike's value and
 * then corrects itself is how a player loses track of what they are watching.
 */
export function frameScores(frames: ReadonlyArray<readonly number[]>): Array<number | null> {
  const rolls = frames.flat();
  const out: Array<number | null> = [];
  let total = 0;
  let at = 0;
  for (let frame = 0; frame < 10; frame++) {
    const first = rolls[at];
    if (first === undefined) break;
    if (first === PIN_COUNT) {
      const bonus = [rolls[at + 1], rolls[at + 2]];
      if (bonus.some((ball) => ball === undefined)) {
        out.push(null);
        break;
      }
      total += PIN_COUNT + (bonus[0] ?? 0) + (bonus[1] ?? 0);
      out.push(total);
      at += 1;
      continue;
    }
    const second = rolls[at + 1];
    if (second === undefined) {
      out.push(null);
      break;
    }
    if (first + second === PIN_COUNT) {
      const bonus = rolls[at + 2];
      if (bonus === undefined) {
        out.push(null);
        break;
      }
      total += PIN_COUNT + bonus;
    } else {
      total += first + second;
    }
    out.push(total);
    at += 2;
  }
  return out;
}

// -- Frames and turns ---------------------------------------------------------

function recordBall(state: BowlingState, player: BowlingPlayer, down: number): BowlingEvent[] {
  if (state.config.frames === 0) return recordDrill(state, player);

  const frame = currentFrame(player);
  if (!frame) return [];
  frame.push(down);
  player.score = scoreFrames(player.frames);

  const events: BowlingEvent[] = [];
  const standing = player.pins.filter(Boolean).length;
  // Judged by what fell, not by which ball it was: the tenth frame throws its
  // second and third balls at a fresh rack, and those are strikes too.
  if (down === PIN_COUNT) events.push({ kind: 'strike', playerId: player.id });
  else if (standing === 0 && down > 0) events.push({ kind: 'spare', playerId: player.id });
  return events;
}

function recordDrill(state: BowlingState, player: BowlingPlayer): BowlingEvent[] {
  const drill = state.config.drills[player.drill];
  if (!drill) return [];

  const events: BowlingEvent[] = [];
  player.drillAttempts++;
  if (player.pins.every((pin) => !pin)) {
    player.drillClears++;
    events.push({
      kind: 'drill_cleared',
      playerId: player.id,
      drill: drill.key,
      clears: player.drillClears,
    });
  }
  return events;
}

/** Whether the frame in progress is finished, by the ten-pin rules. */
function frameComplete(player: BowlingPlayer, tenth: boolean): boolean {
  const frame = currentFrame(player);
  if (!frame) return true;
  const standing = player.pins.filter(Boolean).length;

  if (!tenth) return frame.length >= 2 || standing === 0;
  if (frame.length >= 3) return true;
  if (frame.length < 2) return false;
  // A third ball is earned by a strike on the first or ten across the first two;
  // after a strike the second ball is thrown at a fresh rack, so the two cannot
  // simply be added.
  const [first, second] = [frame[0] ?? 0, frame[1] ?? 0];
  return first !== PIN_COUNT && first + second !== PIN_COUNT;
}

function nextBall(state: BowlingState, player: BowlingPlayer): BowlingEvent[] {
  const events: BowlingEvent[] = [];

  if (state.config.frames === 0) {
    events.push(...advanceDrill(state, player));
    player.phase = player.phase === 'done' ? 'done' : 'aim';
    return events;
  }

  const tenth = player.frames.length >= state.config.frames;
  if (!frameComplete(player, tenth)) {
    // A cleared rack inside the tenth frame stands the pins back up; anywhere
    // else the frame would already be over.
    if (player.pins.every((pin) => !pin)) player.pins = fullRack();
    player.phase = 'aim';
    return events;
  }

  events.push({
    kind: 'frame',
    playerId: player.id,
    frame: player.frames.length,
    score: player.score,
  });

  if (tenth) {
    player.phase = 'done';
  } else {
    player.frames.push([]);
    player.pins = fullRack();
    player.phase = 'aim';
  }
  // Only the player who holds the turn may hand it on. A phone that dropped
  // while its ball was still rolling has already had the turn passed over it,
  // and advancing again when that ball lands takes the turn off whoever has it
  // now, before they have thrown.
  if (state.turn && currentPlayer(state.turn) === player.id) {
    events.push(...fromTurn(state, advance(state.turn)));
  }
  return events;
}

function advanceDrill(state: BowlingState, player: BowlingPlayer): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  const done =
    player.drillClears >= state.config.drillClears ||
    player.drillAttempts >= state.config.drillAttempts;

  if (done) {
    player.drill++;
    player.drillClears = 0;
    player.drillAttempts = 0;
    const next = state.config.drills[player.drill];
    events.push({ kind: 'drill_next', playerId: player.id, drill: next?.key ?? null });
    if (!next) {
      player.phase = 'done';
      return events;
    }
  }
  player.pins = rackFor(state, player.drill);
  return events;
}

/**
 * Whether the match is finished.
 *
 * Every player who is here has to be done, and somebody has to have finished.
 * Waiting on a phone that left would hang the screen forever; requiring nobody
 * at all to have finished would end the match the moment the room emptied,
 * before anyone had a card worth showing. A player who dropped out keeps their
 * seat, their frames and their score in the final table.
 */
function checkOver(state: BowlingState): BowlingEvent[] {
  if (state.over) return [];
  const contenders = state.config.turnBased
    ? state.players.filter((player) => seatOf(state.seats, player.id) !== null)
    : state.players;

  const finished = contenders.filter((player) => player.phase === 'done');
  if (finished.length === 0) return [];
  const here = contenders.filter((player) => player.present);
  if (!here.every((player) => player.phase === 'done')) return [];

  state.over = true;
  return [{ kind: 'over' }];
}

// -- What the screen draws ----------------------------------------------------

/** Highest score first; ties keep their seating order. */
export function standings(state: BowlingState): BowlingPlayer[] {
  const seated = state.players.filter((player) => seatOf(state.seats, player.id) !== null);
  return seated.sort((a, b) => {
    const bySeat = (seatOf(state.seats, a.id) ?? 0) - (seatOf(state.seats, b.id) ?? 0);
    return b.score - a.score || bySeat;
  });
}

export function leader(state: BowlingState): BowlingPlayer | null {
  return standings(state)[0] ?? null;
}

/** The drill this player is on, or null once they are through them all. */
export function currentDrill(state: BowlingState, player: BowlingPlayer): Drill | null {
  return state.config.drills[player.drill] ?? null;
}

/** Which frame and ball this player is about to roll, for the scoreboard. */
export function upNext(player: BowlingPlayer): { frame: number; ball: number } {
  return { frame: player.frames.length, ball: (currentFrame(player)?.length ?? 0) + 1 };
}
