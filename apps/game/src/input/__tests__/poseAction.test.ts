import { describe, expect, it } from 'vitest';
import { SENSOR_FLAG, SENSOR_FRAME_VERSION, type SensorFrame } from '@phonemote/protocol';
import { InputMapper } from '../InputMapper.js';
import { POSES, angleBetweenDeg, poseByKey } from '../pose.js';
import type { CanonicalVector } from '../types.js';

/**
 * The pose action end to end: a frame shaped like one a phone sends, through
 * the mapper, to the vector a game judges against.
 *
 * pose.test.ts checks the maths in isolation. This checks the wiring, which is
 * where a game can fail every round while every helper still passes.
 */

let motionSeq = 0;

function frame(beta: number, gamma: number, alpha = 90): SensorFrame {
  motionSeq++;
  return {
    playerId: 1,
    seq: motionSeq,
    timestamp: motionSeq * 16,
    orientation: { alpha, beta, gamma },
    rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    acceleration: { x: 0, y: 0, z: 0 },
    buttons: 0,
    screenOrientation: 1,
    version: SENSOR_FRAME_VERSION,
    motionSeq,
    flags: SENSOR_FLAG.LINEAR_ACCEL | SENSOR_FLAG.ROTATION_RATE | SENSOR_FLAG.ORIENTATION,
  };
}

function upFrom(beta: number, gamma: number, alpha = 90): CanonicalVector {
  const mapper = new InputMapper({ pose: true });
  mapper.update(frame(beta, gamma, alpha));
  const actions = mapper.update(frame(beta, gamma, alpha));
  const pose = actions.find((action) => action.kind === 'pose');
  if (pose?.kind !== 'pose') throw new Error('no pose action was emitted');
  return pose.up;
}

describe('the pose action', () => {
  it('is emitted when a game asks for it', () => {
    const mapper = new InputMapper({ pose: true });
    mapper.update(frame(0, -90));
    expect(mapper.update(frame(0, -90)).some((action) => action.kind === 'pose')).toBe(true);
  });

  it('is not emitted when a game does not', () => {
    const mapper = new InputMapper({ swing: true });
    mapper.update(frame(0, -90));
    expect(mapper.update(frame(0, -90)).some((action) => action.kind === 'pose')).toBe(false);
  });

  it('reports level as the level pose', () => {
    const up = upFrom(0, -90);
    const level = poseByKey('level');
    expect(level).toBeDefined();
    expect(angleBetweenDeg(level?.up ?? up, up)).toBeLessThan(5);
  });

  it('is unaffected by which way the player is facing', () => {
    // alpha is the compass-ish angle; poses must not depend on it.
    const facingOneWay = upFrom(0, -90, 0);
    const facingAnother = upFrom(0, -90, 200);
    expect(angleBetweenDeg(facingOneWay, facingAnother)).toBeLessThan(1);
  });

  it('matches each named pose when the phone is actually in it', () => {
    // beta rolls the phone, gamma swings the aim up and down, from the
    // canonical landscape hold (ARCHITECTURE.md 5.7).
    const cases: ReadonlyArray<{ key: string; beta: number; gamma: number }> = [
      { key: 'level', beta: 0, gamma: -90 },
      { key: 'tilt-right', beta: 90, gamma: -90 },
      { key: 'tilt-left', beta: -90, gamma: -90 },
      { key: 'aim-up', beta: 0, gamma: -180 },
      { key: 'aim-down', beta: 0, gamma: 0 },
      { key: 'diagonal-right', beta: 45, gamma: -90 },
      { key: 'diagonal-left', beta: -45, gamma: -90 },
    ];

    for (const { key, beta, gamma } of cases) {
      const expected = poseByKey(key);
      expect(expected, key).toBeDefined();
      const measured = upFrom(beta, gamma);
      expect(angleBetweenDeg(expected?.up ?? measured, measured), key).toBeLessThan(10);
    }
  });

  it('finds exactly one matching pose for each of those holds', () => {
    // If two poses answered to the same hold, a round would be unwinnable for
    // reasons the player could never see.
    const measured = upFrom(0, -90);
    const matches = POSES.filter((pose) => angleBetweenDeg(pose.up, measured) < 35);
    expect(matches.map((pose) => pose.key)).toEqual(['level']);
  });
});
