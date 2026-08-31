import { FLAT_GRIP_DEG, angleBetweenDeg, normalise } from './pose.js';
import type { CanonicalVector } from './types.js';

/**
 * Signed tilt away from the grip a player chose (ARCHITECTURE.md 5.8).
 *
 * pose.ts answers "how far off this hold are you" — one unsigned number, which
 * is all Freeze Frame ever needed. Aiming games need the sign and the axis:
 * bowling wants to know the stance leans left, golf wants the club face open or
 * closed, archery wants the bow raised rather than merely moved, ski wants
 * which edge is down, and a shared tilting table wants both axes at once. Same
 * idea as pose.ts, carrying the direction through instead of collapsing it.
 *
 * The construction, in vectors:
 *
 * `up` is gravity written in the phone's own frame, so turning the phone by R
 * moves it by R inverse — the argument is spelled out at expectedUp in pose.ts.
 * The smallest rotation carrying the grip's gravity onto the measured gravity
 * therefore has axis cross(up, grip.up), in that order and not the other one,
 * and angle angleBetweenDeg between the two. A rotation axis is a fixed vector
 * of its own rotation, so it reads the same in the grip's frame and in the
 * current one; its components along the phone's own forward (-Z) and right (+X)
 * axes split the movement into a roll part and a pitch part, sign included.
 * Turning the phone by + about forward is right edge down and by + about right
 * is aiming up, which is the convention types.ts already states.
 *
 * Euler angles are the thing this exists to avoid. Canonical roll is an atan2
 * over the horizontal components of two body axes and both shrink as the phone
 * stands on end, so the reading is scaled by 1/cos(pitch): 5.7x at 80 degrees,
 * 28x at 88, and at 90 it is whatever the rounding error was. Golf aim and
 * archery elevation are played exactly there. `up` has no such pose, and
 * neither does anything below.
 *
 * Nothing here keeps state or reads a clock, so it behaves the same at the
 * 20 Hz the traces were recorded at as at whatever the phone really sends.
 * Smoothing, deadzones and ranges stay with the caller (TiltMode).
 */

/** The phone's aiming axis; rolling turns about this. */
const FORWARD: CanonicalVector = { x: 0, y: 0, z: -1 };
/** The phone's right; aiming up and down turns about this. */
const RIGHT: CanonicalVector = { x: 1, y: 0, z: 0 };

/** What every direction here falls back to: held level, aiming straight ahead. */
const LEVEL: CanonicalVector = { x: 0, y: 1, z: 0 };

/**
 * How far a sample may sit from the newest one and still count as the hold.
 *
 * The rule and the number come from calibrate() in freezeState.ts, measured
 * there: the eight or so frames where the hand is still travelling towards the
 * button drag a mean over the whole window about twenty degrees off, and
 * rejecting against that poisoned mean then throws away the good samples
 * instead. Seeding from the newest sample inverts it — the newest reading is by
 * definition the grip at the moment the player committed.
 */
const SETTLE_DEG = 15;

/**
 * The roll and pitch gain at the line pose.ts already calls flat.
 *
 * Not a second threshold for the same physical problem: FLAT_GRIP_DEG is where
 * that file decided gravity has come too close to an axis for a turn about it
 * to be readable, and this is the same 25 degrees expressed as the gain it
 * implies (sin 25 = 0.42).
 */
const FLAT_GAIN = Math.sin((FLAT_GRIP_DEG * Math.PI) / 180);

export interface Grip {
  readonly up: CanonicalVector;
  /**
   * The clock the caller passed, kept so a scene can tell a grip taken this
   * round from one taken before the player put the phone down.
   */
  readonly capturedAt: number;
}

/**
 * Adopt the hold these readings were taken during.
 *
 * Seeded from the newest sample, not from the mean of the window — see
 * SETTLE_DEG for the measurement behind that. `up` is exactly unit on every
 * recorded frame, so the samples are summed as they arrive and the sum
 * renormalised once, rather than a square root each.
 *
 * An empty window has no grip in it and gives the level fallback, which is what
 * normalise does with a zero vector too.
 */
export function captureGrip(samples: readonly CanonicalVector[], at: number): Grip {
  const newest = samples[samples.length - 1];
  if (!newest) return { up: LEVEL, capturedAt: at };

  let x = 0;
  let y = 0;
  let z = 0;
  for (const sample of samples) {
    if (angleBetweenDeg(sample, newest) >= SETTLE_DEG) continue;
    x += sample.x;
    y += sample.y;
    z += sample.z;
  }
  return { up: normalise({ x, y, z }), capturedAt: at };
}

/**
 * How far the phone has been rolled from the grip, in degrees, + right edge
 * down. Blind to a turn about gravity itself, like everything read from `up`.
 */
export function signedRoll(grip: Grip, up: CanonicalVector): number {
  return tiltVector(grip, up).x;
}

/** How far the phone has been aimed up or down from the grip, in degrees, + up. */
export function signedPitch(grip: Grip, up: CanonicalVector): number {
  return tiltVector(grip, up).y;
}

/**
 * Both at once, in degrees: x is the roll, y the pitch, y positive upwards.
 * Screen space and the range that counts as full deflection stay with the
 * scene, the same division of labour TiltMode already draws.
 *
 * The two components are the forward and right parts of one axis-angle vector,
 * so they are exact for a turn about a single axis and cross-talk by under a
 * tenth of a degree at ten degrees each, 1.6 degrees at twenty-five. Their
 * magnitude never exceeds the angle the phone actually moved through.
 */
export function tiltVector(
  grip: Grip,
  up: CanonicalVector,
): { readonly x: number; readonly y: number } {
  const from = normalise(grip.up);
  const to = normalise(up);

  const axis = {
    x: to.y * from.z - to.z * from.y,
    y: to.z * from.x - to.x * from.z,
    z: to.x * from.y - to.y * from.x,
  };
  const length = Math.hypot(axis.x, axis.y, axis.z);
  // Zero length is the phone sitting in its grip, or turned about gravity,
  // which moves `up` nowhere and is the one motion this cannot see. It is also
  // the phone turned exactly upside down, where the axis is genuinely
  // undefined: no signed split survives the antipode, and no game asks a player
  // to invert their own grip.
  if (length === 0) return { x: 0, y: 0 };

  const angle = angleBetweenDeg(from, to);
  const unit = { x: axis.x / length, y: axis.y / length, z: axis.z / length };
  return {
    x: angle * (unit.x * FORWARD.x + unit.y * FORWARD.y + unit.z * FORWARD.z),
    y: angle * (unit.x * RIGHT.x + unit.y * RIGHT.y + unit.z * RIGHT.z),
  };
}

/**
 * How much signal a grip leaves for the games above to read, 0 to 1.
 *
 * Turning the phone by one degree about some axis moves `up` by sin of the
 * angle between gravity and that axis, so the grip sets a gain on everything
 * this file reports. Worst case over every tilt axis in the phone's own
 * forward-right plane works out at exactly |up.y| — gravity along the screen
 * normal costs the roll (a phone lying flat), gravity along the right edge
 * costs the pitch (a phone stood on its side), and only a phone held with its
 * top edge up keeps both.
 *
 * Rescaled so the flat line pose.ts already draws reads zero, which keeps one
 * threshold in the codebase rather than two that can drift apart. A scene can
 * use this to ask for a better grip before a round rather than after it, the
 * way freezeState refuses a flat calibration.
 */
export function gripQuality(up: CanonicalVector): number {
  const gain = Math.abs(normalise(up).y);
  return Math.min(1, Math.max(0, (gain - FLAT_GAIN) / (1 - FLAT_GAIN)));
}
