import { describe, expect, it } from 'vitest';
import {
  STILL_ENTER_DEG_PER_SEC,
  STILL_EXIT_DEG_PER_SEC,
  STILL_TAU_MS,
  Stillness,
  type StillnessReading,
} from '../Stillness.js';
import type { CanonicalAngles } from '../types.js';

/**
 * Every level here comes from the recorded traces: a phone on a table is
 * 0.17 deg/s per axis, a hand trying to hold still averages |omega| 3.34 with a
 * worst single sample of 14, walking is 54 and a swing peaks past 300.
 *
 * The default rate is 20 Hz because that is what those traces were polled at.
 * The phone's own rate is unknown, which is why one test sweeps 15 to 100.
 */

const TRACE_HZ = 20;

/** Per-axis gyro noise measured while the phone was held at rest, deg/s. */
const REST_SD = { yaw: 1.104, pitch: 1.299, roll: 0.677 };

/** An |omega| of this magnitude, split in the proportions the rest trace saw. */
function omega(degPerSec: number): CanonicalAngles {
  const length = Math.hypot(REST_SD.yaw, REST_SD.pitch, REST_SD.roll);
  const scale = degPerSec / length;
  return { yaw: REST_SD.yaw * scale, pitch: REST_SD.pitch * scale, roll: REST_SD.roll * scale };
}

/**
 * A hand trying to hold still, drawn from a fixed sequence so the assertions
 * cannot flake. The measured per-axis noise on its own averages |omega| 1.7,
 * while the recorded hand averaged 3.34; the difference is the hand slowly
 * wandering rather than the gyro, so a steady drift makes it up.
 */
function stillHand(seed = 20240117): () => CanonicalAngles {
  let state = seed % 2147483647;
  const unit = (): number => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  const gaussian = (): number => Math.sqrt(-2 * Math.log(unit())) * Math.cos(2 * Math.PI * unit());
  const drift = 1.7;
  return () => ({
    yaw: drift + gaussian() * REST_SD.yaw,
    pitch: drift + gaussian() * REST_SD.pitch,
    roll: drift + gaussian() * REST_SD.roll,
  });
}

/** Feed one signal for `ms`, returning every reading it produced. */
function feed(
  stillness: Stillness,
  signal: CanonicalAngles | (() => CanonicalAngles),
  ms: number,
  hz = TRACE_HZ,
): StillnessReading[] {
  const dt = 1 / hz;
  const readings: StillnessReading[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += dt * 1000) {
    readings.push(stillness.update(typeof signal === 'function' ? signal() : signal, dt));
  }
  return readings;
}

function last(readings: readonly StillnessReading[]): StillnessReading {
  const reading = readings.at(-1);
  if (!reading) throw new Error('fed nothing');
  return reading;
}

/** A settled hold, which is the state three of the four games start from. */
function held(hz = TRACE_HZ): Stillness {
  const stillness = new Stillness();
  feed(stillness, omega(3.34), 1000, hz);
  return stillness;
}

/** How long after the phone stops moving the hold is recognised. */
function msToSettle(hz: number): number {
  const stillness = new Stillness();
  const dt = 1 / hz;
  feed(stillness, omega(54), 1000, hz);

  let elapsed = 0;
  while (elapsed < 5000) {
    elapsed += dt * 1000;
    if (stillness.update(omega(3.34), dt).still) return elapsed;
  }
  throw new Error(`never settled at ${hz} Hz`);
}

describe('the fixtures match the traces they claim to come from', () => {
  it('gives the hand the measured mean of 3.34 deg/s', () => {
    const hand = stillHand();
    let total = 0;
    for (let i = 0; i < 400; i++) {
      const sample = hand();
      total += Math.hypot(sample.yaw, sample.pitch, sample.roll);
    }
    expect(total / 400).toBeCloseTo(3.34, 1);
  });
});

describe('a phone nobody is moving', () => {
  it('reads still when it is lying on a table', () => {
    // 0.17 deg/s per axis, which is what the gyro reports with no hand on it.
    const readings = feed(new Stillness(), omega(0.17 * Math.sqrt(3)), 1000);
    expect(readings.every((reading) => reading.still)).toBe(true);
  });

  it('reads still in a hand that is trying to hold it, and counts the hold', () => {
    const readings = feed(new Stillness(), stillHand(), 2000);
    expect(readings.every((reading) => reading.still)).toBe(true);
    expect(last(readings).steadyMs).toBeCloseTo(2000, 0);
  });

  it('scores a shaky hold above a steady one while both still count as held', () => {
    const steady = last(feed(new Stillness(), omega(1.5), 2000));
    const shaky = last(feed(new Stillness(), omega(6), 2000));
    expect(steady.still && shaky.still).toBe(true);
    expect(steady.rate).toBeLessThan(shaky.rate);
  });
});

