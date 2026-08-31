import { POSES, isFlatGrip, poseCloseness, poseOffByDeg, posesUsableFor } from '../../input/pose.js';
import type { NamedPose } from '../../input/pose.js';
import type { CanonicalVector } from '../../input/types.js';

/**
 * Freeze Frame rules, with no Phaser in sight (ARCHITECTURE.md 8).
 *
 * The screen calls a pose and everyone has to hold it. What makes it a game
 * rather than a reading is the holding: an angle sampled at one instant scores
 * a hand that swept through the right position on its way somewhere else, and
 * fails one that arrived early and then breathed. So the rule is dwell — the
 * angle has to stay inside the tolerance continuously — and the first player to
 * manage it scores the most.
 */

export type FreezePhase = 'ready' | 'holding' | 'reveal' | 'over';

export interface FreezeConfig {
  readonly hearts: number;
  readonly roundSeconds: number;
  readonly revealSeconds: number;
  readonly toleranceStart: number;
  readonly toleranceFloor: number;
  readonly freezeMsStart: number;
  readonly freezeMsEnd: number;
  /** Rounds survived before the difficulty stops climbing. */
  readonly tightenOver: number;
  /** A pose reading older than this is not evidence of anything. */
  readonly poseFreshMs: number;
  /** Readings averaged into a reference grip, about half a second. */
  readonly calibrateFrames: number;
  /** Nobody should be stuck on the setup screen because a prompt was missed. */
  readonly autoCalibrateSeconds: number;
}

export const DEFAULT_FREEZE_CONFIG: FreezeConfig = {
  hearts: 3,
  roundSeconds: 3.5,
  revealSeconds: 1.6,
  toleranceStart: 45,
  toleranceFloor: 22,
  freezeMsStart: 500,
  freezeMsEnd: 1200,
  tightenOver: 8,
  poseFreshMs: 300,
  calibrateFrames: 30,
  autoCalibrateSeconds: 5,
};

/** Points for locking the pose first, second, and after that. */
export const LOCK_POINTS = [3, 2, 1] as const;

export interface FreezePlayer {
  readonly id: number;
  score: number;
  hearts: number;
  out: boolean;
  /** The hold this player calibrated as their own "level". */
  reference: CanonicalVector | null;
  /** Recent readings, averaged into the reference on demand. */
  recent: CanonicalVector[];
  /** Degrees away from the called pose, so a miss can be read, not guessed. */
  offBy: number;
  closeness: number;
  held: boolean;
  /** Seconds the pose has been held without a break. */
  dwell: number;
  locked: boolean;
  lockPoints: number;
  lastPoseAt: number;
}

export interface FreezeState {
  readonly config: FreezeConfig;
  phase: FreezePhase;
  round: number;
  timer: number;
  tolerance: number;
  freezeMs: number;
  pose: NamedPose;
  locksThisRound: number;
  readyFor: number;
  /** Who last tried to calibrate with the phone lying flat. */
  flatWarning: number | null;
  players: FreezePlayer[];
}

export type FreezeEvent =
  | { readonly kind: 'lock'; readonly playerId: number; readonly points: number }
  | { readonly kind: 'miss'; readonly playerId: number; readonly out: boolean }
  | { readonly kind: 'round'; readonly round: number }
  | { readonly kind: 'reveal'; readonly locked: number }
  | { readonly kind: 'over' };

const LEVEL: NamedPose = POSES[0] ?? {
  key: 'level',
  label: '그대로',
  axis: { x: 0, y: 0, z: -1 },
  angleDeg: 0,
};

export function createFreeze(config: Partial<FreezeConfig> = {}): FreezeState {
  const merged: FreezeConfig = { ...DEFAULT_FREEZE_CONFIG, ...config };
  return {
    config: merged,
    phase: 'ready',
    round: 0,
    timer: 0,
    tolerance: merged.toleranceStart,
    freezeMs: merged.freezeMsStart,
    pose: LEVEL,
    locksThisRound: 0,
    readyFor: 0,
    flatWarning: null,
    players: [],
  };
}

export function findPlayer(state: FreezeState, id: number): FreezePlayer | undefined {
  return state.players.find((player) => player.id === id);
}

/**
 * Bring the roster in line with who is connected.
 *
 * Everyone already here keeps their record. Somebody joining must not cost the
 * rest of the room its grips, scores and lives, which is exactly what happened
 * when the scene rebuilt every card from scratch on a player-list change.
 */
