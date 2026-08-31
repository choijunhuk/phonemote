import { angleBetweenDeg, normalise } from './pose.js';
import type { CanonicalSensorFrame, CanonicalVector } from './types.js';

/**
 * Tilt as an analogue stick (ARCHITECTURE.md 7.3).
 *
 * roll  -> x, right edge down moves right.
 * pitch -> y, aiming up moves up. y is positive upwards here; screen space is
 * the scene's problem, not this module's.
 *
 * Both are read off `up`, never off orientation.roll/pitch. Euler roll is an
 * angle inside a plane that flattens as the phone leaves the horizontal, so it
 * hands back whatever the phone did multiplied by tan(pitch). One 0.1 degree
 * twist about the phone's own long axis - the smallest step any channel
 * reports, since every one of them is quantised to 0.1 - arrives as 0.12
 * degrees of roll at pitch -50, 0.28 at -70 and 2.86 at -88: 1.19x, 2.75x,
 * 28.61x. That last one is 8.18% of a 35 degree stick for a movement nobody
 * made. Golf address, bowling delivery and Freeze Frame's aim-up and aim-down
 * poses all sit in that band, so the stick was at its twitchiest exactly where
 * it is held longest. `up` has no such plane (ARCHITECTURE.md 5.8, D21, D43).
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

/** The grip assumed until a player calibrates: phone level, screen upright. */
const LEVEL_UP: CanonicalVector = { x: 0, y: 1, z: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class TiltMode {
  private readonly rangeDeg: number;
  private readonly deadzone: number;
  private readonly exponent: number;

  private reference: CanonicalVector = LEVEL_UP;

  constructor(options: TiltOptions = {}) {
    this.rangeDeg = options.rangeDeg ?? DEFAULTS.rangeDeg;
    this.deadzone = options.deadzone ?? DEFAULTS.deadzone;
    this.exponent = options.exponent ?? DEFAULTS.exponent;
  }

  /** Takes the pose held right now as centre. */
  calibrate(frame: CanonicalSensorFrame): void {
    this.reference = normalise(frame.up);
  }

  reset(): void {
    this.reference = LEVEL_UP;
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
    const reference = this.reference;
    const up = normalise(frame.up);

    // The turn from the calibrated grip to this one, as an axis in the phone's
    // own frame and an angle about it, which is how pose.ts states a pose and
    // for the reason its header gives: rotating the measurement onto the
    // reference instead throws away the spin about that axis, and the spin is
    // exactly what the roll axis of a stick is made of.
    const axis: CanonicalVector = {
      x: reference.y * up.z - reference.z * up.y,
      y: reference.z * up.x - reference.x * up.z,
      z: reference.x * up.y - reference.y * up.x,
    };
    const axisLength = Math.hypot(axis.x, axis.y, axis.z);

    // Either exactly the calibrated grip, or the one attitude exactly opposite
    // it. The second is 145 degrees past the clamp, so reading it as centre
    // costs nothing a player could feel.
    if (axisLength === 0) return { x: 0, y: 0 };

    // |reference x up| is the sine of the angle between them, so this converts
    // an axis component into degrees, and it settles towards 180/pi as the two
    // close up rather than towards anything sharp.
    const degreesPerUnit = angleBetweenDeg(reference, up) / axisLength;

    // Gravity turns by the inverse of the phone's own turn, so the phone turned
    // by this axis negated: its part about the aim axis (-Z) is the roll, its
    // part about the right edge (+X) is the pitch. Neither can come out larger
    // than the angle itself, which is the whole reason for measuring here.
    return {
      x: this.shape(axis.z * degreesPerUnit),
      y: this.shape(-axis.x * degreesPerUnit),
    };
  }
}
