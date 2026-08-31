import type { CanonicalAngles, CanonicalSensorFrame, CanonicalVector, Direction8 } from './types.js';

/**
 * Swing detection (ARCHITECTURE.md 6.4, D24, D40, D41).
 *
 * Segmented on angular velocity, not acceleration. A swing is a rotation about
 * the shoulder and the wrist, and |a| is a poor witness to it:
 *
 * - A 500 deg/s swing on a 0.6 m arm throws 45 m/s^2 of centripetal
 *   acceleration along the arm, pointing at the shoulder rather than along the
 *   travel, so the peak vector often points nowhere near where the phone went.
 * - An arm decelerates harder than it accelerates, so the largest |a| in a
 *   burst is frequently the stop at the end — the opposite direction again.
 * - |a| clips at the accelerometer's range on many phones. |omega| has 2000
 *   deg/s of headroom and a real swing peaks near 900.
 *
 * |omega| also peaks at the moment the phone is moving fastest, which is where
 * a ball would be struck, so firing on its decay puts the event within a few
 * tens of milliseconds of contact instead of a fixed window later.
 *
 * What a single threshold could not do, measured on real recordings: a bare
 * 300 deg/s gate fired 12 times on gestures that were not swings — laying the
 * phone down four times, standing it on end three, tilting it three, turning it
 * twice — against 9 fires on the gestures that were. Three things fix that
 * without losing a single real swing:
 *
 * 1. A Schmitt trigger. Entry at 400 (above every tilt gesture recorded),
 *    release at 110, so a burst is one burst rather than a stutter of them.
 * 2. A look-back ring. The entry threshold is high, so the start of the swing
 *    is already in the past when it trips; the capture rewinds to where the
 *    rate last was quiet. Without this the integrated travel of a real swing
 *    read 36 degrees when the gesture was 96.
 * 3. Acceleration as a veto, never as a gate. A rotation that moves the phone
 *    nowhere is a turn, not a swing: measured peaks were 32-60 m/s^2 for real
 *    swings against a hand-at-rest floor of 0.2, so requiring 12 costs nothing
 *    and removes the rest of the false fires.
 */

/** deg/s that starts a burst. Above every non-swing gesture recorded. */
export const SWING_OMEGA_HI = 400;
/** deg/s the rate must fall below before another burst can start. */
export const SWING_OMEGA_LO = 110;
/** deg/s that counts as full strength on the fixed scale. */
export const SWING_OMEGA_MAX = 900;
/** Fired once the rate falls this far below the burst's peak. */
export const SWING_DECAY_RATIO = 0.6;
/**
 * m/s^2 the burst must reach somewhere to count as a swing rather than a turn.
 *
 * Real swings peaked at 32-60; a hand at rest sits at 0.2 and a deliberate
 * tilt barely leaves it. This is a veto on an event already segmented by
 * |omega| — acceleration never decides where a swing starts or ends.
 */
export const SWING_MIN_ACCEL = 12;
/** Frames kept for the rewind. At 20 Hz that is 0.8 s, at 100 Hz 0.16 s. */
export const SWING_LOOKBACK = 16;

export const SWING_MIN_WINDOW_MS = 20;
/** Backstop for a burst that never settles. */
export const SWING_CAPTURE_WINDOW_MS = 400;
export const SWING_COOLDOWN_MS = 150;

/**
 * The rates that map to "gentlest" and "hardest" for a player, in deg/s.
 *
 * Defaults, until a calibration measures the person. The same player's six
 * hardest swings measured 297 to 1211 deg/s, so one scale for everybody puts
 * some people permanently at full power and others permanently at none
 * (ARCHITECTURE.md D42).
 */
export interface PowerScale {
  readonly softRate: number;
  readonly hardRate: number;
}

export const DEFAULT_POWER_SCALE: PowerScale = { softRate: 350, hardRate: 1250 };

/**
 * Whether this burst reversed a recent, weaker one.
 *
 * A tennis stroke is a backswing and then a strike, and the strike is the one
 * the player aimed. A backswing cannot be labelled as it happens — nothing yet
 * distinguishes it from a swing that simply was not very hard — but the strike
 * can, the moment it arrives.
 *
 * Measured caveat: on real recordings the backswing peaks at 6-26% of the
 * strike, far below any gate, so this fired once in six sessions and that once
 * was the recovery sweep after a swing. It is kept because it costs nothing and
 * is correct when it does fire, not because it carries weight.
 */
