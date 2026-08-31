import type { CanonicalSensorFrame, CanonicalVector, Direction8 } from './types.js';

/**
 * Swing detection (ARCHITECTURE.md 6.4).
 *
 * Segmented on angular velocity, not acceleration. A swing is a rotation about
 * the shoulder and the wrist, and |a| is a poor witness to it:
 *
 * - A 500 deg/s swing on a 0.6 m arm throws 45 m/s^2 of centripetal
 *   acceleration along the arm, pointing at the shoulder rather than along the
 *   travel, so the peak vector often points nowhere near where the phone went.
 * - An arm decelerates harder than it accelerates, so the largest |a| in a
 *   burst is frequently the stop at the end — the opposite direction again.
 * - |a| clips at the accelerometer's range, which is 8g on many phones. |ω|
 *   has 2000 deg/s of headroom and a real swing peaks near 900.
 *
 * |ω| also peaks at the moment the phone is moving fastest, which is where a
 * ball would be struck, so firing on its decay puts the event within a few tens
 * of milliseconds of contact instead of a fixed window later.
 *
 * Thresholds come from a recorded session on the actual phone: a deliberate
 * swing peaked at 914 deg/s, while a purposeful slow turn reached 247.
 */

/** deg/s to begin a burst. Above a deliberate slow turn, below any real swing. */
export const SWING_OMEGA_ON = 300;
/** deg/s that counts as full strength. */
export const SWING_OMEGA_MAX = 900;
/** Fired once the rate falls this far below the burst's peak. */
export const SWING_DECAY_RATIO = 0.8;
/** Two consecutive samples over the line, so a single spike is not a swing. */
export const SWING_ARM_SAMPLES = 2;

export const SWING_MIN_WINDOW_MS = 20;
/** Backstop for a burst that never settles. */
export const SWING_CAPTURE_WINDOW_MS = 400;
export const SWING_COOLDOWN_MS = 80;

/**
 * Whether this burst reversed a recent, weaker one.
 *
 * A tennis stroke is a backswing and then a strike, and the strike is the one
 * the player aimed. A backswing cannot be labelled as it happens — nothing yet
 * distinguishes it from a swing that simply was not very hard — but the strike
 * can, the moment it arrives. A game that wants to hide latency can start its
 * animation on any burst and commit on the strike.
 */
export type SwingPhase = 'strike' | 'single';

export interface SwingEvent {
  readonly playerId: number;
  readonly strength: number;
  /** Where the phone's tip travelled, in canonical axes. */
  readonly direction: CanonicalVector;
  readonly direction8: Direction8;
  readonly phase: SwingPhase;
  /** Peak angular rate of the burst, deg/s. */
  readonly peakRate: number;
  readonly timestamp: number;
}

/** Index 0 is east; the compass turns counter-clockwise from there. */
const COMPASS: readonly Direction8[] = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];

/** Projected onto the canonical X-Y plane, never screen space. */
export function direction8Of(vector: CanonicalVector): Direction8 {
  const degrees = (Math.atan2(vector.y, vector.x) * 180) / Math.PI;
  const sector = ((Math.round(degrees / 45) % 8) + 8) % 8;
  return COMPASS[sector] ?? 'E';
}

export function swingStrength(peakRate: number): number {
  const span = SWING_OMEGA_MAX - SWING_OMEGA_ON;
  return Math.min(1, Math.max(0, (peakRate - SWING_OMEGA_ON) / span));
}

/**
 * Where the phone's tip goes for a given rotation.
 *
 * A point out along the aim at -Z moves at omega x r, which works out as
 * (yaw, pitch) in canonical X-Y: turning right sweeps the tip right, pitching
 * up sweeps it up. This is what the player sees, and it is what the direction
 * should describe — not the axis the rotation happened about.
 */
export function tipTravel(yawDeg: number, pitchDeg: number): CanonicalVector {
  return { x: yawDeg, y: pitchDeg, z: 0 };
}

function rateMagnitude(frame: CanonicalSensorFrame): number {
  const { yaw, pitch, roll } = frame.angularVelocity;
  return Math.hypot(yaw, pitch, roll);
}

interface Capture {
  readonly startedAt: number;
  peak: number;
  /** Integrated rotation over the burst, in degrees. */
  yaw: number;
  pitch: number;
  lastTimestamp: number;
}

export class SwingDetector {
  private capture: Capture | null = null;
  private cooldownUntil = Number.NEGATIVE_INFINITY;
  /** Samples so far over the arming line, so one spike cannot start a burst. */
  private armed = 0;
  /** The previous burst, for spotting the reversal that follows a backswing. */
  private previous: { at: number; direction: CanonicalVector; peak: number } | null = null;

  update(frame: CanonicalSensorFrame): SwingEvent | null {
    const now = frame.timestamp;
    const rate = rateMagnitude(frame);

    if (this.capture) {
      const dt = Math.max(0, now - this.capture.lastTimestamp) / 1000;
      this.capture.lastTimestamp = now;
      // Integrating the whole burst describes where the phone actually went,
      // rather than trusting whichever single sample happened to be largest.
      this.capture.yaw += frame.angularVelocity.yaw * dt;
      this.capture.pitch += frame.angularVelocity.pitch * dt;
      if (rate > this.capture.peak) this.capture.peak = rate;

      const elapsed = now - this.capture.startedAt;
      const decayed = rate < this.capture.peak * SWING_DECAY_RATIO;
      if (elapsed < SWING_MIN_WINDOW_MS) return null;
      if (!decayed && elapsed < SWING_CAPTURE_WINDOW_MS) return null;

      const direction = tipTravel(this.capture.yaw, this.capture.pitch);
      const peak = this.capture.peak;
      const event: SwingEvent = {
        playerId: frame.playerId,
        strength: swingStrength(peak),
        direction,
        direction8: direction8Of(direction),
        phase: this.classify(now, direction, peak),
        peakRate: peak,
        timestamp: now,
      };

      this.previous = { at: now, direction, peak };
      this.capture = null;
      this.cooldownUntil = now + SWING_COOLDOWN_MS;
      return event;
    }

    if (now < this.cooldownUntil) return null;
    if (rate <= SWING_OMEGA_ON) return null;

    this.armed += 1;
    if (this.armed < SWING_ARM_SAMPLES) return null;
    this.armed = 0;

    this.capture = { startedAt: now, peak: rate, yaw: 0, pitch: 0, lastTimestamp: now };
    return null;
  }

  /**
   * A burst that follows a weaker one in the opposite direction is the strike
   * that its backswing set up.
   */
  private classify(now: number, direction: CanonicalVector, peak: number): SwingPhase {
    const previous = this.previous;
    if (!previous) return 'single';
    const gap = now - previous.at;
    if (gap > 600) return 'single';

    const opposed = previous.direction.x * direction.x + previous.direction.y * direction.y < 0;
    return opposed && peak > previous.peak ? 'strike' : 'single';
  }

  reset(): void {
    this.capture = null;
    this.armed = 0;
    this.previous = null;
    this.cooldownUntil = Number.NEGATIVE_INFINITY;
  }
}
