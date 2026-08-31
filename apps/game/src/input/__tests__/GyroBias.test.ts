import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSensor, parseTrace } from '@phonemote/protocol';
import { GyroBias } from '../GyroBias.js';
import { normalize } from '../SensorNormalizer.js';
import type { CanonicalAngles } from '../types.js';

/**
 * What the bias estimate does to a player who is holding still, a player who is
 * aiming, and a player who is swinging.
 */

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../traces/corpus');

/** Every sensor channel arrives rounded to 0.1; nothing finer is ever real. */
function quantise(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Deterministic noise at the level a phone lying on a table produces, 0.17
 * deg/s per axis: a uniform of half-width 0.3 has that sd. Quantised to 0.1
 * on the way out, because no channel ever arrives finer than that.
 */
function tableNoise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return quantise((state / 4294967296 - 0.5) * 0.6);
  };
}

function rates(yaw: number, pitch = 0, roll = 0): CanonicalAngles {
  return { yaw, pitch, roll };
}

/**
 * The traces were polled at 20 Hz and the phone's own rate is unknown, so
 * nothing here may quietly assume 60.
 */
const RATES_HZ = [15, 20, 60, 100];

describe('an offset on a phone that is genuinely still', () => {
  for (const hz of RATES_HZ) {
    it(`is found within two seconds at ${hz} Hz`, () => {
      const gyro = new GyroBias();
      const noise = tableNoise(hz * 7 + 1);
      const dt = 1 / hz;

      // 1.5 deg/s is three times the largest offset the traces imply, and at
      // the default pointer sensitivity it crosses the screen in 40 seconds.
      for (let i = 0; i < 2 * hz; i++) {
        gyro.update(rates(quantise(1.5 + noise()), noise(), noise()), dt);
      }

      expect(Math.abs(gyro.bias.yaw - 1.5)).toBeLessThan(0.2);
      expect(Math.abs(gyro.bias.pitch)).toBeLessThan(0.2);
      expect(Math.abs(gyro.bias.roll)).toBeLessThan(0.2);
    });
  }

  it('stops the corrected rate from walking the cursor', () => {
    const gyro = new GyroBias();
    const noise = tableNoise(3);
    const dt = 1 / 50;
    let uncorrected = 0;
    let corrected = 0;

    for (let i = 0; i < 50 * 10; i++) {
      const measured = rates(quantise(1.5 + noise()), noise(), noise());
      uncorrected += measured.yaw * dt;
      corrected += gyro.update(measured, dt).yaw * dt;
    }

    // Ten seconds of an untouched 1.5 deg/s offset is 15 degrees, a quarter of
    // the 60 degree sweep that crosses the screen.
    expect(uncorrected).toBeGreaterThan(14);
    expect(Math.abs(corrected)).toBeLessThan(1.5);
  });
});

describe('a player aiming slowly and steadily', () => {
  it('keeps an 8 deg/s sweep instead of learning it away', () => {
    const gyro = new GyroBias();
    const dt = 1 / 50;

    // Eight seconds is far longer than anyone aims for, and long enough that
    // any pull at all would show.
    let last = rates(0);
    for (let i = 0; i < 50 * 8; i++) last = gyro.update(rates(8), dt);

    expect(gyro.bias.yaw).toBe(0);
    expect(last.yaw).toBe(8);
  });

  it('does not creep in during a sweep that pauses at each end', () => {
    const gyro = new GyroBias();
    const dt = 1 / 50;

    // Out, back, and a fifth of a second of hesitation between: shorter than
    // the window, so the pauses never add up to a still half second.
    for (let sweep = 0; sweep < 20; sweep++) {
      const direction = sweep % 2 === 0 ? 8 : -8;
      for (let i = 0; i < 50; i++) gyro.update(rates(direction), dt);
      for (let i = 0; i < 10; i++) gyro.update(rates(0.2), dt);
    }

    expect(Math.abs(gyro.bias.yaw)).toBeLessThan(0.1);
  });

  it('caps a mislearned offset at what the deadzone already hides', () => {
    // 2.9 deg/s on every axis scrapes under the gate and is nothing like a real
    // offset. The clamp is what stops that mistake becoming a large one: it
    // holds at the pointer's own 2 deg/s deadzone, which was discarding motion
    // that slow anyway.
    const gyro = new GyroBias();
    const dt = 1 / 50;
    for (let i = 0; i < 50 * 20; i++) gyro.update(rates(2.9, 2.9, 2.9), dt);

    expect(gyro.bias).toEqual({ yaw: 2, pitch: 2, roll: 2 });
  });
});

