import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSensor, parseTrace } from '@phonemote/protocol';
import { normalize } from '../SensorNormalizer.js';
import {
  STROKE_GATE_RATE,
  STROKE_MAX_PEAK_RATE,
  STROKE_MAX_STEP_MS,
  StrokeDetector,
  angularVector,
  trapezoidRate,
  type StrokeEvent,
} from '../StrokeDetector.js';
import type { CanonicalAngles, CanonicalSensorFrame } from '../types.js';

/**
 * A putt is a slow out-and-back with no threshold in it, so these drive rate
 * profiles rather than single spikes, and the numbers come from the real
 * recordings: a golf-putt-sized motion lives at 40-300 deg/s, a hand trying to
 * hold still at a mean |omega| of 3.34 with excursions to 14.1, and the phone
 * arrives at a 51-55 ms median interval.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(here, '../../../../../traces/corpus');

/** The two rates that bracket what the phone might send. */
const PHONE_HZ = 20;
const FAST_HZ = 60;

/**
 * `dt` is left at zero because nothing here reads it: the detector times its
 * own steps off the frame timestamps, so that a step spanning a dropped frame
 * is measured the same way as the trapezoid that goes with it.
 */
function frame(
  t: number,
  rate: { yaw?: number; pitch?: number; roll?: number },
  rateStep?: CanonicalAngles,
): CanonicalSensorFrame {
  const angularVelocity: CanonicalAngles = {
    yaw: rate.yaw ?? 0,
    pitch: rate.pitch ?? 0,
    roll: rate.roll ?? 0,
  };
  return {
    playerId: 1,
    seq: 0,
    timestamp: t,
    dt: 0,
    orientation: { yaw: 0, pitch: 0, roll: 0 },
    up: { x: 0, y: 1, z: 0 },
    angularVelocity,
    ...(rateStep === undefined ? {} : { rateStep }),
    acceleration: { x: 0, y: 0, z: 0 },
    buttons: 0,
  };
}

function play(detector: StrokeDetector, frames: readonly CanonicalSensorFrame[]): StrokeEvent[] {
  const events: StrokeEvent[] = [];
  for (const next of frames) {
    const event = detector.update(next);
    if (event) events.push(event);
  }
  return events;
}

/**
 * A putt: `angleDeg` degrees out and the same back again.
 *
 * The rate is a half-sine each way, which is what a hand that accelerates once
 * and decelerates once produces, and the peak is chosen rather than the
 * duration because 40-300 deg/s is the band a putt actually occupies. The
 * trailing quiet is long enough for the return to end on the quiet fallback.
 */
function putt(options: {
  readonly peakRate: number;
  readonly angleDeg: number;
  readonly stepMs: number;
  readonly axis?: 'yaw' | 'pitch' | 'roll';
  readonly startAt?: number;
}): CanonicalSensorFrame[] {
  const axis = options.axis ?? 'yaw';
  const startAt = options.startAt ?? 0;
  const halfMs = (options.angleDeg * Math.PI * 1000) / (2 * options.peakRate);
  const frames: CanonicalSensorFrame[] = [];
  for (let t = 0; t <= 2 * halfMs + 500; t += options.stepMs) {
    const rate = t >= 2 * halfMs ? 0 : options.peakRate * Math.sin((Math.PI * t) / halfMs);
    frames.push(frame(startAt + t, { [axis]: rate }));
  }
  return frames;
}

/** Deterministic, so that a threshold change is a result and not a coin toss. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(Number.MIN_VALUE, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Every sensor channel arrives quantised to 0.1 (deg, deg/s, m/s^2). */
function quantise(value: number): number {
  return Math.round(value * 10) / 10;
}

/** One of the lurches a hand makes every few seconds, as a raised cosine. */
function lurch(seconds: number, everyS: number, widthS: number, peak: number): number {
  const phase = ((seconds % everyS) + everyS) % everyS;
  if (phase > widthS) return 0;
  return peak * (0.5 - 0.5 * Math.cos((2 * Math.PI * phase) / widthS));
}

