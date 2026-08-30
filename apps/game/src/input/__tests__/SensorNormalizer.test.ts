import { describe, expect, it } from 'vitest';
import {
  SENSOR_FLAG,
  SENSOR_FRAME_VERSION,
  type ScreenOrientationValue,
  type SensorFrame,
} from '@phonemote/protocol';
import { normalize, orientationToCanonical, rotateAboutZ } from '../SensorNormalizer.js';

/**
 * These tests encode the physical claims of ARCHITECTURE.md 5.3 and 5.6.
 * If a real phone contradicts them, the document changes first.
 */

function frameWith(overrides: Partial<SensorFrame> = {}): SensorFrame {
  return {
    playerId: 1,
    seq: 0,
    timestamp: 1000,
    orientation: { alpha: 0, beta: 0, gamma: 0 },
    rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    acceleration: { x: 0, y: 0, z: 0 },
    buttons: 0,
    screenOrientation: 1,
    version: SENSOR_FRAME_VERSION,
    motionSeq: 0,
    flags: SENSOR_FLAG.LINEAR_ACCEL | SENSOR_FLAG.ROTATION_RATE | SENSOR_FLAG.ORIENTATION,
    ...overrides,
  };
}

const LANDSCAPE_PRIMARY: ScreenOrientationValue = 1;

describe('screen rotation of vectors', () => {
  it('leaves portrait-primary alone', () => {
    const v = rotateAboutZ({ x: 1, y: 2, z: 3 }, 0);
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(2);
    expect(v.z).toBeCloseTo(3);
  });

  it('maps device +x to canonical +y in landscape-primary', () => {
    // Held in the canonical pose the phone's right edge points at the ceiling.
    const v = rotateAboutZ({ x: 1, y: 0, z: 0 }, 90);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(1);
  });

  it('follows the acceleration table for all four orientations', () => {
    const raw = { x: 1, y: 2, z: 3 };
    const expected: Record<ScreenOrientationValue, [number, number, number]> = {
      0: [1, 2, 3],
      1: [-2, 1, 3],
      2: [-1, -2, 3],
      3: [2, -1, 3],
    };
    for (const key of [0, 1, 2, 3] as ScreenOrientationValue[]) {
      const { acceleration } = normalize(
        frameWith({ acceleration: raw, screenOrientation: key }),
        null,
      );
      const [x, y, z] = expected[key];
      expect([acceleration.x, acceleration.y, acceleration.z].map(Math.round)).toEqual([x, y, z]);
    }
  });
});

describe('angular velocity signs', () => {
  const rate = { alpha: 5, beta: 7, gamma: 11 };

  it('follows the table for all four orientations', () => {
    const expected: Record<ScreenOrientationValue, { pitch: number; yaw: number; roll: number }> = {
      0: { pitch: 7, yaw: -11, roll: -5 },
      1: { pitch: -11, yaw: -7, roll: -5 },
      2: { pitch: -7, yaw: 11, roll: -5 },
      3: { pitch: 11, yaw: 7, roll: -5 },
    };
    for (const key of [0, 1, 2, 3] as ScreenOrientationValue[]) {
      const { angularVelocity } = normalize(
        frameWith({ rotationRate: rate, screenOrientation: key }),
        null,
      );
      expect(Math.round(angularVelocity.pitch)).toBe(expected[key].pitch);
      expect(Math.round(angularVelocity.yaw)).toBe(expected[key].yaw);
      expect(Math.round(angularVelocity.roll)).toBe(expected[key].roll);
    }
  });

  it('reports a positive yaw rate when the phone is swept to the right', () => {
    // Aiming right is a negative rotation about canonical +Y, which in the
    // canonical pose is the device x axis: rotationRate.beta goes negative.
    const { angularVelocity } = normalize(
      frameWith({ rotationRate: { alpha: 0, beta: -60, gamma: 0 } }),
      null,
    );
    expect(angularVelocity.yaw).toBeGreaterThan(0);
  });

  it('reports the roll rate as the screen rotation axis in every orientation', () => {
    for (const key of [0, 1, 2, 3] as ScreenOrientationValue[]) {
      const { angularVelocity } = normalize(
        frameWith({ rotationRate: { alpha: 30, beta: 0, gamma: 0 }, screenOrientation: key }),
        null,
      );
      expect(angularVelocity.roll).toBeCloseTo(-30, 5);
    }
  });
});