describe('a swing', () => {
  it('leaves the estimate exactly where the still hand put it', () => {
    const gyro = new GyroBias();
    const noise = tableNoise(21);
    const dt = 1 / 50;
    for (let i = 0; i < 50 * 3; i++) {
      gyro.update(rates(quantise(0.4 + noise()), noise(), noise()), dt);
    }
    const settled = gyro.bias;
    expect(settled.yaw).toBeGreaterThan(0.2);

    // A real swing peaks at 297 - 1211 deg/s and holds above 300 for 51-154 ms.
    for (let i = 0; i < 8; i++) gyro.update(rates(900, -1100, 400), dt);
    expect(gyro.bias).toEqual(settled);

    // And the wind-down after it is still motion, not a chance to recalibrate.
    for (let i = 0; i < 10; i++) gyro.update(rates(120, -80, 40), dt);
    expect(gyro.bias).toEqual(settled);
  });

  it('passes the swing itself through untouched', () => {
    const gyro = new GyroBias();
    const corrected = gyro.update(rates(1100, -900, 300), 1 / 50);
    expect(corrected.yaw).toBe(1100);
    expect(corrected.pitch).toBe(-900);
    expect(corrected.roll).toBe(300);
  });
});

describe('a stream that stalls', () => {
  it('ignores a repeated frame rather than counting it twice', () => {
    const gyro = new GyroBias();
    for (let i = 0; i < 100; i++) gyro.update(rates(1.5), 0);
    expect(gyro.bias).toEqual({ yaw: 0, pitch: 0, roll: 0 });
  });

  it('starts the window over after a gap, and keeps what it already knew', () => {
    const gyro = new GyroBias();
    const dt = 1 / 50;
    for (let i = 0; i < 50 * 3; i++) gyro.update(rates(1.2), dt);
    const before = gyro.bias;
    expect(before.yaw).toBeGreaterThan(1);

    // The phone was asleep for two seconds. That says nothing about its gyro,
    // so the estimate survives; the half second of samples behind it does not.
    gyro.update(rates(1.2), 2);
    expect(gyro.bias).toEqual(before);
    expect(gyro.update(rates(40), dt).yaw).toBeCloseTo(40 - before.yaw, 6);
  });
});

describe('reset', () => {
  it('forgets the estimate so a recalibration starts clean', () => {
    const gyro = new GyroBias();
    const dt = 1 / 50;
    for (let i = 0; i < 50 * 3; i++) gyro.update(rates(1.2), dt);
    expect(gyro.bias.yaw).toBeGreaterThan(1);

    gyro.reset();
    expect(gyro.bias).toEqual({ yaw: 0, pitch: 0, roll: 0 });
    expect(gyro.update(rates(1.2), dt).yaw).toBe(1.2);
  });
});

interface RecordedRate {
  readonly rate: CanonicalAngles;
  readonly dt: number;
}

function recorded(name: string): RecordedRate[] {
  const trace = parseTrace(readFileSync(join(CORPUS, name), 'utf8'));
  const rows: RecordedRate[] = [];
  let previous: number | null = null;

  for (const encoded of trace.frames) {
    const decoded = decodeSensor(encoded);
    const frame = normalize(decoded, previous);
    previous = decoded.timestamp;
    rows.push({ rate: frame.angularVelocity, dt: frame.dt });
  }
  return rows;
}