/**
 * A hand that is only trying to hold still.
 *
 * Three things, all measured. Gyro noise at 1.104 / 1.299 / 0.677 deg/s sd per
 * canonical axis; a slow wander on top of it, without which mean |omega| would
 * be the 1.7 the noise alone gives rather than the 3.34 the recording shows;
 * and an occasional lurch, because the recording's median is 2.11 against a
 * single worst excursion of 14.1 and only a heavy tail gives both at once.
 */
function stillHand(count: number, stepMs: number, seed = 7): CanonicalSensorFrame[] {
  const random = mulberry32(seed);
  const frames: CanonicalSensorFrame[] = [];
  for (let i = 0; i < count; i++) {
    const t = i * stepMs;
    const seconds = t / 1000;
    frames.push(
      frame(t, {
        yaw: quantise(
          1.104 * gaussian(random) +
            2.42 * Math.sin(2 * Math.PI * (seconds / 2.7) + 0.4) +
            1.32 * Math.sin(2 * Math.PI * (seconds / 0.9)) +
            lurch(seconds, 2.6, 0.16, 11),
        ),
        pitch: quantise(
          1.299 * gaussian(random) +
            2.2 * Math.sin(2 * Math.PI * (seconds / 3.3) + 1.1) +
            1.21 * Math.sin(2 * Math.PI * (seconds / 1.3)) +
            lurch(seconds - 0.05, 2.6, 0.16, 5.5),
        ),
        roll: quantise(
          0.677 * gaussian(random) + 1.1 * Math.sin(2 * Math.PI * (seconds / 4.1) + 2),
        ),
      }),
    );
  }
  return frames;
}

function rateMagnitude(next: CanonicalSensorFrame): number {
  const { yaw, pitch, roll } = next.angularVelocity;
  return Math.hypot(yaw, pitch, roll);
}

function replayTrace(name: string, detector: StrokeDetector): StrokeEvent[] {
  const trace = parseTrace(readFileSync(join(CORPUS, name), 'utf8'));
  const events: StrokeEvent[] = [];
  let previousTimestamp: number | null = null;
  let previousRate: CanonicalAngles | null = null;

  for (const encoded of trace.frames) {
    const raw = decodeSensor(encoded);
    const canonical = normalize(raw, previousTimestamp, previousRate);
    previousTimestamp = raw.timestamp;
    previousRate = canonical.angularVelocity;

    const event = detector.update(canonical);
    if (event) events.push(event);
  }
  return events;
}

describe('reading yaw, pitch and roll as one rotation', () => {
  it('turns a rightward yaw into a rotation about the axis pointing at the floor', () => {
    // Yaw is measured about the down axis, so a positive yaw is a negative Y.
    const vector = angularVector({ yaw: 40, pitch: 0, roll: 0 });
    expect(vector.y).toBe(-40);
    expect(Math.hypot(vector.x, vector.z)).toBe(0);
  });

  it('turns an upward pitch into a rotation about the phone right edge', () => {
    const vector = angularVector({ yaw: 0, pitch: 40, roll: 0 });
    expect(vector.x).toBe(40);
    expect(Math.hypot(vector.y, vector.z)).toBe(0);
  });

  it('turns a rightward roll into a rotation about the direction the phone aims', () => {
    const vector = angularVector({ yaw: 0, pitch: 0, roll: 40 });
    expect(vector.z).toBe(-40);
    expect(Math.hypot(vector.x, vector.y)).toBe(0);
  });

  it('keeps the length of the rotation it was given', () => {
    const vector = angularVector({ yaw: 30, pitch: -40, roll: 120 });
    expect(Math.hypot(vector.x, vector.y, vector.z)).toBeCloseTo(Math.hypot(30, 40, 120), 10);
  });
});

