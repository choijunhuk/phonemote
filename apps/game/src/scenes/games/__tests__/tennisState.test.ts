import { describe, expect, it } from 'vitest';
import {
  AUTO_SERVE_SECONDS,
  BASE_SPEED,
  HIT_ZONE,
  MAX_SPEED,
  createTennis,
  isMatchPoint,
  step,
  swing,
  type TennisState,
} from '../tennisState.js';

function run(state: TennisState, seconds: number, dt = 1 / 60): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) step(state, dt);
}

/**
 * Steps until the predicate holds. Waiting a fixed number of seconds would
 * sail straight through the phase under test.
 */
function runUntil(
  state: TennisState,
  predicate: (state: TennisState) => boolean,
  maxSeconds = 10,
): void {
  const dt = 1 / 60;
  for (let elapsed = 0; elapsed < maxSeconds && !predicate(state); elapsed += dt) step(state, dt);
}

describe('serving', () => {
  it('starts in the serve phase with the ball parked', () => {
    const state = createTennis();
    expect(state.phase).toBe('serve');
    expect(state.ball.vx).toBe(0);
  });

  it('only the server can put the ball in play', () => {
    const state = createTennis();
    expect(swing(state, 2, 1, 'E').served).toBe(false);
    expect(state.phase).toBe('serve');

    expect(swing(state, 1, 1, 'E').served).toBe(true);
    expect(state.phase).toBe('rally');
    expect(state.ball.vx).toBeGreaterThan(0);
  });

  it('serves harder with a stronger swing', () => {
    const soft = createTennis();
    swing(soft, 1, 0, 'E');
    const hard = createTennis();
    swing(hard, 1, 1, 'E');

    expect(soft.ball.vx).toBeCloseTo(BASE_SPEED, 6);
    expect(hard.ball.vx).toBeCloseTo(MAX_SPEED, 6);
  });

  it('aims with the swing direction', () => {
    const up = createTennis();
    swing(up, 1, 1, 'N');
    expect(up.ball.vy).toBeLessThan(0);

    const down = createTennis();
    swing(down, 1, 1, 'S');
    expect(down.ball.vy).toBeGreaterThan(0);

    const flat = createTennis();
    swing(flat, 1, 1, 'E');
    expect(flat.ball.vy).toBe(0);
  });
});

describe('aiming', () => {
  it('reads the vertical aim from the swing vector, not the eight-way bucket', () => {
    // Between two sectors: the bucket says E, which means flat, while the
    // vector plainly slopes upwards.
    const state = createTennis();
    swing(state, 1, 1, 'E', { x: 1, y: 0.9, z: 0 });
    expect(state.ball.vy).toBeLessThan(-0.2);
  });

  it('falls back to the bucket when no vector is given', () => {
    const state = createTennis();
    swing(state, 1, 1, 'N');
    expect(state.ball.vy).toBeLessThan(0);
  });

  it('treats a purely sideways swing as flat', () => {
    const state = createTennis();
    swing(state, 1, 1, 'E', { x: 1, y: 0, z: -0.5 });
    expect(state.ball.vy).toBeCloseTo(0, 6);
  });

  it('ignores a vector with no horizontal content at all', () => {
    const state = createTennis();
    swing(state, 1, 1, 'S', { x: 0, y: 0, z: -1 });
    // Nothing to read, so the bucket decides.
    expect(state.ball.vy).toBeGreaterThan(0);
  });
});

describe('rallying', () => {
  it('returns the ball when the swing lands in the hit zone', () => {
    const state = createTennis();
    swing(state, 1, 1, 'E');
    runUntil(state, (current) => current.ball.x >= 1 - HIT_ZONE);

    // The ball is now in player 2's zone, travelling right.
    expect(state.ball.vx).toBeGreaterThan(0);
    expect(swing(state, 2, 1, 'E').hit).toBe(true);
    expect(state.ball.vx).toBeLessThan(0);
    expect(state.rally).toBe(2);
  });

  it('ignores a swing while the ball is at the other end', () => {
    const state = createTennis();
    swing(state, 1, 1, 'E');
    expect(swing(state, 2, 1, 'E').hit).toBe(false);
  });

  it('bounces off the near and far edges', () => {
    const state = createTennis();
    swing(state, 1, 0.2, 'N');
    run(state, 1.5);
    expect(state.ball.y).toBeGreaterThanOrEqual(0);
    expect(state.ball.y).toBeLessThanOrEqual(1);
  });
});

