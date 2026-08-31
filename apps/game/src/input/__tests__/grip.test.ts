import { describe, expect, it } from 'vitest';
import { canonicalPose } from '../SensorNormalizer.js';
import { captureGrip, gripQuality, signedPitch, signedRoll, tiltVector } from '../grip.js';
import { FLAT_GRIP_DEG, POSES, angleBetweenDeg, expectedUp, isFlatGrip, rotateAbout } from '../pose.js';
import type { CanonicalVector } from '../types.js';

/**
 * These tie signed tilt to physical holds, so the holds are built the way
 * pose.test.ts builds them: landscape-primary (screen angle 90), anchored at
 * alpha 90, beta 0, gamma -90, which is the phone held level aiming straight
 * ahead (ARCHITECTURE.md 5.7). beta rolls it, gamma swings the aim.
 */

const LANDSCAPE = 90;
const ANCHOR = { alpha: 90, beta: 0, gamma: -90 };

const FORWARD: CanonicalVector = { x: 0, y: 0, z: -1 };
const RIGHT: CanonicalVector = { x: 1, y: 0, z: 0 };

function upFor(beta: number, gamma: number): CanonicalVector {
  return canonicalPose(ANCHOR.alpha, beta, gamma, LANDSCAPE).up;
}

function eulerRollFor(beta: number, gamma: number): number {
  return canonicalPose(ANCHOR.alpha, beta, gamma, LANDSCAPE).angles.roll;
}

const LEVEL_GRIP = captureGrip([upFor(ANCHOR.beta, ANCHOR.gamma)], 1000);

/**
 * Where gravity lands, in the phone's frame, after the player turns the phone
 * itself by `deg` about one of its own axes. Negated for the same reason
 * expectedUp in pose.ts negates: turning the phone by R leaves gravity where it
 * was in the room, so in the phone's frame it moves by R inverse.
 */
function turn(up: CanonicalVector, axis: CanonicalVector, deg: number): CanonicalVector {
  return rotateAbout(up, axis, -deg);
}

