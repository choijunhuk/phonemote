import type { Direction8 } from '../../input/types.js';

/**
 * Tennis rules, with no Phaser in sight.
 *
 * The court is normalised: x 0 (left player) to 1 (right player or wall),
 * y 0 (far) to 1 (near). Keeping the rules separate from the rendering is what
 * makes the state machine testable (ARCHITECTURE.md 8).
 */

export type TennisPhase = 'serve' | 'rally' | 'point' | 'gameover';
export type Side = 1 | 2;

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface TennisConfig {
  /** 1 = practice against the wall, 2 = head to head. */
  readonly players: 1 | 2;
  readonly pointsToWin: number;
  /** Practice ends after this many misses. */
  readonly missesAllowed: number;
}

export interface TennisState {
  readonly config: TennisConfig;
  phase: TennisPhase;
  ball: Ball;
  score: [number, number];
  misses: number;
  server: Side;
  lastPointTo: Side | null;
  winner: Side | null;
  /** Seconds left in the current non-rally phase. */
  timer: number;
  rally: number;
  /** Seconds the current serve has gone unplayed. */
  serveWait: number;
  /** Longest rally of the session, which is the score in practice mode. */
  bestRally: number;
  /** Seconds left in which the last hit can still be upgraded by its strike. */
  commit: number;
  /** Who owns that window, and how hard the burst that opened it was. */
  commitSide: Side | null;
  commitPeak: number;
  /** Where the ball was when that window opened. */
  commitFrom: number;
}

/**
 * Tuned down after playing it: at the original 0.55-1.5 the ball crossed the
 * court in well under a second and the hit window was a fraction of that,
 * which is not a timing game so much as a coin toss.
 */
export const HIT_ZONE = 0.32;
export const BASE_SPEED = 0.4;
export const MAX_SPEED = 0.9;
/**
 * Rotation rates, in deg/s, that map to the slowest and fastest ball.
 *
 * Speed used to be taken from the swing's `strength`, which saturates at
 * 900 deg/s — and a real swing peaks between 900 and 1200. Every single ball
 * therefore left at MAX_SPEED, including the ones a player tried to place
 * gently. The comment claiming the range had been tuned by playing described
 * numbers that never occurred at runtime. This is what "the ball is too fast
 * to hit" actually was.
 */
export const SOFT_RATE = 350;
export const HARD_RATE = 1250;
const POINT_PAUSE_SECONDS = 0.9;
/**
 * How far past the baseline the ball travels before the point is awarded.
 *
 * The ball used to stop dead the instant it left the court and sit there for
 * over a second before teleporting back to the serve spot: "it goes back to the
 * start, pauses, then begins again", exactly as described. Letting it fly out
 * turns that into a miss you can see, and the strip doubles as a fair extra
 * beat to swing in — the ball is still hittable while it is visibly out.
 */
export const OUT_STRIP = 0.07;
/**
 * How long a hit stays open to being replaced by a harder one.
 *
 * A tennis stroke is a backswing and then a strike. The detector fires on both,
 * the backswing arrives first, and it is the one that used to put the ball in
 * play — weakly, in the wrong direction, and with the real swing landing a
 * moment later out of the zone, where it read as "too late". Within this window
 * the harder burst simply replaces the softer one, so the shot the player
 * actually made is the shot that counts.
 */
export const COMMIT_SECONDS = 0.12;

/** Nobody should be able to get stuck staring at a ball that will not move. */
export const AUTO_SERVE_SECONDS = 3;

export const DEFAULT_CONFIG: TennisConfig = { players: 2, pointsToWin: 5, missesAllowed: 3 };

/** Fastest the ball climbs or dips, in court units per second. */
const MAX_VERTICAL = 0.55;

/** Fallback for callers with only the bucket. */
const VERTICAL_BY_DIRECTION: Record<Direction8, number> = {
  N: -0.55,
  NE: -0.35,
  E: 0,
  SE: 0.35,
  S: 0.55,
  SW: 0.35,
  W: 0,
  NW: -0.35,
};

