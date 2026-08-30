import { describe, expect, it } from 'vitest';
import {
  SWING_CAPTURE_WINDOW_MS,
  SWING_COOLDOWN_MS,
  SWING_MAX,
  SWING_MIN_WINDOW_MS,
  SWING_QUIET_MS,
  SWING_THRESHOLD,
  SwingDetector,
  direction8Of,
  swingStrength,
} from '../SwingDetector.js';
import type { CanonicalSensorFrame, CanonicalVector, GameAction } from '../types.js';
import type { SwingEvent as DetectorEvent } from '../SwingDetector.js';

function frame(timestamp: number, acceleration: CanonicalVector): CanonicalSensorFrame {
  return {
    playerId: 1,
    seq: 0,
    timestamp,
    dt: 1 / 60,
    orientation: { yaw: 0, pitch: 0, roll: 0 },
    up: { x: 0, y: 1, z: 0 },
    angularVelocity: { yaw: 0, pitch: 0, roll: 0 },
    acceleration,
    buttons: 0,
  };
}

const STILL: CanonicalVector = { x: 0, y: 0, z: 0 };

/** One swing: a burst that peaks at `peak`, then the arm settles. */
function swingOnce(
  detector: SwingDetector,
  startAt: number,
  peak: number,
  axis: CanonicalVector = { x: 0, y: 0, z: -1 },
): DetectorEvent[] {
  const events: DetectorEvent[] = [];
  const push = (t: number, magnitude: number): void => {
    const event = detector.update(
      frame(t, { x: axis.x * magnitude, y: axis.y * magnitude, z: axis.z * magnitude }),
    );
    if (event) events.push(event);
  };

  push(startAt, SWING_THRESHOLD + 1);
  push(startAt + 30, peak);
  push(startAt + 60, peak * 0.6);
  // The burst ends by going quiet, not by running out the window.
  push(startAt + 80, 1);
  push(startAt + 80 + SWING_QUIET_MS, 1);
  return events;
}

describe('strength', () => {
  it('is 0 at the threshold and 1 at the maximum', () => {
    expect(swingStrength(SWING_THRESHOLD)).toBe(0);
    expect(swingStrength(SWING_MAX)).toBe(1);
  });

  it('clamps beyond the maximum', () => {
    expect(swingStrength(SWING_MAX + 40)).toBe(1);
    expect(swingStrength(0)).toBe(0);
  });

  it('is linear in between', () => {
    expect(swingStrength((SWING_THRESHOLD + SWING_MAX) / 2)).toBeCloseTo(0.5, 6);
  });
});

describe('direction8', () => {
  it('reads the compass off the canonical X-Y plane', () => {
    expect(direction8Of({ x: 1, y: 0, z: 0 })).toBe('E');
    expect(direction8Of({ x: 0, y: 1, z: 0 })).toBe('N');
    expect(direction8Of({ x: -1, y: 0, z: 0 })).toBe('W');
    expect(direction8Of({ x: 0, y: -1, z: 0 })).toBe('S');
    expect(direction8Of({ x: 1, y: 1, z: 0 })).toBe('NE');
    expect(direction8Of({ x: -1, y: 1, z: 0 })).toBe('NW');
    expect(direction8Of({ x: -1, y: -1, z: 0 })).toBe('SW');
    expect(direction8Of({ x: 1, y: -1, z: 0 })).toBe('SE');
  });

  it('ignores the Z component', () => {
    expect(direction8Of({ x: 0, y: 1, z: -40 })).toBe('N');
  });
});

