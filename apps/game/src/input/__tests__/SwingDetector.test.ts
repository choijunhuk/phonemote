import { describe, expect, it } from 'vitest';
import {
  SWING_COOLDOWN_MS,
  SWING_MIN_ACCEL,
  SWING_OMEGA_HI,
  SWING_OMEGA_LO,
  SWING_OMEGA_MAX,
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

/**
 * Acceleration defaults to something a swing would actually produce.
 *
 * It is a veto, not a gate (ARCHITECTURE.md D40): a rotation that moves the
 * phone nowhere is a turn. Real swings peaked at 32-60 m/s^2, so 40 is a
 * representative swing and the tests that want a turn pass 0 explicitly.
 */
function frame(
  t: number,
  rate: { yaw?: number; pitch?: number; roll?: number },
  accel = 40,
): CanonicalSensorFrame {
  return {
    playerId: 1,
    seq: 0,
    timestamp: t,
    dt: 1 / 60,
    orientation: { yaw: 0, pitch: 0, roll: 0 },
    up: { x: 0, y: 1, z: 0 },
    angularVelocity: { yaw: rate.yaw ?? 0, pitch: rate.pitch ?? 0, roll: rate.roll ?? 0 },
    acceleration: { x: 0, y: 0, z: accel },
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
  accel = 40,
): SwingEvent[] {
  const events: SwingEvent[] = [];
  for (let i = 0; i <= samples; i++) {
    const shape = Math.sin((i / samples) * Math.PI);
    const event = detector.update(
      frame(startAt + i * STEP_MS, { [axis]: peak * shape }, accel * shape),
    );
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
    expect(swingStrength(SWING_OMEGA_HI)).toBe(0);
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
    expect(SWING_OMEGA_HI).toBeGreaterThan(SWING_OMEGA_LO);
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

describe('telling a swing from a gesture that is not one', () => {
  it('ignores a fast rotation that moved the phone nowhere', () => {
    // Measured: the old single-threshold detector fired 12 times on gestures
    // that were not swings — laying the phone down, standing it on end,
    // tilting it — against 9 fires on the swings. Those rotate; they do not
    // travel, and a hand at rest reads 0.2 m/s^2.
    const detector = new SwingDetector();
    expect(burst(detector, 0, 900, 'yaw', 8, 0)).toHaveLength(0);
  });

  it('still fires for a real swing at the measured acceleration', () => {
    const detector = new SwingDetector();
    expect(burst(detector, 0, 900, 'yaw', 8, SWING_MIN_ACCEL * 3)).toHaveLength(1);
  });

  it('does not start a second burst from the middle of the first', () => {
    // The rate has to fall back below the release line first. Without that a
    // burst that decays and climbs again reads as two swings.
    const detector = new SwingDetector();
    const events: SwingEvent[] = [];
    for (let i = 0; i <= 40; i++) {
      // Two peaks with a dip that stays well above the release line.
      const shape = 0.75 + 0.25 * Math.cos((i / 10) * Math.PI);
      const event = detector.update(frame(i * STEP_MS, { yaw: 900 * shape }, 40));
      if (event) events.push(event);
    }
    expect(events.length).toBeLessThanOrEqual(1);
  });
});

describe('what a swing reports about itself', () => {
  it('keeps yaw and roll apart, which direction cannot', () => {
    // tipTravel folds them together on purpose, because either sweeps the
    // phone's far end sideways. Bowling's hook and golf's club face need to
    // know which one it was.
    const detector = new SwingDetector();
    const [event] = burst(detector, 0, 700, 'yaw');
    expect(event).toBeDefined();
    expect(Math.abs(event?.rotation.yaw ?? 0)).toBeGreaterThan(20);
    expect(Math.abs(event?.rotation.roll ?? 0)).toBeLessThan(1);
    // And the folded value still carries it, for games that only want a sweep.
    expect(Math.abs(event?.direction.x ?? 0)).toBeGreaterThan(20);
  });

  it('reports when the phone was fastest, not just when that became knowable', () => {
    // A peak is only knowable once the rate falls away from it, so detection is
    // always later. A game placing a ball strike in time needs the peak.
    const detector = new SwingDetector();
    const [event] = burst(detector, 1000, 900);
    expect(event).toBeDefined();
    expect(event?.peakAt).toBeLessThan(event?.timestamp ?? 0);
    expect(event?.onsetAt).toBeLessThanOrEqual(event?.peakAt ?? 0);
    expect(event?.durationMs).toBeGreaterThan(0);
  });

  it('captures the start of the swing, not the moment it crossed the line', () => {
    // The entry threshold is high enough to reject a tilt, so a real swing is
    // already under way when it trips. Rewinding recovered a measured 96
    // degrees of travel on a recording the old detector reported as 36.
    const detector = new SwingDetector();
    const [event] = burst(detector, 0, 900, 'yaw', 12);
    const travelled = Math.abs(event?.rotation.yaw ?? 0);
    // Half a sine of 900 deg/s over 12 steps of 16.7 ms is about 115 degrees;
    // starting only above 400 deg/s would lose roughly a third of it.
    expect(travelled).toBeGreaterThan(90);
  });

  it('scales power to this player rather than to a fixed ceiling', () => {
    // The same person's six hardest swings measured 297 to 1211 deg/s, and the
    // fixed scale saturates at 900 — so three of the six read exactly 1.00.
    const detector = new SwingDetector();
    detector.setPowerScale({ softRate: 200, hardRate: 700 });
    const [gentle] = burst(detector, 0, 450, 'yaw', 8, 40);
    const [hard] = burst(detector, 2000, 900, 'yaw', 8, 40);
    expect(gentle?.power ?? 0).toBeGreaterThan(0.1);
    expect(gentle?.power ?? 0).toBeLessThan(0.9);
    expect(hard?.power).toBe(1);
    // Both saturate the fixed scale, which is the problem being fixed.
    expect(hard?.strength).toBe(1);
  });
});
