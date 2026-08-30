import {
  SCREEN_ORIENTATION,
  SENSOR_FLAG,
  SENSOR_MAX_SEND_HZ,
  type EulerAngles,
  type ScreenOrientationValue,
  type Vector3,
} from '@phonemote/protocol';

/**
 * Raw sensor capture (ARCHITECTURE.md 7.2).
 *
 * The phone caches whatever the events last reported and nothing else: no
 * smoothing, no axis correction, no idea what the game is. The PC decides what
 * any of it means.
 *
 * Frames are emitted from the devicemotion event rather than from a rAF loop.
 * Sending on rAF meant a phone whose sensors had stalled kept shipping its
 * cached reading with a fresh timestamp, and the PC integrated dead angular
 * velocity against live dt.
 *
 * Target is Android Chrome only, so there is no iOS permission branch here.
 */

export interface SensorSnapshot {
  readonly orientation: EulerAngles;
  readonly rotationRate: EulerAngles;
  readonly acceleration: Vector3;
  /** The event's own timestamp, on the phone's performance.now() origin. */
  readonly timestamp: number;
  /** Counts devicemotion events; the ground truth for "is the sensor alive". */
  readonly motionSeq: number;
  /** What is sent on the wire, after any hold override. */
  readonly screenOrientation: ScreenOrientationValue;
  /** What the browser actually reported, for the debug readout. */
  readonly reportedOrientation: ScreenOrientationValue;
  readonly flags: number;
}

export interface SupportReport {
  readonly supported: boolean;
  readonly missing: readonly string[];
}

/**
 * How the player is holding the phone.
 *
 * 'auto' trusts screen.orientation, which is the honest answer but a lie
 * whenever rotation lock is on: Chrome keeps reporting portrait-primary no
 * matter how the phone is physically held, and the normaliser then rotates the
 * axes by 90 degrees too few, swapping pitch and roll. Since the canonical pose
 * is landscape anyway (ARCHITECTURE.md 5.1), stating the hold is both safer and
 * more truthful than trusting a value the OS refuses to update.
 */
export type HoldMode = 'auto' | 'landscape' | 'portrait';

const ZERO_ANGLES: EulerAngles = { alpha: 0, beta: 0, gamma: 0 };
const ZERO_VECTOR: Vector3 = { x: 0, y: 0, z: 0 };
const MIN_SEND_INTERVAL_MS = 1000 / SENSOR_MAX_SEND_HZ;

export function checkSupport(): SupportReport {
  const missing: string[] = [];
  if (!window.isSecureContext) missing.push('secure context (HTTPS)');
  if (!('DeviceMotionEvent' in window)) missing.push('DeviceMotionEvent');
  if (!('DeviceOrientationEvent' in window)) missing.push('DeviceOrientationEvent');
  return { supported: missing.length === 0, missing };
}

function screenOrientationValue(): ScreenOrientationValue {
  const type = screen.orientation?.type;
  if (type && type in SCREEN_ORIENTATION) {
    return SCREEN_ORIENTATION[type as keyof typeof SCREEN_ORIENTATION];
  }
  return 0;
}

export class SensorSource {
  private holdMode: HoldMode = 'landscape';
  private orientation: EulerAngles = ZERO_ANGLES;
  private rotationRate: EulerAngles = ZERO_ANGLES;
  private acceleration: Vector3 = ZERO_VECTOR;
  private started = false;

  private motionSeq = 0;
  private lastEventTimestamp = 0;
  private lastEventAtMs = 0;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private capabilities = 0;
  private listener: ((snapshot: SensorSnapshot) => void) | null = null;

  private readonly onOrientation = (event: DeviceOrientationEvent): void => {
    this.capabilities |= SENSOR_FLAG.ORIENTATION;
    this.orientation = {
      alpha: event.alpha ?? 0,
      beta: event.beta ?? 0,
      gamma: event.gamma ?? 0,
    };
  };

  private readonly onMotion = (event: DeviceMotionEvent): void => {
    this.motionSeq++;
    // The event's own clock, not the moment we got round to sending.
    this.lastEventTimestamp = event.timeStamp;
    this.lastEventAtMs = performance.now();

    const rate = event.rotationRate;
    if (rate && (rate.alpha !== null || rate.beta !== null || rate.gamma !== null)) {
      this.capabilities |= SENSOR_FLAG.ROTATION_RATE;
      this.rotationRate = { alpha: rate.alpha ?? 0, beta: rate.beta ?? 0, gamma: rate.gamma ?? 0 };
    }

    const acceleration = event.acceleration;
    if (acceleration && (acceleration.x !== null || acceleration.y !== null)) {
      // Some devices report no gravity-excluded acceleration at all. Saying so
      // is better than a swing detector that silently never fires.
      this.capabilities |= SENSOR_FLAG.LINEAR_ACCEL;
      this.acceleration = {
        x: acceleration.x ?? 0,
        y: acceleration.y ?? 0,
        z: acceleration.z ?? 0,
      };
    }

    const now = performance.now();
    if (now - this.lastEmitAt < MIN_SEND_INTERVAL_MS) return;
    this.lastEmitAt = now;
    this.listener?.(this.read());
  };

  /** Called once per devicemotion event, capped at SENSOR_MAX_SEND_HZ. */
  onFrame(listener: (snapshot: SensorSnapshot) => void): void {
    this.listener = listener;
  }

  setHoldMode(mode: HoldMode): void {
    this.holdMode = mode;
  }

  get isReceiving(): boolean {
    const needed = SENSOR_FLAG.ORIENTATION | SENSOR_FLAG.ROTATION_RATE;
    return (this.capabilities & needed) === needed;
  }

  get eventCount(): number {
    return this.motionSeq;
  }

  /** performance.now() of the last devicemotion event, for stall detection. */
  get lastEventAt(): number {
    return this.lastEventAtMs;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('deviceorientation', this.onOrientation);
    window.addEventListener('devicemotion', this.onMotion);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    window.removeEventListener('deviceorientation', this.onOrientation);
    window.removeEventListener('devicemotion', this.onMotion);
  }

  /** Re-attaches the listeners; Android sometimes stops delivering after a
   * spell in the background and a fresh registration brings them back. */
  restart(): void {
    this.stop();
    this.start();
  }

  read(): SensorSnapshot {
    const reported = screenOrientationValue();
    const applied: ScreenOrientationValue =
      this.holdMode === 'landscape' ? 1 : this.holdMode === 'portrait' ? 0 : reported;
    return {
      orientation: this.orientation,
      rotationRate: this.rotationRate,
      acceleration: this.acceleration,
      timestamp: this.lastEventTimestamp,
      motionSeq: this.motionSeq,
      screenOrientation: applied,
      reportedOrientation: reported,
      flags:
        this.capabilities | (this.holdMode === 'auto' ? 0 : SENSOR_FLAG.HOLD_OVERRIDE),
    };
  }
}