describe('a putt', () => {
  it('measures a 20 degree backswing at the rate the phone records at', () => {
    const detector = new StrokeDetector();
    const events = play(detector, putt({ peakRate: 120, angleDeg: 20, stepMs: 1000 / PHONE_HZ }));

    expect(events).toHaveLength(2);
    const [out, back] = events;
    expect(out?.angleDeg).toBeGreaterThan(18);
    expect(out?.angleDeg).toBeLessThan(22);
    expect(back?.angleDeg).toBeGreaterThan(18);
    expect(back?.angleDeg).toBeLessThan(22);
  });

  it('measures the same putt the same way three times faster', () => {
    const detector = new StrokeDetector();
    const events = play(detector, putt({ peakRate: 120, angleDeg: 20, stepMs: 1000 / FAST_HZ }));

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.angleDeg).toBeGreaterThan(18);
      expect(event.angleDeg).toBeLessThan(22);
    }
  });

  it('knows the return turned back on the backswing', () => {
    const detector = new StrokeDetector();
    const [out, back] = play(
      detector,
      putt({ peakRate: 120, angleDeg: 20, stepMs: 1000 / PHONE_HZ }),
    );

    // The backswing cannot know it is one; the return is the half that can.
    expect(out?.reversedFromPrevious).toBe(false);
    expect(back?.reversedFromPrevious).toBe(true);
  });

  it('gives the return the backswing axis pointing the other way', () => {
    const detector = new StrokeDetector();
    const [out, back] = play(
      detector,
      putt({ peakRate: 120, angleDeg: 20, stepMs: 1000 / PHONE_HZ }),
    );

    // A yaw putt turns about the vertical, so the axis is the one gravity is on.
    expect(out?.axis.y).toBeLessThan(-0.99);
    expect(back?.axis.y).toBeGreaterThan(0.99);
  });

  it('splits the out from the back at the turn, not after a fixed window', () => {
    const detector = new StrokeDetector();
    const [out] = play(detector, putt({ peakRate: 120, angleDeg: 20, stepMs: 1000 / PHONE_HZ }));

    // The backswing lasts 262 ms, and the reversal is called on the first frame
    // that is genuinely coming back rather than 120 ms of quiet later.
    expect(out?.timestamp).toBeLessThan(262 + 1000 / PHONE_HZ);
  });

  it('scales with how far back the player took it, which is what a putt is worth', () => {
    const small = play(
      new StrokeDetector(),
      putt({ peakRate: 120, angleDeg: 10, stepMs: 1000 / PHONE_HZ }),
    );
    const large = play(
      new StrokeDetector(),
      putt({ peakRate: 120, angleDeg: 40, stepMs: 1000 / PHONE_HZ }),
    );

    expect(small[0]?.angleDeg).toBeLessThan(12);
    expect(large[0]?.angleDeg).toBeGreaterThan(36);
  });

  it('still reads a putt at the very bottom of the band, low but present', () => {
    // 40 deg/s is where a putt stops being separable from a hand. Only a third
    // of it clears the 30 deg/s gate, and the quiet fallback ends the backswing
    // before it ever reaches the turn, so 20 degrees reads as 16.4. A game
    // scoring distance off this has to be calibrated on what players do rather
    // than on the true angle.
    const detector = new StrokeDetector();
    const [out] = play(detector, putt({ peakRate: 40, angleDeg: 20, stepMs: 20 }));

    expect(out?.angleDeg).toBeGreaterThan(15);
    expect(out?.angleDeg).toBeLessThan(18);
  });

  it('loses a putt too quick for the 20 Hz poll, and gets it back at 60', () => {
    // 250 deg/s puts a 20 degree backswing inside 126 ms, which is two and a
    // half samples at 20 Hz. No detector recovers a shape it was never sent;
    // this is a statement about the poll rate, not about the segmentation.
    const slow = play(
      new StrokeDetector(),
      putt({ peakRate: 250, angleDeg: 20, stepMs: 1000 / PHONE_HZ }),
    );
    const fast = play(
      new StrokeDetector(),
      putt({ peakRate: 250, angleDeg: 20, stepMs: 1000 / FAST_HZ }),
    );

    expect(slow[0]?.angleDeg).toBeLessThan(17);
    expect(fast[0]?.angleDeg).toBeGreaterThan(19);
  });

  it('reads a putt that turns about the phone own aim, not only about yaw', () => {
    const detector = new StrokeDetector();
    const [out] = play(
      detector,
      putt({ peakRate: 120, angleDeg: 20, stepMs: 1000 / PHONE_HZ, axis: 'roll' }),
    );

    expect(out?.angleDeg).toBeGreaterThan(18);
    expect(out?.axis.z).toBeLessThan(-0.99);
  });
});

