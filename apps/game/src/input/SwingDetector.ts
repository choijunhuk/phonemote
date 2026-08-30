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
 *
 * The floor came down from 25 to 20 after three swings in ten went unnoticed:
 * a controlled stroke does not peak nearly as hard as a shake does. Ordinary
 * hand movement sits around 10, so there is still room below this.
 */
export const SWING_THRESHOLD = 20;
export const SWING_MAX = 90;

/** Long enough for the peak to develop, short enough to still feel immediate. */
export const SWING_MIN_WINDOW_MS = 25;
/** Backstop for a burst that never settles. */
export const SWING_CAPTURE_WINDOW_MS = 250;
/** The burst is over once the phone has been this quiet for this long. */
export const SWING_QUIET_MS = 40;
export const SWING_QUIET_RATIO = 0.6;

/**
 * A tennis stroke is two bursts: the backswing and then the strike. The old
 * 300 ms lockout meant the backswing claimed the event and the strike — the one
 * the player actually aimed — landed inside the cooldown and was thrown away.
 * Short enough now that a strike arriving ~200 ms after the backswing still
 * gets its own event; a stray backswing event is harmless because the game only
 * acts on a swing when the ball is in the hit zone.
 */
export const SWING_COOLDOWN_MS = 80;

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
  /** When the motion first dropped below the quiet line, if it has. */
  quietSince: number | null;
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

      // Track one whole burst rather than firing at the first dip: the peak of
      // a swing often comes after a softer opening, and reporting the opening
      // would understate the strength and mistake its direction.
      const quiet = strengthNow < SWING_THRESHOLD * SWING_QUIET_RATIO;
      if (quiet) this.capture.quietSince ??= now;
      else this.capture.quietSince = null;

      const elapsed = now - this.capture.startedAt;
      const settled =
        this.capture.quietSince !== null && now - this.capture.quietSince >= SWING_QUIET_MS;
      if (elapsed < SWING_MIN_WINDOW_MS) return null;
      if (!settled && elapsed < SWING_CAPTURE_WINDOW_MS) return null;

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

    this.capture = {
      startedAt: now,
      peak: strengthNow,
      peakVector: frame.acceleration,
      quietSince: null,
    };
    return null;
  }

  reset(): void {
    this.capture = null;
    this.cooldownUntil = Number.NEGATIVE_INFINITY;
  }
}