/** Net yaw the pointer would integrate over the replay, in degrees. */
function integratedYaw(
  rows: readonly RecordedRate[],
  options: { readonly offset: number; readonly correct: boolean },
): number {
  const gyro = new GyroBias();
  let total = 0;

  for (const { rate, dt } of rows) {
    const measured: CanonicalAngles = { ...rate, yaw: quantise(rate.yaw + options.offset) };
    const used = options.correct ? gyro.update(measured, dt) : measured;
    total += used.yaw * dt;
  }
  return total;
}

describe('replaying a real phone held still', () => {
  const rest = recorded('real-rest.pmtrace');

  /**
   * The recording is 2.15 s and the drift that motivated this module is a rate:
   * 0.0166 screen widths per second, half a screen in thirty. So the hold is
   * built by replaying the recording end to end until it covers thirty seconds.
   */
  const HOLD: RecordedRate[] = Array.from({ length: 14 }, () => rest).flat();

  /**
   * The offset that walks the cursor half a screen in 68 seconds at the default
   * pointer sensitivity, and inside the 0.07 - 0.51 deg/s the traces imply.
   */
  const OFFSET = 0.44;

  it('takes at least half the drift out of a thirty-second hold', () => {
    // What the recording itself contains — including one visible 11 deg/s hand
    // movement — is not drift and has to survive. So the measurement is the gap
    // between replaying it with an offset present and replaying it without.
    // That gap is what the offset costs and nothing else.
    const uncorrected =
      integratedYaw(HOLD, { offset: OFFSET, correct: false }) -
      integratedYaw(HOLD, { offset: 0, correct: false });
    const corrected =
      integratedYaw(HOLD, { offset: OFFSET, correct: true }) -
      integratedYaw(HOLD, { offset: 0, correct: true });

    // 0.44 deg/s over the hold is 12 degrees of yaw, a fifth of the screen.
    // Correction leaves 1.0, which is inside the pointer's own deadzone.
    expect(uncorrected).toBeGreaterThan(11);
    expect(Math.abs(corrected)).toBeLessThan(uncorrected / 2);
  });

  it('stays far below the deadzone on a recording of a hand', () => {
    const gyro = new GyroBias();
    for (const { rate, dt } of HOLD) gyro.update(rate, dt);

    // It settles at 0.39 yaw, 0.62 pitch, 0.34 roll. Nothing in a recording of
    // a hand can say how much of that is the gyro's offset and how much is the
    // hand slowly tipping, and it does not have to: both are far below the
    // pointer's 2 deg/s deadzone, so whichever it was, the pointer was never
    // going to show it.
    for (const axis of [gyro.bias.yaw, gyro.bias.pitch, gyro.bias.roll]) {
      expect(Math.abs(axis)).toBeLessThan(1);
    }
  });

  it('leaves the hand movement inside the recording alone', () => {
    const gyro = new GyroBias();
    let biggest = 0;
    for (const { rate, dt } of HOLD) {
      biggest = Math.max(biggest, Math.abs(gyro.update(rate, dt).yaw));
    }

    // The recording's one real excursion peaks at 11.3 deg/s. Correction shifts
    // it by the estimate, not by anything like its own size.
    expect(biggest).toBeGreaterThan(10.5);
  });
});

describe('replaying a real swing', () => {
  it('never lets the swing move the estimate', () => {
    const gyro = new GyroBias();

    for (const { rate, dt } of recorded('real-swing.pmtrace')) {
      gyro.update(rate, dt);
      // Not "small at the end": zero on every frame. The recording peaks at
      // 1157 deg/s and never holds half a second under the gate, so there is
      // no moment during it where the estimate is allowed to move at all.
      expect(gyro.bias).toEqual({ yaw: 0, pitch: 0, roll: 0 });
    }
  });
});
