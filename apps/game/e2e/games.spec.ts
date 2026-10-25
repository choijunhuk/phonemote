import { expect, test, type Page } from '@playwright/test';
import { GAMES } from '../src/games.ts';

/**
 * Every game, in every mode, played by keyboard stand-ins for thirty seconds of
 * game time, in a real browser, against the build that gets deployed (D57).
 * `?signal=local` keeps the page off the public signaling server.
 *
 * The unit tests cover each game's rules as pure state machines, and none of
 * them runs a scene. What breaks in a scene — a text object touched after
 * shutdown, a tween on a destroyed sprite, a NaN reaching the renderer — only
 * shows up when the scene really runs. This is that run, for all of them.
 *
 * The game loop is put to sleep and stepped by hand on a synthetic clock, the
 * way the browser walkthrough always was (ARCHITECTURE.md 8): thirty seconds of
 * play takes a fraction of that, and the same keys land on the same frames
 * every time.
 */

const FRAME_MS = 1000 / 60;
const EARLY_SECONDS = 5;
const TOTAL_SECONDS = 30;
/**
 * Draw one frame in this many. Headless Chromium renders WebGL in software, and
 * drawing all 1800 frames took longer than the whole test may. Ten drawn frames
 * a second still runs every scene's render code all the way through.
 */
const RENDER_EVERY = 6;
const SCREENS = 'dist/e2e-screens';

/** Swing, A, lean left, lean right, trigger — for each keyboard stand-in. */
const PLAYER_KEYS: ReadonlyArray<readonly [string, string, string, string, string]> = [
  [' ', 'z', 'ArrowLeft', 'ArrowRight', 'c'],
  ['q', 'e', 'a', 'd', 'f'],
  ['u', 'o', 'j', 'l', ';'],
  ['5', '7', '4', '6', '1'],
];

/** The slice of the page's handle (src/main.ts) that this test touches. */
interface Handle {
  readonly game: {
    readonly isBooted: boolean;
    readonly loop: { sleep(): void };
    readonly events: { emit(event: string, ...args: unknown[]): void };
    step(time: number, delta: number): void;
    readonly scene: {
      isProcessing: boolean;
      update(time: number, delta: number): void;
      isActive(key: string): boolean;
      getScene(key: string): { scene: { start(key: string, data: object): void } };
    };
  };
  readonly session: {
    readonly players: readonly unknown[];
    readonly room: { roomCode: string } | null;
    readonly lastError: { message: string } | null;
    configureInput(config: unknown): void;
  };
}

/** The keyboard stand-ins' hand crank (src/dev/FakeController.ts). */
interface FakeHandle {
  tick(now: number): void;
  press(key: string): void;
  release(key: string): void;
}

interface DriverState {
  now: number;
  frame: number;
  reached: boolean;
  /** The game finished and went back to the lobby by itself. */
  left: boolean;
}

type TestWindow = Window & {
  phonemote?: Handle;
  phonemoteFake?: FakeHandle;
  e2e?: DriverState;
};

