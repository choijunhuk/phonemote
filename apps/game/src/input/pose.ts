import type { CanonicalVector } from './types.js';

/**
 * Pose matching against gravity (ARCHITECTURE.md 5.8).
 *
 * A pose is a rotation from the grip the player calibrated, not a direction in
 * the room. That distinction is the whole design:
 *
 * - Judging absolute directions demands one specific grip, and a player holding
 *   the phone their own way then fails every round for a reason nobody can see.
 * - Rotating the measurement onto a reference "up" fixes the grip but throws
 *   away the spin about that axis, which is precisely what separates "roll it
 *   right" from "stand it on end". Both move gravity ninety degrees; only the
 *   direction differs, and that is the part such an alignment cannot keep.
 *
 * So a pose is an axis in the phone's own frame and an angle about it. Turning
 * the phone that way moves gravity, in the phone's frame, by the inverse of
 * that rotation — computable exactly, from any starting grip, with no unknowns.
 *
 * Yaw about gravity is deliberately absent: it leaves gravity where it was, so
 * no pose here can ask for it and no sensor here could see it.
 *
 * Canonical axes: +X right, +Y up, +Z out of the screen towards the player, and
 * the phone aims along -Z (ARCHITECTURE.md 5.2).
 */

/** The phone's aiming axis; rolling happens about this. */
const FORWARD: CanonicalVector = { x: 0, y: 0, z: -1 };
/** The phone's right; standing it on end happens about this. */
const RIGHT: CanonicalVector = { x: 1, y: 0, z: 0 };

export interface NamedPose {
  readonly key: string;
  /** Shown to the player, phrased as a movement from their own grip. */
  readonly label: string;
  /** Rotation axis, in the phone's own frame. */
  readonly axis: CanonicalVector;
  readonly angleDeg: number;
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

/** Rodrigues rotation of a vector about an axis, angle in degrees. */
export function rotateAbout(
  vector: CanonicalVector,
  axis: CanonicalVector,
  angleDeg: number,
): CanonicalVector {
  const k = normalise(axis);
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const cross = {
    x: k.y * vector.z - k.z * vector.y,
    y: k.z * vector.x - k.x * vector.z,
    z: k.x * vector.y - k.y * vector.x,
  };
  const along = k.x * vector.x + k.y * vector.y + k.z * vector.z;

  return {
    x: vector.x * cos + cross.x * sin + k.x * along * (1 - cos),
    y: vector.y * cos + cross.y * sin + k.y * along * (1 - cos),
    z: vector.z * cos + cross.z * sin + k.z * along * (1 - cos),
  };
}

/**
 * Where gravity should sit, in the phone's frame, once this pose is held from
 * that reference grip. The angle is negated because turning the phone by R
 * leaves gravity where it was in the world, so in the phone's frame it moves
 * by R inverse.
 */
export function expectedUp(pose: NamedPose, reference: CanonicalVector): CanonicalVector {
  return rotateAbout(reference, pose.axis, -pose.angleDeg);
}

export function poseOffByDeg(
  pose: NamedPose,
  reference: CanonicalVector,
  measured: CanonicalVector,
): number {
  return angleBetweenDeg(expectedUp(pose, reference), measured);
}

export function poseMatches(
  pose: NamedPose,
  reference: CanonicalVector,
  measured: CanonicalVector,
  toleranceDeg: number,
): boolean {
  return poseOffByDeg(pose, reference, measured) <= toleranceDeg;
}

/**
 * How close the hold is: 1 dead on, 0 at the tolerance. Games use this for a
 * progress meter rather than a bare pass or fail, so a player can see
 * themselves getting warmer.
 */
export function poseCloseness(offByDeg: number, toleranceDeg: number): number {
  return Math.max(0, 1 - offByDeg / toleranceDeg);
}

export const POSES: readonly NamedPose[] = [
  { key: 'level', label: '그대로', axis: FORWARD, angleDeg: 0 },
  { key: 'tilt-right', label: '오른쪽으로 눕히기', axis: FORWARD, angleDeg: 90 },
  { key: 'tilt-left', label: '왼쪽으로 눕히기', axis: FORWARD, angleDeg: -90 },
  { key: 'diagonal-right', label: '오른쪽으로 45도', axis: FORWARD, angleDeg: 45 },
  { key: 'diagonal-left', label: '왼쪽으로 45도', axis: FORWARD, angleDeg: -45 },
  { key: 'upside-down', label: '거꾸로 뒤집기', axis: FORWARD, angleDeg: 180 },
  { key: 'aim-up', label: '화면을 바닥으로 눕히기', axis: RIGHT, angleDeg: 90 },
  { key: 'aim-down', label: '화면을 하늘로 눕히기', axis: RIGHT, angleDeg: -90 },
  { key: 'aim-up-half', label: '앞으로 45도 눕히기', axis: RIGHT, angleDeg: 45 },
  { key: 'aim-down-half', label: '뒤로 45도 젖히기', axis: RIGHT, angleDeg: -45 },
];

export function poseByKey(key: string): NamedPose | undefined {
  return POSES.find((pose) => pose.key === key);
}

/**
 * The poses worth asking for from this grip.
 *
 * Which ones are usable depends on the grip: gravity cannot see a turn about
 * itself, so a pose whose axis happens to lie along gravity would score for
 * standing perfectly still. Those are filtered out rather than called.
 */
export function posesUsableFrom(reference: CanonicalVector, minSeparationDeg: number): NamedPose[] {
  const usable: NamedPose[] = [];
  for (const pose of POSES) {
    const target = expectedUp(pose, reference);
    if (pose.angleDeg !== 0 && angleBetweenDeg(target, reference) < minSeparationDeg) continue;
    const clashes = usable.some(
      (other) => angleBetweenDeg(expectedUp(other, reference), target) < minSeparationDeg,
    );
    if (!clashes) usable.push(pose);
  }
  return usable;
}
