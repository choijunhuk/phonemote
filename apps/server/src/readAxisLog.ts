import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR } from './logs.js';

/**
 * Reads back an axis-check session and says what the phone actually reported.
 *
 *   pnpm --filter @phonemote/server run axis
 *
 * It prints the mean of each measurement next to what ARCHITECTURE.md 5.6
 * predicts, and flags the ones that disagree. Nothing is corrected here: if
 * the table is wrong, the table changes first, then the normaliser, then the
 * tests — in that order, deliberately.
 */

interface Sample {
  raw: Record<string, number>;
  canonical: Record<string, number>;
}

interface Step {
  key: string;
  prompt: string;
  expectation: string;
  samples: Sample[];
}

interface AxisSession {
  kind?: string;
  receivedAt?: string;
  startedAt?: string;
  player?: { id: number; name: string };
  userAgent?: string;
  steps: Step[];
}

function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function extreme(values: number[]): number {
  // The largest departure from zero, which is what a motion is about.
  return values.reduce((best, value) => (Math.abs(value) > Math.abs(best) ? value : best), 0);
}

function column(field: string, step: Step, side: 'raw' | 'canonical'): number[] {
  return step.samples.map((sample) => sample[side][field] ?? Number.NaN);
}

/**
 * The last part of the window, once the phone has stopped moving.
 *
 * Averaging the whole window mixes the journey in with the destination — the
 * mean of a unit vector that swung ninety degrees is not a direction anyone
 * held, and it shows up as a gravity vector shorter than one.
 */
function settled(step: Step): Step {
  const keep = Math.max(5, Math.floor(step.samples.length * 0.4));
  return { ...step, samples: step.samples.slice(-keep) };
}

function fixed(value: number, width = 7): string {
  return (Number.isFinite(value) ? value.toFixed(1) : '—').padStart(width);
}

function report(session: AxisSession): void {
  console.log('');
  console.log(`session   ${session.startedAt ?? '?'}  player ${session.player?.name ?? '?'}`);
  console.log(`device    ${(session.userAgent ?? '?').slice(0, 90)}`);
  console.log('');

  for (const step of session.steps) {
    const samples = step.samples.length;
    console.log(`── ${step.key}  (${samples} samples, ${settled(step).samples.length} settled)`);
    console.log(`   요청: ${step.prompt}`);
    console.log(`   예상: ${step.expectation}`);
    if (samples === 0) {
      console.log('   (표본 없음 — 프레임이 도착하지 않았습니다)');
      console.log('');
      continue;
    }

    // Held pose from the settled tail; motion figures from the whole window.
    const held = settled(step);
    const up = {
      x: mean(column('upX', held, 'canonical')),
      y: mean(column('upY', held, 'canonical')),
      z: mean(column('upZ', held, 'canonical')),
    };
    console.log(
      `   up        x${fixed(up.x)} y${fixed(up.y)} z${fixed(up.z)}` +
        `   (|up| ${Math.hypot(up.x, up.y, up.z).toFixed(2)})`,
    );
    console.log(
      `   angles    yaw${fixed(mean(column('yaw', held, 'canonical')))}` +
        ` pitch${fixed(mean(column('pitch', held, 'canonical')))}` +
        ` roll${fixed(mean(column('roll', held, 'canonical')))}`,
    );
    console.log(
      `   rate peak yaw${fixed(extreme(column('yawRate', step, 'canonical')))}` +
        ` pitch${fixed(extreme(column('pitchRate', step, 'canonical')))}` +
        ` roll${fixed(extreme(column('rollRate', step, 'canonical')))}`,
    );
    console.log(
      `   accel pk  x${fixed(extreme(column('accelX', step, 'canonical')))}` +
        ` y${fixed(extreme(column('accelY', step, 'canonical')))}` +
        ` z${fixed(extreme(column('accelZ', step, 'canonical')))}`,
    );
    console.log(
      `   raw       a${fixed(mean(column('alpha', held, 'raw')))}` +
        ` b${fixed(mean(column('beta', held, 'raw')))}` +
        ` g${fixed(mean(column('gamma', held, 'raw')))}` +
        `   screen ${mean(column('screenOrientation', held, 'raw')).toFixed(0)}` +
        `   flags ${mean(column('flags', held, 'raw')).toFixed(0)}`,
    );
    console.log(
      `   raw rate  a${fixed(extreme(column('rateAlpha', step, 'raw')))}` +
        ` b${fixed(extreme(column('rateBeta', step, 'raw')))}` +
        ` g${fixed(extreme(column('rateGamma', step, 'raw')))}`,
    );
    console.log('');
  }
}

const file = join(LOG_DIR, 'sessions.jsonl');
let text: string;
try {
  text = readFileSync(file, 'utf8');
} catch {
  console.error(`No log at ${file}. Press r in the lobby to record one.`);
  process.exit(1);
}

const sessions = text
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as AxisSession)
  .filter((entry) => entry.kind === 'axis-check' && Array.isArray(entry.steps));

if (sessions.length === 0) {
  console.error('No axis-check sessions in the log yet.');
  process.exit(1);
}

const which = process.argv[2] === 'all' ? sessions : sessions.slice(-1);
console.log(`${sessions.length} session(s) recorded; showing ${which.length}.`);
for (const session of which) report(session);
