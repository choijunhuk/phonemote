import type { InputMapperConfig } from './input/InputMapper.js';

/**
 * The list of games, as data.
 *
 * It deliberately imports no scene and no Phaser: this file is what the lobby,
 * the launcher and the contract tests read, and none of them need a canvas.
 * `sceneTable.ts` does the wiring, and only main.ts imports that.
 *
 * Adding a game used to mean editing the scene array in main.ts, the hardcoded
 * key handlers in the lobby, and the hint string next to them. It also meant a
 * game's input needs were buried inside its create(), so nothing could know
 * what a game wanted until it had already started.
 */

/**
 * How a game is being played right now.
 *
 * Before this existed, Tennis guessed from the number of connected phones
 * (`players.length >= 2 ? 2 : 1`), so with two phones there was no way to
 * practise and with one there was no way to play a match. The mode is chosen in
 * the lobby and passed to the scene, and it carries its own input config
 * because a putting drill and a full round do not want the same detectors.
 */
export type GameModeKey = 'practice' | 'solo' | 'versus' | 'coop' | 'party';

export interface GameMode {
  readonly key: GameModeKey;
  /** Shown on the lobby chip. */
  readonly title: string;
  /** One line under it, saying what this mode actually is. */
  readonly detail: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly input: InputMapperConfig;
}

export type GameCategory = 'sports' | 'party' | 'tool';

export interface GameDefinition {
  /** Must equal the scene's own key. A test enforces that. */
  readonly key: string;
  readonly title: string;
  readonly blurb: string;
  readonly category: GameCategory;
  /**
   * Every game declares a practice mode. No exceptions, including the tool —
   * a rule with an exception in it does not get kept, and the practice screen
   * is where a player finds out what their own movement looks like.
   */
  readonly modes: readonly GameMode[];
  /** Whether to send players through the calibration screen first. */
  readonly calibration: boolean;
}

/** Player-count summary for the lobby, derived rather than written twice. */
export function playersLabel(game: GameDefinition): string {
  const min = Math.min(...game.modes.map((mode) => mode.minPlayers));
  const max = Math.max(...game.modes.map((mode) => mode.maxPlayers));
  return min === max ? `${min}명` : `${min}~${max}명`;
}

export function modeByKey(game: GameDefinition, key: string): GameMode | undefined {
  return game.modes.find((mode) => mode.key === key);
}

/** The mode to offer first for the number of phones in the room. */
export function defaultMode(game: GameDefinition, playerCount: number): GameMode {
  const fits = game.modes.filter(
    (mode) => playerCount >= mode.minPlayers && playerCount <= mode.maxPlayers,
  );
  const first = fits.find((mode) => mode.key !== 'practice') ?? fits[0] ?? game.modes[0];
  // The registry is never empty, but the type does not know that.
  return first ?? { key: 'practice', title: '연습', detail: '', minPlayers: 1, maxPlayers: 4, input: {} };
}

/** Gravity only: no swing timing, no drift, no absolute heading. */
const POSE_ONLY: InputMapperConfig = { pose: true };

export const GAMES: readonly GameDefinition[] = [
  {
    key: 'freeze-frame',
    title: 'Freeze Frame',
    blurb: '화면이 부르는 자세로 폰을 들고 버티기',
    category: 'party',
    calibration: false,
    modes: [
      {
        key: 'party',
        title: '다 같이',
        detail: '라운드마다 자세 하나, 먼저 고정한 순서로 3·2·1점',
        minPlayers: 2,
        maxPlayers: 4,
        input: POSE_ONLY,
      },
      {
        key: 'solo',
        title: '혼자',
        detail: '목숨 3개로 몇 라운드까지 버티는지',
        minPlayers: 1,
        maxPlayers: 1,
        input: POSE_ONLY,
      },
      {
        key: 'practice',
        title: '연습',
        detail: '목숨도 점수도 없이, 지금 몇 도 어긋났는지만 계속 보여준다',
        minPlayers: 1,
        maxPlayers: 4,
        input: POSE_ONLY,
      },
    ],
  },
  {
    key: 'tennis',
    title: 'Tennis',
    blurb: '공이 라켓 근처에 왔을 때 폰을 휘두르기',
    category: 'sports',
    calibration: false,
    modes: [
      {
        key: 'versus',
        title: '대전',
        detail: '5점 선취',
        minPlayers: 2,
        maxPlayers: 2,
        input: { swing: true },
      },
      {
        key: 'practice',
        title: '벽치기',
        detail: '벽을 상대로 랠리, 스윙 속도와 파워를 숫자로 표시',
        minPlayers: 1,
        maxPlayers: 1,
        input: { swing: true },
      },
    ],
  },
  {
    key: 'pointer-test',
    title: 'Pointer Test',
    blurb: '기울기와 자이로 포인터를 눈으로 확인하는 도구',
    category: 'tool',
    calibration: true,
    modes: [
      {
        key: 'practice',
        title: '점검',
        detail: '기울기·포인터·스윙·흔들림이 지금 어떻게 읽히는지',
        minPlayers: 1,
        maxPlayers: 4,
        input: { tilt: {}, pointer: {}, swing: true, stillness: true },
      },
    ],
  },
];

export function gameByKey(key: string): GameDefinition | undefined {
  return GAMES.find((game) => game.key === key);
}