describe('a stroke that stops instead of turning back', () => {
  it('is reported once the hand has been quiet, without waiting for a reversal', () => {
    const detector = new StrokeDetector();
    const frames: CanonicalSensorFrame[] = [];
    // 200 ms of a steady 90 deg/s turn is 18 degrees, then the hand stops.
    for (let t = 0; t <= 200; t += 50) frames.push(frame(t, { yaw: 90 }));
    for (let t = 250; t <= 700; t += 50) frames.push(frame(t, {}));

    const events = play(detector, frames);
    expect(events).toHaveLength(1);
    expect(events[0]?.angleDeg).toBeGreaterThan(15);
    expect(events[0]?.reversedFromPrevious).toBe(false);
  });

  it('does not count the quiet that ended it as part of the stroke', () => {
    const detector = new StrokeDetector();
    const frames: CanonicalSensorFrame[] = [];
    for (let t = 0; t <= 200; t += 50) frames.push(frame(t, { yaw: 90 }));
    for (let t = 250; t <= 700; t += 50) frames.push(frame(t, {}));

    const [event] = play(detector, frames);
    expect(event?.durationMs).toBe(200);
    expect(event?.timestamp).toBeGreaterThan(300);
  });
});

describe('a hand that is only trying to hold still', () => {
  it('is generated at the noise floor the recording actually measured', () => {
    // The test is worth nothing if the input is quieter than a real hand.
    const frames = stillHand(10 * PHONE_HZ, 1000 / PHONE_HZ);
    const magnitudes = frames.map(rateMagnitude);
    const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;

    // Measured: mean 3.34, median 2.11, worst single excursion 14.06 deg/s.
    expect(mean).toBeGreaterThan(3.0);
    expect(mean).toBeLessThan(3.8);
    expect(Math.max(...magnitudes)).toBeGreaterThan(11);
    expect(Math.max(...magnitudes)).toBeLessThan(15);
  });

  it('produces no strokes at all over ten seconds', () => {
    const detector = new StrokeDetector();
    expect(play(detector, stillHand(10 * PHONE_HZ, 1000 / PHONE_HZ))).toHaveLength(0);
  });

  it('produces none at 60 Hz either, where there are three times as many chances', () => {
    const detector = new StrokeDetector();
    expect(play(detector, stillHand(10 * FAST_HZ, 1000 / FAST_HZ, 21))).toHaveLength(0);
  });

});