describe('telling a hold from a movement', () => {
  it('survives the loudest single sample a still hand ever produced', () => {
    const stillness = held();
    const before = last(feed(stillness, omega(3.34), 500));

    // 14 deg/s was the worst instant in the whole rest trace. An archer holding
    // steady must not lose the shot to one of those.
    const excursion = stillness.update(omega(14), 1 / TRACE_HZ);
    expect(excursion.still).toBe(true);
    expect(excursion.steadyMs).toBeGreaterThan(before.steadyMs);

    const after = feed(stillness, omega(3.34), 500);
    expect(after.every((reading) => reading.still)).toBe(true);
  });

  it('breaks on a sustained 40 deg/s, the slowest thing anyone does on purpose', () => {
    const readings = feed(held(), omega(40), 400);
    expect(last(readings).still).toBe(false);

    // A putt-sized motion has no threshold to cross, so noticing it must not
    // take longer than the movement itself.
    const brokeAfterMs = (readings.findIndex((reading) => !reading.still) + 1) * (1000 / TRACE_HZ);
    expect(brokeAfterMs).toBeLessThan(250);
  });

  it('breaks on walking, and on the first frame of a swing', () => {
    expect(last(feed(held(), omega(54), 300)).still).toBe(false);
    expect(held().update(omega(900), 1 / TRACE_HZ).still).toBe(false);
  });

  it('does not flicker on a rate sitting between the two thresholds', () => {
    // 12 deg/s is above the entry and below the exit. A hold survives it and a
    // phone that was moving does not gain one, which is the whole reason the
    // two numbers differ.
    expect(STILL_ENTER_DEG_PER_SEC).toBeLessThan(STILL_EXIT_DEG_PER_SEC);

    const holding = feed(held(), omega(12), 1000);
    expect(holding.every((reading) => reading.still)).toBe(true);

    const moving = new Stillness();
    feed(moving, omega(54), 500);
    const settling = feed(moving, omega(12), 1000);
    expect(settling.some((reading) => reading.still)).toBe(false);
  });
});

describe('the length of a hold', () => {
  it('resets to zero the moment the phone moves', () => {
    const stillness = held();
    expect(last(feed(stillness, omega(3.34), 1000)).steadyMs).toBeGreaterThan(900);
    expect(last(feed(stillness, omega(300), 500)).steadyMs).toBe(0);
  });

  it('starts the next hold from zero rather than resuming the old one', () => {
    const stillness = held();
    feed(stillness, omega(3.34), 2000);
    feed(stillness, omega(54), 500);

    const again = feed(stillness, omega(3.34), 1500);
    const recognised = again.find((reading) => reading.still);
    expect(recognised?.steadyMs).toBeLessThan(100);
    expect(last(again).steadyMs).toBeLessThan(1000);
  });

  it('does not count a repeated frame twice', () => {
    const stillness = held();
    const counted = last(feed(stillness, omega(3.34), 1000)).steadyMs;
    expect(stillness.update(omega(3.34), 0).steadyMs).toBe(counted);
  });
});

describe('the time constant', () => {
  it('recognises a hold in the same time at 15, 20, 60 and 100 Hz', () => {
    const times = [15, 20, 60, 100].map(msToSettle);
    expect(Math.max(...times) / Math.min(...times)).toBeLessThan(1.15);
  });

  it('recognises it in a couple of time constants, not a couple of seconds', () => {
    // Falling from walking to a still hand crosses the entry threshold at about
    // 2.4 tau. A game that waited much longer than that would feel broken.
    for (const time of [15, 20, 60, 100].map(msToSettle)) {
      expect(time).toBeGreaterThan(STILL_TAU_MS * 2);
      expect(time).toBeLessThan(STILL_TAU_MS * 3);
    }
  });

  it('follows the option rather than the sample rate', () => {
    const fast = new Stillness({ tauMs: 60 });
    feed(fast, omega(54), 500);
    expect(feed(fast, omega(3.34), 200).some((reading) => reading.still)).toBe(true);
  });
});

describe('reset', () => {
  it('forgets the hold and the average', () => {
    const stillness = held();
    feed(stillness, omega(3.34), 1000);
    stillness.reset();

    // No memory of the hold and none of how quiet things were: the first sample
    // after a reset stands on its own.
    const swinging = stillness.update(omega(900), 1 / TRACE_HZ);
    expect(swinging.still).toBe(false);
    expect(swinging.rate).toBeCloseTo(900, 6);
    expect(swinging.steadyMs).toBe(0);
  });
});