describe('canonical orientation angles', () => {
  // Landscape-primary, level, aiming north: derived in ARCHITECTURE.md 5.7.
  const ANCHOR = { alpha: 90, beta: 0, gamma: -90 };

  it('reads the canonical pose as all zeros', () => {
    const angles = orientationToCanonical(ANCHOR.alpha, ANCHOR.beta, ANCHOR.gamma, 90);
    expect(angles.pitch).toBeCloseTo(0, 6);
    expect(angles.roll).toBeCloseTo(0, 6);
    expect(angles.yaw).toBeCloseTo(0, 6);
  });

  it('gives pitch + when the phone aims up', () => {
    const up = orientationToCanonical(ANCHOR.alpha, ANCHOR.beta, ANCHOR.gamma - 20, 90);
    expect(up.pitch).toBeCloseTo(20, 4);
    const down = orientationToCanonical(ANCHOR.alpha, ANCHOR.beta, ANCHOR.gamma + 20, 90);
    expect(down.pitch).toBeCloseTo(-20, 4);
  });

  it('gives roll + when the right edge dips', () => {
    const right = orientationToCanonical(ANCHOR.alpha, ANCHOR.beta + 25, ANCHOR.gamma, 90);
    expect(right.roll).toBeCloseTo(25, 4);
    const left = orientationToCanonical(ANCHOR.alpha, ANCHOR.beta - 25, ANCHOR.gamma, 90);
    expect(left.roll).toBeCloseTo(-25, 4);
  });

  it('gives yaw + when the aim swings right', () => {
    // alpha grows counter-clockwise seen from above, which aims left.
    const left = orientationToCanonical(ANCHOR.alpha + 30, ANCHOR.beta, ANCHOR.gamma, 90);
    expect(left.yaw).toBeCloseTo(-30, 4);
    const right = orientationToCanonical(ANCHOR.alpha - 30, ANCHOR.beta, ANCHOR.gamma, 90);
    expect(right.yaw).toBeCloseTo(30, 4);
  });

  it('keeps pitch and roll independent of the screen orientation value used', () => {
    // Portrait-primary held upright and aiming north: alpha 0, beta 90, gamma 0.
    const portrait = orientationToCanonical(0, 90, 0, 0);
    expect(portrait.pitch).toBeCloseTo(0, 4);
    expect(portrait.roll).toBeCloseTo(0, 4);
  });
});

describe('frame timing', () => {
  it('reports dt in seconds against the previous frame', () => {
    expect(normalize(frameWith({ timestamp: 1016 }), 1000).dt).toBeCloseTo(0.016, 6);
  });

  it('reports zero for the first frame', () => {
    expect(normalize(frameWith(), null).dt).toBe(0);
  });

  it('reports zero when the phone clock goes backwards', () => {
    expect(normalize(frameWith({ timestamp: 900 }), 1000).dt).toBe(0);
  });

  it('carries player, seq and buttons through untouched', () => {
    const canonical = normalize(
      frameWith({ playerId: 3, seq: 77, buttons: 5, screenOrientation: LANDSCAPE_PRIMARY }),
      null,
    );
    expect(canonical.playerId).toBe(3);
    expect(canonical.seq).toBe(77);
    expect(canonical.buttons).toBe(5);
  });
});

describe('a forward swing', () => {
  it('peaks along canonical -Z in the canonical pose', () => {
    // Thrusting the phone away from the player accelerates it along -Z.
    const { acceleration } = normalize(
      frameWith({ acceleration: { x: 0, y: 0, z: -25 } }),
      null,
    );
    expect(acceleration.z).toBeCloseTo(-25);
    expect(Math.abs(acceleration.x)).toBeLessThan(1e-9);
    expect(Math.abs(acceleration.y)).toBeLessThan(1e-9);
  });
});
