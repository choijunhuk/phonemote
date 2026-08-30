import { describe, expect, it } from 'vitest';
import { ComplementaryFilter, angleDifference } from '../ComplementaryFilter.js';
import type { CanonicalSensorFrame } from '../types.js';

function frame(
  overrides: Partial<CanonicalSensorFrame> & { dt?: number } = {},
): CanonicalSensorFrame {
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

describe('angle difference', () => {
  it('takes the short way round', () => {
    expect(angleDifference(170, -170)).toBeCloseTo(20, 6);
    expect(angleDifference(-170, 170)).toBeCloseTo(-20, 6);
    expect(angleDifference(0, 90)).toBeCloseTo(90, 6);
  });
});

describe('fusion', () => {
  it('adopts the absolute pose on the first frame', () => {
    const filter = new ComplementaryFilter();
    const result = filter.update(frame({ dt: 0, orientation: { yaw: 0, pitch: 12, roll: -30 } }));
    expect(result.pitch).toBe(12);
    expect(result.roll).toBe(-30);
  });

  it('rides out a one-frame spike in the absolute reading', () => {
    const filter = new ComplementaryFilter();
    const steady = { yaw: 0, pitch: 10, roll: 0 };
    for (let i = 0; i < 30; i++) filter.update(frame({ orientation: steady }));

    // A hard shake throws the gravity-derived pitch 60 degrees off for a frame.
    // Most of that has to be absorbed rather than passed through.
    const spiked = filter.update(frame({ orientation: { yaw: 0, pitch: 70, roll: 0 } }));
    expect(spiked.pitch - 10).toBeLessThan(60 * 0.2);
    expect(spiked.pitch).toBeGreaterThan(9);
  });

  it('converges on a sustained change', () => {
    const filter = new ComplementaryFilter();
    filter.update(frame({ dt: 0, orientation: { yaw: 0, pitch: 0, roll: 0 } }));
    for (let i = 0; i < 600; i++) {
      filter.update(frame({ orientation: { yaw: 0, pitch: 40, roll: 0 } }));
    }
    expect(filter.update(frame({ orientation: { yaw: 0, pitch: 40, roll: 0 } })).pitch).toBeCloseTo(
      40,
      1,
    );
  });

  it('follows the gyro between absolute updates', () => {
    const filter = new ComplementaryFilter({ gyroWeight: 1 });
    filter.update(frame({ dt: 0 }));
    for (let i = 0; i < 60; i++) {
      filter.update(frame({ angularVelocity: { yaw: 0, pitch: 30, roll: 0 } }));
    }
    // Pure gyro: one second at 30 deg/s.
    expect(filter.update(frame({ angularVelocity: { yaw: 0, pitch: 0, roll: 0 } })).pitch).toBeCloseTo(
      30,
      1,
    );
  });

  it('integrates yaw and ignores the absolute heading', () => {
    const filter = new ComplementaryFilter();
    filter.update(frame({ dt: 0 }));
    for (let i = 0; i < 60; i++) {
      // Absolute yaw wanders, as Chrome's relative alpha does.
      filter.update(
        frame({
          orientation: { yaw: i * 3, pitch: 0, roll: 0 },
          angularVelocity: { yaw: 45, pitch: 0, roll: 0 },
        }),
      );
    }
    expect(filter.update(frame()).yaw).toBeCloseTo(45, 0);
  });

  it('starts over after a stall in the stream', () => {
    const filter = new ComplementaryFilter();
    filter.update(frame({ dt: 0, orientation: { yaw: 0, pitch: 10, roll: 0 } }));
    for (let i = 0; i < 60; i++) {
      filter.update(frame({ angularVelocity: { yaw: 90, pitch: 0, roll: 0 } }));
    }
    expect(filter.update(frame()).yaw).toBeGreaterThan(80);

    // A two second gap: the phone was asleep, the integration is worthless.
    const afterGap = filter.update(frame({ dt: 2, orientation: { yaw: 0, pitch: 33, roll: 0 } }));
    expect(afterGap.yaw).toBe(0);
    expect(afterGap.pitch).toBe(33);
  });
});