/**
 * Fixed-seed noise. Real jitter would make these tests fail one run in fifty
 * and pass on a rerun, which teaches everyone to rerun them.
 */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe('signed tilt from a grip', () => {
  it('reads a thirty degree roll to the right as +30, and nothing else', () => {
    const up = turn(LEVEL_GRIP.up, FORWARD, 30);
    expect(signedRoll(LEVEL_GRIP, up)).toBeCloseTo(30, 6);
    expect(signedPitch(LEVEL_GRIP, up)).toBeCloseTo(0, 6);
  });

  it('reads the same roll to the left as -30', () => {
    const up = turn(LEVEL_GRIP.up, FORWARD, -30);
    expect(signedRoll(LEVEL_GRIP, up)).toBeCloseTo(-30, 6);
    expect(signedPitch(LEVEL_GRIP, up)).toBeCloseTo(0, 6);
  });

  it('reads thirty degrees of aim upwards as +30 pitch, the mirror of the roll', () => {
    const up = turn(LEVEL_GRIP.up, RIGHT, 30);
    expect(signedPitch(LEVEL_GRIP, up)).toBeCloseTo(30, 6);
    expect(signedRoll(LEVEL_GRIP, up)).toBeCloseTo(0, 6);
  });

  it('reads aiming down as negative pitch', () => {
    const up = turn(LEVEL_GRIP.up, RIGHT, -30);
    expect(signedPitch(LEVEL_GRIP, up)).toBeCloseTo(-30, 6);
    expect(signedRoll(LEVEL_GRIP, up)).toBeCloseTo(0, 6);
  });

  it('keeps roll and pitch apart when the player is doing both at once', () => {
    const up = turn(turn(LEVEL_GRIP.up, FORWARD, 10), RIGHT, 10);
    // A tenth of a degree of cross-talk at ten degrees each: a ski edge and an
    // archery elevation read off the same hand do not contaminate each other.
    expect(signedRoll(LEVEL_GRIP, up)).toBeCloseTo(10, 1);
    expect(signedPitch(LEVEL_GRIP, up)).toBeCloseTo(10, 1);
  });

  it('keeps them apart whichever way round the player moved', () => {
    const rollFirst = turn(turn(LEVEL_GRIP.up, FORWARD, 10), RIGHT, 10);
    const pitchFirst = turn(turn(LEVEL_GRIP.up, RIGHT, 10), FORWARD, 10);
    expect(signedRoll(LEVEL_GRIP, rollFirst)).toBeCloseTo(signedPitch(LEVEL_GRIP, pitchFirst), 6);
    expect(signedPitch(LEVEL_GRIP, rollFirst)).toBeCloseTo(signedRoll(LEVEL_GRIP, pitchFirst), 6);
  });

  it('agrees with every pose in the POSES table about which way the phone turned', () => {
    for (const pose of POSES) {
      // The antipode has no axis to project, so upside-down sits out; it gets
      // its own test below.
      if (Math.abs(pose.angleDeg) === 180) continue;

      const up = expectedUp(pose, LEVEL_GRIP.up);
      const rolls = pose.axis.z !== 0;
      expect(rolls ? signedRoll(LEVEL_GRIP, up) : signedPitch(LEVEL_GRIP, up), pose.key).toBeCloseTo(
        pose.angleDeg,
        5,
      );
      expect(rolls ? signedPitch(LEVEL_GRIP, up) : signedRoll(LEVEL_GRIP, up), pose.key).toBeCloseTo(
        0,
        5,
      );
    }
  });

  it('reports nothing at all for the grip it was captured from', () => {
    expect(tiltVector(LEVEL_GRIP, LEVEL_GRIP.up)).toEqual({ x: 0, y: 0 });
  });

  it('is blind to a turn about gravity, which no gravity sensor can see', () => {
    const up = turn(LEVEL_GRIP.up, LEVEL_GRIP.up, 40);
    expect(tiltVector(LEVEL_GRIP, up)).toEqual({ x: 0, y: 0 });
  });

  it('never reports more tilt than the phone actually moved through', () => {
    for (let beta = -180; beta <= 180; beta += 20) {
      for (let gamma = -180; gamma <= 0; gamma += 20) {
        const up = upFor(beta, gamma);
        const tilt = tiltVector(LEVEL_GRIP, up);
        const moved = angleBetweenDeg(LEVEL_GRIP.up, up);
        expect(Math.hypot(tilt.x, tilt.y), `beta ${beta} gamma ${gamma}`).toBeLessThanOrEqual(
          moved + 1e-9,
        );
      }
    }
  });

  it('stays finite at the one hold the split cannot represent', () => {
    // Exactly upside down, the rotation axis is any perpendicular you like, so
    // there is no honest answer. What matters is that a phone flipped over does
    // not hand a game an Infinity or a NaN to steer with.
    const inverted = tiltVector(LEVEL_GRIP, { x: -LEVEL_GRIP.up.x, y: -1, z: -LEVEL_GRIP.up.z });
    expect(inverted).toEqual({ x: 0, y: 0 });

    const nearlyInverted = tiltVector(LEVEL_GRIP, turn(LEVEL_GRIP.up, FORWARD, 179.9));
    expect(Number.isFinite(nearlyInverted.x)).toBe(true);
    expect(Number.isFinite(nearlyInverted.y)).toBe(true);
    expect(Math.hypot(nearlyInverted.x, nearlyInverted.y)).toBeLessThanOrEqual(180);
  });

  it('hands signedRoll and signedPitch the same two numbers as tiltVector', () => {
    const up = upFor(37, -119);
    const tilt = tiltVector(LEVEL_GRIP, up);
    expect(signedRoll(LEVEL_GRIP, up)).toBe(tilt.x);
    expect(signedPitch(LEVEL_GRIP, up)).toBe(tilt.y);
  });
});

