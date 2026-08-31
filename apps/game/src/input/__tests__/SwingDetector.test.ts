import { describe, expect, it } from 'vitest';
import {
  SWING_ARM_SAMPLES,
  SWING_COOLDOWN_MS,
  SWING_OMEGA_MAX,
  SWING_OMEGA_ON,
  SwingDetector,
  direction8Of,
  swingStrength,
  tipTravel,
  type SwingEvent,
} from '../SwingDetector.js';
import type { CanonicalSensorFrame } from '../types.js';

/**
 * Swings are segmented on angular velocity, so these drive rotation rates
 * rather than acceleration. The numbers come from a recorded session: a
 * deliberate swing peaked at 914 deg/s, a purposeful slow turn at 247.
 */

const STEP_MS = 1000 / 60;

function frame(
  t: number,
  rate: { yaw?: number; pitch?: number; roll?: number },
): CanonicalSensorFrame {
  return {
    playerId: 1,
    seq: 0,
    timestamp: t,
    dt: 1 / 60,
    orientation: { yaw: 0, pitch: 0, roll: 0 },
    up: { x: 0, y: 1, z: 0 },
    angularVelocity: { yaw: rate.yaw ?? 0, pitch: rate.pitch ?? 0, roll: rate.roll ?? 0 },
    acceleration: { x: 0, y: 0, z: 0 },
    buttons: 0,
  };
}

/**
 * One burst: a rise to `peak`, then a fall. `axis` picks which canonical rate
 * carries it, which is what decides the reported direction.
 */
function burst(
  detector: SwingDetector,
  startAt: number,
  peak: number,
  axis: 'yaw' | 'pitch' = 'yaw',
  samples = 8,
): SwingEvent[] {
  const events: SwingEvent[] = [];
  for (let i = 0; i <= samples; i++) {
    const shape = Math.sin((i / samples) * Math.PI);
    const event = detector.update(frame(startAt + i * STEP_MS, { [axis]: peak * shape }));
    if (event) events.push(event);
  }
  // A couple of quiet samples so the burst can end.
  for (let i = 1; i <= 2; i++) {
    const event = detector.update(frame(startAt + (samples + i) * STEP_MS, {}));
    if (event) events.push(event);
  }
  return events;
}

describe('strength', () => {
  it('is 0 at the arming rate and 1 at the maximum', () => {
    expect(swingStrength(SWING_OMEGA_ON)).toBe(0);
    expect(swingStrength(SWING_OMEGA_MAX)).toBe(1);
  });

  it('clamps outside the range', () => {
    expect(swingStrength(2000)).toBe(1);
    expect(swingStrength(0)).toBe(0);
  });

  it('separates a flick from a full swing', () => {
    // The whole point of moving off |a|: these used to be indistinguishable
    // once acceleration clipped.
    expect(swingStrength(450)).toBeLessThan(swingStrength(900));
  });
});

describe('where the tip goes', () => {
  it('sweeps right for a rightward turn', () => {
    expect(direction8Of(tipTravel(30, 0))).toBe('E');
  });

  it('sweeps up for an upward pitch', () => {
    expect(direction8Of(tipTravel(0, 30))).toBe('N');
  });

  it('reads the diagonals', () => {
    expect(direction8Of(tipTravel(30, 30))).toBe('NE');
    expect(direction8Of(tipTravel(-30, -30))).toBe('SW');
  });
});

describe('detection', () => {
  it('emits one event per burst', () => {
    const detector = new SwingDetector();
    expect(burst(detector, 1000, 900)).toHaveLength(1);
  });

  it('ignores a deliberate slow turn', () => {
    // 247 deg/s was the fastest a purposeful turn reached on the real phone.
    const detector = new SwingDetector();
    expect(burst(detector, 1000, 247)).toHaveLength(0);
  });

  it('ignores a single spike', () => {
    const detector = new SwingDetector();
    expect(SWING_ARM_SAMPLES).toBeGreaterThan(1);
    detector.update(frame(0, { yaw: 1200 }));
    const after = detector.update(frame(STEP_MS, {}));
    expect(after).toBeNull();
  });

  it('fires while the swing is still recent, not a window later', () => {
    const detector = new SwingDetector();
    const [event] = burst(detector, 0, 900);
    // The burst peaks around 65 ms in; firing on its decay should land close.
    expect(event?.timestamp).toBeLessThan(150);
  });

  it('reports the strength of the peak', () => {
    const detector = new SwingDetector();
    const [event] = burst(detector, 1000, 900);
    expect(event?.peakRate).toBeGreaterThan(850);
    expect(event?.strength).toBeGreaterThan(0.9);
  });

  it('reports where the tip travelled, not the axis it turned about', () => {
    const detector = new SwingDetector();
    const [right] = burst(detector, 1000, 900, 'yaw');
    expect(right?.direction8).toBe('E');

    const other = new SwingDetector();
    const [up] = burst(other, 1000, 900, 'pitch');
    expect(up?.direction8).toBe('N');
  });

  it('ignores a burst that lives entirely inside the cooldown', () => {
    const detector = new SwingDetector();
    const [first] = burst(detector, 0, 900);
    expect(first).toBeDefined();

    // Short enough to start and finish before the cooldown ends. A burst that
    // merely starts inside it is a different matter: the cooldown blocks
    // starting a capture, not the swing that follows the one just reported.
    const firedAt = first?.timestamp ?? 0;
    expect(burst(detector, firedAt + 5, 900, 'yaw', 2)).toHaveLength(0);
  });

  it('accepts the next swing once the cooldown has passed', () => {
    const detector = new SwingDetector();
    const [first] = burst(detector, 0, 900);
    const firedAt = first?.timestamp ?? 0;
    expect(burst(detector, firedAt + SWING_COOLDOWN_MS + 400, 900)).toHaveLength(1);
  });

  it('stays silent while the phone is still', () => {
    const detector = new SwingDetector();
    for (let t = 0; t < 2000; t += STEP_MS) {
      expect(detector.update(frame(t, { yaw: 3, pitch: -2, roll: 1 }))).toBeNull();
    }
  });

  it('forgets everything on reset', () => {
    const detector = new SwingDetector();
    burst(detector, 0, 900);
    detector.reset();
    expect(burst(detector, 50, 900)).toHaveLength(1);
  });
});

describe('telling a strike from a backswing', () => {
  it('marks a stronger reversal as the strike', () => {
    const detector = new SwingDetector();
    // The backswing cannot be labelled as it happens; only the strike can.
    const [windup] = burst(detector, 0, 500, 'yaw');
    expect(windup?.phase).toBe('single');

    const [strike] = burst(detector, 250, -900, 'yaw');
    expect(strike?.phase).toBe('strike');
  });

  it('does not call a repeat in the same direction a strike', () => {
    const detector = new SwingDetector();
    burst(detector, 0, 900, 'yaw');
    const [again] = burst(detector, 250, 900, 'yaw');
    expect(again?.phase).toBe('single');
  });

  it('does not link two swings a long way apart', () => {
    const detector = new SwingDetector();
    burst(detector, 0, 500, 'yaw');
    const [later] = burst(detector, 1500, -900, 'yaw');
    expect(later?.phase).toBe('single');
  });
});
