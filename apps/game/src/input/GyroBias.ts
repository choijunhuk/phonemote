import type { CanonicalAngles } from './types.js';

/**
 * Gyro zero-rate offset (ARCHITECTURE.md 5.4).
 *
 * A MEMS gyro does not read zero when nothing is turning. The rest traces put
 * the leftover offset at 0.07 - 0.51 deg/s per axis, and the pointer integrates
 * all of it: at the default sensitivity a 0.44 deg/s yaw offset alone walks the
 * cursor half a screen in 68 seconds. The cursor on real-rest.pmtrace already
 * moves 0.0166 screen widths per second, 60% of the bound pointerNoise.test.ts
 * holds, and while part of that is the hand in the recording, an offset this
 * size is the part that never averages out.
 *
 * The one-euro filter cannot help. An offset is not noise, it is the signal
 * being wrong in one direction, and no amount of smoothing removes a mean; it
 * has to be measured and subtracted.
 *
 * The measurement is the only interesting part. There is no reference to
 * compare against, so stillness has to be inferred from the rates themselves,
 * and that inference is where the danger lives: someone aiming slowly and
 * steadily is moving, and calling that "still" would subtract their aim away.
 *
 * Two things bound that damage.
 *
 * The gate is on the same signal the estimate is built from. No window is used
 * unless every component in it stayed under stillDegPerSec, so the mean pulled
 * towards is under that too and the estimate can never grow past it. The slow,
 * careful sweep the pointer exists for — 8 deg/s in pointerNoise.test.ts —
 * never opens the gate at all, so it passes through whole rather than being
 * subtracted away a little at a time.
 *
 * The clamp bounds what is left. At 2 deg/s it sits exactly on the pointer's
 * own deadzone (DEFAULT_POINTER_DEADZONE), so even a completely mislearned
 * estimate costs the player no more aiming speed than the deadzone already
 * throws away — and reaching it takes half a second in which nothing on any
 * axis exceeded the gate.
 */

/**
 * Above the noise, far below anything deliberate. Per-axis rate noise on the
 * rest traces is sd 0.68 - 1.30 deg/s and a phone on a table reads 0.17, while
 * a walk gives ~54 and a swing 297 - 1211. The gap either side is wide enough
 * that the exact number does not matter much.
 *
 * A hand trying to hold still peaks near 14 deg/s, so a held phone opens this
 * gate only in its calmer moments. That is the conservative direction: the
 * estimate is learned more slowly, never wrongly.
 */
export const DEFAULT_STILL_DEG_PER_SEC = 3;

/**
 * Long enough that a momentary lull between two hand movements cannot pass for
 * stillness, short enough that a player who does hold still gets the
 * correction while they are still holding it.
 */
export const DEFAULT_WINDOW_MS = 500;

/**
 * Per accepted frame, so the time constant follows the phone's rate: about
 * 0.5 s at the 20 Hz the traces were polled at, 0.1 s at 100 Hz, 0.67 s at
 * 15 Hz. The spread is fine because the gate, not the pull, is what decides
 * whether learning happens at all — and the gate always costs half a second of
 * stillness first, at any rate. Sized against the slow end: 15 Hz is the worst
 * case and reaches 1.37 of a 1.5 deg/s offset in two seconds, half of which
 * goes on filling the window in the first place.
 */
export const DEFAULT_PULL_PER_FRAME = 0.1;

/**
 * Four times the largest offset the traces imply (0.51 deg/s), and equal to
 * the pointer deadzone, which is what makes a mistake survivable rather than
 * merely small.
 */
export const DEFAULT_MAX_BIAS_DEG_PER_SEC = 2;

/**
 * Guards a stream so slow that a single sample would span the whole window and
 * "the maximum over the window" would mean nothing. At 15 Hz the window
 * already holds eight samples, so this never binds on a real phone.
 */
const MIN_WINDOW_SAMPLES = 4;

export interface GyroBiasOptions {
  /** A window whose every component stays under this counts as still, deg/s. */
  readonly stillDegPerSec?: number;
  /** How much recent rate the stillness test looks at. */
  readonly windowMs?: number;
  /** Share of the gap to the window mean taken on each still frame. */
  readonly pullPerFrame?: number;
  /** Hard limit on each component of the estimate, deg/s. */
  readonly maxBiasDegPerSec?: number;
}

const ZERO: CanonicalAngles = { yaw: 0, pitch: 0, roll: 0 };

const AXES = ['yaw', 'pitch', 'roll'] as const;

interface Sample {
  readonly rate: CanonicalAngles;
  readonly dt: number;
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

export class GyroBias {
  private readonly stillDegPerSec: number;
  private readonly windowSeconds: number;
  private readonly pullPerFrame: number;
  private readonly maxBiasDegPerSec: number;

  private readonly window: Sample[] = [];
  private span = 0;
  private estimate: CanonicalAngles = ZERO;

  constructor(options: GyroBiasOptions = {}) {
    this.stillDegPerSec = options.stillDegPerSec ?? DEFAULT_STILL_DEG_PER_SEC;
    this.windowSeconds = (options.windowMs ?? DEFAULT_WINDOW_MS) / 1000;
    this.pullPerFrame = options.pullPerFrame ?? DEFAULT_PULL_PER_FRAME;
    this.maxBiasDegPerSec = options.maxBiasDegPerSec ?? DEFAULT_MAX_BIAS_DEG_PER_SEC;
  }

  get bias(): CanonicalAngles {
    return this.estimate;
  }

  reset(): void {
    this.window.length = 0;
    this.span = 0;
    this.estimate = ZERO;
  }

  /** The rate with the current estimate removed. */
  update(angularVelocity: CanonicalAngles, dtSeconds: number): CanonicalAngles {
    this.absorb(angularVelocity, dtSeconds);
    return {
      yaw: angularVelocity.yaw - this.estimate.yaw,
      pitch: angularVelocity.pitch - this.estimate.pitch,
      roll: angularVelocity.roll - this.estimate.roll,
    };
  }

  private absorb(rate: CanonicalAngles, dt: number): void {
    // A dt of zero is a frame already folded in, and a gap longer than the
    // window means whatever is in the buffer stopped being "the last half
    // second" a while ago. Keep the estimate either way: the phone having been
    // asleep is no reason to believe its gyro changed.
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (dt > this.windowSeconds) {
      this.window.length = 0;
      this.span = 0;
      return;
    }

    this.window.push({ rate, dt });
    this.span += dt;
    while (this.window.length > 1) {
      const oldest = this.window[0];
      if (oldest === undefined || this.span - oldest.dt < this.windowSeconds) break;
      this.span -= oldest.dt;
      this.window.shift();
    }

    if (this.span < this.windowSeconds || this.window.length < MIN_WINDOW_SAMPLES) return;
    if (!this.isStill()) return;

    // Towards the window mean rather than straight to it: a still window is
    // still a handful of noisy samples, and the mean of ten of them at sd 1.3
    // is only good to about 0.4 deg/s on its own.
    const pulled = { yaw: 0, pitch: 0, roll: 0 };
    for (const axis of AXES) {
      const mean = this.window.reduce((sum, s) => sum + s.rate[axis], 0) / this.window.length;
      pulled[axis] = clamp(
        this.estimate[axis] + this.pullPerFrame * (mean - this.estimate[axis]),
        this.maxBiasDegPerSec,
      );
    }
    this.estimate = pulled;
  }

  private isStill(): boolean {
    for (const sample of this.window) {
      for (const axis of AXES) {
        if (Math.abs(sample.rate[axis]) >= this.stillDegPerSec) return false;
      }
    }
    return true;
  }
}
