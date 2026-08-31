import { normalise } from './pose.js';
import type { CanonicalAngles, CanonicalSensorFrame, CanonicalVector } from './types.js';

/**
 * Stroke detection: the slow-motion sibling of SwingDetector
 * (ARCHITECTURE.md 7.3).
 *
 * A putt, a half swing and a deliberate roll all live between 40 and 300 deg/s,
 * which is precisely the band SwingDetector throws away. It starts a burst at
 * 400 because a single 300 deg/s gate fired twelve times on the real phone for
 * gestures that were not swings — laying it down, standing it on end, tilting
 * it (ARCHITECTURE.md D40).
 *
 * The reason this cannot be that detector with a lower threshold is that a putt
 * has no threshold to cross. It is a slow out-and-back, and the only feature in
 * it that is not an arbitrary line is the moment the hand turns around. So the
 * segmentation here is by SIGN REVERSAL of the rotation about the stroke's own
 * axis, with a quiet period as the fallback for a stroke that simply stops
 * instead of turning back.
 *
 * Everything else follows from that. The rate gate decides when to start
 * looking, not what a stroke is, so it sits as low as the measured hand noise
 * allows rather than wherever a putt happens to peak. And the number a putting
 * game reads is `angleDeg`: a putt's distance comes from how far the club went
 * back, not from how fast it moved, which is the opposite of a swing.
 */

/**
 * deg/s at which rotation starts being accumulated.
 *
 * A floor, not a definition, so it is set as low as the hand allows rather than
 * anywhere a putt lives. A hand trying to hold still measured a mean |omega| of
 * 3.34 deg/s over the whole rest recording, median 2.11, with its single
 * largest excursion at 14.1; a phone on a table gives 0.17 per axis. 30 is more
 * than twice that worst excursion, and far below the 297 deg/s the softest
 * real swing reached.
 *
 * Not higher, because the gate costs angle at both ends of every stroke and a
 * putt near the bottom of its 40-300 deg/s band spends most of its time under
 * any gate at all. A synthetic 20 degree out-and-back peaking at 40 deg/s reads
 * 13.4 degrees with the gate at 35 and 16.4 with it at 30; one peaking at 60
 * reads 18.0 against 19.3. Nothing above 120 deg/s peak moves at all between
 * the two. 25 would recover another degree at the very bottom and leave under
 * twice the hand's worst excursion, which is not a trade worth making.
 */
export const STROKE_GATE_RATE = 30;

/**
 * deg/s against the stroke's own axis that counts as having turned around.
 *
 * Not zero. Every stroke decays through zero at its own ending, and per-axis
 * gyro noise at rest is 0.68-1.30 deg/s sd, so a bare sign test would chop the
 * tail of every stroke into fragments. The largest single-axis rate a hand
 * trying to hold still produced was 11.3 deg/s, so 15 is clear of the hand and
 * still only half the start gate — the turn is called as early as it can be
 * believed rather than as late as it is obvious.
 */
export const STROKE_REVERSAL_RATE = 15;

/**
 * ms below the gate that ends a stroke which never turned around.
 *
 * It has to survive one slow packet. The real recordings arrive at a 51-55 ms
 * median interval, and at 15 Hz — the slowest rate this has to behave at — a
 * frame is 67 ms. 120 ms is two frames there and twelve at 100 Hz, so no single
 * gap ends a stroke at any rate the phone might send.
 */
export const STROKE_QUIET_MS = 120;

/**
 * Degrees below which a segment is not reported at all.
 *
 * The reversal test can fire on the ragged end of a real stroke and open a
 * fragment that then dies at the quiet timeout. A hand at its measured mean of
 * 3.34 deg/s covers 0.4 degrees in that 120 ms and at its worst excursion of
 * 14.1 covers 1.7, so 3 degrees is above anything a fragment can hold and well
 * below the smallest motion a player would call a putt.
 */
export const STROKE_MIN_ANGLE_DEG = 3;

/**
 * deg/s above which the gesture belongs to SwingDetector and nothing is said.
 *
 * Suppressed rather than marked. Both detectors read the same frames, so a
 * gesture over the line would otherwise arrive twice — a putt and a drive out
 * of one motion — and a stroke event carries nothing that would help a scene
 * choose between them, while SwingDetector's own event already describes that
 * gesture better. Marking would push the same decision into every scene, and
 * every scene would make it the same way.
 *
 * The line is where the two bands stop overlapping, not where SwingDetector
 * starts. Real swings measured 297-1211 deg/s and putts 40-300, so 300-400 is
 * genuinely both; cutting there would leave a firm putt producing nothing at
 * all, because the swing detector needs 400 to start. Letting both fire in the
 * overlap costs nothing: a scene turns on one detector or the other.
 */
export const STROKE_MAX_PEAK_RATE = 400;

/**
 * ms within which one stroke can be called a reversal of the one before it.
 *
 * An out-and-back split at its own turn-around has a gap of a single frame, so
 * this only decides the pair a player separates with a pause at the top of the
 * backswing. It has to clear the 120 ms quiet fallback plus the time a slow
 * return takes to climb back through the gate, and stay short enough that two
 * unrelated gestures are not read as one stroke.
 */
