import { WebSocket } from 'ws';
import {
  PORTS,
  SENSOR_FLAG,
  SENSOR_FRAME_VERSION,
  decodeSensor,
  encodeSensor,
  parseMessage,
  toArrayBuffer,
  type SensorFrame,
} from '@phonemote/protocol';
import { resolveLanIp } from './lanIp.js';

/**
 * Development harness for the throughput part of the Phase 1 DoD.
 *
 * Stands up a fake game and a fake controller, streams frames at 60 Hz, and
 * reports what actually arrived. It never runs in production; it exists so the
 * "does the pipe keep up" question has a number instead of an opinion.
 *
 *   pnpm --filter @phonemote/server run throughput
 */

const DURATION_MS = 5000;
const SEND_INTERVAL_MS = 1000 / 60;
const PING_INTERVAL_MS = 100;

// This is a local dev probe against our own mkcert certificate; Node keeps its
// own CA store and there is nothing to gain from teaching it about ours here.
const wsOptions = { rejectUnauthorized: false };

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? Number.NaN;
}

function frame(playerId: number, seq: number): SensorFrame {
  const t = performance.now();
  return {
    playerId,
    seq,
    timestamp: t,
    orientation: { alpha: (seq * 3) % 360, beta: 10, gamma: -5 },
    rotationRate: { alpha: 1, beta: 2, gamma: 3 },
    acceleration: { x: 0.1, y: 0.2, z: 0.3 },
    buttons: seq % 120 < 5 ? 1 : 0,
    screenOrientation: 1,
    version: SENSOR_FRAME_VERSION,
    motionSeq: seq,
    flags: SENSOR_FLAG.LINEAR_ACCEL | SENSOR_FLAG.ROTATION_RATE | SENSOR_FLAG.ORIENTATION,
  };
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, wsOptions);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function main(): Promise<void> {
  const host = resolveLanIp().host;
  const url = `wss://${host}:${PORTS.relay}`;
  console.log(`[throughput] connecting to ${url}`);

  const game = await open(url);
  const roomCode = await new Promise<string>((resolve, reject) => {
    game.once('message', (data) => {
      const message = parseMessage(data.toString());
      if (message?.type === 'room') resolve(message.roomCode);
      else reject(new Error(`Expected a room message, got: ${data.toString()}`));
    });
    game.send(JSON.stringify({ type: 'hello', role: 'game' }));
  });
  console.log(`[throughput] room ${roomCode}`);

  const controller = await open(url);
  const playerId = await new Promise<number>((resolve, reject) => {
    controller.once('message', (data) => {
      const message = parseMessage(data.toString());
      if (message?.type === 'joined') resolve(message.playerId);
      else reject(new Error(`Expected a joined message, got: ${data.toString()}`));
    });
    controller.send(JSON.stringify({ type: 'hello', role: 'controller', roomCode }));
  });

  let received = 0;
  let lost = 0;
  let lastSeq: number | null = null;
  const rtts: number[] = [];
  const pingSentAt = new Map<number, number>();

  game.on('message', (data, isBinary) => {
    if (isBinary) {
      const decoded = decodeSensor(toArrayBuffer(data as Buffer));
      received++;
      if (lastSeq !== null && decoded.seq !== lastSeq + 1) lost += decoded.seq - lastSeq - 1;
      lastSeq = decoded.seq;
      return;
    }
    const message = parseMessage(data.toString());
    if (message?.type === 'pong') {
      const sentAt = pingSentAt.get(message.id);
      if (sentAt !== undefined) rtts.push(performance.now() - sentAt);
    }
  });

  controller.on('message', (data, isBinary) => {
    if (isBinary) return;
    const message = parseMessage(data.toString());
    if (message?.type === 'ping') controller.send(JSON.stringify({ ...message, type: 'pong' }));
  });

  let sent = 0;
  let pingId = 0;
  const startedAt = performance.now();

  // Windows timers do not honour a 16.67 ms interval (they land nearer 23 ms),
  // which would cap the harness at ~42 Hz and measure the timer instead of the
  // pipe. Tick faster and send every frame whose slot has come due. A real
  // phone paces itself off requestAnimationFrame and has no such problem.
  let nextDueAt = performance.now();
  const sender = setInterval(() => {
    const now = performance.now();
    while (nextDueAt <= now) {
      controller.send(encodeSensor(frame(playerId, sent++)));
      nextDueAt += SEND_INTERVAL_MS;
    }
  }, 2);

  const pinger = setInterval(() => {
    const id = pingId++;
    pingSentAt.set(id, performance.now());
    game.send(JSON.stringify({ type: 'ping', id, playerId }));
  }, PING_INTERVAL_MS);

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  clearInterval(sender);
  clearInterval(pinger);
  // Measure over the sending window only: the drain wait below would otherwise
  // be counted as time nothing was sent, understating both rates.
  const seconds = (performance.now() - startedAt) / 1000;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const hz = received / seconds;
  const sendHz = sent / seconds;

  console.log('');
  console.log(`  sent      ${sent} frames  (${sendHz.toFixed(1)} Hz)`);
  console.log(`  received  ${received} frames  (${hz.toFixed(1)} Hz)`);
  console.log(`  lost      ${lost} frames  (${((lost / Math.max(1, sent)) * 100).toFixed(2)}%)`);
  console.log(`  rtt       median ${percentile(rtts, 50).toFixed(1)} ms  ` +
    `p95 ${percentile(rtts, 95).toFixed(1)} ms  (${rtts.length} samples)`);
  console.log('');

  game.close();
  controller.close();

  if (sendHz < 58) {
    console.error(`INCONCLUSIVE: the harness only sent ${sendHz.toFixed(1)} Hz, so the ` +
      'receive rate says nothing about the relay.');
    process.exit(1);
  }
  if (hz < 55) {
    console.error(`FAIL: expected at least 55 Hz at the game, measured ${hz.toFixed(1)}`);
    process.exit(1);
  }
  console.log('PASS: >= 55 Hz at the game socket');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
