import { SCREEN_ORIENTATION_ANGLE, type SensorFrame } from '@phonemote/protocol';
import type { CanonicalAngles, CanonicalSensorFrame, CanonicalVector } from './types.js';

/**
 * Raw device frame -> canonical frame (ARCHITECTURE.md 5.5 - 5.7).
 *
 * This is the only place that knows about screen orientation, and it is pure:
 * same input, same output, no clock and no DOM. Everything downstream is
 * written against the canonical axes and never sees alpha/beta/gamma.
 *
 * If a real phone disagrees with these signs, fix the table in ARCHITECTURE.md
 * first and this file second. Do not bolt a sign flip onto a caller.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Screen rotation is always a rotation about the device z axis. */
export function rotateAboutZ(vector: CanonicalVector, angleDeg: number): CanonicalVector {
  const angle = angleDeg * DEG;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
    z: vector.z,
  };
}

function rotateX(v: CanonicalVector, angle: number): CanonicalVector {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
}

function rotateY(v: CanonicalVector, angle: number): CanonicalVector {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

function rotateZ(v: CanonicalVector, angle: number): CanonicalVector {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

/**
 * R_dw = Rz(alpha) Rx(beta) Ry(gamma), the W3C device-to-world rotation.
 * World axes: X east, Y north, Z up.
 */
function deviceToWorld(
  vector: CanonicalVector,
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
): CanonicalVector {
  return rotateZ(rotateX(rotateY(vector, gammaDeg * DEG), betaDeg * DEG), alphaDeg * DEG);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Recovers yaw/pitch/roll of the canonical pose from the raw Euler angles.
 *
 * Euler angles cannot be permuted like a vector, so the canonical body axes are
 * carried into world space and the angles are read back off them there.
 */
export interface CanonicalPose {
  readonly angles: CanonicalAngles;
  /** World up expressed in canonical axes; free of the angles' singularities. */
  readonly up: CanonicalVector;
}

export function orientationToCanonical(
  alpha: number,
  beta: number,
  gamma: number,
  screenAngleDeg: number,
): CanonicalAngles {
  return canonicalPose(alpha, beta, gamma, screenAngleDeg).angles;
}

export function canonicalPose(
  alpha: number,
  beta: number,
  gamma: number,
  screenAngleDeg: number,
): CanonicalPose {
  const theta = screenAngleDeg * DEG;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Canonical body axes expressed in device coordinates: Rz(-theta) * e.
  const forwardDevice: CanonicalVector = { x: 0, y: 0, z: -1 };
  const rightDevice: CanonicalVector = { x: cos, y: -sin, z: 0 };
  const downDevice: CanonicalVector = { x: -sin, y: -cos, z: 0 };

  const forward = deviceToWorld(forwardDevice, alpha, beta, gamma);
  const right = deviceToWorld(rightDevice, alpha, beta, gamma);
  const down = deviceToWorld(downDevice, alpha, beta, gamma);

  return {
    angles: {
      // World +Z is up, so the vertical component of "forward" is the elevation.
      pitch: Math.asin(clamp(forward.z, -1, 1)) * RAD,
      // Right edge dipping below horizontal means a positive roll. This goes
      // singular when forward is vertical, which is why `up` exists.
      roll: Math.atan2(-right.z, -down.z) * RAD,
      // Heading, measured from north. Absolute value is meaningless on Chrome's
      // relative deviceorientation; only differences are usable.
      yaw: Math.atan2(forward.x, forward.y) * RAD,
    },
    // Each canonical axis's share of world up: no angles, so no singularity.
    up: { x: right.z, y: -down.z, z: -forward.z },
  };
}

export function screenAngleFor(screenOrientation: number): number {
  return SCREEN_ORIENTATION_ANGLE[screenOrientation] ?? 0;
}

/**
 * @param previousTimestamp the phone timestamp of this player's previous frame,
 *   or null for the first frame.
 */
function midpoint(a: CanonicalAngles, b: CanonicalAngles): CanonicalAngles {
  return {
    yaw: (a.yaw + b.yaw) / 2,
    pitch: (a.pitch + b.pitch) / 2,
    roll: (a.roll + b.roll) / 2,
  };
}

export function normalize(
  frame: SensorFrame,
  previousTimestamp: number | null,
  /**
   * The previous frame's canonical rate, for the trapezoid step.
   *
   * Optional so existing callers keep working; without it `rateStep` is just
   * the instantaneous rate, which is what everything did before
   * (ARCHITECTURE.md D39).
   */
  previousRate: CanonicalAngles | null = null,
): CanonicalSensorFrame {
  const screenAngle = screenAngleFor(frame.screenOrientation);

  const acceleration = rotateAboutZ(
    { x: frame.acceleration.x, y: frame.acceleration.y, z: frame.acceleration.z },
    screenAngle,
  );

  // Measured, not assumed: this device reports rotationRate.alpha/beta/gamma as
  // the rates about x/y/z, where the W3C spec says z/x/y. Correlating the true
  // body rate — recovered from consecutive orientation matrices — against each
  // reported channel came out at 0.92, 0.78 and 0.90 straight down the diagonal
  // across five sessions (ARCHITECTURE.md 5.4).
  //
  // Trusting the spec here sent a nod of the phone into roll and left canonical
  // pitch barely moving, which is why the pointer had no vertical axis.
  const omega = rotateAboutZ(
    { x: frame.rotationRate.alpha, y: frame.rotationRate.beta, z: frame.rotationRate.gamma },
    screenAngle,
  );

  const dtMs = previousTimestamp === null ? 0 : frame.timestamp - previousTimestamp;

  const pose = canonicalPose(
    frame.orientation.alpha,
    frame.orientation.beta,
    frame.orientation.gamma,
    screenAngle,
  );

  const angularVelocity: CanonicalAngles = {
    pitch: omega.x,
    yaw: -omega.y,
    roll: -omega.z,
  };

  return {
    playerId: frame.playerId,
    seq: frame.seq,
    timestamp: frame.timestamp,
    // A negative dt would mean the phone clock jumped; treat it as a fresh start.
    dt: dtMs > 0 ? dtMs / 1000 : 0,
    orientation: pose.angles,
    up: pose.up,
    angularVelocity,
    // The average rate across the step, which is what anything integrating
    // rotation should multiply by dt. Measured against the orientation matrix
    // on a recorded swing, this cuts per-step rate error from 115 to 47 deg/s
    // on the fastest axis and halves the two-second attitude error.
    rateStep: previousRate === null ? angularVelocity : midpoint(previousRate, angularVelocity),
    acceleration,
    buttons: frame.buttons,
  };
}
