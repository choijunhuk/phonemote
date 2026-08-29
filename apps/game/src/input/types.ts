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
      direction: CanonicalVector;
      direction8: Direction8;
      timestamp: number;
    }
  | { kind: 'tilt'; playerId: number; x: number; y: number }
  | { kind: 'button_down'; playerId: number; button: ButtonName }
  | { kind: 'button_up'; playerId: number; button: ButtonName };
