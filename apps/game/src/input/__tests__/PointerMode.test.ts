import { describe, expect, it } from 'vitest';
import { DEFAULT_POINTER_SENSITIVITY, PointerMode } from '../PointerMode.js';
import type { CanonicalSensorFrame } from '../types.js';

function frame(overrides: Partial<CanonicalSensorFrame> = {}): CanonicalSensorFrame {
  return {
    playerId: 1,
    seq: 0,
    timestamp: 0,
    dt: 1 / 60,
    orientation: { yaw: 0, pitch: 0, roll: 0 },
    angularVelocity: { yaw: 0, pitch: 0, roll: 0 },
    acceleration: { x: 0, y: 0, z: 0 },
    buttons: 0,
    ...overrides,
  };
}

/** Feeds one second of a steady rate at 60 Hz. */
function sweep(pointer: PointerMode, yaw: number, pitch: number): void {
  for (let i = 0; i < 60; i++) {
    pointer.update(frame({ angularVelocity: { yaw, pitch, roll: 0 } }));
  }
}

describe('pointer integration', () => {
  it('crosses half the screen when swept 30 deg to the right in one second', () => {
    const pointer = new PointerMode();
    sweep(pointer, 30, 0);
    expect(pointer.position.x).toBeCloseTo(1, 2);
    expect(pointer.position.y).toBeCloseTo(0.5, 6);
  });

  it('moves left for a negative yaw rate', () => {
    const pointer = new PointerMode();
    sweep(pointer, -30, 0);
    expect(pointer.position.x).toBeCloseTo(0, 2);
  });

  it('moves the cursor up when aiming up', () => {
    const pointer = new PointerMode();
    sweep(pointer, 0, 15);
    // Screen y grows downwards, so aiming up must decrease it.
    expect(pointer.position.y).toBeLessThan(0.5);
    expect(pointer.position.y).toBeCloseTo(0.25, 2);
  });

  it('honours a custom sensitivity', () => {
    const pointer = new PointerMode({ sensitivity: DEFAULT_POINTER_SENSITIVITY / 2 });
    sweep(pointer, 30, 0);
    expect(pointer.position.x).toBeCloseTo(0.75, 2);
  });

  it('ignores rates inside the deadzone', () => {
    const pointer = new PointerMode();
    sweep(pointer, 1.9, 1.9);
    expect(pointer.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('acts on rates just outside the deadzone', () => {
    const pointer = new PointerMode();
    sweep(pointer, 2.1, 0);
    expect(pointer.position.x).toBeGreaterThan(0.5);
  });

  it('clamps at the screen edges', () => {
    const pointer = new PointerMode();
    sweep(pointer, 400, 400);
    expect(pointer.position.x).toBe(1);
    expect(pointer.position.y).toBe(0);
    sweep(pointer, -400, -400);
    expect(pointer.position.x).toBe(0);
    expect(pointer.position.y).toBe(1);
  });

  it('returns to the centre on reset', () => {
    const pointer = new PointerMode();
    sweep(pointer, 30, 10);
    pointer.reset();
    expect(pointer.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('does not move on a frame with no elapsed time', () => {
    const pointer = new PointerMode();
    pointer.update(frame({ dt: 0, angularVelocity: { yaw: 500, pitch: 500, roll: 0 } }));
    expect(pointer.position).toEqual({ x: 0.5, y: 0.5 });
  });
});
