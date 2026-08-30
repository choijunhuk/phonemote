import type { CanonicalAngles, CanonicalSensorFrame } from './types.js';

/**
 * Gyro/gravity fusion (ARCHITECTURE.md 11, Phase 4).
 *
 * The two sources fail in opposite ways: integrated gyro is smooth but drifts,
 * gravity-derived pitch and roll are absolute but jump around whenever the
 * phone is accelerated. Leaning on the gyro moment to moment and nudging it
 * back towards gravity keeps both problems small.
 *
 * Yaw gets no such treatment. Chrome's relative deviceorientation has no
 * absolute heading to nudge towards, so yaw here is a running total since the
 * last reset and is only ever meaningful as a difference.
 */

export interface FusionOptions {
  /** Share of each update taken from the gyro. Nearer 1 is smoother, slower. */
  readonly gyroWeight?: number;
  /** A gap longer than this means the stream stalled; start over. */
  readonly maxGapSeconds?: number;
}

/**
 * 0.98 assumes a healthy gyro; where the rates are weak or missing the pose
 * then crawls towards gravity with a 0.8 s time constant, which reads as the
 * tilt lagging and dropping input. 0.9 still smooths the jitter but recovers
 * in under 0.2 s even with no gyro at all.
 */
const DEFAULT_GYRO_WEIGHT = 0.9;
const DEFAULT_MAX_GAP_SECONDS = 0.25;

/** Shortest signed way from `from` to `to`, in degrees. */
export function angleDifference(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export class ComplementaryFilter {
  private readonly gyroWeight: number;
  private readonly maxGapSeconds: number;

  private pitch: number | null = null;
  private roll: number | null = null;
  private yaw = 0;
  private last: CanonicalAngles = { yaw: 0, pitch: 0, roll: 0 };

  constructor(options: FusionOptions = {}) {
    this.gyroWeight = options.gyroWeight ?? DEFAULT_GYRO_WEIGHT;
    this.maxGapSeconds = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
  }

  reset(): void {
    this.pitch = null;
    this.roll = null;
    this.yaw = 0;
    this.last = { yaw: 0, pitch: 0, roll: 0 };
  }

  update(frame: CanonicalSensorFrame): CanonicalAngles {
    const { orientation, angularVelocity, dt } = frame;

    // No elapsed time means a repeat of a frame already folded in. Holding the
    // pose is right; resetting would snap to the raw gravity reading and wipe
    // the yaw total, quietly turning the filter off exactly when the stream
    // gets noisy. The very first frame is exempt: it has no pose to hold.
    if (dt === 0 && this.pitch !== null && this.roll !== null) return this.last;

    const stalled = dt <= 0 || dt > this.maxGapSeconds;
    if (stalled || this.pitch === null || this.roll === null) {
      this.pitch = orientation.pitch;
      this.roll = orientation.roll;
      if (stalled) this.yaw = 0;
      this.last = { yaw: this.yaw, pitch: this.pitch, roll: this.roll };
      return this.last;
    }

    const gyroPitch = this.pitch + angularVelocity.pitch * dt;
    const gyroRoll = this.roll + angularVelocity.roll * dt;
    const correction = 1 - this.gyroWeight;

    // Correct along the shortest arc so the seam at +-180 does not spin things.
    this.pitch = gyroPitch + correction * angleDifference(gyroPitch, orientation.pitch);
    this.roll = gyroRoll + correction * angleDifference(gyroRoll, orientation.roll);
    this.yaw += angularVelocity.yaw * dt;

    this.last = { yaw: this.yaw, pitch: this.pitch, roll: this.roll };
    return this.last;
  }
}