export const STROKE_LINK_MS = 800;

/**
 * Longest step the integrator will trust, in ms.
 *
 * A putt's whole meaning is its integrated angle, so a gap with unmeasured
 * rotation inside it cannot be papered over — the stroke is abandoned rather
 * than reported at a size nobody measured. 200 ms is three frames at 15 Hz, the
 * slowest rate this has to work at.
 */
export const STROKE_MAX_STEP_MS = 200;

export interface StrokeOptions {
  /** deg/s above which rotation starts being accumulated. */
  readonly gateRate?: number;
  /** deg/s against the stroke's axis that ends it as a turn-around. */
  readonly reversalRate?: number;
  /** ms below the gate that ends a stroke which stopped instead of turning. */
  readonly quietMs?: number;
  /** Degrees below which a segment is dropped. */
  readonly minAngleDeg?: number;
  /** deg/s above which the gesture is left to SwingDetector. */
  readonly maxPeakRate?: number;
  /** ms within which two strokes can be called reversals of each other. */
  readonly linkMs?: number;
}

export interface StrokeEvent {
  readonly playerId: number;
  /** Integrated rotation magnitude about the dominant axis, in degrees. */
  readonly angleDeg: number;
  /** The dominant axis, unit length, in canonical axes. */
  readonly axis: CanonicalVector;
  readonly durationMs: number;
  readonly peakRate: number;
  /** This stroke turned back on the one before it. */
  readonly reversedFromPrevious: boolean;
  readonly timestamp: number;
}

/**
 * yaw/pitch/roll as a rotation vector in canonical axes.
 *
 * The aviation convention names each rate for the body axis it turns about, and
 * two of those three point the other way from the canonical ones: yaw is about
 * down (-Y) and roll is about the phone's aim (-Z), while pitch is about right
 * (+X). This is the inverse of the mapping SensorNormalizer applies, and it is
 * what lets a rotation be added, projected and normalised like any other
 * vector — which is the whole reason the dominant axis here is one vector
 * rather than a choice between three channels.
 */
export function angularVector(angles: CanonicalAngles): CanonicalVector {
  return { x: angles.pitch, y: -angles.yaw, z: -angles.roll };
}

/**
 * The average of two consecutive rates, which is the trapezoid rule.
 *
 * `CanonicalSensorFrame.rateStep` already carries this wherever the normaliser
 * had a previous frame to average against; this rebuilds it from the sample
 * this detector saw last when it does not. Multiplying the instantaneous rate
 * by dt instead is the rectangle rule, and against ground truth recovered from
 * the orientation matrix it cost 115 deg/s of per-step rate error on the
 * fastest axis where the trapezoid costs 47, and twice the open-loop attitude
 * error (ARCHITECTURE.md D39).
 */
export function trapezoidRate(
  rate: CanonicalAngles,
  previous: CanonicalAngles | null,
): CanonicalAngles {
  if (previous === null) return rate;
  return {
    yaw: (rate.yaw + previous.yaw) / 2,
    pitch: (rate.pitch + previous.pitch) / 2,
    roll: (rate.roll + previous.roll) / 2,
  };
}

function dot(a: CanonicalVector, b: CanonicalVector): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

interface Sample {
  readonly timestamp: number;
  readonly rate: CanonicalAngles;
  /** Instantaneous rotation vector; what the gate and the sign test read. */
  readonly omega: CanonicalVector;
  /** Average rotation vector across the step ending here; what is integrated. */
  readonly step: CanonicalVector;
  readonly magnitude: number;
}

interface Capture {
  readonly startedAt: number;
  /** Last sample above the gate. The quiet tail is how a stroke ends, not part of it. */
  lastMovingAt: number;
  peak: number;
  /** Direction of the fastest sample so far; the reference for the sign test. */
  axis: CanonicalVector;
  /** Integrated rotation so far, in degrees, in canonical axes. */
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  quietSince: number | null;
}

export class StrokeDetector {
  private readonly gateRate: number;
  private readonly reversalRate: number;
  private readonly quietMs: number;
  private readonly minAngleDeg: number;
  private readonly maxPeakRate: number;
  private readonly linkMs: number;

  private capture: Capture | null = null;
  private previous: Sample | null = null;
  /** The last stroke actually reported, for the reversal flag. */
  private last: { at: number; axis: CanonicalVector } | null = null;

  constructor(options: StrokeOptions = {}) {
    this.gateRate = options.gateRate ?? STROKE_GATE_RATE;
    this.reversalRate = options.reversalRate ?? STROKE_REVERSAL_RATE;
    this.quietMs = options.quietMs ?? STROKE_QUIET_MS;
    this.minAngleDeg = options.minAngleDeg ?? STROKE_MIN_ANGLE_DEG;
    this.maxPeakRate = options.maxPeakRate ?? STROKE_MAX_PEAK_RATE;
    this.linkMs = options.linkMs ?? STROKE_LINK_MS;
  }

