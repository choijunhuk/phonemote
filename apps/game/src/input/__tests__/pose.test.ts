import { describe, expect, it } from 'vitest';
import { canonicalPose } from '../SensorNormalizer.js';
import {
  POSES,
  angleBetweenDeg,
  poseByKey,
  poseCloseness,
  poseMatches,
  rotateFromReference,
} from '../pose.js';

/**
 * These tie the gravity vector to physical poses. If a real phone disagrees,
 * ARCHITECTURE.md 5.8 changes first, then this file, then the games.
 *
 * Landscape-primary throughout (screen angle 90), which is the canonical hold.
 * The anchor pose is alpha 90, beta 0, gamma -90 (ARCHITECTURE.md 5.7).
 */

const LANDSCAPE = 90;
const ANCHOR = { alpha: 90, beta: 0, gamma: -90 };

function upFor(beta: number, gamma: number): ReturnType<typeof canonicalPose>['up'] {
  return canonicalPose(ANCHOR.alpha, beta, gamma, LANDSCAPE).up;
}

describe('the gravity vector', () => {
  it('points along canonical +Y when the phone is held level', () => {
    const up = upFor(ANCHOR.beta, ANCHOR.gamma);
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeCloseTo(1, 6);
    expect(up.z).toBeCloseTo(0, 6);
  });

  it('swings onto -X when the phone rolls right', () => {
    // Rolling right tips the right edge down, so up leans left in canonical X.
    const up = upFor(ANCHOR.beta + 90, ANCHOR.gamma);
    expect(up.x).toBeCloseTo(-1, 5);
    expect(up.y).toBeCloseTo(0, 5);
  });

  it('swings onto -Z when the phone aims at the ceiling', () => {
    const up = upFor(ANCHOR.beta, ANCHOR.gamma - 90);
    expect(up.z).toBeCloseTo(-1, 5);
  });

  it('swings onto +Z when the phone aims at the floor', () => {
    const up = upFor(ANCHOR.beta, ANCHOR.gamma + 90);
    expect(up.z).toBeCloseTo(1, 5);
  });

  it('stays a unit vector through every pose', () => {
    for (let beta = -180; beta <= 180; beta += 30) {
      for (let gamma = -180; gamma <= 180; gamma += 30) {
        const up = upFor(beta, gamma);
        expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 6);
      }
    }
  });

  it('stays steady where roll goes singular', () => {
    // Aiming straight up leaves roll undefined; the vector does not care.
    const straightUp = upFor(ANCHOR.beta, ANCHOR.gamma - 90);
    const nudged = upFor(ANCHOR.beta + 1, ANCHOR.gamma - 90);
    expect(angleBetweenDeg(straightUp, nudged)).toBeLessThan(2);

    const angles = canonicalPose(ANCHOR.alpha, ANCHOR.beta, ANCHOR.gamma - 90, LANDSCAPE).angles;
    const nudgedAngles = canonicalPose(
      ANCHOR.alpha,
      ANCHOR.beta + 1,
      ANCHOR.gamma - 90,
      LANDSCAPE,
    ).angles;
    // The same one degree of movement throws roll around by a lot, which is
    // the whole argument for judging poses on the vector.
    expect(Math.abs(angles.roll - nudgedAngles.roll)).toBeGreaterThan(10);
  });
});

describe('matching a pose', () => {
  const level = { x: 0, y: 1, z: 0 };

  it('accepts the pose it is asked for', () => {
    expect(poseMatches(level, upFor(ANCHOR.beta, ANCHOR.gamma), 20)).toBe(true);
  });

  it('rejects one that is clearly different', () => {
    expect(poseMatches(level, upFor(ANCHOR.beta + 90, ANCHOR.gamma), 20)).toBe(false);
  });

  it('accepts a near miss inside the tolerance', () => {
    expect(poseMatches(level, upFor(ANCHOR.beta + 15, ANCHOR.gamma), 20)).toBe(true);
    expect(poseMatches(level, upFor(ANCHOR.beta + 25, ANCHOR.gamma), 20)).toBe(false);
  });

  it('scores closeness from 1 at dead on to 0 at the tolerance', () => {
    expect(poseCloseness(level, level, 20)).toBe(1);
    expect(poseCloseness(level, upFor(ANCHOR.beta + 10, ANCHOR.gamma), 20)).toBeCloseTo(0.5, 1);
    expect(poseCloseness(level, upFor(ANCHOR.beta + 90, ANCHOR.gamma), 20)).toBe(0);
  });

  it('treats a pose and its opposite as far apart', () => {
    expect(angleBetweenDeg({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 })).toBeCloseTo(180, 6);
  });
});

describe('judging in the player’s own frame', () => {
  const level = { x: 0, y: 1, z: 0 };

  it('treats whatever grip was calibrated as level', () => {
    // Someone holding the phone rolled 40 degrees over and aimed 20 down.
    const grip = upFor(ANCHOR.beta + 40, ANCHOR.gamma + 20);
    expect(poseMatches(level, grip, 20)).toBe(false);
    expect(poseMatches(level, rotateFromReference(grip, grip), 20)).toBe(true);
  });

  it('keeps the same movement meaning the same thing from an odd grip', () => {
    const grip = upFor(ANCHOR.beta + 40, ANCHOR.gamma + 20);
    // From that grip, roll a further 90 degrees right.
    const rolled = upFor(ANCHOR.beta + 130, ANCHOR.gamma + 20);
    const aligned = rotateFromReference(rolled, grip);

    const tiltRight = poseByKey('tilt-right');
    expect(tiltRight).toBeDefined();
    expect(angleBetweenDeg(tiltRight?.up ?? aligned, aligned)).toBeLessThan(25);
  });

  it('leaves a canonical grip untouched', () => {
    const canonical = upFor(ANCHOR.beta, ANCHOR.gamma);
    const other = upFor(ANCHOR.beta + 90, ANCHOR.gamma);
    const aligned = rotateFromReference(other, canonical);
    expect(angleBetweenDeg(aligned, other)).toBeLessThan(1);
  });

  it('preserves the angle between any two holds', () => {
    // Rotating into another frame must not distort how far apart poses are.
    const grip = upFor(ANCHOR.beta - 60, ANCHOR.gamma + 35);
    const a = upFor(ANCHOR.beta + 20, ANCHOR.gamma);
    const b = upFor(ANCHOR.beta, ANCHOR.gamma - 45);
    expect(angleBetweenDeg(rotateFromReference(a, grip), rotateFromReference(b, grip))).toBeCloseTo(
      angleBetweenDeg(a, b),
      4,
    );
  });

  it('handles a grip that is exactly upside down', () => {
    const upsideDown = { x: 0, y: -1, z: 0 };
    const aligned = rotateFromReference(upsideDown, upsideDown);
    expect(angleBetweenDeg(aligned, level)).toBeLessThan(1);
  });
});

describe('the pose list', () => {
  it('has unique keys and unit vectors', () => {
    const keys = POSES.map((pose) => pose.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const pose of POSES) {
      expect(Math.hypot(pose.up.x, pose.up.y, pose.up.z)).toBeCloseTo(1, 6);
    }
  });

  it('keeps every pose distinguishable at a 20 degree tolerance', () => {
    for (const a of POSES) {
      for (const b of POSES) {
        if (a.key === b.key) continue;
        expect(angleBetweenDeg(a.up, b.up)).toBeGreaterThan(40);
      }
    }
  });

  it('looks a pose up by key', () => {
    expect(poseByKey('aim-up')?.label).toBe('끝을 하늘로');
    expect(poseByKey('nonsense')).toBeUndefined();
  });
});
