import { describe, expect, it } from 'vitest';
import { angleBetweenDeg, expectedUp } from '../../../input/pose.js';
import type { CanonicalVector } from '../../../input/types.js';
import {
  calibrate,
  createFreeze,
  everyoneReady,
  findPlayer,
  holdProgress,
  leader,
  readPose,
  startRound,
  stepFreeze,
  syncPlayers,
  type FreezeEvent,
  type FreezeState,
} from '../freezeState.js';

/**
 * The rules of Freeze Frame, driven at 60 Hz with a clock we control.
 *
 * Every test here holds a pose by feeding the exact gravity vector that pose
 * asks for, which is what a phone in that position would report.
 */

const FRAME = 1 / 60;

/** Deterministic, so a failing round can be replayed. */
function random(seed = 7): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
/**
 * A phone held upright, screen towards the player: gravity-up is the phone's
 * own +Y (ARCHITECTURE.md 5.2). Written out rather than derived from the
 * normaliser, which scenes are not allowed to import (P4).
 */
const GRIP: CanonicalVector = { x: 0, y: 1, z: 0 };

function freeze(players = 1, config = {}): FreezeState {
  const state = createFreeze({ autoCalibrateSeconds: 999, ...config });
  syncPlayers(
    state,
    Array.from({ length: players }, (_, index) => ({ id: index + 1, present: true })),
  );
  return state;
}

/** Calibrate everybody on the same grip and start round one. */
function begin(state: FreezeState): void {
  for (const player of state.players) {
    for (let i = 0; i < 30; i++) readPose(state, player.id, GRIP, i * 16);
    expect(calibrate(state, player.id, true)).toBe(true);
  }
  expect(everyoneReady(state)).toBe(true);
  startRound(state, () => 0.5);
}

/** Hold the called pose (or something `offBy` degrees away) for a while. */
function hold(
  state: FreezeState,
  ids: readonly number[],
  seconds: number,
  what: 'pose' | 'wrong' = 'pose',
  startMs = 1000,
): FreezeEvent[] {
  const events: FreezeEvent[] = [];
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) {
    const now = startMs + i * FRAME * 1000;
    for (const id of ids) {
      const player = findPlayer(state, id);
      if (!player?.reference) continue;
      const up = what === 'pose' ? expectedUp(state.pose, player.reference) : player.reference;
      readPose(state, id, up, now);
    }
    events.push(...stepFreeze(state, FRAME, now, () => 0.5));
  }
  return events;
}

describe('setting a grip', () => {
  it('averages the last readings rather than trusting one', () => {
    const state = freeze();
    // A hand that is still arriving, then settles.
    for (let i = 0; i < 8; i++) readPose(state, 1, { x: 0, y: 0, z: 1 }, i * 16);
    for (let i = 8; i < 30; i++) readPose(state, 1, GRIP, i * 16);
    calibrate(state, 1);

    const reference = findPlayer(state, 1)?.reference;
    expect(reference).toBeDefined();
    // The eight stray frames are rejected, not averaged in.
    expect(angleBetweenDeg(reference ?? GRIP, GRIP)).toBeLessThan(3);
  });

  it('refuses a phone lying flat, and says who', () => {
    const state = freeze();
    for (let i = 0; i < 30; i++) readPose(state, 1, { x: 0, y: 0, z: 1 }, i * 16);
    expect(calibrate(state, 1, true)).toBe(false);
    expect(state.flatWarning).toBe(1);
    expect(findPlayer(state, 1)?.reference).toBeNull();
  });

  it('never leaves anyone stuck on the setup screen', () => {
    // Same flat phone, but now the player never presses A.
    const state = createFreeze();
    syncPlayers(state, [{ id: 1, present: true }]);
    for (let i = 0; i < 30; i++) readPose(state, 1, { x: 0, y: 0, z: 1 }, i * 16);
    for (let i = 0; i < 6 * 60; i++) stepFreeze(state, FRAME, 500 + i * 16, () => 0.5);

    expect(findPlayer(state, 1)?.reference).not.toBeNull();
    expect(state.phase).toBe('holding');
  });
});

describe('holding a pose', () => {
  it('scores a hold that lasts, not an angle that happens to pass through', () => {
    const state = freeze();
    begin(state);
    // Right pose, but only for a moment.
    hold(state, [1], 0.2);
    expect(findPlayer(state, 1)?.locked).toBe(false);

    hold(state, [1], 0.4, 'pose', 2000);
    expect(findPlayer(state, 1)?.locked).toBe(true);
  });

  it('restarts the hold when the pose breaks', () => {
    const state = freeze();
    begin(state);
    hold(state, [1], 0.4);
    hold(state, [1], 0.1, 'wrong', 2000);
    expect(findPlayer(state, 1)?.dwell).toBe(0);
    expect(findPlayer(state, 1)?.locked).toBe(false);
  });

  it('does not credit a phone that stopped sending', () => {
    const state = freeze();
    begin(state);
    const player = findPlayer(state, 1);
    if (!player?.reference) throw new Error('not calibrated');

    // One good reading, then silence: the reading stays true and stale.
    readPose(state, 1, expectedUp(state.pose, player.reference), 1000);
    for (let i = 0; i < 120; i++) stepFreeze(state, FRAME, 1000 + i * 16, () => 0.5);
    expect(player.locked).toBe(false);
  });
});