export type SwingPhase = 'strike' | 'single';

export interface SwingEvent {
  readonly playerId: number;
  readonly strength: number;
  /** 0 at this player's gentlest swing, 1 at their hardest. */
  readonly power: number;
  /** Where the phone's tip travelled, in canonical axes. */
  readonly direction: CanonicalVector;
  readonly direction8: Direction8;
  /** Rotation integrated over the burst, per axis, in degrees. */
  readonly rotation: CanonicalAngles;
  readonly phase: SwingPhase;
  /** Peak angular rate of the burst, deg/s. */
  readonly peakRate: number;
  readonly onsetAt: number;
  readonly peakAt: number;
  readonly durationMs: number;
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

/** The fixed scale, kept for anything that wants a device-independent number. */
export function swingStrength(peakRate: number): number {
  const span = SWING_OMEGA_MAX - SWING_OMEGA_HI;
  return Math.min(1, Math.max(0, (peakRate - SWING_OMEGA_HI) / span));
}

/** The per-player scale. This is what games should read. */
export function swingPower(peakRate: number, scale: PowerScale = DEFAULT_POWER_SCALE): number {
  const span = Math.max(1, scale.hardRate - scale.softRate);
  return Math.min(1, Math.max(0, (peakRate - scale.softRate) / span));
}

/**
 * Where the far end of the phone goes for a given rotation.
 *
 * Two grips sweep it horizontally, and a swing usually has some of both:
 *
 * - Held like a pointer, the far end is the aim at -Z, and a point out there
 *   moves with omega x r, which reduces to the yaw.
 * - Held like a racket, the far end is the top edge at +Y, and the same
 *   product reduces to the roll.
 *
 * Summing them covers either grip, and a hand somewhere between the two gets a
 * share of each, which is what actually happens.
 *
 * This is a convenience derived from the burst's per-axis integral, not the
 * primary output: it deliberately folds yaw and roll together, and a game that
 * needs them apart — bowling's hook, golf's club face — reads `rotation`.
 *
 * Pitch stays the vertical: it tips the far end up or down whichever way the
 * phone is held.
 */
export function tipTravel(yawDeg: number, pitchDeg: number, rollDeg = 0): CanonicalVector {
  return { x: yawDeg + rollDeg, y: pitchDeg, z: 0 };
}

function rateMagnitude(rate: CanonicalAngles): number {
  return Math.hypot(rate.yaw, rate.pitch, rate.roll);
}

function accelMagnitude(frame: CanonicalSensorFrame): number {
  const { x, y, z } = frame.acceleration;
  return Math.hypot(x, y, z);
}

interface Sample {
  readonly timestamp: number;
  readonly rate: CanonicalAngles;
  readonly magnitude: number;
  readonly accel: number;
}

interface Capture {
  readonly startedAt: number;
  peak: number;
  peakAt: number;
  maxAccel: number;
  /** Integrated rotation over the burst, in degrees. */
  yaw: number;
  pitch: number;
  roll: number;
  previous: Sample;
}

export class SwingDetector {
  private capture: Capture | null = null;
  private cooldownUntil = Number.NEGATIVE_INFINITY;
  /**
   * The rate has to fall back below the release line before another burst can
   * start. Without it a burst that was vetoed, or one that decayed and then
   * climbed again, reads as a second swing from the middle of the first.
   */
  private waitingForQuiet = false;
  private readonly recent: Sample[] = [];
  private powerScale: PowerScale = DEFAULT_POWER_SCALE;
  /** The previous burst, for spotting the reversal that follows a backswing. */
  private previous: { at: number; direction: CanonicalVector; peak: number } | null = null;

  setPowerScale(scale: PowerScale): void {
    this.powerScale = scale;
  }

