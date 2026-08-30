import type { CanonicalSensorFrame } from './types.js';

/**
 * Tilt as an analogue stick (ARCHITECTURE.md 7.3).
 *
 * roll  -> x, right edge down moves right.
 * pitch -> y, aiming up moves up. y is positive upwards here; screen space is
 * the scene's problem, not this module's.
 */

export interface TiltOptions {
  /** Tilt angle, in degrees, that reaches full deflection. */
  readonly rangeDeg?: number;
  /** Fraction of the range ignored around centre. */
  readonly deadzone?: number;
  /** 1 is linear; higher values make small tilts gentler. */
  readonly exponent?: number;
}

export interface TiltAxes {
  readonly x: number;
  readonly y: number;
}

// 45 degrees of wrist travel to reach full deflection asked too much of a
// phone held out in front of you; 35 lands closer to a comfortable range.
const DEFAULTS = { rangeDeg: 35, deadzone: 0.05, exponent: 1 } as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class TiltMode {
  private readonly rangeDeg: number;
  private readonly deadzone: number;
  private readonly exponent: number;

  private offsetPitch = 0;
  private offsetRoll = 0;

  constructor(options: TiltOptions = {}) {
    this.rangeDeg = options.rangeDeg ?? DEFAULTS.rangeDeg;
    this.deadzone = options.deadzone ?? DEFAULTS.deadzone;
    this.exponent = options.exponent ?? DEFAULTS.exponent;
  }

  /** Takes the pose held right now as centre. */
  calibrate(frame: CanonicalSensorFrame): void {
    this.offsetPitch = frame.orientation.pitch;
    this.offsetRoll = frame.orientation.roll;
  }

  reset(): void {
    this.offsetPitch = 0;
    this.offsetRoll = 0;
  }

  private shape(raw: number): number {
    const normalised = clamp(raw / this.rangeDeg, -1, 1);
    const magnitude = Math.abs(normalised);
    if (magnitude <= this.deadzone) return 0;
    // Re-expand what is left of the range so the axis still reaches 1.
    const rescaled = (magnitude - this.deadzone) / (1 - this.deadzone);
    return Math.sign(normalised) * Math.pow(rescaled, this.exponent);
  }

  update(frame: CanonicalSensorFrame): TiltAxes {
    return {
      x: this.shape(frame.orientation.roll - this.offsetRoll),
      y: this.shape(frame.orientation.pitch - this.offsetPitch),
    };
  }
}
