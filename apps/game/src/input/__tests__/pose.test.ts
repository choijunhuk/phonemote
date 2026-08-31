import { describe, expect, it } from 'vitest';
import { canonicalPose } from '../SensorNormalizer.js';
import {
  POSES,
  angleBetweenDeg,
  expectedUp,
  isFlatGrip,
  poseByKey,
  poseCloseness,
  poseMatches,
  poseOffByDeg,
  posesUsableFor,
  posesUsableFrom,
  rotateAbout,
} from '../pose.js';
import type { CanonicalVector } from '../types.js';

/**
 * These tie poses to physical holds. If a real phone disagrees,
 * ARCHITECTURE.md 5.8 changes first, then this file, then the games.
 *
 * Landscape-primary throughout (screen angle 90), which is the canonical hold.
 * The anchor is alpha 90, beta 0, gamma -90 (ARCHITECTURE.md 5.7): held level,
 * aiming straight ahead. beta rolls the phone, gamma swings the aim.
 */

const LANDSCAPE = 90;
const ANCHOR = { alpha: 90, beta: 0, gamma: -90 };

function upFor(beta: number, gamma: number, alpha = ANCHOR.alpha): CanonicalVector {
  return canonicalPose(alpha, beta, gamma, LANDSCAPE).up;
}

const LEVEL_GRIP = upFor(ANCHOR.beta, ANCHOR.gamma);

describe('the gravity vector', () => {
  it('points along canonical +Y when the phone is held level', () => {
    expect(LEVEL_GRIP.x).toBeCloseTo(0, 6);
    expect(LEVEL_GRIP.y).toBeCloseTo(1, 6);
    expect(LEVEL_GRIP.z).toBeCloseTo(0, 6);
  });

  it('swings onto -X when the phone rolls right', () => {
    expect(upFor(ANCHOR.beta + 90, ANCHOR.gamma).x).toBeCloseTo(-1, 5);
  });

  it('swings onto -Z when the phone stands on end, aim up', () => {
    expect(upFor(ANCHOR.beta, ANCHOR.gamma - 90).z).toBeCloseTo(-1, 5);
  });

  it('stays a unit vector through every hold', () => {
    for (let beta = -180; beta <= 180; beta += 30) {
      for (let gamma = -180; gamma <= 180; gamma += 30) {
        const up = upFor(beta, gamma);
        expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 6);
      }
    }
  });

  it('stays steady where roll goes singular', () => {
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
    // A single degree of movement throws roll around by a lot, which is the
    // whole argument for judging on the vector.
    expect(Math.abs(angles.roll - nudgedAngles.roll)).toBeGreaterThan(10);
  });
});