  update(frame: CanonicalSensorFrame): StrokeEvent | null {
    const previous = this.previous;
    const previousRate = previous === null ? null : previous.rate;
    const omega = angularVector(frame.angularVelocity);
    const sample: Sample = {
      timestamp: frame.timestamp,
      rate: frame.angularVelocity,
      omega,
      step: angularVector(frame.rateStep ?? trapezoidRate(frame.angularVelocity, previousRate)),
      magnitude: Math.hypot(omega.x, omega.y, omega.z),
    };
    this.previous = sample;

    if (previous !== null) {
      const gap = sample.timestamp - previous.timestamp;
      if (gap <= 0 || gap > STROKE_MAX_STEP_MS) {
        // Rotation happened across that gap and nothing here can say how much.
        // Reporting the stroke anyway would hand a putting game a distance that
        // was never measured, which is worse than handing it nothing.
        this.capture = null;
        return null;
      }
    }

    const capture = this.capture;
    if (capture === null) {
      if (sample.magnitude <= this.gateRate) return null;
      this.capture = this.open(sample, previous);
      return null;
    }

    // The sign test reads the instantaneous rate, not the step average: the
    // average straddles the turn and so flips half a frame late.
    if (dot(sample.omega, capture.axis) < -this.reversalRate) {
      const event = this.finish(capture, frame);
      // The step that straddles the turn goes to the stroke that is starting.
      // Charging it to the one that just ended subtracts from the very number a
      // putt's distance is read from, and an out-and-back is one continuous
      // motion: waiting for the return to climb back through the gate would
      // throw away its opening ramp as well.
      this.capture = this.open(sample, previous);
      return event;
    }

    this.accumulate(capture, sample, previous);

    if (sample.magnitude > this.gateRate) {
      capture.quietSince = null;
      capture.lastMovingAt = sample.timestamp;
    } else if (capture.quietSince === null) {
      capture.quietSince = sample.timestamp;
    }

    if (capture.quietSince !== null && sample.timestamp - capture.quietSince >= this.quietMs) {
      this.capture = null;
      return this.finish(capture, frame);
    }
    return null;
  }

  /**
   * The stroke starts at the sample before the one that crossed the gate.
   *
   * That step is rotation the player made, and the ramp up through the gate is
   * a real share of the answer: on a 20 degree putt peaking at 120 deg/s,
   * sampled at the 20 Hz the phone records at, it is 1.7 of the 19.3 degrees
   * reported.
   */
  private open(sample: Sample, previous: Sample | null): Capture {
    const capture: Capture = {
      startedAt: previous === null ? sample.timestamp : previous.timestamp,
      lastMovingAt: sample.timestamp,
      peak: 0,
      axis: normalise(sample.omega),
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
      quietSince: null,
    };
    this.accumulate(capture, sample, previous);
    return capture;
  }

  private accumulate(capture: Capture, sample: Sample, previous: Sample | null): void {
    const dt = previous === null ? 0 : Math.max(0, sample.timestamp - previous.timestamp) / 1000;
    capture.rotationX += sample.step.x * dt;
    capture.rotationY += sample.step.y * dt;
    capture.rotationZ += sample.step.z * dt;

    if (sample.magnitude > capture.peak) {
      capture.peak = sample.magnitude;
      // The fastest sample is where the axis is least polluted by hand tremor,
      // and nothing can have reversed yet while the stroke is still speeding up.
      capture.axis = normalise(sample.omega);
    }
  }

  private finish(capture: Capture, frame: CanonicalSensorFrame): StrokeEvent | null {
    const rotation: CanonicalVector = {
      x: capture.rotationX,
      y: capture.rotationY,
      z: capture.rotationZ,
    };
    const angleDeg = Math.hypot(rotation.x, rotation.y, rotation.z);

    // A fragment, usually the reversal test firing on a stroke's own ragged
    // end. `last` is deliberately left alone: dropping the fragment must not
    // break the link between the two real strokes on either side of it.
    if (angleDeg < this.minAngleDeg) return null;

    if (capture.peak > this.maxPeakRate) {
      // Forgetting the last stroke as well, so the recovery motion after a
      // swing is not announced as the reversal of a putt nobody was told about.
      this.last = null;
      return null;
    }

    const axis = normalise(rotation);
    const event: StrokeEvent = {
      playerId: frame.playerId,
      angleDeg,
      axis,
      durationMs: capture.lastMovingAt - capture.startedAt,
      peakRate: capture.peak,
      reversedFromPrevious: this.reversedFromLast(frame.timestamp, axis),
      timestamp: frame.timestamp,
    };
    this.last = { at: frame.timestamp, axis };
    return event;
  }

  /**
   * Compared against the last stroke reported, not against how this one ended.
   *
   * A pair split by the quiet fallback — a player who pauses at the top of the
   * backswing — is just as much a reversal as one split at the turn-around, and
   * only the axes can say so.
   */
  private reversedFromLast(now: number, axis: CanonicalVector): boolean {
    const last = this.last;
    if (last === null || now - last.at > this.linkMs) return false;
    return dot(last.axis, axis) < 0;
  }

  reset(): void {
    this.capture = null;
    this.previous = null;
    this.last = null;
  }
}