describe('integrating the rotation', () => {
  /** Rate that ramps up to `peak` and back down, sampled off the sample grid. */
  function triangle(t: number, peak: number, riseMs: number, fallMs: number): number {
    if (t <= 0 || t >= riseMs + fallMs) return 0;
    return t < riseMs ? (peak * t) / riseMs : (peak * (riseMs + fallMs - t)) / fallMs;
  }

  /** What the rate really averaged over one step, by dense sub-sampling. */
  function trueMean(
    from: number,
    to: number,
    peak: number,
    riseMs: number,
    fallMs: number,
  ): number {
    const slices = 400;
    let sum = 0;
    for (let i = 0; i < slices; i++) {
      sum += triangle(from + ((i + 0.5) * (to - from)) / slices, peak, riseMs, fallMs);
    }
    return sum / slices;
  }

  it('follows a ramping rate more closely than the raw sample does', () => {
    // The measurement the trapezoid rests on (ARCHITECTURE.md D39): against
    // ground truth from the orientation matrix, per-step rate error was 115
    // deg/s on the fastest axis reading the raw sample and 47 taking the
    // average across the step. The apex sits between two samples on purpose —
    // aligned with one, the trapezoid would be exactly right and the comparison
    // would flatter it.
    const stepMs = 1000 / PHONE_HZ;
    const peak = 260;
    const riseMs = 173;
    const fallMs = 291;

    let rectangleError = 0;
    let trapezoidError = 0;
    let steps = 0;
    for (let t = stepMs; t <= riseMs + fallMs; t += stepMs) {
      const rate: CanonicalAngles = { yaw: triangle(t, peak, riseMs, fallMs), pitch: 0, roll: 0 };
      const before: CanonicalAngles = {
        yaw: triangle(t - stepMs, peak, riseMs, fallMs),
        pitch: 0,
        roll: 0,
      };
      const truth = trueMean(t - stepMs, t, peak, riseMs, fallMs);

      rectangleError += (rate.yaw - truth) ** 2;
      trapezoidError += (trapezoidRate(rate, before).yaw - truth) ** 2;
      steps++;
    }

    const rectangleRmse = Math.sqrt(rectangleError / steps);
    const trapezoidRmse = Math.sqrt(trapezoidError / steps);
    expect(trapezoidRmse).toBeLessThan(rectangleRmse / 2);
  });

  it('does not run a backswing long the way a rectangle sum does', () => {
    // Where the difference actually lives. Over a whole motion the two rules
    // telescope to the same total, because it starts and ends at rest; over the
    // rising half — the backswing, which is the part a power meter is drawn
    // from — the rectangle sum overshoots by one step of half the peak, and
    // that is 20% of a five-step backswing.
    const stepMs = 1000 / PHONE_HZ;
    const peak = 200;
    const riseMs = 5 * stepMs;

    let rectangle = 0;
    let trapezoid = 0;
    for (let t = stepMs; t <= riseMs; t += stepMs) {
      const rate: CanonicalAngles = { yaw: (peak * t) / riseMs, pitch: 0, roll: 0 };
      const before: CanonicalAngles = { yaw: (peak * (t - stepMs)) / riseMs, pitch: 0, roll: 0 };
      rectangle += (rate.yaw * stepMs) / 1000;
      trapezoid += (trapezoidRate(rate, before).yaw * stepMs) / 1000;
    }

    const truth = (peak * riseMs) / 2000;
    expect(trapezoid).toBeCloseTo(truth, 10);
    expect(rectangle).toBeGreaterThan(truth * 1.15);
  });

  it('honours the step average the normaliser already computed', () => {
    // A frame that carries `rateStep` is integrated on that, not on the
    // instantaneous rate: it is the same trapezoid, taken where the previous
    // frame is known for certain.
    const detector = new StrokeDetector();
    const events = play(detector, [
      frame(0, { yaw: 0 }),
      frame(50, { yaw: 200 }, { yaw: 100, pitch: 0, roll: 0 }),
      frame(100, { yaw: 0 }, { yaw: 100, pitch: 0, roll: 0 }),
      frame(150, {}, { yaw: 0, pitch: 0, roll: 0 }),
      frame(200, {}, { yaw: 0, pitch: 0, roll: 0 }),
      frame(250, {}, { yaw: 0, pitch: 0, roll: 0 }),
      frame(300, {}, { yaw: 0, pitch: 0, roll: 0 }),
    ]);

    // Two steps of 50 ms at a 100 deg/s average is 10 degrees.
    expect(events[0]?.angleDeg).toBeCloseTo(10, 6);
  });
});

