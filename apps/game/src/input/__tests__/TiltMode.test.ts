import { describe, expect, it } from 'vitest';
import { TiltMode } from '../TiltMode.js';
import type { CanonicalSensorFrame } from '../types.js';

function frame(pitch: number, roll: number): CanonicalSensorFrame {
  return {
    playerId: 1,
    seq: 0,
    timestamp: 0,
    dt: 1 / 60,
    orientation: { yaw: 0, pitch, roll },
    angularVelocity: { yaw: 0, pitch: 0, roll: 0 },
    acceleration: { x: 0, y: 0, z: 0 },
    buttons: 0,
  };
}

describe('tilt axes', () => {
  it('maps roll to x and pitch to y', () => {
    const tilt = new TiltMode({ deadzone: 0 });
    expect(tilt.update(frame(0, 45)).x).toBeCloseTo(1, 6);
    expect(tilt.update(frame(45, 0)).y).toBeCloseTo(1, 6);
    expect(tilt.update(frame(0, -45)).x).toBeCloseTo(-1, 6);
  });

  it('clamps past the range', () => {
    const tilt = new TiltMode({ deadzone: 0 });
    expect(tilt.update(frame(0, 90)).x).toBe(1);
    expect(tilt.update(frame(-90, 0)).y).toBe(-1);
  });

  it('honours a custom range', () => {
    const tilt = new TiltMode({ rangeDeg: 20, deadzone: 0 });
    expect(tilt.update(frame(0, 10)).x).toBeCloseTo(0.5, 6);
  });

  it('ignores tilt inside the deadzone and still reaches full deflection', () => {
    const tilt = new TiltMode({ rangeDeg: 100, deadzone: 0.1 });
    expect(tilt.update(frame(0, 9)).x).toBe(0);
    expect(tilt.update(frame(0, 11)).x).toBeGreaterThan(0);
    expect(tilt.update(frame(0, 100)).x).toBeCloseTo(1, 6);
  });

  it('softens small tilts with an exponent', () => {
    const linear = new TiltMode({ deadzone: 0, exponent: 1 });
    const curved = new TiltMode({ deadzone: 0, exponent: 2 });
    const half = frame(0, 22.5);
    expect(curved.update(half).x).toBeLessThan(linear.update(half).x);
    // The extremes must still line up.
    expect(curved.update(frame(0, 45)).x).toBeCloseTo(1, 6);
  });

  it('treats the calibrated pose as centre', () => {
    const tilt = new TiltMode({ deadzone: 0 });
    tilt.calibrate(frame(10, -15));
    expect(tilt.update(frame(10, -15))).toEqual({ x: 0, y: 0 });
    expect(tilt.update(frame(10, 30)).x).toBeCloseTo(1, 6);
    tilt.reset();
    expect(tilt.update(frame(10, -15)).y).toBeCloseTo(10 / 45, 6);
  });
});