/** Page errors and console errors, collected for one assertion at the end. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  return problems;
}

async function waitForLobby(page: Page, players: number): Promise<void> {
  await page.waitForFunction((count) => {
    const handle = (window as TestWindow).phonemote;
    return (
      handle !== undefined &&
      handle.game.isBooted &&
      handle.game.scene.isActive('lobby') &&
      handle.session.players.length === count
    );
  }, players);
}

/** Step the game and the stand-ins together, pressing keys like a rough player. */
async function play(
  page: Page,
  seconds: number,
  gameKey: string,
  players: number,
): Promise<{ reached: boolean; left: boolean; error: string | null }> {
  return page.evaluate(
    ({ frames, frameMs, renderEvery, key, keys }) => {
      const w = window as TestWindow;
      const handle = w.phonemote;
      const fake = w.phonemoteFake;
      const state = w.e2e;
      if (!handle || !fake || !state) throw new Error('the page handles are missing');
      const game = handle.game;

      // Phaser's Game.step with the drawing left out: the same events, in the
      // same order, around the same scene update.
      const update = (time: number, delta: number): void => {
        game.events.emit('prestep', time, delta);
        game.events.emit('step', time, delta);
        game.scene.update(time, delta);
        game.events.emit('poststep', time, delta);
        game.scene.isProcessing = false;
      };

      for (let n = 0; n < frames && !state.left; n++) {
        const frame = state.frame++;
        keys.forEach(([swing, a, left, right, trigger], index) => {
          // Out of step with each other, the way people are.
          const t = frame + index * 23;
          if (t % 90 === 0) fake.press(swing);
          else if (t % 90 === 6) fake.release(swing);
          if (t % 120 === 30) fake.press(a);
          else if (t % 120 === 34) fake.release(a);
          if (t % 240 === 60) fake.press(left);
          else if (t % 240 === 90) fake.release(left);
          if (t % 240 === 150) fake.press(right);
          else if (t % 240 === 180) fake.release(right);
          if (t % 300 === 200) fake.press(trigger);
          else if (t % 300 === 204) fake.release(trigger);
        });
        fake.tick(state.now);
        // The last frame of a stretch is always drawn: a screenshot follows it.
        if (frame % renderEvery === 0 || n === frames - 1) game.step(state.now, frameMs);
        else update(state.now, frameMs);
        state.now += frameMs;
        if (game.scene.isActive(key)) state.reached = true;
        // A finished game returns to the lobby, and the A this player keeps
        // pressing would then launch whatever the lobby has focused.
        else if (state.reached && game.scene.isActive('lobby')) state.left = true;
      }
      return {
        reached: state.reached,
        left: state.left,
        error: handle.session.lastError?.message ?? null,
      };
    },
    {
      frames: Math.round(seconds * 60),
      frameMs: FRAME_MS,
      renderEvery: RENDER_EVERY,
      key: gameKey,
      keys: PLAYER_KEYS.slice(0, players),
    },
  );
}

test('the page opens a room with a code and needs no server of its own', async ({ page }) => {
  const problems = watchForProblems(page);
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));

  await page.goto('./?signal=local');
  await expect(page.locator('.web-banner')).toContainText('scan the QR code');
  await waitForLobby(page, 0);
  await page.waitForFunction(
    () => /^[A-Z0-9]{4}$/.test((window as TestWindow).phonemote?.session.room?.roomCode ?? ''),
  );
  await page.screenshot({ path: `${SCREENS}/lobby.png` });

  expect(sockets).toEqual([]);
  expect(problems).toEqual([]);
});

test('N in the lobby seats keyboard players in the room', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto('./?signal=local');
  await waitForLobby(page, 0);
  await page.keyboard.press('n');
  await waitForLobby(page, 1);
  await page.keyboard.press('n');
  await waitForLobby(page, 2);
  expect(problems).toEqual([]);
});

test('a recorded phone trace replays from beside the page', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto('./?signal=local&replay=real-swing.pmtrace');
  await waitForLobby(page, 1);
  expect(problems).toEqual([]);
});

for (const game of GAMES) {
  for (const mode of game.modes) {
    test(`${game.key} / ${mode.key}: ${TOTAL_SECONDS}s of play without an error`, async ({
      page,
    }) => {
      // Two vCPUs on CI, software WebGL, thirty seconds of game per test.
      test.setTimeout(120_000);
      const problems = watchForProblems(page);
      await page.goto(`./?signal=local&fake=${mode.minPlayers}`);
      await waitForLobby(page, mode.minPlayers);

      // What the lobby's launch does, without needing the menu focus there.
      await page.evaluate(
        ({ key, modeKey, calibration, input }) => {
          const w = window as TestWindow;
          const handle = w.phonemote;
          if (!handle) throw new Error('the page handle is missing');
          handle.game.loop.sleep();
          handle.session.configureInput(input);
          handle.game.scene
            .getScene('lobby')
            .scene.start(calibration ? 'calibration' : key, { mode: modeKey, next: key });
          w.e2e = { now: performance.now(), frame: 0, reached: false, left: false };
        },
        { key: game.key, modeKey: mode.key, calibration: game.calibration, input: mode.input },
      );

      await play(page, EARLY_SECONDS, game.key, mode.minPlayers);
      await page.screenshot({ path: `${SCREENS}/${game.key}-${mode.key}-early.png` });
      const result = await play(page, TOTAL_SECONDS - EARLY_SECONDS, game.key, mode.minPlayers);
      await page.screenshot({ path: `${SCREENS}/${game.key}-${mode.key}-late.png` });

      expect(result.error).toBeNull();
      expect(result.reached, 'the game scene never became active').toBe(true);
      expect(problems).toEqual([]);
    });
  }
}
