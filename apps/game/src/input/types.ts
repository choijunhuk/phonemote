import type { ButtonName } from '@phonemote/protocol';

/**
 * The canonical frame every game-side module speaks (ARCHITECTURE.md 5).
 *
 * Axes: +X right, +Y up, +Z out of the screen towards the player. Angles use
 * the aviation convention on the body axes forward -Z, right +X, down -Y:
 *   pitch + = aiming up, yaw + = aiming right, roll + = right edge down.
 */

export interface CanonicalAngles {
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
}

export interface CanonicalVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CanonicalSensorFrame {
  readonly playerId: number;
  readonly seq: number;
  /** Phone clock, ms. Only ever compared against frames from the same phone. */
  readonly timestamp: number;
  /** Seconds since this player's previous frame; 0 for the first one. */
  readonly dt: number;
  /** Degrees. yaw is relative only — see ARCHITECTURE.md 5.7. */
  readonly orientation: CanonicalAngles;
  /**
   * Which way is up, as a unit vector in canonical axes (ARCHITECTURE.md 5.8).
   *
   * Angles go singular when the phone is laid flat or stood on end, and near
   * those poses a tiny movement swings roll wildly. This has no such pose, so
   * anything judging how the phone is held should read this rather than the
   * angles.
   */
  readonly up: CanonicalVector;
  /** Degrees per second. */
  readonly angularVelocity: CanonicalAngles;
  /** m/s^2, gravity excluded. */
  readonly acceleration: CanonicalVector;
  readonly buttons: number;
}

export type Direction8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export type GameAction =
  | { kind: 'pointer_move'; playerId: number; x: number; y: number }
  | {
      kind: 'swing';
      playerId: number;
      /** 0 at the detection threshold, 1 at full strength. */
      strength: number;
      /** Where the phone's tip travelled, in canonical axes. */
      direction: CanonicalVector;
      direction8: Direction8;
      /** 'strike' when this burst reversed a recent weaker one. */
      phase: 'strike' | 'single';
      /** Peak angular rate of the burst, deg/s. */
      peakRate: number;
      timestamp: number;
    }
  | { kind: 'tilt'; playerId: number; x: number; y: number }
  /**
   * Which way is up, in canonical axes. Continuous pose belongs in the action
   * stream like everything else: a scene that reached past this for the frame
   * itself would be back to reading sensors (ARCHITECTURE.md P4).
   */
  | { kind: 'pose'; playerId: number; up: CanonicalVector }
  | { kind: 'button_down'; playerId: number; button: ButtonName }
  | { kind: 'button_up'; playerId: number; button: ButtonName };
