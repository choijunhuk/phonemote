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
  /** Turn rate at which gravity stops being believed at all, deg/s. */
  readonly trustCutoffDegPerSecond?: number;
  /** How long gravity takes to earn full trust back after a disturbance. */
  readonly trustRecoverySeconds?: number;
}

/**
 * 0.98 assumes a healthy gyro; where the rates are weak or missing the pose
 * then crawls towards gravity, which reads as the tilt lagging and dropping
 * input. 0.9 still smooths the jitter but closes 90% of a step in 0.37 s even
 * with no gyro at all.
 */
const DEFAULT_GYRO_WEIGHT = 0.9;
const DEFAULT_MAX_GAP_SECONDS = 0.25;

/**
 * The rate the weight above is quoted at.
 *
 * A weight is a per-frame survival factor, so applying it once per sample makes
 * the time constant a function of the frame rate. Measured on a 30 degree step
 * in the gravity reference, the time to close 90% of it was 367 ms at 60 Hz but
 * 1100 ms at 20 Hz and 2200 ms at 10 Hz — and the real device recordings arrive
 * at about 19 Hz, so the filter was three times slower in the field than the
 * one number anybody had ever measured. Reading the weight at 60 Hz, converting
 * it to a time constant and spending that against dt keeps 60 Hz exactly where
 * it was and drags every other rate onto the same curve.
 *
 * OneEuroFilter has always done this correctly — its alphaFor takes dt — so
 * until now the two filters here disagreed about what dt meant.
 */
const WEIGHT_REFERENCE_HZ = 60;

/**
 * Above this turn rate the accelerometer is measuring the swing, not gravity.
 *
 * The gap between the gravity-derived pose and the gyro-propagated one is 0.19
 * deg of pitch and 0.09 deg of roll at rest (median), but 29.8 / 21.1 deg at
 * p95 through real-swing.pmtrace and 43.2 / 45.8 deg at its peak. Correcting
 * towards a reference that wrong, at the gain that suits a resting phone, threw
 * several degrees of pose into a single frame at exactly the moment the
 * reference was worthless.
 *
 * 200 deg/s sits in open space between the two cases rather than near either
 * edge: a hand trying to hold still averages 3.34 deg/s (max ~14), and a swing
 * peaks at 300-1211. Walking, at ~54, keeps most of its correction, which is
 * what we want — a carried phone still needs gravity to stop it drifting.
 */
const DEFAULT_TRUST_CUTOFF_DEG_PER_SECOND = 200;

/**
 * How long gravity takes to earn full trust back.
 *
 * The cutoff above reads one sample, and one sample is not the disturbance. A
 * burst lasts 51-154 ms while the recordings arrive every 51-55 ms, so the
 * sample caught as a swing reverses can read 81 deg/s — well under the cutoff —
 * while the accelerometer is still reading 6.1 m/s^2 of the swing, 43 times its
 * 0.141 resting median. On real-swing.pmtrace the gate reopened on exactly that
 * sample and handed back the whole 58.7 degrees the pose had drifted across the
 * burst at once: 9.6 degrees of pose in one frame, worse than the fixed gain it
 * replaced.
 *
 * So trust drops the instant the phone moves and returns on a ramp. At 3 s no
 * frame of that trace moves the pose by more than 0.7 degrees of correction; 2 s
 * reaches 0.96, too near the line to trust. The ramp is close to free — the gyro
 * carries the pose meanwhile and its bias is at most 0.51 deg/s.
 */
const DEFAULT_TRUST_RECOVERY_SECONDS = 3;

/** Shortest signed way from `from` to `to`, in degrees. */
export function angleDifference(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export class ComplementaryFilter {
  private readonly correctionTau: number;
  private readonly maxGapSeconds: number;
  private readonly trustCutoff: number;
  private readonly trustRecoverySeconds: number;

  private pitch: number | null = null;
  private roll: number | null = null;
  private yaw = 0;
  private trust = 1;
  private last: CanonicalAngles = { yaw: 0, pitch: 0, roll: 0 };

  constructor(options: FusionOptions = {}) {
    const gyroWeight = options.gyroWeight ?? DEFAULT_GYRO_WEIGHT;
    // Weight 1 gives -Infinity, weight 0 gives +0; both survive the exponential
    // below as "never correct" and "correct fully", which is what they mean.
    this.correctionTau = -(1 / WEIGHT_REFERENCE_HZ) / Math.log(gyroWeight);
    this.maxGapSeconds = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
    this.trustCutoff = options.trustCutoffDegPerSecond ?? DEFAULT_TRUST_CUTOFF_DEG_PER_SECOND;
    this.trustRecoverySeconds = options.trustRecoverySeconds ?? DEFAULT_TRUST_RECOVERY_SECONDS;
  }

  reset(): void {
    this.pitch = null;
    this.roll = null;
    this.yaw = 0;
    this.trust = 1;
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
      // The pose was just taken straight from gravity, so there is nothing left
      // to distrust; carrying a stale gate across the gap would only throttle
      // the frames that come after it.
      this.trust = 1;
      this.last = { yaw: this.yaw, pitch: this.pitch, roll: this.roll };
      return this.last;
    }

    const gyroPitch = this.pitch + angularVelocity.pitch * dt;
    const gyroRoll = this.roll + angularVelocity.roll * dt;

    const rate = Math.hypot(angularVelocity.yaw, angularVelocity.pitch, angularVelocity.roll);
    const believable = Math.min(1, Math.max(0, 1 - rate / this.trustCutoff));
    this.trust = Math.min(believable, this.trust + dt / this.trustRecoverySeconds);
    const correction = this.trust * (1 - Math.exp(-dt / this.correctionTau));

    // Correct along the shortest arc so the seam at +-180 does not spin things.
    this.pitch = gyroPitch + correction * angleDifference(gyroPitch, orientation.pitch);
    this.roll = gyroRoll + correction * angleDifference(gyroRoll, orientation.roll);
    this.yaw += angularVelocity.yaw * dt;

    this.last = { yaw: this.yaw, pitch: this.pitch, roll: this.roll };
    return this.last;
  }
}
