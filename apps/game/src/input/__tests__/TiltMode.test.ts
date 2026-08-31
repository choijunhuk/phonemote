import { describe, expect, it } from 'vitest';
import { rotateAbout } from '../pose.js';
import { TiltMode, type TiltAxes } from '../TiltMode.js';
import type { CanonicalSensorFrame, CanonicalVector } from '../types.js';

const DEG = Math.PI / 180;

/** The phone aims along -Z, so a roll is a turn about this. */
const AIM_AXIS: CanonicalVector = { x: 0, y: 0, z: -1 };
/**
 * Out of the top of the phone. A turn about this is invisible to gravity while
 * the phone is level and becomes a pure roll once it points straight up, which
 * is why it is the twist Euler roll multiplies by tan(pitch).
 */
const LONG_AXIS: CanonicalVector = { x: 0, y: 1, z: 0 };

/** Where gravity sits, in the phone's frame, for a phone held at these angles. */
function upFor(pitchDeg: number, rollDeg: number): CanonicalVector {
  const pitch = pitchDeg * DEG;
  const roll = rollDeg * DEG;
  return {
    x: -Math.cos(pitch) * Math.sin(roll),
    y: Math.cos(pitch) * Math.cos(roll),
    z: -Math.sin(pitch),
  };
}

/**
 * A frame whose angles and `up` describe the same attitude, the way
 * SensorNormalizer emits them. Yaw stays 0: gravity cannot see it.
 */
function frameFor(up: CanonicalVector): CanonicalSensorFrame {
  return {
    playerId: 1,
    seq: 0,
    timestamp: 0,
    dt: 1 / 60,
    orientation: {
      yaw: 0,
      pitch: -Math.asin(Math.min(1, Math.max(-1, up.z))) / DEG,
      roll: Math.atan2(-up.x, up.y) / DEG,
    },
    up,
    angularVelocity: { yaw: 0, pitch: 0, roll: 0 },
    acceleration: { x: 0, y: 0, z: 0 },
    buttons: 0,
  };
}

function frame(pitch: number, roll: number): CanonicalSensorFrame {
  return frameFor(upFor(pitch, roll));
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
    // Range is pinned here so the test survives retuning the default.
    const tilt = new TiltMode({ deadzone: 0, rangeDeg: 45 });
    tilt.calibrate(frame(10, -15));
    expect(tilt.update(frame(10, -15))).toEqual({ x: 0, y: 0 });
    // 45 degrees of wrist roll from that grip, less the degree and a half of it
    // gravity cannot see once the phone is also pitched up 10.
    expect(tilt.update(frame(10, 30)).x).toBeCloseTo(43.49 / 45, 3);
    tilt.reset();
    expect(tilt.update(frame(10, -15)).y).toBeCloseTo(10 / 45, 2);
  });

  it("reads a quarter turn about the phone's own aim axis as sideways only", () => {
    // Gravity turns by the inverse of the phone's own turn (pose.ts), hence the
    // negated angle. ARCHITECTURE 5.8 tabulates this attitude as (-1, 0, 0).
    const rolled = frameFor(rotateAbout(upFor(0, 0), AIM_AXIS, -90));
    expect(rolled.up.x).toBeCloseTo(-1, 12);

    const axes = new TiltMode().update(rolled);
    expect(axes.x).toBe(1);
    expect(axes.y).toBe(0);
  });
});

describe('tilt away from the horizontal', () => {
  it('reads what the angles read while the phone is held near level', () => {
    // Nothing changes for a player holding the phone the ordinary way: inside
    // 15 degrees of either angle the two disagree by at most a third of a
    // degree, which is 1% of the stick.
    const tilt = new TiltMode({ rangeDeg: 45, deadzone: 0, exponent: 1 });
    for (let pitch = -15; pitch <= 15; pitch += 5) {
      for (let roll = -15; roll <= 15; roll += 5) {
        const held = frame(pitch, roll);
        const axes = tilt.update(held);
        expect(Math.abs(axes.x * 45 - held.orientation.roll)).toBeLessThan(1);
        expect(Math.abs(axes.y * 45 - held.orientation.pitch)).toBeLessThan(1);
      }
    }
  });

  it('sweeps the pitch axis in even steps all the way to the vertical', () => {
    const tilt = new TiltMode({ deadzone: 0 });
    let previous: TiltAxes = tilt.update(frame(0, 0));

    for (let pitch = 1; pitch <= 89; pitch++) {
      const axes = tilt.update(frame(pitch, 0));
      // A degree of pitch is worth a degree of the 35 the range spans, right up
      // to the clamp; nowhere along the way is it worth more.
      expect(Math.abs(axes.y - previous.y)).toBeLessThanOrEqual(1 / 35 + 1e-9);
      // And a pure nod stays out of the sideways axis at every attitude.
      expect(axes.x).toBe(0);
      previous = axes;
    }
    expect(previous.y).toBe(1);
  });

  it('barely moves on a 0.1 degree twist however far the phone aims up', () => {
    // The phone does the same tiny thing at every attitude: one quantisation
    // step of twist about its own long axis, held while it is raised from level
    // to almost straight up. Nobody has tilted it sideways, so the sideways
    // axis should sit still.
    const tilt = new TiltMode({ deadzone: 0 });
    const twistDeg = 0.1;
    const twistedAt = (pitch: number): CanonicalSensorFrame =>
      frameFor(rotateAbout(upFor(pitch, 0), LONG_AXIS, twistDeg));

    // The channel this used to read really does run away up there, by exactly
    // the tan(pitch) the bug report measured.
    expect(Math.abs(twistedAt(50).orientation.roll) / twistDeg).toBeCloseTo(1.19, 2);
    expect(Math.abs(twistedAt(88).orientation.roll) / twistDeg).toBeCloseTo(28.61, 1);
    expect(Math.abs(twistedAt(88).orientation.roll) / 35).toBeCloseTo(0.0818, 3);

    let previous = 0;
    let furthest = 0;
    for (let pitch = 0; pitch <= 89; pitch++) {
      const { x } = tilt.update(twistedAt(pitch));
      if (pitch > 0) expect(Math.abs(x - previous)).toBeLessThan(0.001);
      previous = x;
      furthest = Math.max(furthest, Math.abs(x));
    }
    // ...and across the whole sweep the stick moves under 1% of its travel.
    expect(furthest).toBeLessThan(0.01);
  });

  it('holds steady on a grip that aims down, where roll amplified 1.73x', () => {
    // Golf address: the phone points 60 degrees down the shaft, which is where
    // a player spends the whole shot.
    const address = frame(-60, 0);
    const tilt = new TiltMode({ deadzone: 0 });
    tilt.calibrate(address);
    expect(tilt.update(address)).toEqual({ x: 0, y: 0 });

    const twistDeg = 0.1;
    const twisted = frameFor(rotateAbout(address.up, LONG_AXIS, twistDeg));
    expect(Math.abs(twisted.orientation.roll) / twistDeg).toBeCloseTo(1.73, 2);
    // Under half of the twist reaches the stick, where roll served up nearly
    // twice it. Gravity genuinely sees less of a roll from a grip that aims
    // down; reading it back out is what cost the 1.73x.
    expect((Math.abs(tilt.update(twisted).x) * 35) / twistDeg).toBeLessThan(0.5);
  });
});
