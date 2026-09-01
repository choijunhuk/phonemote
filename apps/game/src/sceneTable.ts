import type Phaser from 'phaser';
import { Archery } from './scenes/games/Archery.js';
import { Bowling } from './scenes/games/Bowling.js';
import { FreezeFrame } from './scenes/games/FreezeFrame.js';
import { Golf } from './scenes/games/Golf.js';
import { Ski } from './scenes/games/Ski.js';
import { StatueRace } from './scenes/games/StatueRace.js';
import { TogetherTable } from './scenes/games/TogetherTable.js';
import { PointerTest } from './scenes/games/PointerTest.js';
import { Tennis } from './scenes/games/Tennis.js';
import { GAMES } from './games.js';

/**
 * The only place a game key becomes a Phaser class.
 *
 * Kept apart from games.ts because that file is read by the lobby, the launcher
 * and the contract tests, none of which want Phaser — importing it there meant
 * every registry test had to mock a canvas library to ask what a game is called.
 */

const SCENES: Readonly<Record<string, new () => Phaser.Scene>> = {
  bowling: Bowling,
  golf: Golf,
  archery: Archery,
  ski: Ski,
  'statue-race': StatueRace,
  'together-table': TogetherTable,
  'freeze-frame': FreezeFrame,
  tennis: Tennis,
  'pointer-test': PointerTest,
};

/** Throws at startup rather than showing a menu entry that starts nothing. */
export function gameScenes(): ReadonlyArray<new () => Phaser.Scene> {
  return GAMES.map((game) => {
    const scene = SCENES[game.key];
    if (!scene) throw new Error(`no scene registered for game "${game.key}"`);
    return scene;
  });
}
