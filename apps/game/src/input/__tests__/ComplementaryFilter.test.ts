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

// TEMP MEASUREMENT BLOCK
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { decodeSensor, parseTrace } from '@phonemote/protocol';
import { normalize } from '../SensorNormalizer.js';

const here2 = dirname(fileURLToPath(import.meta.url));
const CORPUS2 = resolve(here2, '../../../../../traces/corpus');

function canonicalFrames(name: string): CanonicalSensorFrame[] {
  const trace = parseTrace(readFileSync(join(CORPUS2, name), 'utf8'));
  const out: CanonicalSensorFrame[] = [];
  let previous: number | null = null;
  for (const encoded of trace.frames) {
    const raw = decodeSensor(encoded);
    out.push(normalize(raw, previous));
    previous = raw.timestamp;
  }
  return out;
}

describe('TEMP measurements', () => {
  it('step response at several rates', () => {
    for (const dt of [1 / 120, 1 / 60, 1 / 20, 1 / 10]) {
      const filter = new ComplementaryFilter();
      filter.update(frame({ dt: 0, orientation: { yaw: 0, pitch: 0, roll: 0 } }));
      let n = 0;
      for (; n < 5000; n++) {
        const r = filter.update(frame({ dt, orientation: { yaw: 0, pitch: 30, roll: 0 } }));
        if (r.pitch >= 27) break;
      }
      console.log(`dt=${dt.toFixed(5)} frames=${n + 1} time=${((n + 1) * dt * 1000).toFixed(1)}ms`);
    }
  });

  it('tail detail', () => {
    for (const name of ['real-swing.pmtrace', 'phone-on-table.pmtrace']) {
      const frames = canonicalFrames(name);
      const filter = new ComplementaryFilter({ trustRecoverySeconds: 3 });
      let previous: { yaw: number; pitch: number; roll: number } | null = null;
      const rows: string[] = [];
      for (const f of frames) {
        const before = previous;
        const after = filter.update(f);
        if (before && f.dt > 0 && f.dt <= 0.25) {
          const gyroPitch = before.pitch + f.angularVelocity.pitch * f.dt;
          const gyroRoll = before.roll + f.angularVelocity.roll * f.dt;
          const ip = Math.abs(after.pitch - gyroPitch);
          const ir = Math.abs(after.roll - gyroRoll);
          const w = Math.hypot(f.angularVelocity.yaw, f.angularVelocity.pitch, f.angularVelocity.roll);
          const dp = after.pitch - f.orientation.pitch;
          const dr = after.roll - f.orientation.roll;
          rows.push(`  w=${w.toFixed(0).padStart(5)} err=${Math.hypot(dp, dr).toFixed(1).padStart(6)} inj=${Math.max(ip, ir).toFixed(2).padStart(6)}`);
        }
        previous = after;
      }
      console.log(name + String.fromCharCode(10) + rows.slice(-16).join(String.fromCharCode(10)));
    }
  });
});