describe('detection', () => {
  it('emits exactly one event for one swing', () => {
    const detector = new SwingDetector();
    expect(swingOnce(detector, 1000, 30)).toHaveLength(1);
  });

  it('reports the peak, not the first sample over the threshold', () => {
    const detector = new SwingDetector();
    const [event] = swingOnce(detector, 1000, SWING_MAX);
    expect(event?.strength).toBe(1);
  });

  it('stays silent below the threshold', () => {
    const detector = new SwingDetector();
    for (let t = 0; t < 500; t += 16) {
      expect(detector.update(frame(t, { x: 0, y: 0, z: -(SWING_THRESHOLD - 0.5) }))).toBeNull();
    }
  });

  it('ignores a second swing during the cooldown', () => {
    const detector = new SwingDetector();
    swingOnce(detector, 1000, 30);
    const during = swingOnce(detector, 1000 + 80 + SWING_QUIET_MS + 10, 35);
    expect(during).toHaveLength(0);
  });

  it('accepts the next swing once the cooldown has passed', () => {
    const detector = new SwingDetector();
    swingOnce(detector, 1000, 30);
    const emittedAt = 1000 + 80 + SWING_QUIET_MS;
    const after = swingOnce(detector, emittedAt + SWING_COOLDOWN_MS + 1, 35);
    expect(after).toHaveLength(1);
  });

  it('reports the direction of the peak', () => {
    const detector = new SwingDetector();
    const [event] = swingOnce(detector, 1000, 30, { x: 0, y: 1, z: 0 });
    expect(event?.direction8).toBe('N');
  });

  it('carries the player id and the phone timestamp', () => {
    const detector = new SwingDetector();
    const [event] = swingOnce(detector, 5000, 60);
    expect(event?.playerId).toBe(1);
    // Fired on the sample where the burst had clearly subsided, which is what
    // keeps the hit feeling immediate rather than a fixed window late.
    expect(event?.timestamp).toBeLessThanOrEqual(5000 + SWING_CAPTURE_WINDOW_MS);
    expect(event?.timestamp).toBeGreaterThanOrEqual(5000 + SWING_MIN_WINDOW_MS);
  });

  it('reports the peak of the whole burst, not its opening', () => {
    const detector = new SwingDetector();
    const push = (t: number, magnitude: number): DetectorEvent | null =>
      detector.update(frame(t, { x: 0, y: 0, z: -magnitude }));

    expect(push(0, 30)).toBeNull();
    // A dip mid-swing must not end the burst and understate the strength.
    expect(push(20, 28)).toBeNull();
    expect(push(40, 95)).toBeNull();
    expect(push(60, 5)).toBeNull();

    const event = push(60 + SWING_QUIET_MS, 4);
    expect(event).not.toBeNull();
    expect(event?.strength).toBe(1);
  });

  it('still sees the strike that follows a backswing', () => {
    // The regression that made tennis feel broken: the backswing claimed the
    // event and the strike landed inside the cooldown.
    const detector = new SwingDetector();
    const push = (t: number, magnitude: number): DetectorEvent | null =>
      detector.update(frame(t, { x: 0, y: 0, z: -magnitude }));

    const events: DetectorEvent[] = [];
    const record = (t: number, magnitude: number): void => {
      const event = push(t, magnitude);
      if (event) events.push(event);
    };

    // Backswing, then quiet, then the strike 200 ms after it started.
    record(0, 40);
    record(30, 35);
    record(60, 3);
    record(110, 2);
    record(200, 70);
    record(230, 100);
    record(270, 4);
    record(320, 3);

    expect(events).toHaveLength(2);
    expect(events[1]?.strength).toBeGreaterThan(events[0]?.strength ?? 1);
  });

  it('forgets everything on reset', () => {
    const detector = new SwingDetector();
    swingOnce(detector, 1000, 30);
    detector.reset();
    expect(swingOnce(detector, 1050, 30)).toHaveLength(1);
  });

  it('stays quiet while the phone is still', () => {
    const detector = new SwingDetector();
    for (let t = 0; t < 1000; t += 16) expect(detector.update(frame(t, STILL))).toBeNull();
  });
});

/** A detector event must spread straight into the scene-facing action. */
const scenePayload: GameAction = {
  kind: 'swing',
  playerId: 1,
  strength: 1,
  direction: STILL,
  direction8: 'N',
  timestamp: 0,
};
void scenePayload;
