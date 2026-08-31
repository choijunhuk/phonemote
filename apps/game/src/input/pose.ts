import type { CanonicalVector } from './types.js';

/**
 * Pose matching against gravity (ARCHITECTURE.md 5.8).
 *
 * A pose is a direction, not a pair of angles. Comparing directions is one
 * angle between two unit vectors: no per-axis tolerances, no wrap-around at
 * 180 degrees, and nothing that blows up when the phone is laid flat or stood
 * on end, which is exactly where pitch and roll stop meaning anything.
 *
 * Yaw is deliberately absent. Chrome gives no absolute heading, so a pose that
 * depended on which way the player was facing could never be judged fairly.
 * Every pose here is one the phone can verify on its own.
 */

export interface NamedPose {
  readonly key: string;
  /** Shown to the player. */
  readonly label: string;
  /** Where world up sits in canonical axes when the pose is held. */
  readonly up: CanonicalVector;
}

export function normalise(vector: CanonicalVector): CanonicalVector {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length === 0) return { x: 0, y: 1, z: 0 };
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

/** Angle between two directions, in degrees, always 0..180. */
export function angleBetweenDeg(a: CanonicalVector, b: CanonicalVector): number {
  const first = normalise(a);
  const second = normalise(b);
  const dot = first.x * second.x + first.y * second.y + first.z * second.z;
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

/**
 * Rotates a measured direction into the frame of a reference hold.
 *
 * Poses are written against the canonical landscape hold, but a player holds
 * the phone however they like — and a pose game that silently requires one
 * grip fails every round for a reason nobody in the room can see. Whatever way
 * they were holding it when they calibrated becomes "level", and every pose is
 * judged relative to that.
 *
 * This is the shortest rotation taking the reference onto canonical up. The
 * remaining freedom is a spin about the up axis, which no pose here
 * distinguishes, so it does not matter that we cannot observe it.
 */
export function rotateFromReference(
  vector: CanonicalVector,
  reference: CanonicalVector,
): CanonicalVector {
  const from = normalise(reference);
  const to = { x: 0, y: 1, z: 0 };

  const dot = from.x * to.x + from.y * to.y + from.z * to.z;
  if (dot > 0.9999) return vector;
  if (dot < -0.9999) {
    // Exactly upside down: any axis perpendicular to up will do.
    return { x: -vector.x, y: -vector.y, z: vector.z };
  }

  const axis = normalise({
    x: from.y * to.z - from.z * to.y,
    y: from.z * to.x - from.x * to.z,
    z: from.x * to.y - from.y * to.x,
  });
  const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Rodrigues: v cos + (k x v) sin + k (k . v)(1 - cos)
  const cross = {
    x: axis.y * vector.z - axis.z * vector.y,
    y: axis.z * vector.x - axis.x * vector.z,
    z: axis.x * vector.y - axis.y * vector.x,
  };
  const along = axis.x * vector.x + axis.y * vector.y + axis.z * vector.z;

  return {
    x: vector.x * cos + cross.x * sin + axis.x * along * (1 - cos),
    y: vector.y * cos + cross.y * sin + axis.y * along * (1 - cos),
    z: vector.z * cos + cross.z * sin + axis.z * along * (1 - cos),
  };
}

export function poseMatches(
  target: CanonicalVector,
  measured: CanonicalVector,
  toleranceDeg: number,
): boolean {
  return angleBetweenDeg(target, measured) <= toleranceDeg;
}

/**
 * How close the hold is, 1 at dead on and 0 at the tolerance. Games use this
 * for a progress ring rather than a bare pass or fail, so a player can see
 * themselves getting warmer.
 */
export function poseCloseness(
  target: CanonicalVector,
  measured: CanonicalVector,
  toleranceDeg: number,
): number {
  const off = angleBetweenDeg(target, measured);
  return Math.max(0, 1 - off / toleranceDeg);
}

/**
 * The poses a phone can be asked to hold, in canonical terms.
 *
 * The labels describe a movement from the grip the player calibrated, not an
 * absolute direction, because that is what the judging does. "Aim at the
 * ceiling" would be a lie the moment somebody held the phone differently.
 *
 * Canonical axes: +X right, +Y up, +Z out of the screen towards the player,
 * and the phone aims along -Z. So "level" puts world up along +Y, aiming at
 * the ceiling rotates it onto -Z, and laying the phone screen-up puts it on +Z.
 */
export const POSES: readonly NamedPose[] = [
  { key: 'level', label: '그대로', up: { x: 0, y: 1, z: 0 } },
  { key: 'tilt-right', label: '오른쪽으로 눕히기', up: { x: -1, y: 0, z: 0 } },
  { key: 'tilt-left', label: '왼쪽으로 눕히기', up: { x: 1, y: 0, z: 0 } },
  { key: 'aim-up', label: '끝을 하늘로', up: { x: 0, y: 0, z: -1 } },
  { key: 'aim-down', label: '끝을 바닥으로', up: { x: 0, y: 0, z: 1 } },
  { key: 'upside-down', label: '거꾸로 뒤집기', up: { x: 0, y: -1, z: 0 } },
  {
    key: 'diagonal-right',
    label: '오른쪽으로 45도',
    up: normalise({ x: -1, y: 1, z: 0 }),
  },
  {
    key: 'diagonal-left',
    label: '왼쪽으로 45도',
    up: normalise({ x: 1, y: 1, z: 0 }),
  },
];

export function poseByKey(key: string): NamedPose | undefined {
  return POSES.find((pose) => pose.key === key);
}
