import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSensor, parseTrace } from '@phonemote/protocol';
import { InputMapper } from '../InputMapper.js';
import { MAX_POINTER_STEP_SECONDS, PointerMode } from '../PointerMode.js';
import { normalize } from '../SensorNormalizer.js';
import type { CanonicalSensorFrame, GameAction } from '../types.js';

/**
 * What the pointer does with a hand that is trying to hold still.
 *
 * The gyro reads about 3.1 deg/s of noise on a motionless phone, against a
 * deadzone of 2, so noise clears the deadzone often and every excursion is
 * integrated. The result is a cursor that wanders on its own — which is what
 * "the left and right are not accurate" turned out to mean.
 */

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../traces/corpus');

function path(actions: readonly GameAction[]): Array<{ x: number; y: number }> {
  return actions.flatMap((action) =>
    action.kind === 'pointer_move' ? [{ x: action.x, y: action.y }] : [],
  );
}

function wander(points: ReadonlyArray<{ x: number; y: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    if (from && to) total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return total;
}

function replayPointer(name: string): Array<{ x: number; y: number }> {
  const trace = parseTrace(readFileSync(join(CORPUS, name), 'utf8'));
  const mapper = new InputMapper({ pointer: {} });
  const actions: GameAction[] = [];
  for (const encoded of trace.frames) actions.push(...mapper.update(decodeSensor(encoded)));
  return path(actions);
}

/** The dt of every frame the pointer would actually be handed. */
function integrationSteps(name: string): number[] {
  const trace = parseTrace(readFileSync(join(CORPUS, name), 'utf8'));
  const steps: number[] = [];
  let lastTimestamp: number | null = null;
  let lastMotionSeq: number | null = null;
  for (const encoded of trace.frames) {
    const sensor = decodeSensor(encoded);
    // A repeated motionSeq never reaches the pointer, so its gap is not a step.
    if (lastMotionSeq !== null && sensor.motionSeq === lastMotionSeq) continue;
    lastMotionSeq = sensor.motionSeq;
    const canonical = normalize(sensor, lastTimestamp);
    lastTimestamp = sensor.timestamp;
    if (canonical.dt > 0) steps.push(canonical.dt);
  }
  return steps;
}

describe('the integration step cap against a real phone', () => {
  for (const name of ['real-rest.pmtrace', 'real-swing.pmtrace']) {
    it(`integrates the time that actually elapsed in ${name}`, () => {
      const steps = integrationSteps(name);
      expect(steps.length).toBeGreaterThan(10);

      const elapsed = steps.reduce((total, dt) => total + dt, 0);
      const integrated = steps.reduce(
        (total, dt) => total + Math.min(dt, MAX_POINTER_STEP_SECONDS),
        0,
      );

      // A cap shorter than an ordinary frame is a silent gain cut. At 0.05 s it
      // fired on all 39 steps of both traces and integrated 0.906 of the rest
      // trace and 0.958 of the swing: a cursor slower than the hand, by a
      // different amount from one frame to the next.
      expect(integrated / elapsed).toBeGreaterThan(0.99);
    });
  }
});

describe('a phone whose sensor has stopped', () => {
  it('leaves the cursor exactly where it was for the whole stall', () => {
    // The trace turns at 40 deg/s for two seconds and then freezes with the
    // frames still arriving at 60 Hz, each repeating a reading the sensor
    // already gave. A longer step cap must not let any of that become movement.
    const trace = parseTrace(readFileSync(join(CORPUS, 'sensor-stall.pmtrace'), 'utf8'));
    const mapper = new InputMapper({ pointer: {} });
    let live = 0;
    let stalled = 0;
    let movesWhileStalled = 0;

    for (const encoded of trace.frames) {
      const moves = path(mapper.update(decodeSensor(encoded)));
      if (mapper.inputState(1).sensorStalled) {
        stalled++;
        movesWhileStalled += moves.length;
      } else {
        live += moves.length;
      }
    }

    expect(live).toBeGreaterThan(100);
    expect(stalled).toBeGreaterThan(100);
    expect(movesWhileStalled).toBe(0);
  });
});

describe('a hand parked on the deadzone boundary', () => {
  function boundaryFrame(t: number, yaw: number): CanonicalSensorFrame {
    return {
      playerId: 1,
      seq: 0,
      timestamp: t,
      dt: 0.05,
      orientation: { yaw: 0, pitch: 0, roll: 0 },
      up: { x: 0, y: 1, z: 0 },
      angularVelocity: { yaw, pitch: 0, roll: 0 },
      acceleration: { x: 0, y: 0, z: 0 },
      buttons: 0,
    };
  }

  it('does not stutter between moving and frozen', () => {
    const pointer = new PointerMode();
    let flips = 0;
    let wasMoving: boolean | null = null;
    let previousX = pointer.position.x;

    // Every channel is quantised to 0.1 deg/s, so a hand turning at exactly the
    // 2 deg/s deadzone reports 1.9 and 2.1 on alternate frames. Two seconds of
    // that at the phone's own rate crossed a bare threshold 35 times, and the
    // cursor started and stopped for a hand that never changed what it was
    // doing.
    for (let i = 0; i < 40; i++) {
      const { x } = pointer.update(boundaryFrame(i * 50, i % 2 === 0 ? 1.9 : 2.1));
      const moving = x !== previousX;
      if (wasMoving !== null && moving !== wasMoving) flips++;
      wasMoving = moving;
      previousX = x;
    }

    expect(flips).toBeLessThan(3);
  });
});

describe('a real phone being held still', () => {
  it('keeps the cursor near where it started', () => {
    // A held phone is not a tripod: part of what this trace contains is a hand,
    // and a pointer that follows the hand is behaving. The bound is set to
    // catch the sensor walking off, not to pretend people are motionless.
    const points = replayPointer('real-rest.pmtrace');
    expect(points.length).toBeGreaterThan(10);
    const last = points.at(-1);
    expect(Math.hypot((last?.x ?? 0.5) - 0.5, (last?.y ?? 0.5) - 0.5)).toBeLessThan(0.06);
  });

  it('does not let the cursor wander while it sits there', () => {
    // Total path, not net displacement: noise averages out in the net figure
    // while still being perfectly visible on screen.
    expect(wander(replayPointer('real-rest.pmtrace'))).toBeLessThan(0.2);
  });
});

describe('the filter against a deadzone alone', () => {
  function noisyFrame(t: number, yaw: number): CanonicalSensorFrame {
    return {
      playerId: 1,
      seq: 0,
      timestamp: t,
      dt: 1 / 60,
      orientation: { yaw: 0, pitch: 0, roll: 0 },
      up: { x: 0, y: 1, z: 0 },
      angularVelocity: { yaw, pitch: 0, roll: 0 },
      acceleration: { x: 0, y: 0, z: 0 },
      buttons: 0,
    };
  }

  /** Deterministic noise at the level the phone actually produces. */
  function noise(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      const uniform = state / 4294967296 - 0.5;
      return uniform * 3.1 * 3.4;
    };
  }

  it('holds still through noise that would otherwise walk the cursor', () => {
    const pointer = new PointerMode();
    const random = noise(5);
    for (let i = 0; i < 600; i++) pointer.update(noisyFrame(i * 16, random()));

    // Ten seconds of a motionless hand.
    expect(Math.abs(pointer.position.x - 0.5)).toBeLessThan(0.03);
  });

  it('still follows a deliberate sweep', () => {
    const pointer = new PointerMode();
    const random = noise(9);
    // One second at 30 deg/s crosses half the screen, noise and all.
    for (let i = 0; i < 60; i++) pointer.update(noisyFrame(i * 16, 30 + random()));

    expect(pointer.position.x).toBeGreaterThan(0.85);
  });

  it('reaches a slow, careful sweep too', () => {
    const pointer = new PointerMode();
    // 8 deg/s for two seconds: the kind of aiming a deadzone-only approach has
    // to choose between keeping and filtering out.
    for (let i = 0; i < 120; i++) pointer.update(noisyFrame(i * 16, 8));
    expect(pointer.position.x).toBeGreaterThan(0.7);
  });
});