describe('scoring a round', () => {
  it('pays the first player to lock more than the second', () => {
    const state = freeze(2);
    begin(state);
    hold(state, [1], 0.6);
    hold(state, [1, 2], 0.6, 'pose', 3000);

    const [first, second] = state.players;
    expect(first?.lockPoints).toBe(3);
    expect(second?.lockPoints).toBe(2);
    expect(first?.score).toBeGreaterThan(second?.score ?? 0);
  });

  it('costs a heart to miss, and the game to run out', () => {
    const state = freeze(1, { hearts: 2 });
    begin(state);
    // Two rounds of holding the wrong thing.
    hold(state, [1], 12, 'wrong');

    const player = state.players[0];
    expect(player?.hearts).toBe(0);
    expect(player?.out).toBe(true);
    expect(state.phase).toBe('over');
  });

  it('ends a two-player game when only one still has hearts', () => {
    const state = freeze(2, { hearts: 1 });
    begin(state);
    // P1 holds every round, P2 holds nothing.
    for (let round = 0; round < 3 && state.phase !== 'over'; round++) {
      hold(state, [1], 5, 'pose', 1000 + round * 10_000);
    }

    expect(state.players[1]?.out).toBe(true);
    expect(state.phase).toBe('over');
    expect(leader(state)?.id).toBe(1);
  });

  it('moves on early once everyone has locked', () => {
    const state = freeze(1);
    begin(state);
    // The round is 3.5 s; a half-second hold should not cost the other three.
    const events = hold(state, [1], 1.2);
    expect(events.some((event) => event.kind === 'reveal')).toBe(true);
    expect(state.phase).toBe('reveal');
  });

  it('gets harder as it goes', () => {
    const state = freeze(1, { hearts: 99 });
    begin(state);
    const firstTolerance = state.tolerance;
    const firstFreeze = state.freezeMs;
    hold(state, [1], 30, 'pose');

    expect(state.round).toBeGreaterThan(3);
    expect(state.tolerance).toBeLessThan(firstTolerance);
    expect(state.freezeMs).toBeGreaterThan(firstFreeze);
  });

  it('never calls the same pose twice in a row', () => {
    // Sampled on every round change rather than every few seconds: reading it
    // at a fixed interval skips rounds and compares poses that were never
    // consecutive.
    const state = freeze(1, { hearts: 99 });
    begin(state);
    const seen: string[] = [state.pose.key];
    let round = state.round;
    for (let i = 0; i < 60 * 60; i++) {
      const player = state.players[0];
      if (!player?.reference) break;
      const now = 1000 + i * FRAME * 1000;
      readPose(state, 1, expectedUp(state.pose, player.reference), now);
      stepFreeze(state, FRAME, now, random());
      if (state.round !== round) {
        round = state.round;
        seen.push(state.pose.key);
      }
    }
    expect(seen.length).toBeGreaterThan(6);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });
});

describe('the room changing while it plays', () => {
  it('keeps scores, lives and grips when somebody joins', () => {
    const state = freeze(1);
    begin(state);
    hold(state, [1], 0.7);
    const before = state.players[0]?.score ?? 0;
    expect(before).toBeGreaterThan(0);

    syncPlayers(state, [{ id: 1, present: true }, { id: 2, present: true }]);
    expect(state.players[0]?.score).toBe(before);
    expect(state.players[0]?.reference).not.toBeNull();
    expect(state.players[1]?.reference).toBeNull();
  });
});

describe('what the screen is told', () => {
  it('reports the hold in progress, so it can be drawn', () => {
    const state = freeze(1);
    begin(state);
    expect(holdProgress(state)).toBe(0);
    hold(state, [1], 0.25);
    expect(holdProgress(state)).toBeGreaterThan(0);
    expect(holdProgress(state)).toBeLessThan(1);
  });
});

describe('a phone that drops out mid-round', () => {
  it('does not take a life for a round it was never asked to play', () => {
    // A two-second wifi hiccup used to cost the player a life every round it
    // spanned, and three of them knocked them out of a game they were winning.
    const state = freeze(2);
    begin(state);
    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    hold(state, [1], 5);

    expect(state.players[0]?.hearts).toBe(3);
    expect(state.players[1]?.hearts).toBe(3);
    expect(state.players[1]?.out).toBe(false);
  });

  it('keeps their score and their grip for when they come back', () => {
    const state = freeze(2);
    begin(state);
    hold(state, [1, 2], 1.2);
    const score = state.players[1]?.score ?? 0;
    expect(score).toBeGreaterThan(0);

    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
    ]);
    expect(state.players[1]?.score).toBe(score);
    expect(state.players[1]?.reference).not.toBeNull();
  });

  it('does not wait for an absent player to end the round', () => {
    const state = freeze(2);
    begin(state);
    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    // P1 locks; the round should finish rather than run its full length
    // waiting on a phone that is not there.
    const events = hold(state, [1], 1.4);
    expect(events.some((event) => event.kind === 'reveal')).toBe(true);
  });
});
