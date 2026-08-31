import type { CanonicalAngles } from './types.js';

/**
 * How still the phone is being held (ARCHITECTURE.md 7.3).
 *
 * Four games ask this and none of them can ask it of a single sample: Statue
 * Race judges whether a player moved, Archery reads the shake in the moment
 * before the release, and Bowling, Golf and Ski take the grip the player is
 * already holding instead of making them press a button for it.
 *
 * One number serves all four because the recorded separation is enormous: a
 * phone on a table sits at 0.17 deg/s per axis, a hand trying to hold still
 * averages |omega| 3.34, walking is 54, a swing peaks past 300. The only
 * boundary that needs care is between the hand and the slowest deliberate
 * motion, and the slowest deliberate motion anyone makes — a golf putt — starts
 * at 40. That is the gap the two thresholds below sit in.
 *
 * The average uses a time constant rather than a fixed per-sample weight. The
 * phone's real sample rate is unknown and varies (ARCHITECTURE.md 11.2), and
 * the weight that averages over 300 ms at 20 Hz averages over 400 ms at 15 Hz
 * and 60 ms at 100 Hz — a different filter on every phone, with nothing in the
 * code changing to say so.
 */

/**
 * deg/s of smoothed |omega| below which the phone counts as held still.
 *
 * A hand trying to hold still averages 3.34, and once ~10 samples are averaged
 * the smoothed value wanders by well under 1 either way. 8 is 2.4x that mean,
 * so a genuine hold is never lost to noise, and still five times below the 40
 * that the slowest deliberate motion reaches.
 */
export const STILL_ENTER_DEG_PER_SEC = 8;

/**
 * deg/s of smoothed |omega| that ends a hold.
 *
 * Twice the entry, so a rate sitting on the line cannot flicker. The loudest
 * single sample a still hand produced was 14 deg/s, which lifts the smoothed
 * rate to about 5 and so cannot reach here; a sustained 40 crosses it about
 * 130 ms after it starts. The band is deliberately wide on the still side:
 * losing a hold the player was keeping is the failure they notice.
 */
export const STILL_EXIT_DEG_PER_SEC = 16;

/**
 * Time constant of the |omega| average, ms.
 *
 * At 15 Hz, the slowest rate this has to survive, 300 ms still averages about
 * nine samples, which is enough to bury the 1.1-1.3 deg/s per-axis gyro noise.
 * It also sets how fast movement is noticed: a 40 deg/s creep crosses the exit
 * threshold 130 ms after it starts and anything faster is near immediate, which
 * is inside the reaction time Statue Race is judging anyway.
 */
export const STILL_TAU_MS = 300;

export interface StillnessOptions {
  readonly enterDegPerSec?: number;
  readonly exitDegPerSec?: number;
  readonly tauMs?: number;
}

export interface StillnessReading {
  /** Smoothed |omega|, deg/s. Archery reads this directly as the wobble. */
  readonly rate: number;
  readonly still: boolean;
  /** Continuous ms held still, back to 0 the moment it is not. */
  readonly steadyMs: number;
}

export class Stillness {
  private readonly enterDegPerSec: number;
  private readonly exitDegPerSec: number;
  private readonly tauSeconds: number;

  private rate: number | null = null;
  private isStill = false;
  private steadyMs = 0;

  constructor(options: StillnessOptions = {}) {
    this.enterDegPerSec = options.enterDegPerSec ?? STILL_ENTER_DEG_PER_SEC;
    this.exitDegPerSec = options.exitDegPerSec ?? STILL_EXIT_DEG_PER_SEC;
    this.tauSeconds = (options.tauMs ?? STILL_TAU_MS) / 1000;
  }

  update(angularVelocity: CanonicalAngles, dtSeconds: number): StillnessReading {
    const sample = Math.hypot(angularVelocity.yaw, angularVelocity.pitch, angularVelocity.roll);
    const previous = this.rate;

    let rate: number;
    if (previous === null) {
      // Seeded from the first sample rather than from zero. An average starting
      // at zero reads as still through the opening frames of a swing, which is
      // exactly when a game that just started asks.
      rate = sample;
    } else if (dtSeconds > 0) {
      rate = previous + (1 - Math.exp(-dtSeconds / this.tauSeconds)) * (sample - previous);
    } else {
      // No time elapsed means a frame already folded in, and weighting one
      // sample twice is worse than skipping it.
      rate = previous;
    }
    this.rate = rate;

    this.isStill = this.isStill ? rate <= this.exitDegPerSec : rate < this.enterDegPerSec;

    // The interval that just elapsed counts towards the hold. The average
    // already reports stillness later than the hand achieved it, so dropping
    // this interval as well would push every hold requirement a frame further
    // out, and a frame is 67 ms at the rates this has to work at.
    if (!this.isStill) this.steadyMs = 0;
    else if (dtSeconds > 0) this.steadyMs += dtSeconds * 1000;

    return { rate, still: this.isStill, steadyMs: this.steadyMs };
  }

  reset(): void {
    this.rate = null;
    this.isStill = false;
    this.steadyMs = 0;
  }
}
