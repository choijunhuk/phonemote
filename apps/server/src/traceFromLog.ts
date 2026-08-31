import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SENSOR_FLAG,
  SENSOR_FRAME_VERSION,
  TRACE_VERSION,
  encodeSensor,
  serializeTrace,
  type SensorFrame,
  type TraceHeader,
} from '@phonemote/protocol';
import { LOG_DIR } from './logs.js';
import { TRACE_DIR } from './recorder.js';

/**
 * Turns a step of a recorded measurement session into a trace.
 *
 *   pnpm --filter @phonemote/server run trace-from-log swing real-swing
 *
 * The synthetic corpus says what the detector should do with a shape a human
 * never quite produces. This promotes an actual movement by an actual person
 * into a golden test, which is the only kind of evidence that can say whether
 * a change to the detector helped.
 *
 * The recorder keeps the raw values next to the canonical ones precisely so
 * this is possible: the frames are rebuilt from the raw side and run through
 * the whole pipeline again on replay.
 */

interface Sample {
  t: number;
  raw: Record<string, number>;
}

interface Step {
  key: string;
  prompt: string;
  samples: Sample[];
}

interface AxisSession {
  kind?: string;
  startedAt?: string;
  steps: Step[];
}

const [stepKey = 'swing', name = stepKey] = process.argv.slice(2);

const sessions = readFileSync(join(LOG_DIR, 'sessions.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as AxisSession)
  .filter((entry) => entry.kind === 'axis-check' && Array.isArray(entry.steps));

const session = sessions.at(-1);
if (!session) {
  console.error('No axis-check session recorded yet.');
  process.exit(1);
}

const step = session.steps.find((entry) => entry.key === stepKey);
if (!step || step.samples.length === 0) {
  console.error(`Session has no samples for step "${stepKey}".`);
  console.error(`Available: ${session.steps.map((entry) => entry.key).join(', ')}`);
  process.exit(1);
}

const first = step.samples[0]?.t ?? 0;
const frames = step.samples.map((sample, index) => {
  const raw = sample.raw;
  const frame: SensorFrame = {
    playerId: 1,
    seq: index,
    // Rebased so the trace starts at zero, as a fresh recording would.
    timestamp: sample.t - first,
    orientation: {
      alpha: raw['alpha'] ?? 0,
      beta: raw['beta'] ?? 0,
      gamma: raw['gamma'] ?? 0,
    },
    rotationRate: {
      alpha: raw['rateAlpha'] ?? 0,
      beta: raw['rateBeta'] ?? 0,
      gamma: raw['rateGamma'] ?? 0,
    },
    acceleration: {
      x: raw['accelX'] ?? 0,
      y: raw['accelY'] ?? 0,
      z: raw['accelZ'] ?? 0,
    },
    buttons: 0,
    screenOrientation: ((raw['screenOrientation'] ?? 0) % 4) as 0 | 1 | 2 | 3,
    version: SENSOR_FRAME_VERSION,
    motionSeq: index,
    flags: raw['flags'] ?? SENSOR_FLAG.LINEAR_ACCEL | SENSOR_FLAG.ROTATION_RATE,
  };
  return encodeSensor(frame);
});

const header: TraceHeader = {
  trace: TRACE_VERSION,
  roomCode: 'REAL',
  playerId: 1,
  startedAt: session.startedAt ?? new Date().toISOString(),
  note: `recorded on a real phone: ${step.prompt}`,
};

const file = join(TRACE_DIR, 'corpus', `${name}.pmtrace`);
writeFileSync(file, serializeTrace(header, frames), 'utf8');
console.log(`wrote ${file}  (${frames.length} frames from step "${stepKey}")`);
