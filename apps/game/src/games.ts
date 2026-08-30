import type Phaser from 'phaser';
import type { InputMapperConfig } from './input/InputMapper.js';
import { FreezeFrame } from './scenes/games/FreezeFrame.js';
import { PointerTest } from './scenes/games/PointerTest.js';
import { Tennis } from './scenes/games/Tennis.js';

/**
 * The list of games, in one place.
 *
 * It lives beside main.ts rather than under scenes/ because it is wiring, not
 * a scene: it names what each game needs so the app can set that up before the
 * scene exists. Scenes themselves still see only GameActions (P4).
 *
 * Adding a game used to mean editing the scene array in main.ts, the hardcoded
 * key handlers in the lobby, and the hint string next to them — three places,
 * two of which are easy to forget. It also meant a game's input needs were
 * buried inside its create(), so nothing could know what a game wanted until
 * it had already started.
 */

export interface GameDefinition {
  /** Must equal the scene's own key. A test enforces that. */
  readonly key: string;
  readonly title: string;
  readonly blurb: string;
  readonly players: string;
  /** Applied before the scene starts, so the first frame is already correct. */
  readonly input: InputMapperConfig;
  /** Whether to send players through the calibration screen first. */
  readonly calibration: boolean;
  readonly scene: new () => Phaser.Scene;
}

export const GAMES: readonly GameDefinition[] = [
  {
    key: 'freeze-frame',
    title: 'Freeze Frame',
    blurb: '화면이 부르는 자세로 폰을 들고 버티기',
    players: '1~4명',
    // Gravity only: no swing timing, no drift, no absolute heading.
    input: { pose: true },
    calibration: false,
    scene: FreezeFrame,
  },
  {
    key: 'tennis',
    title: 'Tennis',
    blurb: '공이 라켓 근처에 왔을 때 폰을 휘두르기',
    players: '1~2명',
    input: { swing: true },
    calibration: false,
    scene: Tennis,
  },
  {
    key: 'pointer-test',
    title: 'Pointer Test',
    blurb: '기울기와 자이로 포인터를 눈으로 확인하는 도구',
    players: '1~4명',
    input: { tilt: {}, pointer: {}, swing: true },
    calibration: true,
    scene: PointerTest,
  },
];

export function gameByKey(key: string): GameDefinition | undefined {
  return GAMES.find((game) => game.key === key);
}
