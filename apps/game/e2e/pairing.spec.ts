import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * A phone joining the web build, end to end (ARCHITECTURE.md D60).
 *
 * The game page and the controller page run side by side in one browser and
 * connect over a real RTCPeerConnection with real data channels. The handshake
 * is either local (`?signal=local`, a BroadcastChannel) or the PhoneMote server
 * running on this machine, which is also how the relay is tested (D63);
 * everything after it — the room's seating, the sensor channel, pings and their
 * pongs, rejoining a kept seat — is the code that runs on a phone.
 *
 * What it cannot stand in for: an Android phone's sensors, and the networks
 * between a real phone and a real PC. Those stay a manual check.
 */

interface PlayerView {
  readonly id: number;
  readonly name: string;
  readonly present: boolean;
}

interface Handle {
  readonly session: {
    readonly players: readonly PlayerView[];
    readonly room: { roomCode: string; controllerUrl: string } | null;
    debugInfo(playerId: number): { hz: number; latency: { samples: number } };
  };
}

type TestWindow = Window & { phonemote?: Handle };

function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  return problems;
}

/** The PhoneMote server the config starts on this machine (D63). */
const SERVER = 'signal=server&server=ws://localhost:4190';

async function openGame(
  context: BrowserContext,
  query = 'signal=local',
): Promise<{ game: Page; url: string }> {
  const game = await context.newPage();
  await game.goto(`./?${query}`);
  const url = await game
    .waitForFunction(() => (window as TestWindow).phonemote?.session.room?.controllerUrl)
    .then((handle) => handle.jsonValue());
  if (typeof url !== 'string') throw new Error('the room never got a controller URL');
  return { game, url };
}

/** Join from the controller page, as a player would after scanning the code. */
async function joinAs(phone: Page, url: string, name: string): Promise<void> {
  await phone.goto(url);
  await phone.locator('input.name').fill(name);
  await phone.locator('button.start').click();
  await expect(phone.locator('.status')).toContainText('연결됨', { timeout: 20_000 });
}

/** Motion and orientation events at 60 Hz, as Chrome on a phone fires them. */
async function startSensors(phone: Page): Promise<void> {
  await phone.evaluate(() => {
    window.setInterval(() => {
      window.dispatchEvent(
        new DeviceMotionEvent('devicemotion', {
          acceleration: { x: 0, y: 0, z: 0 },
          accelerationIncludingGravity: { x: 0, y: 9.8, z: 0 },
          rotationRate: { alpha: 5, beta: 0, gamma: 0 },
          interval: 16,
        }),
      );
      window.dispatchEvent(
        new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 90, gamma: 0 }),
      );
    }, 16);
  });
}

/**
 * The game's view of a player, by name. The name is passed in rather than
 * closed over: Playwright sends the function to the page as source text, and a
 * captured variable there resolves to whatever the page has by that name.
 */
function playerNamed(game: Page, name: string): Promise<PlayerView | undefined> {
  return game.evaluate(
    (wanted) => (window as TestWindow).phonemote?.session.players.find((p) => p.name === wanted),
    name,
  );
}

/** Sensor frames at a real rate and pings answered, for this player, both ways of the link. */
async function expectStreaming(game: Page, name: string): Promise<void> {
  // Frames arriving over the sensor channel (or the relay's tunnel), at a real rate.
  await game.waitForFunction(
    (wanted) => {
      const session = (window as TestWindow).phonemote?.session;
      const player = session?.players.find((entry) => entry.name === wanted);
      return player !== undefined && (session?.debugInfo(player.id).hz ?? 0) > 20;
    },
    name,
    { timeout: 15_000 },
  );
  // The game pings once a second, and the pong comes back the same way.
  await game.waitForFunction(
    (wanted) => {
      const session = (window as TestWindow).phonemote?.session;
      const player = session?.players.find((entry) => entry.name === wanted);
      return player !== undefined && (session?.debugInfo(player.id).latency.samples ?? 0) >= 2;
    },
    name,
    { timeout: 15_000 },
  );
}

