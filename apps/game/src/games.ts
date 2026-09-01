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

/**
 * Leaning and aiming games: where the phone is pointing, plus whether it is
 * being held still — which is how they take a grip reference without asking for
 * a button press, and how archery measures the shake in the hand.
 */
const LEAN_INPUT: InputMapperConfig = { pose: true, stillness: true };

/**
 * Bowling: stance from gravity, delivery from the swing, and the moment the
 * ball leaves the hand from the trigger going up. A gentle delivery may never
 * cross the swing threshold at all, so the release is a button edge rather than
 * an inference (ARCHITECTURE.md D49).
 */
const BOWL_INPUT: InputMapperConfig = {
  pose: true,
  stillness: true,
  swing: true,
  release: true,
};

/**
 * Golf needs both bands from the same phone: the full swing above 400 deg/s and
 * the putt at 40-300, which has no threshold to cross and is segmented by the
 * point where the stroke turns around.
 */
const GOLF_INPUT: InputMapperConfig = {
  pose: true,
  stillness: true,
  swing: true,
  stroke: true,
};

/** The statue race reads one number: how hard the phone is being shaken. */
const SHAKE_INPUT: InputMapperConfig = { stillness: true };

export const GAMES: readonly GameDefinition[] = [
  {
    key: 'statue-race',
    title: 'Statue Race',
    blurb: '움직일 땐 마구, 멈출 땐 완전히',
    category: 'party',
    calibration: false,
    modes: [
      {
        key: 'party',
        title: '다 같이',
        detail: '한 트랙에서 동시에, 빨간불에 움직이면 잡힌다',
        minPlayers: 2,
        maxPlayers: 4,
        input: SHAKE_INPUT,
      },
      {
        key: 'solo',
        title: '혼자',
        detail: '자기 최고 기록의 고스트와 경주',
        minPlayers: 1,
        maxPlayers: 1,
        input: SHAKE_INPUT,
      },
      {
        key: 'practice',
        title: '멈추기',
        detail: '멈추는 데 몇 밀리초 걸리는지만 잰다',
        minPlayers: 1,
        maxPlayers: 4,
        input: SHAKE_INPUT,
      },
    ],
  },
  {
    key: 'together-table',
    title: 'Together Table',
    blurb: '다 같이 한 상을 기울여 공을 굴린다',
    category: 'party',
    calibration: false,
    modes: [
      {
        key: 'coop',
        title: '협동',
        detail: '판의 기울기는 전원의 평균 — 맞추지 않으면 아무 데도 못 간다',
        minPlayers: 2,
        maxPlayers: 4,
        input: LEAN_INPUT,
      },
      {
        key: 'versus',
        title: '줄다리기',
        detail: '한 판 위에서 자기 색 구멍에 3골 선취',
        minPlayers: 2,
        maxPlayers: 4,
        input: LEAN_INPUT,
      },
      {
        key: 'solo',
        title: '혼자',
        detail: '구슬 미로, 코스별 기록',
        minPlayers: 1,
        maxPlayers: 1,
        input: LEAN_INPUT,
      },
      {
        key: 'practice',
        title: '기울기 보기',
        detail: '자기 기울기를 10배로 확대해서 보여주고 편차를 도로 보고',
        minPlayers: 1,
        maxPlayers: 4,
        input: LEAN_INPUT,
      },
    ],
  },
  {
    key: 'archery',
    title: 'Archery',
    blurb: '당기고, 버티고, 흔들리기 전에 놓는다',
    category: 'sports',
    calibration: false,
    modes: [
      {
        key: 'versus',
        title: '대전',
        detail: '각자 과녁에 엔드마다 3발, 동시에',
        minPlayers: 2,
        maxPlayers: 4,
        input: LEAN_INPUT,
      },
      {
        key: 'solo',
        title: '혼자',
        detail: '6엔드 18발, 180점 만점',
        minPlayers: 1,
        maxPlayers: 1,
        input: LEAN_INPUT,
      },
      {
        key: 'practice',
        title: '정지 훈련',
        detail: '점수 없이, 버티는 동안의 흔들림과 조준점 궤적을 그린다',
        minPlayers: 1,
        maxPlayers: 4,
        input: LEAN_INPUT,
      },
    ],
  },
  {
    key: 'ski',
    title: 'Alpine Ski',
    blurb: '좌우로 기울여 카빙한다',
    category: 'sports',
    calibration: false,
    modes: [
      {
        key: 'versus',
        title: '대전',
        detail: '같은 코스를 나란히, 게이트 실패는 +2초',
        minPlayers: 2,
        maxPlayers: 4,
        input: LEAN_INPUT,
      },
      {
        key: 'solo',
        title: '타임 트라이얼',
        detail: '자기 최고 기록의 고스트와 함께 달린다',
        minPlayers: 1,
        maxPlayers: 1,
        input: LEAN_INPUT,
      },
      {
        key: 'practice',
        title: '카빙 레인',
        detail: '시계도 실패도 없이, 지금 엣지 각이 몇 도인지 계속 표시',
        minPlayers: 1,
        maxPlayers: 4,
        input: LEAN_INPUT,
      },
    ],
  },
  {
    key: 'bowling',
    title: 'Bowling',
    blurb: '자리를 잡고, 트리거를 놓는 순간 굴린다',
    category: 'sports',
    calibration: false,
    modes: [
      {
        key: 'versus',
        title: '대전',
        detail: '한 프레임씩 돌아가며, 10프레임 합계',
        minPlayers: 2,
        maxPlayers: 4,
        input: BOWL_INPUT,
      },
      {
        key: 'solo',
        title: '혼자',
        detail: '10프레임 정식 스코어링, 300점 만점',
        minPlayers: 1,
        maxPlayers: 1,
        input: BOWL_INPUT,
      },
      {
        key: 'practice',
        title: '스페어 드릴',
        detail: '핀을 남겨두고 반복, 궤적과 훅 비율을 숫자로 표시',
        minPlayers: 1,
        maxPlayers: 4,
        input: BOWL_INPUT,
      },
    ],
  },
  {
    key: 'golf',
    title: 'Golf',
    blurb: '드라이버는 1200°/s, 퍼팅은 10도',
    category: 'sports',
    calibration: false,
    modes: [
      {
        key: 'versus',
        title: '대전',
        detail: '9홀 스트로크 플레이, 홀에서 먼 사람이 먼저',
        minPlayers: 2,
        maxPlayers: 4,
        input: GOLF_INPUT,
      },
      {
        key: 'solo',
        title: '혼자',
        detail: '9홀, 파 대비 기록',
        minPlayers: 1,
        maxPlayers: 1,
        input: GOLF_INPUT,
      },
      {
        key: 'practice',
        title: '드라이빙 레인지',
        detail: '공 무제한, 샷마다 페이스 각과 스윙 속도를 표시',
        minPlayers: 1,
        maxPlayers: 4,
        input: GOLF_INPUT,
      },
    ],
  },
  {
    key: 'freeze-frame',
    title: 'Freeze Frame',
    blurb: '화면이 부르는 자세로 버티기',
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
    blurb: '공이 라켓 근처에 왔을 때 휘두르기',
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
        // Four, not one: refusing to start practice because a second phone
        // happens to be connected is a menu telling somebody to unplug a
        // device. The others watch, and the rules ignore their swings.
        key: 'practice',
        title: '벽치기',
        detail: '벽을 상대로 랠리, 스윙 속도와 파워를 숫자로 표시',
        minPlayers: 1,
        maxPlayers: 4,
        input: { swing: true },
      },
    ],
  },
  {
    key: 'pointer-test',
    title: 'Pointer Test',
    blurb: '기울기와 포인터를 눈으로 확인',
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
