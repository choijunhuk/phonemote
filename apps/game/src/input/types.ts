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
  /**
   * The average rate across the step from the previous frame to this one.
   *
   * Anything integrating rotation should multiply this by dt rather than the
   * instantaneous rate, which is the rectangle rule and systematically wrong on
   * a signal that is changing fast. Measured against the orientation matrix on
   * a recorded swing, the trapezoid cuts per-step rate error from 115 to 47
   * deg/s on the fastest axis and halves the two-second attitude error
   * (ARCHITECTURE.md D39).
   *
   * Optional only because frames built by hand in tests do not have a previous
   * frame; consumers fall back to angularVelocity.
   */
  readonly rateStep?: CanonicalAngles;
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
      /**
       * 0 for this player's gentlest swing, 1 for their hardest.
       *
       * `strength` saturates at a fixed 900 deg/s, and the same person's six
       * "hard" swings measured 297 to 1211 — so three of the six read exactly
       * 1.00 and the difference between a tap and everything they had was
       * invisible. Games should read this (ARCHITECTURE.md D42).
       */
      power: number;
      /** Where the phone's tip travelled, in canonical axes. */
      direction: CanonicalVector;
      direction8: Direction8;
      /**
       * Rotation integrated over the burst, per axis, in degrees.
       *
       * `direction` folds yaw and roll together because either can sweep the
       * phone's far end sideways. Bowling's hook and golf's club face need them
       * apart, and the burst already computes both (ARCHITECTURE.md D41).
       */
      rotation: CanonicalAngles;
      /** 'strike' when this burst reversed a recent weaker one. */
      phase: 'strike' | 'single';
      /** Peak angular rate of the burst, deg/s. */
      peakRate: number;
      /** When the burst began, on the phone's clock. */
      onsetAt: number;
      /**
       * When the burst was fastest — the moment a ball would be struck.
       *
       * Detection necessarily comes later, because a peak is only knowable once
       * the rate falls away from it: measured +33 ms on a 60 Hz synthetic pulse
       * and +50 to +102 ms on the 20 Hz recordings. A game that wants to place
       * the contact in time should use this, not `timestamp`.
       */
      peakAt: number;
      readonly durationMs: number;
      /** When the event fired. */
      timestamp: number;
    }
  /**
   * A slow, deliberate out-and-back: a putt, a half swing, a gentle roll.
   *
   * The swing detector starts at 300 deg/s because below that lies every
   * accidental wobble. A putting stroke lives at 40-300 and has no threshold to
   * cross at all — only a point where it turns around, which is what segments
   * it (ARCHITECTURE.md 7.3).
   */
  | {
      kind: 'stroke';
      playerId: number;
      /** How far it rotated about its dominant axis, in degrees. */
      angleDeg: number;
      axis: CanonicalVector;
      durationMs: number;
      peakRate: number;
      /** This stroke turned back on the one before it. */
      reversedFromPrevious: boolean;
      timestamp: number;
    }
  /**
   * The trigger being let go, with the motion that was under way at that moment.
   *
   * Bowling needs the instant the ball leaves the hand. Inferring it from the
   * rate curve is an estimate with a 50 ms error bar, and a gentle delivery may
   * never cross the swing threshold at all — one of six recorded "hard" swings
   * peaked at 297 deg/s and produced nothing. A button edge is exact, survives a
   * stalled sensor because of the keep-alive, and is what the Wii remote's
   * trigger did (ARCHITECTURE.md D49).
   */
  | {
      kind: 'release';
      playerId: number;
      at: number;
      /** |omega| at the moment of release, deg/s. */
      rate: number;
      /** Rotation integrated since the trigger went down, per axis, degrees. */
      rotation: CanonicalAngles;
      /** How long the trigger was held, ms. */
      heldMs: number;
    }
  /**
   * How still this phone is being held, and for how long.
   *
   * Four games need it: one judges stillness directly, one measures it as aim
   * wobble, and the rest use it to take a grip reference without asking for a
   * button press. `stalled` is here because a phone that stopped sending is not
   * a phone being held still, and only this layer can tell them apart.
   */
  | {
      kind: 'stillness';
      playerId: number;
      /** Smoothed |omega|, deg/s. */
      rate: number;
      still: boolean;
      steadyMs: number;
      stalled: boolean;
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
