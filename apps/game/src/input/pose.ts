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
 * Canonical axes: +X right, +Y up, +Z out of the screen towards the player,
 * and the phone aims along -Z. So "level" puts world up along +Y, aiming at
 * the ceiling rotates it onto -Z, and laying the phone screen-up puts it on +Z.
 */
export const POSES: readonly NamedPose[] = [
  { key: 'level', label: '똑바로 들기', up: { x: 0, y: 1, z: 0 } },
  { key: 'tilt-right', label: '오른쪽으로 눕히기', up: { x: -1, y: 0, z: 0 } },
  { key: 'tilt-left', label: '왼쪽으로 눕히기', up: { x: 1, y: 0, z: 0 } },
  { key: 'aim-up', label: '천장 겨누기', up: { x: 0, y: 0, z: -1 } },
  { key: 'aim-down', label: '바닥 겨누기', up: { x: 0, y: 0, z: 1 } },
  { key: 'upside-down', label: '거꾸로 들기', up: { x: 0, y: -1, z: 0 } },
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
