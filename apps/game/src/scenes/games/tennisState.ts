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
}

/**
 * Tuned down after playing it: at the original 0.55-1.5 the ball crossed the
 * court in well under a second and the hit window was a fraction of that,
 * which is not a timing game so much as a coin toss.
 */
export const HIT_ZONE = 0.26;
export const BASE_SPEED = 0.32;
export const MAX_SPEED = 0.8;
const POINT_PAUSE_SECONDS = 1.2;

export const DEFAULT_CONFIG: TennisConfig = { players: 2, pointsToWin: 5, missesAllowed: 3 };

/** Vertical component each swing direction adds, in court units per second. */
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
  };
}

function serveSpot(state: TennisState): Ball {
  const x = state.server === 1 ? HIT_ZONE * 0.6 : 1 - HIT_ZONE * 0.6;
  return { x, y: 0.5, vx: 0, vy: 0 };
}

function speedFor(strength: number): number {
  return BASE_SPEED + (MAX_SPEED - BASE_SPEED) * strength;
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
    state.server = to;
  }
  state.timer = POINT_PAUSE_SECONDS;
  state.rally = 0;
}

export interface SwingResult {
  readonly hit: boolean;
  readonly served: boolean;
}

export function swing(
  state: TennisState,
  side: Side,
  strength: number,
  direction: Direction8,
): SwingResult {
  const vertical = VERTICAL_BY_DIRECTION[direction];

  if (state.phase === 'serve') {
    if (side !== state.server) return { hit: false, served: false };
    const toward = state.server === 1 ? 1 : -1;
    state.ball = { ...serveSpot(state), vx: toward * speedFor(strength), vy: vertical };
    state.phase = 'rally';
    state.rally = 1;
    return { hit: true, served: true };
  }

  if (state.phase !== 'rally') return { hit: false, served: false };

  const approachingLeft = state.ball.vx < 0 && state.ball.x <= HIT_ZONE;
  const approachingRight = state.ball.vx > 0 && state.ball.x >= 1 - HIT_ZONE;
  const inZone = side === 1 ? approachingLeft : approachingRight;
  if (!inZone) return { hit: false, served: false };

  const toward = side === 1 ? 1 : -1;
  state.ball.vx = toward * speedFor(strength);
  state.ball.vy = vertical;
  state.rally++;
  return { hit: true, served: false };
}

export function step(state: TennisState, dt: number): void {
  if (state.phase === 'gameover') return;

  if (state.phase === 'point') {
    state.timer -= dt;
    if (state.timer <= 0) {
      state.phase = 'serve';
      state.ball = serveSpot(state);
    }
    return;
  }

  if (state.phase === 'serve') {
    state.ball = serveSpot(state);
    return;
  }

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
    // The wall always returns the ball, at the same speed.
    state.ball.x = 2 - state.ball.x;
    state.ball.vx = -Math.abs(state.ball.vx);
    return;
  }

  if (state.ball.x < 0) awardPoint(state, 2);
  else if (state.ball.x > 1) awardPoint(state, 1);
}

export function isMatchPoint(state: TennisState): boolean {
  if (state.config.players === 1) return state.misses === state.config.missesAllowed - 1;
  return state.score.some((points) => points === state.config.pointsToWin - 1);
}