describe('scoring a point', () => {
  it('gives the point to whoever hit it past the other side', () => {
    const state = createTennis();
    swing(state, 1, 1, 'E');
    runUntil(state, (current) => current.phase !== 'rally');

    expect(state.score).toEqual([1, 0]);
    expect(state.phase).toBe('point');
    expect(state.lastPointTo).toBe(1);
  });

  it('hands the serve to whoever won the point, after a pause', () => {
    const state = createTennis();
    swing(state, 1, 1, 'E');
    runUntil(state, (current) => current.phase !== 'rally');
    expect(state.server).toBe(1);
    expect(state.phase).toBe('point');

    runUntil(state, (current) => current.phase === 'serve');
    expect(state.ball.x).toBeLessThan(0.5);
  });
});

describe('finishing', () => {
  it('ends once someone reaches the target score', () => {
    const state = createTennis({ pointsToWin: 2 });
    for (let point = 0; point < 2; point++) {
      // Whoever serves loses the point here: nobody returns.
      swing(state, state.server, 1, 'E');
      runUntil(state, (current) => current.phase !== 'rally');
      if (state.phase === 'point') runUntil(state, (current) => current.phase === 'serve');
    }
    expect(state.phase).toBe('gameover');
    expect(state.winner).not.toBeNull();
    expect(state.score[0] + state.score[1]).toBe(2);
  });

  it('stops the clock after game over', () => {
    const state = createTennis({ pointsToWin: 1 });
    swing(state, 1, 1, 'E');
    runUntil(state, (current) => current.phase === 'gameover');
    expect(state.phase).toBe('gameover');

    const frozen = { ...state.ball };
    run(state, 2);
    expect(state.ball).toEqual(frozen);
  });

  it('flags match point', () => {
    const state = createTennis({ pointsToWin: 2 });
    expect(isMatchPoint(state)).toBe(false);
    state.score = [1, 0];
    expect(isMatchPoint(state)).toBe(true);
  });
});

describe('telling the player why a swing missed', () => {
  it('says early when the ball has not arrived yet', () => {
    const state = createTennis();
    swing(state, 1, 1, 'E');
    runUntil(state, (current) => current.ball.x > 0.6);
    // Player 2 swinging while the ball is still crossing the court.
    const result = swing(state, 2, 1, 'E');
    expect(result).toMatchObject({ hit: false, miss: 'early' });
  });

  it('says late once the ball is heading away again', () => {
    const state = createTennis();
    swing(state, 1, 1, 'E');
    const result = swing(state, 1, 1, 'E');
    expect(result).toMatchObject({ hit: false, miss: 'late' });
  });

  it('says whose serve it is', () => {
    const state = createTennis();
    expect(swing(state, 2, 1, 'E')).toMatchObject({ hit: false, miss: 'not-your-turn' });
  });

  it('reports no miss when the swing connects', () => {
    const state = createTennis();
    expect(swing(state, 1, 1, 'E')).toMatchObject({ hit: true, miss: null });
  });
});

describe('never getting stuck', () => {
  it('serves on its own if nobody swings', () => {
    const state = createTennis();
    expect(state.phase).toBe('serve');

    run(state, AUTO_SERVE_SECONDS - 0.5);
    expect(state.phase).toBe('serve');

    run(state, 1);
    expect(state.phase).toBe('rally');
    expect(state.ball.vx).not.toBe(0);
  });

  it('resets the wait once a serve is played', () => {
    const state = createTennis();
    run(state, 2);
    swing(state, 1, 1, 'E');
    expect(state.serveWait).toBe(0);
  });
});

describe('practice against the wall', () => {
  it('bounces the ball back instead of scoring', () => {
    const state = createTennis({ players: 1 });
    swing(state, 1, 1, 'E');
    runUntil(state, (current) => current.ball.vx < 0);
    expect(state.score).toEqual([0, 0]);
    expect(state.ball.vx).toBeLessThan(0);
  });

  it('counts a miss and ends after the allowance', () => {
    const state = createTennis({ players: 1, missesAllowed: 2 });
    swing(state, 1, 1, 'E');
    runUntil(state, (current) => current.phase !== 'rally');
    expect(state.misses).toBe(1);
    expect(state.phase).toBe('point');

    runUntil(state, (current) => current.phase === 'serve');
    swing(state, 1, 1, 'E');
    runUntil(state, (current) => current.phase !== 'rally');
    expect(state.misses).toBe(2);
    expect(state.phase).toBe('gameover');
  });
});
