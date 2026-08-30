import { describe, expect, it, vi } from 'vitest';

/**
 * The registry promises that its key is the scene's key. Nothing at runtime
 * checks that, and getting it wrong means a menu entry that starts nothing.
 *
 * Phaser reaches for a canvas as soon as it is imported, which no headless
 * environment has, so it is replaced with a stub that records the key each
 * scene passes to super(). That is the only part of Phaser this contract
 * depends on.
 */

vi.mock('phaser', () => {
  class Scene {
    constructor(readonly sceneKey: string) {}
  }
  return {
    default: {
      Scene,
      Scenes: { Events: { SHUTDOWN: 'shutdown' } },
      Math: { Linear: (a: number) => a },
      AUTO: 0,
      Scale: { FIT: 0, CENTER_BOTH: 0 },
    },
  };
});

const { GAMES, gameByKey } = await import('../games.js');

function sceneKey(definition: (typeof GAMES)[number]): string {
  return (new definition.scene() as unknown as { sceneKey: string }).sceneKey;
}

describe('the game registry', () => {
  it('has a unique key per game', () => {
    const keys = GAMES.map((game) => game.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses each scene’s own key', () => {
    for (const game of GAMES) {
      expect(sceneKey(game)).toBe(game.key);
    }
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
      expect(game.players).toMatch(/명/);
    }
  });

  it('looks a game up by key', () => {
    expect(gameByKey('freeze-frame')?.title).toBe('Freeze Frame');
    expect(gameByKey('nope')).toBeUndefined();
  });

  it('asks for calibration only where tilt is actually used', () => {
    for (const game of GAMES) {
      if (!game.calibration) continue;
      // Calibration centres the tilt axes; requiring it without tilt would be
      // the ceremony the calibration screen used to be.
      expect(game.input.tilt).toBeDefined();
    }
  });
});