export function createTennis(config: Partial<TennisConfig> = {}): TennisState {
  const merged: TennisConfig = { ...DEFAULT_CONFIG, ...config };
  return {
    config: merged,
    phase: 'serve',
    ball: { x: 0.1, y: 0.5, vx: 0, vy: 0 },
    score: [0, 0],
    misses: 0,
    server: 1,
    lastPointTo: null,
    winner: null,
    timer: 0,
    rally: 0,
    serveWait: 0,
    bestRally: 0,
    commit: 0,
    commitSide: null,
    commitPeak: 0,
    commitFrom: 0,
  };
}

function serveSpot(state: TennisState): Ball {
  const x = state.server === 1 ? HIT_ZONE * 0.6 : 1 - HIT_ZONE * 0.6;
  return { x, y: 0.5, vx: 0, vy: 0 };
}

/** 0 for a gentle push, 1 for everything a hand can do. */
export function swingPower(peakRate: number): number {
  return Math.min(1, Math.max(0, (peakRate - SOFT_RATE) / (HARD_RATE - SOFT_RATE)));
}

function speedFor(peakRate: number): number {
  return BASE_SPEED + (MAX_SPEED - BASE_SPEED) * swingPower(peakRate);
}

function awardPoint(state: TennisState, to: Side): void {
  if (state.config.players === 1) {
    // Practice: the wall never scores, the player just runs out of lives.
    state.misses++;
    state.phase = state.misses >= state.config.missesAllowed ? 'gameover' : 'point';
    state.lastPointTo = null;
    if (state.phase === 'gameover') state.winner = null;
  } else {
    const index = to - 1;
    const points = (state.score[index] ?? 0) + 1;
    state.score[index] = points;
    state.lastPointTo = to;
    state.phase = points >= state.config.pointsToWin ? 'gameover' : 'point';
    if (state.phase === 'gameover') state.winner = to;
    // The serve alternates. Handing it to whoever just scored let a 5-0 run
    // finish in twenty seconds with the loser never once serving.
    state.server = to === 1 ? 2 : 1;
  }
  state.timer = POINT_PAUSE_SECONDS;
  state.rally = 0;
  state.commit = 0;
  state.commitSide = null;
}

/**
 * Why a swing did nothing. A silent miss is indistinguishable from a swing the
 * detector never saw, which is the difference between "my timing is off" and
 * "this thing is broken".
 */
export type SwingMiss = 'early' | 'late' | 'not-your-turn';

/**
 * How much the ball is aimed up or down.
 *
 * The eight-way bucket is coarse enough that E and W both mean "flat", so a
 * swing between two sectors snapped to no aim at all. When the caller has the
 * swing vector, its own vertical share is used instead, which makes aiming
 * continuous rather than a choice between eight answers.
 */
export function verticalFor(
  direction: Direction8,
  vector?: { readonly x: number; readonly y: number; readonly z: number },
): number {
  if (!vector) return VERTICAL_BY_DIRECTION[direction];
  const planar = Math.hypot(vector.x, vector.y);
  if (planar < 1e-6) return VERTICAL_BY_DIRECTION[direction];
  // Canonical +Y is up; the court's y grows towards the near edge, so a swing
  // that lifts the ball has to reduce it.
  return -(vector.y / planar) * MAX_VERTICAL;
}

export interface SwingResult {
  readonly hit: boolean;
  readonly served: boolean;
  readonly miss: SwingMiss | null;
  /** The strike replacing its own backswing, rather than a new shot. */
  readonly upgraded: boolean;
}

