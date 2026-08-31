import { describe, expect, it } from 'vitest';
import { GAMES, defaultMode, gameByKey, modeByKey, playersLabel } from '../games.js';

/**
 * What the registry promises the rest of the app.
 *
 * These used to need a Phaser stub, because the registry held scene classes and
 * importing Phaser reaches for a canvas no headless environment has. The stub
 * then had to grow whatever Phaser API any scene happened to touch at module
 * scope, and a new game could fail this file for reasons that had nothing to do
 * with the registry. The data lives apart from the wiring now (sceneTable.ts),
 * so this asks only about the data.
 */

describe('the game registry', () => {
  it('has a unique key per game', () => {
    const keys = GAMES.map((game) => game.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not collide with the two scenes that are not games', () => {
    const keys = GAMES.map((game) => game.key);
    expect(keys).not.toContain('lobby');
    expect(keys).not.toContain('calibration');
  });

  it('describes every game for the menu', () => {
    for (const game of GAMES) {
      expect(game.title.length).toBeGreaterThan(0);
      expect(game.blurb.length).toBeGreaterThan(0);
      expect(playersLabel(game)).toMatch(/명/);
    }
  });

  it('gives every game a practice mode, with no exception', () => {
    // A conditional rule does not get kept. The tool declares one too: it is
    // the screen where a player finds out what their own movement looks like,
    // which is the thing this platform is worst at telling them.
    for (const game of GAMES) {
      expect(modeByKey(game, 'practice'), game.key).toBeDefined();
    }
  });

  it('gives every game something one person alone can start', () => {
    for (const game of GAMES) {
      const solo = game.modes.filter((mode) => mode.minPlayers <= 1);
      expect(solo.length, game.key).toBeGreaterThan(0);
    }
  });

  it('keeps every mode inside what the room can hold', () => {
    for (const game of GAMES) {
      for (const mode of game.modes) {
        expect(mode.minPlayers, `${game.key}/${mode.key}`).toBeGreaterThanOrEqual(1);
        expect(mode.minPlayers, `${game.key}/${mode.key}`).toBeLessThanOrEqual(mode.maxPlayers);
        // Four is the relay's slot limit, so a mode asking for five could never
        // be started and would sit in the menu forever.
        expect(mode.maxPlayers, `${game.key}/${mode.key}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('names every mode uniquely within its game, and says what it is', () => {
    for (const game of GAMES) {
      const keys = game.modes.map((mode) => mode.key);
      expect(new Set(keys).size, game.key).toBe(keys.length);
      for (const mode of game.modes) {
        expect(mode.title.length, `${game.key}/${mode.key}`).toBeGreaterThan(0);
        expect(mode.detail.length, `${game.key}/${mode.key}`).toBeGreaterThan(0);
      }
    }
  });

  it('asks for calibration only where tilt is actually used', () => {
    for (const game of GAMES) {
      if (!game.calibration) continue;
      // Calibration centres the tilt axes; requiring it without tilt would be
      // the ceremony the calibration screen used to be.
      expect(game.modes.some((mode) => mode.input.tilt !== undefined), game.key).toBe(true);
    }
  });

  it('looks a game up by key', () => {
    expect(gameByKey('freeze-frame')?.title).toBe('Freeze Frame');
    expect(gameByKey('nope')).toBeUndefined();
  });
});

describe('offering the right mode for the room', () => {
  it('offers a real game rather than practice when the phones are there', () => {
    const tennis = gameByKey('tennis');
    expect(tennis).toBeDefined();
    if (!tennis) return;
    expect(defaultMode(tennis, 2).key).toBe('versus');
  });

  it('falls back to what one person can actually start', () => {
    const tennis = gameByKey('tennis');
    expect(tennis).toBeDefined();
    if (!tennis) return;
    expect(defaultMode(tennis, 1).key).toBe('practice');
  });

  it('always returns something, even for a room that fits no mode', () => {
    for (const game of GAMES) {
      for (const count of [0, 1, 2, 3, 4, 9]) {
        expect(defaultMode(game, count).key.length, `${game.key}/${count}`).toBeGreaterThan(0);
      }
    }
  });
});
