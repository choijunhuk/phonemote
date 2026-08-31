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
    up: { x: 0, y: 1, z: 0 },
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

/** Feeds a steady yaw rate at whatever interval the phone happens to deliver. */
function hold(pointer: PointerMode, yaw: number, dt: number, frames: number): void {
  for (let i = 0; i < frames; i++) {
    pointer.update(frame({ dt, angularVelocity: { yaw, pitch: 0, roll: 0 } }));
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

  it('travels the same distance on a real phone stream as on a 60 Hz one', () => {
    // The recorded phone delivers a frame every 51-55 ms, not every 16.7 ms.
    // Both of these are 1.1 seconds of the same 20 deg/s turn, so the hand has
    // gone the same distance and the cursor has to agree.
    const fast = new PointerMode();
    hold(fast, 20, 1 / 60, 66);
    const slow = new PointerMode();
    hold(slow, 20, 0.055, 20);

    expect(slow.position.x).toBeCloseTo(fast.position.x, 6);
    // 22 degrees of a 60 degree sweep, from the centre.
    expect(slow.position.x).toBeCloseTo(0.5 + 22 / 60, 6);
  });

  it('does not lurch when the phone goes quiet for two seconds', () => {
    const pointer = new PointerMode();
    hold(pointer, 0, 0.05, 10);
    const before = pointer.position;

    // A backgrounded tab hands the whole gap to the next frame it sends. 14
    // deg/s is the fastest a hand trying to hold still was measured turning,
    // and two seconds of that integrated whole throws the cursor 0.47 of the
    // screen away from where the player left it.
    pointer.update(frame({ dt: 2, angularVelocity: { yaw: 14, pitch: 14, roll: 0 } }));

    const after = pointer.position;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.05);
  });
});

describe('pointer deadzone hysteresis', () => {
  it('keeps following a hand that eases off without stopping', () => {
    const pointer = new PointerMode();
    hold(pointer, 3, 0.05, 20);
    const beforeEasingOff = pointer.position.x;

    // Still turning, just slower than the deadzone. Dropping the cursor here
    // is what makes a slow, careful aim feel like it keeps catching.
    hold(pointer, 1.6, 0.05, 20);

    expect(pointer.position.x).toBeGreaterThan(beforeEasingOff);
  });

  it('stops once the hand really has settled', () => {
    const pointer = new PointerMode();
    hold(pointer, 3, 0.05, 20);
    hold(pointer, 1, 0.05, 40);
    const settled = pointer.position.x;

    hold(pointer, 1, 0.05, 20);

    expect(pointer.position.x).toBe(settled);
  });

  it('needs the full deadzone again after a re-centre', () => {
    const pointer = new PointerMode();
    hold(pointer, 3, 0.05, 20);
    pointer.reset();

    // 1.6 deg/s would hold an already-open gate open, but it has never been
    // enough to open one.
    hold(pointer, 1.6, 0.05, 20);

    expect(pointer.position).toEqual({ x: 0.5, y: 0.5 });
  });
});