export function syncPlayers(state: FreezeState, ids: readonly number[]): void {
  state.players = ids.map(
    (id) =>
      findPlayer(state, id) ?? {
        id,
        score: 0,
        hearts: state.config.hearts,
        out: false,
        reference: null,
        recent: [],
        offBy: 180,
        closeness: 0,
        held: false,
        dwell: 0,
        locked: false,
        lockPoints: 0,
        lastPoseAt: 0,
      },
  );
}

/** A reading from a phone: kept for calibration, and judged if calibrated. */
export function readPose(
  state: FreezeState,
  id: number,
  up: CanonicalVector,
  nowMs: number,
): void {
  const player = findPlayer(state, id);
  if (!player) return;

  player.lastPoseAt = nowMs;
  player.recent.push(up);
  if (player.recent.length > state.config.calibrateFrames) player.recent.shift();
  if (!player.reference) return;

  // Judged as a rotation from this player's own grip, which keeps the direction
  // of the movement — the part an alignment onto "up" throws away.
  player.offBy = poseOffByDeg(state.pose, player.reference, up);
  player.closeness = poseCloseness(player.offBy, state.tolerance);
  // The reveal shows what happened; it must not keep moving underneath it.
  if (state.phase === 'holding') player.held = player.offBy <= state.tolerance;
}

/**
 * Adopt the grip this player is holding, averaged over the last half second.
 *
 * One sample carries the noise of one sample, and every angle in the game is
 * measured from this vector, so its error is added to every round. Readings far
 * from the newest one are dropped: those are the hand still moving towards the
 * button, not the grip.
 *
 * `refusable` is the difference between the player pressing A and the timeout
 * giving up on them. A phone calibrated flat can never be asked to tilt —
 * gravity lies along the axis every tilt turns about, so those poses move it
 * nowhere and half the game silently disappears. Worth refusing once, with a
 * reason. Never worth leaving somebody stuck on a setup screen over.
 */
export function calibrate(state: FreezeState, id: number, refusable = false): boolean {
  const player = findPlayer(state, id);
  if (!player || player.recent.length === 0) return false;

  // Seeded from the newest reading rather than the mean of the window. The
  // mean is dragged by the hand still travelling towards the button — eight bad
  // frames in thirty pull it twenty degrees, and then the rejection throws away
  // the good samples for disagreeing with it. The newest reading is by
  // definition the grip at the moment A was pressed; its neighbours are the
  // rest of the hold, and averaging them takes the noise off.
  const newest = player.recent[player.recent.length - 1] ?? { x: 0, y: 1, z: 0 };
  const settled = player.recent.filter((sample) => angleBetween(sample, newest) < 15);
  const reference = averageDirection(settled);

  if (refusable && isFlatGrip(reference)) {
    state.flatWarning = id;
    return false;
  }

  state.flatWarning = null;
  player.reference = reference;
  player.closeness = 1;
  player.held = true;
  player.offBy = 0;
  return true;
}

export function everyoneReady(state: FreezeState): boolean {
  return state.players.length > 0 && state.players.every((player) => player.reference !== null);
}

export function alivePlayers(state: FreezeState): FreezePlayer[] {
  return state.players.filter((player) => !player.out);
}

function everyoneLocked(state: FreezeState): boolean {
  const alive = alivePlayers(state);
  return alive.length > 0 && alive.every((player) => player.locked);
}

export function startRound(state: FreezeState, rng: () => number = Math.random): FreezeEvent[] {
  const alive = alivePlayers(state);
  // Solo play ends when the lives run out; with company it ends when only one
  // player still has any. Before this the game had no way to end at all —
  // nothing ever knocked anybody out, so the winner screen was unreachable.
  const survivors = state.players.length > 1 ? 1 : 0;
  if (state.round > 0 && alive.length <= survivors) {
    state.phase = 'over';
    return [{ kind: 'over' }];
  }

  state.round++;
  // Tighten as the round number climbs, then hold: a game that gets harder
  // forever ends in frustration rather than in a winner.
  const { toleranceStart, toleranceFloor, freezeMsStart, freezeMsEnd, tightenOver } = state.config;
  const progress = Math.min(1, (state.round - 1) / tightenOver);
  state.tolerance = toleranceStart - (toleranceStart - toleranceFloor) * progress;
  state.freezeMs = freezeMsStart + (freezeMsEnd - freezeMsStart) * progress;

  // Only poses the room can actually show: gravity cannot see a turn about
  // itself, so a pose whose axis lies along one player's gravity would score
  // them for standing still.
  const references = alive
    .map((player) => player.reference)
    .filter((reference): reference is CanonicalVector => reference !== null);
  const available = posesUsableFor(references, Math.max(30, state.tolerance));
  const choices = available.filter((pose) => pose.key !== state.pose.key);
  state.pose = choices[Math.floor(rng() * choices.length)] ?? state.pose;

  state.phase = 'holding';
  state.timer = state.config.roundSeconds;
  state.locksThisRound = 0;
  for (const player of state.players) {
    player.locked = false;
    player.lockPoints = 0;
    player.dwell = 0;
    player.held = false;
    player.offBy = 180;
    player.closeness = 0;
  }
  return [{ kind: 'round', round: state.round }];
}

