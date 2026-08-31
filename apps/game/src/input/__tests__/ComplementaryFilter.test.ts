import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSensor, parseTrace } from '@phonemote/protocol';
import { ComplementaryFilter, angleDifference } from '../ComplementaryFilter.js';
import { normalize } from '../SensorNormalizer.js';
import type { CanonicalAngles, CanonicalSensorFrame } from '../types.js';

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

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../traces/corpus');

function canonicalTrace(name: string): CanonicalSensorFrame[] {
  const trace = parseTrace(readFileSync(join(CORPUS, name), 'utf8'));
  const frames: CanonicalSensorFrame[] = [];
  let previousTimestamp: number | null = null;
  for (const encoded of trace.frames) {
    const raw = decodeSensor(encoded);
    frames.push(normalize(raw, previousTimestamp));
    previousTimestamp = raw.timestamp;
  }
  return frames;
}

/**
 * Per frame, everything the filter added on top of dead reckoning: the pull
 * towards gravity and nothing else. That is the part a player sees as a jump —
 * the rest of the frame's movement is the phone actually turning.
 */
function correctionsInjectedDeg(name: string): number[] {
  const filter = new ComplementaryFilter();
  const injected: number[] = [];
  let previous: CanonicalAngles | null = null;

  for (const canonical of canonicalTrace(name)) {
    const before = previous;
    const after = filter.update(canonical);
    previous = after;
    if (before === null || canonical.dt <= 0) continue;

    const gyroPitch = before.pitch + canonical.angularVelocity.pitch * canonical.dt;
    const gyroRoll = before.roll + canonical.angularVelocity.roll * canonical.dt;
    injected.push(Math.max(Math.abs(after.pitch - gyroPitch), Math.abs(after.roll - gyroRoll)));
  }
  return injected;
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

/**
 * The correction used to be spent once per sample, which made the filter's time
 * constant whatever the frame rate happened to be: a 30 degree step in the
 * gravity reference took 367 ms to close nine tenths of itself at 60 Hz, but
 * 1100 ms at 20 Hz and 2200 ms at 10 Hz. The device recordings arrive at about
 * 19 Hz, so the figure in the class comment described a rate no phone ran at.
 */
const STEP_DEG = 30;
const STEP_90_AT_60HZ_MS = 367;

function stepResponse90Ms(dt: number): number {
  const filter = new ComplementaryFilter();
  const stepped = { yaw: 0, pitch: STEP_DEG, roll: 0 };
  filter.update(frame({ dt: 0 }));

  for (let frames = 1; frames <= 10_000; frames++) {
    if (filter.update(frame({ dt, orientation: stepped })).pitch >= STEP_DEG * 0.9) {
      return frames * dt * 1000;
    }
  }
  throw new Error('the step never closed');
}

describe.each([
  { hz: 120, dt: 1 / 120 },
  { hz: 60, dt: 1 / 60 },
  { hz: 20, dt: 1 / 20 },
  { hz: 10, dt: 1 / 10 },
])('a phone streaming at $hz Hz', ({ dt }) => {
  it('recovers from a step in gravity in the time the documentation claims', () => {
    const elapsed = stepResponse90Ms(dt);
    expect(elapsed).toBeGreaterThan(STEP_90_AT_60HZ_MS * 0.85);
    expect(elapsed).toBeLessThan(STEP_90_AT_60HZ_MS * 1.15);
  });
});

describe('the 60 Hz behaviour the weight was tuned at', () => {
  it('still spends exactly the old share of the disagreement, to the last bit', () => {
    const filter = new ComplementaryFilter({ gyroWeight: 0.9 });
    filter.update(frame({ dt: 0 }));
    const corrected = filter.update(frame({ orientation: { yaw: 0, pitch: 30, roll: 0 } }));
    expect(corrected.pitch).toBe(30 * (1 - 0.9));
  });
});

describe('gravity while the phone is being thrown around', () => {
  it('is ignored outright above the rate a swing runs at', () => {
    const filter = new ComplementaryFilter();
    filter.update(frame({ dt: 0 }));

    // A real swing peaks at 300-1211 deg/s. Nothing the accelerometer reports
    // there is gravity, so the pose is the gyro's alone.
    const swinging = filter.update(
      frame({
        orientation: { yaw: 0, pitch: 20, roll: 0 },
        angularVelocity: { yaw: 400, pitch: 0, roll: 0 },
      }),
    );
    expect(swinging.pitch).toBe(0);
  });

  it('counts for less the faster the phone is turning', () => {
    const still = new ComplementaryFilter();
    const turning = new ComplementaryFilter();
    still.update(frame({ dt: 0 }));
    turning.update(frame({ dt: 0 }));

    const seen = { yaw: 0, pitch: 20, roll: 0 };
    const calm = still.update(frame({ orientation: seen })).pitch;
    // 150 deg/s about the aiming axis moves pitch not at all, so the whole
    // difference between these two is the gate rather than the integration.
    const brisk = turning.update(
      frame({ orientation: seen, angularVelocity: { yaw: 0, pitch: 0, roll: 150 } }),
    ).pitch;

    expect(calm).toBeCloseTo(2, 6);
    expect(brisk).toBeCloseTo(calm * (1 - 150 / 200), 6);
  });

  it('is taken back on a ramp rather than in one jump once the phone settles', () => {
    const filter = new ComplementaryFilter();
    filter.update(frame({ dt: 0 }));
    // Three frames of a swing at the rate the recordings arrive at. Yaw does not
    // feed the pitch integration, so the pose sits still while the gate shuts.
    for (let i = 0; i < 3; i++) {
      filter.update(frame({ dt: 1 / 20, angularVelocity: { yaw: 800, pitch: 0, roll: 0 } }));
    }

    // The phone stops 45 degrees away from where the pose thinks it is, which is
    // the disagreement measured at the peak of real-swing.pmtrace.
    const settled = { yaw: 0, pitch: 45, roll: 0 };
    expect(filter.update(frame({ dt: 1 / 20, orientation: settled })).pitch).toBeLessThan(1);

    // It still gets there. It just does not arrive all at once.
    for (let i = 0; i < 100; i++) filter.update(frame({ dt: 1 / 20, orientation: settled }));
    expect(filter.update(frame({ dt: 1 / 20, orientation: settled })).pitch).toBeCloseTo(45, 1);
  });
});

describe('a swing recorded on a real phone', () => {
  it('never moves the pose a whole degree towards gravity in one frame', () => {
    // The fixed gain put 4.6 degrees into a single frame, on the sample where the
    // swing reversed and the accelerometer was worth the least.
    const injected = correctionsInjectedDeg('real-swing.pmtrace');
    expect(injected).not.toHaveLength(0);
    expect(Math.max(...injected)).toBeLessThan(1);
  });

  it('leaves the pose to the gyro through the burst itself', () => {
    // Three consecutive frames above 300 deg/s, and for those gravity contributes
    // nothing at all rather than a little of something wrong.
    const untouched = correctionsInjectedDeg('real-swing.pmtrace').filter((deg) => deg === 0);
    expect(untouched.length).toBeGreaterThanOrEqual(3);
  });
});

describe('a phone held still, recorded on a real phone', () => {
  it('goes on correcting every frame, because nothing there is dynamic', () => {
    // A hand trying to hold still averages 3.34 deg/s against a 200 deg/s gate,
    // so the gate has to be invisible in this trace.
    const injected = correctionsInjectedDeg('real-rest.pmtrace');
    expect(injected.every((deg) => deg > 0)).toBe(true);
    expect(Math.max(...injected)).toBeLessThan(0.5);
  });
});
