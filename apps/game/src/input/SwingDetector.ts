import type { CanonicalSensorFrame, CanonicalVector, Direction8 } from './types.js';

/**
 * Swing detection (ARCHITECTURE.md 6.4).
 *
 * A swing is one burst of acceleration, not a stream: cross the threshold,
 * watch for a short window to find the peak, emit exactly one event, then stay
 * quiet long enough that the follow-through does not read as a second swing.
 *
 * Time comes from the phone's own clock so network jitter cannot widen or
 * shorten the window.
 */

/**
 * Calibrated against a real phone, not the spec's first guess of 15/40: a
 * deliberate swing peaks near 100 m/s^2, so a 40 ceiling made every swing
 * read as maximum strength and every ball come back at full speed.
 */
export const SWING_THRESHOLD = 25;
export const SWING_MAX = 90;

/** Long enough for the peak to develop, short enough to still feel immediate. */
export const SWING_MIN_WINDOW_MS = 25;
export const SWING_CAPTURE_WINDOW_MS = 80;
export const SWING_COOLDOWN_MS = 300;

/** Once the burst has fallen this far below its peak, the swing is over. */
export const SWING_DECAY_RATIO = 0.5;

export interface SwingEvent {
  readonly playerId: number;
  readonly strength: number;
  readonly direction: CanonicalVector;
  readonly direction8: Direction8;
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

export function swingStrength(peakMagnitude: number): number {
  const span = SWING_MAX - SWING_THRESHOLD;
  return Math.min(1, Math.max(0, (peakMagnitude - SWING_THRESHOLD) / span));
}

function magnitude(vector: CanonicalVector): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

interface Capture {
  readonly startedAt: number;
  peak: number;
  peakVector: CanonicalVector;
}

export class SwingDetector {
  private capture: Capture | null = null;
  private cooldownUntil = Number.NEGATIVE_INFINITY;

  update(frame: CanonicalSensorFrame): SwingEvent | null {
    const now = frame.timestamp;
    const strengthNow = magnitude(frame.acceleration);

    if (this.capture) {
      if (strengthNow > this.capture.peak) {
        this.capture.peak = strengthNow;
        this.capture.peakVector = frame.acceleration;
      }

      // Waiting out a fixed window would add its full length to every hit. Fire
      // as soon as the burst is clearly past its peak; the window is only the
      // backstop for a swing that never settles.
      const elapsed = now - this.capture.startedAt;
      const subsided =
        strengthNow < Math.max(SWING_THRESHOLD, this.capture.peak * SWING_DECAY_RATIO);
      if (elapsed < SWING_MIN_WINDOW_MS) return null;
      if (!subsided && elapsed < SWING_CAPTURE_WINDOW_MS) return null;

      const event: SwingEvent = {
        playerId: frame.playerId,
        strength: swingStrength(this.capture.peak),
        direction: this.capture.peakVector,
        direction8: direction8Of(this.capture.peakVector),
        timestamp: now,
      };
      this.capture = null;
      this.cooldownUntil = now + SWING_COOLDOWN_MS;
      return event;
    }

    if (now < this.cooldownUntil) return null;
    if (strengthNow <= SWING_THRESHOLD) return null;

    this.capture = { startedAt: now, peak: strengthNow, peakVector: frame.acceleration };
    return null;
  }

  reset(): void {
    this.capture = null;
    this.cooldownUntil = Number.NEGATIVE_INFINITY;
  }
}