test('a phone joins from the link, and its sensors and pings reach the game', async ({
  context,
}) => {
  const { game, url } = await openGame(context);
  const gameProblems = watchForProblems(game);
  const code = await game.evaluate(() => (window as TestWindow).phonemote?.session.room?.roomCode);
  expect(url).toContain(`controller/?room=${code}&signal=local`);

  const phone = await context.newPage();
  const phoneProblems = watchForProblems(phone);
  await joinAs(phone, url, 'Tester');
  await startSensors(phone);
  await expectStreaming(game, 'Tester');

  expect(gameProblems).toEqual([]);
  expect(phoneProblems).toEqual([]);
});

test('two phones get two seats, and a phone that drops comes back to its own', async ({
  context,
}) => {
  const { game, url } = await openGame(context);
  const gameProblems = watchForProblems(game);

  const first = await context.newPage();
  await joinAs(first, url, 'First');
  // Pages in one browser share storage, so the phones' ids are managed by hand:
  // the second gets its own, and the first's is put back for its return.
  const firstId = await first.evaluate(() => localStorage.getItem('phonemote.clientId'));
  const second = await context.newPage();
  await second.addInitScript(() => localStorage.setItem('phonemote.clientId', 'second-phone'));
  await joinAs(second, url, 'Second');
  await second.evaluate((id) => localStorage.setItem('phonemote.clientId', id ?? ''), firstId);

  const seats = await game.evaluate(() =>
    ((window as TestWindow).phonemote?.session.players ?? []).map((player) => player.id),
  );
  expect(new Set(seats).size).toBe(2);
  const firstSeat = await playerNamed(game, 'First');
  expect(firstSeat?.present).toBe(true);

  // The first phone's page closes. Its seat is held, not handed out.
  await first.close();
  await game.waitForFunction(
    () =>
      (window as TestWindow).phonemote?.session.players.find((p) => p.name === 'First')?.present ===
      false,
    null,
    { timeout: 15_000 },
  );

  // Same phone, same stored id: back in the same seat, under the same number.
  const again = await context.newPage();
  await again.goto(url);
  // A live sensor stream, or the status line reports the stall instead.
  await startSensors(again);
  await again.locator('button.start').click();
  await expect(again.locator('.status')).toContainText('복귀', { timeout: 20_000 });
  const back = await playerNamed(game, 'First');
  expect(back?.id).toBe(firstSeat?.id);
  expect(back?.present).toBe(true);

  expect(gameProblems).toEqual([]);
});

test('a phone joins through the PhoneMote server, over a direct link', async ({ context }) => {
  // The handshake goes through the real server code on this machine; the
  // game hands the same choice on to the phone through the link.
  const { game, url } = await openGame(context, SERVER);
  const gameProblems = watchForProblems(game);
  expect(url).toContain('signal=server');
  expect(url).toContain('server=ws');

  const phone = await context.newPage();
  const phoneProblems = watchForProblems(phone);
  const links: string[] = [];
  phone.on('console', (message) => {
    if (message.text().startsWith('[link]')) links.push(message.text());
  });
  await joinAs(phone, url, 'Direct');
  await startSensors(phone);
  await expectStreaming(game, 'Direct');
  expect(links.some((line) => line.includes('direct link open'))).toBe(true);

  expect(gameProblems).toEqual([]);
  expect(phoneProblems).toEqual([]);
});

test('a phone that cannot connect directly plays through the server relay', async ({
  context,
}) => {
  // `relay=only` skips the WebRTC attempt, which is what a network without a
  // direct route amounts to: the phone tunnels to the room over a WebSocket.
  const { game, url } = await openGame(context, SERVER);
  const gameProblems = watchForProblems(game);

  const phone = await context.newPage();
  const phoneProblems = watchForProblems(phone);
  const links: string[] = [];
  phone.on('console', (message) => {
    if (message.text().startsWith('[link]')) links.push(message.text());
  });
  await joinAs(phone, `${url}&relay=only`, 'Relayed');
  await startSensors(phone);
  await expectStreaming(game, 'Relayed');
  expect(links.some((line) => line.includes('relay link open'))).toBe(true);

  expect(gameProblems).toEqual([]);
  expect(phoneProblems).toEqual([]);
});