describe('rotateAbout', () => {
  it('turns up into the rolled position', () => {
    expect(rotateAbout({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, -90).x).toBeCloseTo(-1, 6);
  });

  it('leaves a vector on its own axis alone', () => {
    const axis = { x: 0, y: 0, z: -1 };
    expect(angleBetweenDeg(rotateAbout(axis, axis, 137), axis)).toBeLessThan(1e-6);
  });

  it('preserves angles between vectors', () => {
    const a = { x: 0.3, y: 0.8, z: -0.5 };
    const b = { x: -0.7, y: 0.1, z: 0.2 };
    const axis = { x: 1, y: 2, z: -3 };
    expect(angleBetweenDeg(rotateAbout(a, axis, 61), rotateAbout(b, axis, 61))).toBeCloseTo(
      angleBetweenDeg(a, b),
      6,
    );
  });
});

describe('poses as rotations from a grip', () => {
  /** Holds that physically are the pose, from the canonical level grip. */
  const holds: ReadonlyArray<{ key: string; beta: number; gamma: number }> = [
    { key: 'level', beta: 0, gamma: -90 },
    { key: 'tilt-right', beta: 90, gamma: -90 },
    { key: 'tilt-left', beta: -90, gamma: -90 },
    { key: 'diagonal-right', beta: 45, gamma: -90 },
    { key: 'diagonal-left', beta: -45, gamma: -90 },
    { key: 'upside-down', beta: 180, gamma: -90 },
    { key: 'aim-up', beta: 0, gamma: -180 },
    { key: 'aim-down', beta: 0, gamma: 0 },
    { key: 'aim-up-half', beta: 0, gamma: -135 },
    { key: 'aim-down-half', beta: 0, gamma: -45 },
  ];

  it('matches every pose when the phone is actually in it', () => {
    for (const { key, beta, gamma } of holds) {
      const pose = poseByKey(key);
      expect(pose, key).toBeDefined();
      if (!pose) continue;
      expect(poseOffByDeg(pose, LEVEL_GRIP, upFor(beta, gamma)), key).toBeLessThan(10);
    }
  });

  it('tells rolling apart from standing on end', () => {
    // The bug that made half the poses unwinnable: both move gravity ninety
    // degrees, and aligning onto "up" cannot separate them.
    const roll = poseByKey('tilt-right');
    const stand = poseByKey('aim-up');
    if (!roll || !stand) throw new Error('missing pose');

    const rolled = upFor(90, -90);
    expect(poseOffByDeg(roll, LEVEL_GRIP, rolled)).toBeLessThan(10);
    expect(poseOffByDeg(stand, LEVEL_GRIP, rolled)).toBeGreaterThan(60);
  });

  it('moves gravity by the angle the pose asks for, from any grip', () => {
    // Incrementing beta is only a body roll at the canonical grip, so the check
    // from an odd grip is the property itself: a rotation of N degrees about an
    // axis across gravity moves gravity N degrees.
    for (const grip of [LEVEL_GRIP, upFor(35, -65), upFor(90, -90), upFor(20, -120)]) {
      for (const pose of POSES) {
        const target = expectedUp(pose, grip);
        const axisDot =
          Math.abs(pose.axis.x * grip.x + pose.axis.y * grip.y + pose.axis.z * grip.z) /
          Math.hypot(pose.axis.x, pose.axis.y, pose.axis.z);
        // Only meaningful where the axis is not lying along gravity.
        if (axisDot > 0.2) continue;
        expect(angleBetweenDeg(target, grip), `${pose.key}`).toBeCloseTo(
          Math.abs(pose.angleDeg),
          4,
        );
      }
    }
  });

  it('separates a roll from a stand-on-end at an upright grip', () => {
    const roll = poseByKey('tilt-right');
    const stand = poseByKey('aim-up');
    if (!roll || !stand) throw new Error('missing pose');

    for (const grip of [LEVEL_GRIP, upFor(35, -65)]) {
      expect(angleBetweenDeg(expectedUp(roll, grip), expectedUp(stand, grip))).toBeGreaterThan(45);
    }
  });

  it('admits that some grips cannot separate them, and says which', () => {
    // Not a defect but the geometry: gravity is one direction, so from some
    // holds two different rotations land it in nearly the same place. That is
    // what posesUsableFrom is for — the game stops calling those poses instead
    // of asking for something it cannot judge.
    const awkward = upFor(20, -120);
    const roll = poseByKey('tilt-right');
    const stand = poseByKey('aim-up');
    if (!roll || !stand) throw new Error('missing pose');

    const apart = angleBetweenDeg(expectedUp(roll, awkward), expectedUp(stand, awkward));
    expect(apart).toBeLessThan(45);

    const usable = posesUsableFrom(awkward, 45).map((pose) => pose.key);
    expect(usable.includes('tilt-right') && usable.includes('aim-up')).toBe(false);
  });

  it('produces a unit target from any grip', () => {
    const grip = upFor(90, -90);
    for (const pose of POSES) {
      const target = expectedUp(pose, grip);
      expect(Math.hypot(target.x, target.y, target.z)).toBeCloseTo(1, 6);
    }
  });

  it('scores closeness from 1 dead on to 0 at the tolerance', () => {
    expect(poseCloseness(0, 20)).toBe(1);
    expect(poseCloseness(10, 20)).toBeCloseTo(0.5, 6);
    expect(poseCloseness(40, 20)).toBe(0);
  });

  it('accepts a near miss inside the tolerance', () => {
    const pose = poseByKey('level');
    if (!pose) throw new Error('missing pose');
    expect(poseMatches(pose, LEVEL_GRIP, upFor(15, -90), 20)).toBe(true);
    expect(poseMatches(pose, LEVEL_GRIP, upFor(25, -90), 20)).toBe(false);
  });
});

describe('choosing poses for a grip', () => {
  it('drops a pose gravity cannot see from this grip', () => {
    // Phone flat on its back: rolling spins about gravity, so gravity does not
    // move and the pose would score for standing perfectly still.
    const usable = posesUsableFrom(upFor(0, 0), 30).map((pose) => pose.key);
    expect(usable).not.toContain('tilt-right');
    expect(usable).not.toContain('tilt-left');
    expect(usable).toContain('aim-up');
  });

  it('keeps the full range from a level grip', () => {
    const usable = posesUsableFrom(LEVEL_GRIP, 30).map((pose) => pose.key);
    expect(usable).toContain('tilt-right');
    expect(usable).toContain('aim-up');
    expect(usable).toContain('upside-down');
  });

  it('never offers two poses that mean the same hold', () => {
    for (const grip of [LEVEL_GRIP, upFor(0, 0), upFor(90, -90), upFor(35, -65)]) {
      const usable = posesUsableFrom(grip, 30);
      for (const a of usable) {
        for (const b of usable) {
          if (a.key === b.key) continue;
          expect(
            angleBetweenDeg(expectedUp(a, grip), expectedUp(b, grip)),
            `${a.key} vs ${b.key}`,
          ).toBeGreaterThanOrEqual(30);
        }
      }
    }
  });

  it('always leaves something to ask for', () => {
    for (const grip of [LEVEL_GRIP, upFor(0, 0), upFor(90, -90), upFor(180, -90)]) {
      expect(posesUsableFrom(grip, 30).length).toBeGreaterThan(2);
    }
  });
});

describe('the pose list', () => {
  it('has unique keys and a label each', () => {
    const keys = POSES.map((pose) => pose.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const pose of POSES) expect(pose.label.length).toBeGreaterThan(0);
  });

  it('looks a pose up by key', () => {
    expect(poseByKey('aim-up')?.label).toBe('화면을 바닥으로 눕히기');
    expect(poseByKey('nonsense')).toBeUndefined();
  });
});

describe('choosing poses for a room', () => {
  it('drops a pose that only one of the grips cannot show', () => {
    // One player holding the phone upright, one with it flat on the table. A
    // roll is a real movement for the first and no movement at all for the
    // second, who would score every time by doing nothing.
    const upright = LEVEL_GRIP;
    const flat = upFor(0, 0);
    const usable = posesUsableFor([upright, flat], 30).map((pose) => pose.key);
    expect(usable).not.toContain('tilt-right');
    expect(usable).toContain('aim-up');
  });

  it('matches the single-grip rule when there is only one grip', () => {
    for (const grip of [LEVEL_GRIP, upFor(0, 0), upFor(35, -65)]) {
      expect(posesUsableFor([grip], 30).map((pose) => pose.key)).toEqual(
        posesUsableFrom(grip, 30).map((pose) => pose.key),
      );
    }
  });

  it('still leaves something to call for a mixed room', () => {
    expect(posesUsableFor([LEVEL_GRIP, upFor(0, 0), upFor(90, -90)], 30).length).toBeGreaterThan(1);
  });

  it('offers everything when nobody has calibrated yet', () => {
    expect(posesUsableFor([], 30)).toHaveLength(POSES.length);
  });
});

describe('spotting a phone calibrated flat', () => {
  it('knows a phone lying on its back or its face', () => {
    expect(isFlatGrip(upFor(0, 0))).toBe(true);
    expect(isFlatGrip({ x: 0, y: 0, z: -1 })).toBe(true);
  });

  it('does not accuse a phone that is being held up', () => {
    expect(isFlatGrip(LEVEL_GRIP)).toBe(false);
    expect(isFlatGrip(upFor(0, -90))).toBe(false);
  });
});
