/**
 * The raw sensor frame exactly as the phone reports it.
 *
 * Nothing here is corrected, filtered or rotated: the phone does not know what
 * the game is (ARCHITECTURE.md P2). Interpretation happens on the PC, starting
 * with SensorNormalizer.
 */

export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** W3C DeviceOrientationEvent angles, in degrees, device frame. */
export interface EulerAngles {
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
}

/** 0 portrait-primary, 1 landscape-primary, 2 portrait-secondary, 3 landscape-secondary. */
export type ScreenOrientationValue = 0 | 1 | 2 | 3;

export interface SensorFrame {
  readonly playerId: number;
  /** Increments per sent frame; gaps mean packet loss. */
  readonly seq: number;
  /** Phone performance.now(), in ms. Only ever compared with itself. */
  readonly timestamp: number;
  readonly orientation: EulerAngles;
  /** deg/s about the device axes. */
  readonly rotationRate: EulerAngles;
  /** m/s^2 along the device axes, gravity excluded. */
  readonly acceleration: Vector3;
  readonly buttons: number;
  readonly screenOrientation: ScreenOrientationValue;
}

export function isScreenOrientationValue(value: number): value is ScreenOrientationValue {
  return value === 0 || value === 1 || value === 2 || value === 3;
}
