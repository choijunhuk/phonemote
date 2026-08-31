import { OneEuroFilter } from './OneEuroFilter.js';
import type { CanonicalSensorFrame } from './types.js';

/**
 * Gyro pointer (ARCHITECTURE.md 6.3 / 7.3).
 *
 * Integrates yaw and pitch rate into a 0..1 screen position. Absolute yaw is
 * unusable on Chrome's relative deviceorientation, so nothing here reads it;
 * drift is handled by the player re-centring with HOME.
 */

export interface PointerOptions {
  /** Screen widths per degree of rotation. */
  readonly sensitivity?: number;
  /** Rates below this are treated as hand tremor, in deg/s. */
  readonly deadzoneDegPerSec?: number;
}

export interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

/** A 60 degree sweep crosses the screen once. */
export const DEFAULT_POINTER_SENSITIVITY = 1 / 60;
/**
 * Measured noise on a still phone is about 3.1 deg/s, so a deadzone alone
 * cannot separate a hand from the sensor without also swallowing slow aiming.
 * The filter does that work; this only removes the last of the shiver.
 */
export const DEFAULT_POINTER_DEADZONE = 2;

/**
 * Longest step the integrator will honour. The first frame after a stall
 * carries the whole gap in its dt, and integrating that at the rate the phone
 * happened to be turning teleports the cursor.
 */
export const MAX_POINTER_STEP_SECONDS = 0.05;

const CENTRE: PointerPosition = { x: 0.5, y: 0.5 };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class PointerMode {
  private readonly sensitivity: number;
  private readonly deadzone: number;
  private readonly yawFilter = new OneEuroFilter();
  private readonly pitchFilter = new OneEuroFilter();
  private x = CENTRE.x;
  private y = CENTRE.y;

  constructor(options: PointerOptions = {}) {
    this.sensitivity = options.sensitivity ?? DEFAULT_POINTER_SENSITIVITY;
    this.deadzone = options.deadzoneDegPerSec ?? DEFAULT_POINTER_DEADZONE;
  }

  get position(): PointerPosition {
    return { x: this.x, y: this.y };
  }

  reset(): void {
    this.x = CENTRE.x;
    this.y = CENTRE.y;
    this.yawFilter.reset();
    this.pitchFilter.reset();
  }

  private applyDeadzone(rate: number): number {
    return Math.abs(rate) < this.deadzone ? 0 : rate;
  }

  update(frame: CanonicalSensorFrame): PointerPosition {
    if (frame.dt <= 0) return this.position;

    const dt = Math.min(frame.dt, MAX_POINTER_STEP_SECONDS);
    // Filter first, then deadzone: the filter is what separates a hand from
    // sensor noise, and the deadzone only has to mop up what is left.
    const yaw = this.applyDeadzone(this.yawFilter.filter(frame.angularVelocity.yaw, dt));
    const pitch = this.applyDeadzone(this.pitchFilter.filter(frame.angularVelocity.pitch, dt));

    this.x = clamp01(this.x + yaw * dt * this.sensitivity);
    // Screen y grows downwards, aiming up must move the cursor up.
    this.y = clamp01(this.y - pitch * dt * this.sensitivity);
    return this.position;
  }
}