/**
 * One frame of the game.
 *
 * `nowMs` is a clock, only ever compared against the timestamps on incoming
 * readings: a phone that stopped sending is not holding a pose, however good
 * its last reading was.
 */
export function stepFreeze(
  state: FreezeState,
  dt: number,
  nowMs: number,
  rng: () => number = Math.random,
): FreezeEvent[] {
  const events: FreezeEvent[] = [];

  if (state.phase === 'ready') {
    state.readyFor += dt;
    if (state.readyFor >= state.config.autoCalibrateSeconds) {
      for (const player of state.players) {
        if (!player.reference) calibrate(state, player.id);
      }
      if (everyoneReady(state)) events.push(...startRound(state, rng));
    }
    return events;
  }

  if (state.phase === 'holding') {
    state.timer -= dt;
    events.push(...tickHolds(state, dt, nowMs));
    if (state.timer <= 0 || everyoneLocked(state)) events.push(...judge(state));
    return events;
  }

  if (state.phase === 'reveal') {
    state.timer -= dt;
    if (state.timer <= 0) events.push(...startRound(state, rng));
  }
  return events;
}

/** Stillness, measured: the angle has to stay inside the tolerance. */
function tickHolds(state: FreezeState, dt: number, nowMs: number): FreezeEvent[] {
  const events: FreezeEvent[] = [];
  for (const player of state.players) {
    if (player.out || player.locked) continue;

    const fresh = nowMs - player.lastPoseAt < state.config.poseFreshMs;
    if (!fresh || !player.held) {
      player.dwell = 0;
      continue;
    }

    player.dwell += dt;
    if (player.dwell * 1000 < state.freezeMs) continue;

    player.locked = true;
    player.lockPoints = LOCK_POINTS[Math.min(state.locksThisRound, LOCK_POINTS.length - 1)] ?? 1;
    player.score += player.lockPoints;
    state.locksThisRound++;
    events.push({ kind: 'lock', playerId: player.id, points: player.lockPoints });
  }
  return events;
}

function judge(state: FreezeState): FreezeEvent[] {
  state.phase = 'reveal';
  state.timer = state.config.revealSeconds;

  const events: FreezeEvent[] = [];
  for (const player of state.players) {
    if (player.out || player.locked) continue;
    // Missing a pose costs a life, not the game.
    player.hearts--;
    player.out = player.hearts <= 0;
    events.push({ kind: 'miss', playerId: player.id, out: player.out });
  }
  events.push({ kind: 'reveal', locked: state.locksThisRound });
  return events;
}

/** Who is winning, or who won. */
export function leader(state: FreezeState): FreezePlayer | null {
  return [...state.players].sort((a, b) => b.score - a.score)[0] ?? null;
}

/** How far the closest player is through the hold, 0 to 1. */
export function holdProgress(state: FreezeState): number {
  return state.players.reduce(
    (best, player) =>
      Math.max(best, player.locked ? 1 : Math.min(1, (player.dwell * 1000) / state.freezeMs)),
    0,
  );
}

/** Mean direction of a set of unit vectors, renormalised. */
export function averageDirection(samples: readonly CanonicalVector[]): CanonicalVector {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const sample of samples) {
    x += sample.x;
    y += sample.y;
    z += sample.z;
  }
  const length = Math.hypot(x, y, z);
  if (length === 0) return { x: 0, y: 1, z: 0 };
  return { x: x / length, y: y / length, z: z / length };
}

function angleBetween(a: CanonicalVector, b: CanonicalVector): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  const scale = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z);
  if (scale === 0) return 180;
  return (Math.acos(Math.min(1, Math.max(-1, dot / scale))) * 180) / Math.PI;
}
