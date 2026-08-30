import { describe, expect, it } from 'vitest';
import {
  BUTTON,
  SENSOR_FLAG,
  SENSOR_FRAME_BYTES,
  SENSOR_FRAME_BYTES_V1,
  SENSOR_FRAME_VERSION,
} from '../constants.js';
import { decodeSensor, encodeSensor, MalformedSensorFrameError } from '../binary.js';
import type { ScreenOrientationValue, SensorFrame } from '../frame.js';

/**
 * float32 carries ~7 significant digits, so the error scales with magnitude:
 * a fixed number of decimal places would pass for angles and fail for
 * millisecond timestamps. Compare relatively instead.
 */
function expectFloat32Equal(actual: number, expected: number): void {
  const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-6);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function makeFrame(overrides: Partial<SensorFrame> = {}): SensorFrame {
  return {
    playerId: 2,
    seq: 12345,
    timestamp: 98765.5,
    orientation: { alpha: 123.25, beta: -45.5, gamma: 89.125 },
    rotationRate: { alpha: -12.5, beta: 250.75, gamma: -0.5 },
    acceleration: { x: 1.5, y: -9.25, z: 0.125 },
    buttons: BUTTON.A | BUTTON.TRIGGER,
    screenOrientation: 1,
    version: SENSOR_FRAME_VERSION,
    motionSeq: 4242,
    flags: SENSOR_FLAG.LINEAR_ACCEL | SENSOR_FLAG.ROTATION_RATE | SENSOR_FLAG.ORIENTATION,
    ...overrides,
  };
}

function expectFrameEqual(actual: SensorFrame, expected: SensorFrame): void {
  expect(actual.playerId).toBe(expected.playerId);
  expect(actual.seq).toBe(expected.seq);
  expect(actual.buttons).toBe(expected.buttons);
  expect(actual.screenOrientation).toBe(expected.screenOrientation);
  expect(actual.motionSeq).toBe(expected.motionSeq);
  expect(actual.flags).toBe(expected.flags);
  expectFloat32Equal(actual.timestamp, expected.timestamp);
  for (const axis of ['alpha', 'beta', 'gamma'] as const) {
    expectFloat32Equal(actual.orientation[axis], expected.orientation[axis]);
    expectFloat32Equal(actual.rotationRate[axis], expected.rotationRate[axis]);
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    expectFloat32Equal(actual.acceleration[axis], expected.acceleration[axis]);
  }
}

describe('sensor frame codec', () => {
  it('encodes to exactly 68 bytes', () => {
    expect(encodeSensor(makeFrame()).byteLength).toBe(SENSOR_FRAME_BYTES);
    expect(SENSOR_FRAME_BYTES).toBe(68);
  });

  it('stamps the current format version', () => {
    expect(decodeSensor(encodeSensor(makeFrame())).version).toBe(SENSOR_FRAME_VERSION);
  });

  it('still decodes a v1 frame from an old recording', () => {
    // Same layout, truncated: the fields v1 never had take honest defaults.
    const v2 = encodeSensor(makeFrame({ seq: 99 }));
    const v1 = v2.slice(0, SENSOR_FRAME_BYTES_V1);

    const decoded = decodeSensor(v1);
    expect(decoded.version).toBe(1);
    expect(decoded.seq).toBe(99);
    expect(decoded.flags).toBe(0);
    // No event counter existed, so it cannot claim to detect a stall.
    expect(decoded.motionSeq).toBe(99);
  });

  it('round-trips a frame', () => {
    const frame = makeFrame();
    expectFrameEqual(decodeSensor(encodeSensor(frame)), frame);
  });

  it('round-trips every screen orientation', () => {
    for (const value of [0, 1, 2, 3] as ScreenOrientationValue[]) {
      const frame = makeFrame({ screenOrientation: value });
      expect(decodeSensor(encodeSensor(frame)).screenOrientation).toBe(value);
    }
  });

  it('round-trips every button combination', () => {
    const all = Object.values(BUTTON).reduce((mask, bit) => mask | bit, 0);
    for (let buttons = 0; buttons <= all; buttons++) {
      const decoded = decodeSensor(encodeSensor(makeFrame({ buttons })));
      expect(decoded.buttons).toBe(buttons);
    }
  });

  it('round-trips randomised frames', () => {
    let seed = 42;
    const random = (): number => {
      // Deterministic LCG: a failing case must be reproducible.
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 500; i++) {
      const frame = makeFrame({
        playerId: 1 + Math.floor(random() * 4),
        seq: Math.floor(random() * 100000),
        timestamp: random() * 1e6,
        orientation: {
          alpha: random() * 360,
          beta: random() * 360 - 180,
          gamma: random() * 180 - 90,
        },
        rotationRate: {
          alpha: random() * 2000 - 1000,
          beta: random() * 2000 - 1000,
          gamma: random() * 2000 - 1000,
        },
        acceleration: { x: random() * 80 - 40, y: random() * 80 - 40, z: random() * 80 - 40 },
      });
      expectFrameEqual(decodeSensor(encodeSensor(frame)), frame);
    }
  });

  it('keeps seq exact up to the float32 integer limit', () => {
    const seq = (1 << 24) - 1;
    expect(decodeSensor(encodeSensor(makeFrame({ seq }))).seq).toBe(seq);
  });

  it('rejects a buffer of the wrong size', () => {
    expect(() => decodeSensor(new ArrayBuffer(55))).toThrow(MalformedSensorFrameError);
    expect(() => decodeSensor(new ArrayBuffer(64))).toThrow(MalformedSensorFrameError);
    expect(() => decodeSensor(new ArrayBuffer(0))).toThrow(MalformedSensorFrameError);
  });

  it('rejects an unknown screen orientation', () => {
    const buffer = encodeSensor(makeFrame());
    new DataView(buffer).setFloat32(13 * 4, 7, true);
    expect(() => decodeSensor(buffer)).toThrow(MalformedSensorFrameError);
  });
});