  update(frame: CanonicalSensorFrame): SwingEvent | null {
    const now = frame.timestamp;
    // The trapezoid rate when the normaliser provides it: integrating the
    // instantaneous rate over a step is the rectangle rule, and on a signal
    // this fast it triples the error (ARCHITECTURE.md D39).
    const step = frame.rateStep ?? frame.angularVelocity;
    const sample: Sample = {
      timestamp: now,
      rate: step,
      magnitude: rateMagnitude(frame.angularVelocity),
      accel: accelMagnitude(frame),
    };

    if (this.capture) {
      const event = this.advance(frame, sample);
      this.remember(sample);
      return event;
    }

    this.remember(sample);

    if (sample.magnitude < SWING_OMEGA_LO) this.waitingForQuiet = false;
    if (this.waitingForQuiet || now < this.cooldownUntil) return null;
    if (sample.magnitude < SWING_OMEGA_HI) return null;

    this.capture = this.begin(sample);
    return null;
  }

  /**
   * Start the capture where the gesture started, not where it was noticed.
   *
   * The entry threshold is set high enough to reject a deliberate tilt, which
   * means a real swing is already well under way by the time it trips. Rewinding
   * to the last quiet sample recovered a measured 96 degrees of travel on a
   * recording the old detector reported as 36.
   */
  private begin(sample: Sample): Capture {
    let start = this.recent.length - 1;
    while (start > 0) {
      const earlier = this.recent[start - 1];
      if (!earlier || earlier.magnitude < SWING_OMEGA_LO) break;
      start--;
    }

    const first = this.recent[start] ?? sample;
    const capture: Capture = {
      startedAt: first.timestamp,
      peak: 0,
      peakAt: first.timestamp,
      maxAccel: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      previous: first,
    };
    for (let i = start; i < this.recent.length; i++) {
      const replayed = this.recent[i];
      if (replayed) this.accumulate(capture, replayed);
    }
    return capture;
  }

  private accumulate(capture: Capture, sample: Sample): void {
    const dt = Math.max(0, sample.timestamp - capture.previous.timestamp) / 1000;
    // Integrating the whole burst describes where the phone actually went,
    // rather than trusting whichever single sample happened to be largest.
    capture.yaw += sample.rate.yaw * dt;
    capture.pitch += sample.rate.pitch * dt;
    capture.roll += sample.rate.roll * dt;
    if (sample.magnitude > capture.peak) {
      capture.peak = sample.magnitude;
      capture.peakAt = sample.timestamp;
    }
    capture.maxAccel = Math.max(capture.maxAccel, sample.accel);
    capture.previous = sample;
  }

  private advance(frame: CanonicalSensorFrame, sample: Sample): SwingEvent | null {
    const capture = this.capture;
    if (!capture) return null;

    this.accumulate(capture, sample);

    const elapsed = sample.timestamp - capture.startedAt;
    const decayed = sample.magnitude < capture.peak * SWING_DECAY_RATIO;
    if (elapsed < SWING_MIN_WINDOW_MS) return null;
    if (!decayed && elapsed < SWING_CAPTURE_WINDOW_MS) return null;

    this.capture = null;
    this.cooldownUntil = sample.timestamp + SWING_COOLDOWN_MS;
    this.waitingForQuiet = true;

    // A rotation that never moved the phone anywhere is a turn, not a swing.
    if (capture.maxAccel < SWING_MIN_ACCEL) return null;

    const rotation: CanonicalAngles = {
      yaw: capture.yaw,
      pitch: capture.pitch,
      roll: capture.roll,
    };
    const direction = tipTravel(rotation.yaw, rotation.pitch, rotation.roll);
    const event: SwingEvent = {
      playerId: frame.playerId,
      strength: swingStrength(capture.peak),
      power: swingPower(capture.peak, this.powerScale),
      direction,
      direction8: direction8Of(direction),
      rotation,
      phase: this.classify(sample.timestamp, direction, capture.peak),
      peakRate: capture.peak,
      onsetAt: capture.startedAt,
      peakAt: capture.peakAt,
      durationMs: elapsed,
      timestamp: sample.timestamp,
    };

    this.previous = { at: sample.timestamp, direction, peak: capture.peak };
    return event;
  }

  private remember(sample: Sample): void {
    this.recent.push(sample);
    if (this.recent.length > SWING_LOOKBACK) this.recent.shift();
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
    this.previous = null;
    this.recent.length = 0;
    this.waitingForQuiet = false;
    this.cooldownUntil = Number.NEGATIVE_INFINITY;
  }
}