describe('the holds where Euler angles fall apart', () => {
  /** Level to straight up, one degree at a time, from a grip that is not level. */
  const SWEEP_BETA = 20;

  it('moves smoothly all the way from level to aiming straight up', () => {
    let previous = tiltVector(LEVEL_GRIP, upFor(SWEEP_BETA, ANCHOR.gamma));
    for (let step = 1; step <= 90; step++) {
      const tilt = tiltVector(LEVEL_GRIP, upFor(SWEEP_BETA, ANCHOR.gamma - step));
      expect(Math.abs(tilt.x - previous.x), `roll at ${step}`).toBeLessThan(2);
      expect(Math.abs(tilt.y - previous.y), `pitch at ${step}`).toBeLessThan(2);
      previous = tilt;
    }
  });

  it('never reads a raised aim as lowered on the way up', () => {
    let previous = -Infinity;
    for (let step = 0; step <= 90; step++) {
      const pitch = signedPitch(LEVEL_GRIP, upFor(SWEEP_BETA, ANCHOR.gamma - step));
      expect(pitch, `step ${step}`).toBeGreaterThan(previous);
      previous = pitch;
    }
  });

  it('stays put where canonical roll swings through ninety degrees', () => {
    // Standing the phone on end is where the atan2 loses its denominators. One
    // degree of beta there is one degree of real movement, and the vector
    // reading follows it; the angle reading does not.
    const straightUp = upFor(ANCHOR.beta, ANCHOR.gamma - 90);
    const nudged = upFor(ANCHOR.beta + 1, ANCHOR.gamma - 90);

    const before = tiltVector(LEVEL_GRIP, straightUp);
    const after = tiltVector(LEVEL_GRIP, nudged);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(2);

    const eulerJump = Math.abs(
      eulerRollFor(ANCHOR.beta + 1, ANCHOR.gamma - 90) - eulerRollFor(ANCHOR.beta, ANCHOR.gamma - 90),
    );
    expect(eulerJump).toBeGreaterThan(45);
  });
});

describe('capturing a grip', () => {
  const TRUTH = turn(turn(upFor(ANCHOR.beta, ANCHOR.gamma), FORWARD, 12), RIGHT, -8);

  /** Thirty readings of a hand trying to hold still, jittered by up to 6 degrees. */
  function heldStill(seed: number): CanonicalVector[] {
    const random = noise(seed);
    const samples: CanonicalVector[] = [];
    for (let i = 0; i < 30; i++) {
      const roll = (random() * 2 - 1) * 6;
      const pitch = (random() * 2 - 1) * 6;
      samples.push(turn(turn(TRUTH, FORWARD, roll), RIGHT, pitch));
    }
    return samples;
  }

  it('averages the noise out of a hand that is only trying to hold still', () => {
    const samples = heldStill(7);
    const worstSingleSample = Math.max(...samples.map((s) => angleBetweenDeg(s, TRUTH)));
    expect(worstSingleSample).toBeGreaterThan(6);

    expect(angleBetweenDeg(captureGrip(samples, 0).up, TRUTH)).toBeLessThan(3);
  });

  it('ignores the frames where the hand was still travelling towards the button', () => {
    const random = noise(11);
    const samples: CanonicalVector[] = [];
    // The aim sweeping down into the grip over the first eight frames, then the
    // hold itself. This is the shape freezeState measured: a mean over the whole
    // window lands ten degrees out and the good samples are the ones that then
    // get rejected for disagreeing with it.
    for (let i = 0; i < 8; i++) samples.push(turn(TRUTH, RIGHT, 60 - i * 5));
    for (let i = 0; i < 22; i++) {
      const roll = (random() * 2 - 1) * 3;
      const pitch = (random() * 2 - 1) * 3;
      samples.push(turn(turn(TRUTH, FORWARD, roll), RIGHT, pitch));
    }

    expect(angleBetweenDeg(captureGrip(samples, 0).up, TRUTH)).toBeLessThan(2);

    let x = 0;
    let y = 0;
    let z = 0;
    for (const sample of samples) {
      x += sample.x;
      y += sample.y;
      z += sample.z;
    }
    expect(angleBetweenDeg({ x, y, z }, TRUTH)).toBeGreaterThan(8);
  });

  it('reads zero tilt against the grip it just captured', () => {
    const grip = captureGrip(heldStill(23), 0);
    expect(Math.hypot(signedRoll(grip, grip.up), signedPitch(grip, grip.up))).toBeLessThan(1e-9);
  });

  it('gives back a unit vector whatever it was fed', () => {
    const up = captureGrip(heldStill(41), 0).up;
    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 12);
  });

  it('remembers when it was taken, so a scene can tell a stale grip from a fresh one', () => {
    expect(captureGrip([upFor(0, -90)], 4321).capturedAt).toBe(4321);
    expect(captureGrip([], 4321).capturedAt).toBe(4321);
  });

  it('falls back to level rather than to nothing when there is no reading yet', () => {
    expect(captureGrip([], 0).up).toEqual({ x: 0, y: 1, z: 0 });
  });
});