describe('a gesture that belongs to the swing detector', () => {
  it('says nothing about a rotation fast enough to be a swing', () => {
    const detector = new StrokeDetector();
    const events = play(detector, putt({ peakRate: 900, angleDeg: 60, stepMs: 1000 / FAST_HZ }));
    expect(events).toHaveLength(0);
  });

  it('still speaks for the firm putt that the swing detector would miss', () => {
    // 300-400 deg/s is where the two bands overlap: real swings measured
    // 297-1211 and putts 40-300. Cutting at 300 would leave this producing
    // nothing at all, because the swing detector needs 400 to start.
    const detector = new StrokeDetector();
    const [out] = play(detector, putt({ peakRate: 350, angleDeg: 40, stepMs: 1000 / FAST_HZ }));

    expect(out?.peakRate).toBeGreaterThan(300);
    expect(out?.peakRate).toBeLessThan(STROKE_MAX_PEAK_RATE);
    expect(out?.angleDeg).toBeGreaterThan(36);
  });

  it('does not let a swing become the thing the next putt reversed', () => {
    const detector = new StrokeDetector();
    play(detector, putt({ peakRate: 900, angleDeg: 60, stepMs: 1000 / FAST_HZ, startAt: 0 }));
    const [next] = play(
      detector,
      putt({ peakRate: 120, angleDeg: 20, stepMs: 1000 / FAST_HZ, startAt: 1000 }),
    );

    expect(next?.reversedFromPrevious).toBe(false);
  });
});

describe('frames that stop arriving', () => {
  it('abandons a stroke rather than reporting a size nobody measured', () => {
    const detector = new StrokeDetector();
    const frames: CanonicalSensorFrame[] = [];
    for (let t = 0; t <= 200; t += 50) frames.push(frame(t, { yaw: 90 }));
    // The next frame lands after the gap the integrator will trust.
    frames.push(frame(200 + STROKE_MAX_STEP_MS + 50, { yaw: 90 }));
    for (let t = 1; t <= 12; t++) frames.push(frame(200 + STROKE_MAX_STEP_MS + 50 + t * 50, {}));

    expect(play(detector, frames)).toHaveLength(0);
  });

  it('starts a clean stroke on the frames that come after the gap', () => {
    const detector = new StrokeDetector();
    const frames: CanonicalSensorFrame[] = [];
    frames.push(frame(0, { yaw: 90 }));
    frames.push(frame(1000, { yaw: 90 }));
    for (let t = 1050; t <= 1200; t += 50) frames.push(frame(t, { yaw: 90 }));
    for (let t = 1250; t <= 1700; t += 50) frames.push(frame(t, {}));

    const [event] = play(detector, frames);
    expect(event?.angleDeg).toBeGreaterThan(15);
    expect(event?.durationMs).toBeLessThanOrEqual(200);
  });
});

describe('starting over', () => {
  it('forgets the stroke in progress and the one before it on reset', () => {
    const detector = new StrokeDetector();
    play(detector, putt({ peakRate: 120, angleDeg: 20, stepMs: 1000 / PHONE_HZ }));
    detector.reset();

    const [out] = play(
      detector,
      putt({ peakRate: 120, angleDeg: 20, stepMs: 1000 / PHONE_HZ, startAt: 2000, axis: 'pitch' }),
    );
    expect(out?.angleDeg).toBeGreaterThan(18);
    expect(out?.reversedFromPrevious).toBe(false);
  });
});

describe('recorded traces', () => {
  it('finds no stroke in a phone held still on a real recording', () => {
    expect(replayTrace('real-rest.pmtrace', new StrokeDetector())).toHaveLength(0);
  });

  it('finds none in a phone lying on a table either', () => {
    expect(replayTrace('phone-on-table.pmtrace', new StrokeDetector())).toHaveLength(0);
  });

  it('leaves ten deliberate swings entirely to the swing detector', () => {
    expect(replayTrace('swing-forward.pmtrace', new StrokeDetector())).toHaveLength(0);
  });

  it('never even opens a stroke, because the hand stays under the gate', () => {
    const trace = parseTrace(readFileSync(join(CORPUS, 'real-rest.pmtrace'), 'utf8'));
    let previousTimestamp: number | null = null;
    let worst = 0;
    for (const encoded of trace.frames) {
      const raw = decodeSensor(encoded);
      worst = Math.max(worst, rateMagnitude(normalize(raw, previousTimestamp)));
      previousTimestamp = raw.timestamp;
    }
    // 14.06 deg/s was the worst this hand managed while trying to hold still,
    // so the gate has room for a hand twice as unsteady as the one recorded.
    expect(worst * 2).toBeLessThan(STROKE_GATE_RATE);
  });
});
