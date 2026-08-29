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
export const DEFAULT_POINTER_DEADZONE = 2;

const CENTRE: PointerPosition = { x: 0.5, y: 0.5 };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class PointerMode {
  private readonly sensitivity: number;
  private readonly deadzone: number;
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
  }

  private applyDeadzone(rate: number): number {
    return Math.abs(rate) < this.deadzone ? 0 : rate;
  }

  update(frame: CanonicalSensorFrame): PointerPosition {
    if (frame.dt <= 0) return this.position;

    const yaw = this.applyDeadzone(frame.angularVelocity.yaw);
    const pitch = this.applyDeadzone(frame.angularVelocity.pitch);

    this.x = clamp01(this.x + yaw * frame.dt * this.sensitivity);
    // Screen y grows downwards, aiming up must move the cursor up.
    this.y = clamp01(this.y - pitch * frame.dt * this.sensitivity);
    return this.position;
  }
}