describe('grip quality', () => {
  it('is full for a phone held upright, where both axes read at full size', () => {
    expect(gripQuality(upFor(ANCHOR.beta, ANCHOR.gamma))).toBeCloseTo(1, 6);
  });

  it('is zero for every grip pose.ts already calls flat', () => {
    for (let beta = -180; beta <= 180; beta += 15) {
      for (let gamma = -180; gamma <= 0; gamma += 15) {
        const up = upFor(beta, gamma);
        if (!isFlatGrip(up)) continue;
        expect(gripQuality(up), `beta ${beta} gamma ${gamma}`).toBe(0);
      }
    }
  });

  it('is zero for a phone stood on its side too, where the pitch stops being visible', () => {
    // Not the same failure as lying flat, and pose.ts does not name it: gravity
    // along the right edge is along the axis every aim-up turns about, so the
    // elevation an archery game wants moves nothing.
    const onItsSide = turn(upFor(ANCHOR.beta, ANCHOR.gamma), FORWARD, 90);
    expect(isFlatGrip(onItsSide)).toBe(false);
    expect(gripQuality(onItsSide)).toBe(0);
  });

  it('falls off as the phone is laid down, so a scene can warn before the round', () => {
    let previous = Infinity;
    for (let step = 0; step <= 90; step += 5) {
      const quality = gripQuality(turn(upFor(ANCHOR.beta, ANCHOR.gamma), RIGHT, step));
      expect(quality, `step ${step}`).toBeLessThanOrEqual(previous);
      previous = quality;
    }
    expect(previous).toBe(0);
  });

  it('reaches zero exactly at the flat line pose.ts draws, not somewhere near it', () => {
    const justInside = turn(upFor(ANCHOR.beta, ANCHOR.gamma), RIGHT, 90 - FLAT_GRIP_DEG - 1);
    expect(justInside).toBeDefined();
    expect(gripQuality(justInside)).toBeGreaterThan(0);
    expect(gripQuality(turn(upFor(ANCHOR.beta, ANCHOR.gamma), RIGHT, 90 - FLAT_GRIP_DEG))).toBe(0);
  });

  it('stays inside 0..1 for every hold there is', () => {
    for (let beta = -180; beta <= 180; beta += 15) {
      for (let gamma = -180; gamma <= 180; gamma += 15) {
        const quality = gripQuality(upFor(beta, gamma));
        expect(quality, `beta ${beta} gamma ${gamma}`).toBeGreaterThanOrEqual(0);
        expect(quality, `beta ${beta} gamma ${gamma}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
