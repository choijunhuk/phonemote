import { SENSOR_STALL_MS } from '@phonemote/protocol';
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
 * Fraction of the deadzone a rate has to fall back to before it counts as
 * still again.
 *
 * Rates arrive quantised to 0.1 deg/s, and at the 2 deg/s deadzone a still hand
 * still leaves 6% of yaw frames and 22% of pitch frames above the line. A bare
 * comparison turns that into a cursor that comes alive and dies again on
 * alternate frames while the hand does nothing at all.
 */
export const POINTER_DEADZONE_RELEASE = 0.7;

/**
 * Longest step the integrator will honour. The first frame after a stall
 * carries the whole gap in its dt, and integrating that at the rate the phone
 * happened to be turning teleports the cursor.
 *
 * It is the stall budget because anything longer than that is a stall, and
 * InputMapper already drops the frames a stalled sensor repeats. The previous
 * 0.05 s guess was shorter than a normal frame: the real recordings arrive at a
 * 51-55 ms median interval, so it fired on 39 of 39 steps in both and left only
 * 90.6% (rest) and 95.8% (swing) of the elapsed time integrated — a cursor
 * quietly slower than the hand, by an amount that moved with the jitter.
 */
export const MAX_POINTER_STEP_SECONDS = SENSOR_STALL_MS / 1000;

const CENTRE: PointerPosition = { x: 0.5, y: 0.5 };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A deadzone that is harder to leave than to stay out of. */
class DeadzoneGate {
  private live = false;

  constructor(
    private readonly enterDegPerSec: number,
    private readonly leaveDegPerSec: number,
  ) {}

  reset(): void {
    this.live = false;
  }

  apply(rate: number): number {
    const speed = Math.abs(rate);
    this.live = this.live ? speed >= this.leaveDegPerSec : speed >= this.enterDegPerSec;
    return this.live ? rate : 0;
  }
}

export class PointerMode {
  private readonly sensitivity: number;
  private readonly yawFilter = new OneEuroFilter();
  private readonly pitchFilter = new OneEuroFilter();
  private readonly yawGate: DeadzoneGate;
  private readonly pitchGate: DeadzoneGate;
  private x = CENTRE.x;
  private y = CENTRE.y;

  constructor(options: PointerOptions = {}) {
    this.sensitivity = options.sensitivity ?? DEFAULT_POINTER_SENSITIVITY;
    const deadzone = options.deadzoneDegPerSec ?? DEFAULT_POINTER_DEADZONE;
    this.yawGate = new DeadzoneGate(deadzone, deadzone * POINTER_DEADZONE_RELEASE);
    this.pitchGate = new DeadzoneGate(deadzone, deadzone * POINTER_DEADZONE_RELEASE);
  }

  get position(): PointerPosition {
    return { x: this.x, y: this.y };
  }

  reset(): void {
    this.x = CENTRE.x;
    this.y = CENTRE.y;
    this.yawFilter.reset();
    this.pitchFilter.reset();
    // A gate left open would let the first frame after HOME move on a rate that
    // was never big enough to open it.
    this.yawGate.reset();
    this.pitchGate.reset();
  }

  update(frame: CanonicalSensorFrame): PointerPosition {
    if (frame.dt <= 0) return this.position;

    const dt = Math.min(frame.dt, MAX_POINTER_STEP_SECONDS);
    // Filter first, then deadzone: the filter is what separates a hand from
    // sensor noise, and the deadzone only has to mop up what is left.
    const yaw = this.yawGate.apply(this.yawFilter.filter(frame.angularVelocity.yaw, dt));
    const pitch = this.pitchGate.apply(this.pitchFilter.filter(frame.angularVelocity.pitch, dt));

    this.x = clamp01(this.x + yaw * dt * this.sensitivity);
    // Screen y grows downwards, aiming up must move the cursor up.
    this.y = clamp01(this.y - pitch * dt * this.sensitivity);
    return this.position;
  }
}