export function swing(
  state: TennisState,
  side: Side,
  /** Peak rotation rate of the swing, deg/s — not the saturating strength. */
  peakRate: number,
  direction: Direction8,
  /** The swing's own direction, when the caller has it. */
  vector?: { readonly x: number; readonly y: number; readonly z: number },
): SwingResult {
  const vertical = verticalFor(direction, vector);

  if (state.phase === 'serve') {
    if (side !== state.server) {
      return { hit: false, served: false, miss: 'not-your-turn', upgraded: false };
    }
    const toward = state.server === 1 ? 1 : -1;
    state.ball = { ...serveSpot(state), vx: toward * speedFor(peakRate), vy: vertical };
    state.phase = 'rally';
    state.rally = 1;
    state.bestRally = Math.max(state.bestRally, 1);
    state.serveWait = 0;
    openCommit(state, side, peakRate);
    return { hit: true, served: true, miss: null, upgraded: false };
  }

  if (state.phase !== 'rally') {
    return { hit: false, served: false, miss: null, upgraded: false };
  }

  // The strike catching up with its own backswing, before anything is judged:
  // the harder burst wins and the softer one is forgotten.
  if (state.commit > 0 && state.commitSide === side) {
    if (peakRate <= state.commitPeak) {
      return { hit: false, served: false, miss: null, upgraded: false };
    }
    const toward = side === 1 ? 1 : -1;
    state.ball.vx = toward * speedFor(peakRate);
    state.ball.vy = vertical;
    // Back to where it was struck, so the upgrade does not also gift the ball
    // the ground it covered during the window.
    state.ball.x = state.commitFrom;
    state.commitPeak = peakRate;
    return { hit: true, served: false, miss: null, upgraded: true };
  }

  const approachingLeft = state.ball.vx < 0 && state.ball.x <= HIT_ZONE;
  const approachingRight = state.ball.vx > 0 && state.ball.x >= 1 - HIT_ZONE;
  const inZone = side === 1 ? approachingLeft : approachingRight;
  if (!inZone) {
    const approaching = side === 1 ? state.ball.vx < 0 : state.ball.vx > 0;
    return {
      hit: false,
      served: false,
      miss: approaching ? 'early' : 'late',
      upgraded: false,
    };
  }

  const toward = side === 1 ? 1 : -1;
  state.ball.vx = toward * speedFor(peakRate);
  state.ball.vy = vertical;
  // A ball caught out in the strip is brought back onto the court, so the
  // return does not start from behind the baseline.
  state.ball.x = Math.min(1, Math.max(0, state.ball.x));
  state.rally++;
  state.bestRally = Math.max(state.bestRally, state.rally);
  openCommit(state, side, peakRate);
  return { hit: true, served: false, miss: null, upgraded: false };
}

function openCommit(state: TennisState, side: Side, peakRate: number): void {
  state.commit = COMMIT_SECONDS;
  state.commitSide = side;
  state.commitPeak = peakRate;
  state.commitFrom = state.ball.x;
}

export function step(state: TennisState, dt: number): void {
  if (state.phase === 'gameover') return;

  if (state.phase === 'point') {
    // The ball keeps flying while the point is settled, so a miss looks like
    // the ball going out rather than the game freezing.
    state.ball.x += state.ball.vx * dt;
    state.ball.y += state.ball.vy * dt;
    state.timer -= dt;
    if (state.timer <= 0) {
      state.phase = 'serve';
      state.ball = serveSpot(state);
    }
    return;
  }

  if (state.phase === 'serve') {
    state.ball = serveSpot(state);
    state.serveWait += dt;
    // Serve for them rather than leave the game looking broken. A missed swing,
    // a phone that dropped out, a player who put it down — all end the same way
    // without this, with a ball that never moves again.
    if (state.serveWait >= AUTO_SERVE_SECONDS) swing(state, state.server, 500, 'E');
    return;
  }

  state.commit = Math.max(0, state.commit - dt);
  state.ball.x += state.ball.vx * dt;
  state.ball.y += state.ball.vy * dt;

  // The near and far edges of the court bounce.
  if (state.ball.y < 0) {
    state.ball.y = -state.ball.y;
    state.ball.vy = Math.abs(state.ball.vy);
  } else if (state.ball.y > 1) {
    state.ball.y = 2 - state.ball.y;
    state.ball.vy = -Math.abs(state.ball.vy);
  }

  if (state.config.players === 1 && state.ball.x >= 1) {
    // The wall returns the ball a little softer than it arrived, so a hard
    // shot does not immediately become an impossible return.
    state.ball.x = 2 - state.ball.x;
    state.ball.vx = -Math.abs(state.ball.vx) * 0.85;
    return;
  }

  // Out is past the strip, not past the line: the ball stays hittable for the
  // moment it spends visibly out, which is a fair beat rather than a hidden one.
  if (state.ball.x < -OUT_STRIP) awardPoint(state, 2);
  else if (state.ball.x > 1 + OUT_STRIP) awardPoint(state, 1);
}

export function isMatchPoint(state: TennisState): boolean {
  if (state.config.players === 1) return state.misses === state.config.missesAllowed - 1;
  return state.score.some((points) => points === state.config.pointsToWin - 1);
}
