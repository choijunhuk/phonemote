import { mkdirSync, writeFileSync } from 'node:fs';
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
import { TRACE_DIR } from './recorder.js';

/**
 * Generates the synthetic part of the trace corpus.
 *
 *   pnpm --filter @phonemote/server run corpus
 *
 * These are not recordings of a real phone and they do not pretend to be: a
 * synthetic swing says what the detector should do with a shape, not what a
 * human arm produces. Their value is in the negative cases — a phone lying
 * still, a phone being carried, a sensor that has died with the acceleration
 * frozen above the threshold. Those are the ones that catch a detector that
 * has been loosened too far, and they are exactly the situations nobody
 * remembers to test by hand.
 *
 * Real recordings from a real phone go alongside them via --record.
 */

const CORPUS_DIR = join(TRACE_DIR, 'corpus');
const HZ = 60;
const STEP_MS = 1000 / HZ;

/** Deterministic noise: a failing golden test has to be reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

interface FrameSpec {
  readonly t: number;
  readonly motionSeq: number;
  readonly orientation?: { alpha: number; beta: number; gamma: number };
  readonly rotationRate?: { alpha: number; beta: number; gamma: number };
  readonly acceleration?: { x: number; y: number; z: number };
  readonly buttons?: number;
}

function frame(spec: FrameSpec, seq: number): SensorFrame {
  return {
    playerId: 1,
    seq,
    timestamp: spec.t,
    // Landscape-primary held level, aiming north (ARCHITECTURE.md 5.7).
    orientation: spec.orientation ?? { alpha: 90, beta: 0, gamma: -90 },
    rotationRate: spec.rotationRate ?? { alpha: 0, beta: 0, gamma: 0 },
    acceleration: spec.acceleration ?? { x: 0, y: 0, z: 0 },
    buttons: spec.buttons ?? 0,
    screenOrientation: 1,
    version: SENSOR_FRAME_VERSION,
    motionSeq: spec.motionSeq,
    flags: SENSOR_FLAG.LINEAR_ACCEL | SENSOR_FLAG.ROTATION_RATE | SENSOR_FLAG.ORIENTATION,
  };
}

function write(name: string, note: string, specs: readonly FrameSpec[]): void {
  const header: TraceHeader = {
    trace: TRACE_VERSION,
    roomCode: 'SYNT',
    playerId: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    note,
    synthetic: true,
  };
  const frames = specs.map((spec, index) => encodeSensor(frame(spec, index)));
  writeFileSync(join(CORPUS_DIR, name), serializeTrace(header, frames), 'utf8');
  console.log(`  ${name}  ${specs.length} frames`);
}

/** A phone lying on a table: sensor noise and nothing else. */
function phoneOnTable(seconds: number): FrameSpec[] {
  const random = makeRandom(7);
  return Array.from({ length: seconds * HZ }, (_, i) => ({
    t: i * STEP_MS,
    motionSeq: i,
    // Flat on its back: gravity is along device z, so beta and gamma are 0.
    orientation: { alpha: 0, beta: random() * 0.3, gamma: random() * 0.3 },
    rotationRate: { alpha: random() * 0.6, beta: random() * 0.6, gamma: random() * 0.6 },
    acceleration: { x: random() * 0.2, y: random() * 0.2, z: random() * 0.2 },
  }));
}

/** Carried in a hand, at a walk: real motion, none of it a swing. */
function walkAround(seconds: number): FrameSpec[] {
  const random = makeRandom(11);
  return Array.from({ length: seconds * HZ }, (_, i) => {
    const t = i * STEP_MS;
    const stride = Math.sin((t / 1000) * 2 * Math.PI * 1.8);
    return {
      t,
      motionSeq: i,
      orientation: { alpha: 90 + stride * 12, beta: stride * 6, gamma: -90 + stride * 8 },
      rotationRate: { alpha: stride * 40, beta: stride * 55, gamma: stride * 30 },
      // Walking peaks around 10 m/s^2 including the heel strike.
      acceleration: { x: stride * 4 + random(), y: stride * 3 + random(), z: stride * 9 + random() },
    };
  });
}

/**
 * The nastiest case: the sensor dies mid-motion with acceleration frozen well
 * above the swing threshold, while the phone keeps sending. Everything except
 * motionSeq keeps looking alive.
 */
function sensorStall(): FrameSpec[] {
  const live: FrameSpec[] = Array.from({ length: 2 * HZ }, (_, i) => ({
    t: i * STEP_MS,
    motionSeq: i,
    rotationRate: { alpha: 0, beta: -40, gamma: 0 },
    acceleration: { x: 0, y: 0, z: -3 },
  }));

  const frozen = { alpha: 0, beta: -40, gamma: 0 };
  const stuckAt = live.length - 1;
  // The keep-alive repeats the last reading, timestamp and motionSeq included:
  // every frame here is identical, which is the whole point.
  const dead: FrameSpec[] = Array.from({ length: 5 * HZ }, () => ({
    t: stuckAt * STEP_MS,
    motionSeq: stuckAt,
    rotationRate: frozen,
    acceleration: { x: 0, y: 0, z: -60 },
  }));

  return [...live, ...dead];
}

/**
 * Ten deliberate swings, 800 ms apart: a burst that ramps, peaks near what a
 * real phone reports, and settles.
 */
function swings(count: number): FrameSpec[] {
  const specs: FrameSpec[] = [];
  const gapFrames = Math.round(0.8 * HZ);
  const burstFrames = 9;
  let motionSeq = 0;

  for (let swing = 0; swing < count; swing++) {
    for (let i = 0; i < gapFrames; i++) {
      const inBurst = i < burstFrames;
      // A half-sine over the burst: quiet, ramp, peak, settle.
      const shape = inBurst ? Math.sin((i / (burstFrames - 1)) * Math.PI) : 0;
      const magnitude = shape * 90;
      specs.push({
        t: motionSeq * STEP_MS,
        motionSeq,
        rotationRate: { alpha: 0, beta: -shape * 400, gamma: 0 },
        acceleration: { x: 0, y: 0, z: -magnitude },
      });
      motionSeq++;
    }
  }
  return specs;
}

mkdirSync(CORPUS_DIR, { recursive: true });
console.log(`[corpus] writing to ${CORPUS_DIR}`);
write('phone-on-table.pmtrace', 'phone lying still on a table, synthetic', phoneOnTable(10));
write('walk-around.pmtrace', 'carried in hand at a walking pace, synthetic', walkAround(10));
write('sensor-stall.pmtrace', 'sensor stops with acceleration frozen high, synthetic', sensorStall());
write('swing-forward.pmtrace', 'ten deliberate forward swings, synthetic', swings(10));
console.log('[corpus] done');
