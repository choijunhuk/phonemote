import { SCREEN_ORIENTATION, type EulerAngles, type ScreenOrientationValue, type Vector3 } from '@phonemote/protocol';

/**
 * Raw sensor capture (ARCHITECTURE.md 7.2).
 *
 * The phone caches whatever the events last reported and nothing else: no
 * smoothing, no axis correction, no idea what the game is. The PC decides what
 * any of it means.
 *
 * Target is Android Chrome only, so there is no iOS permission branch here.
 */

export interface SensorSnapshot {
  readonly orientation: EulerAngles;
  readonly rotationRate: EulerAngles;
  readonly acceleration: Vector3;
  /** What is sent on the wire, after any hold override. */
  readonly screenOrientation: ScreenOrientationValue;
  /** What the browser actually reported, for the debug readout. */
  readonly reportedOrientation: ScreenOrientationValue;
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

export interface SupportReport {
  readonly supported: boolean;
  readonly missing: readonly string[];
}

const ZERO_ANGLES: EulerAngles = { alpha: 0, beta: 0, gamma: 0 };
const ZERO_VECTOR: Vector3 = { x: 0, y: 0, z: 0 };

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

  /** Set once either event has been seen, so the UI can say "no data yet". */
  private seenMotion = false;
  private seenOrientation = false;

  private readonly onOrientation = (event: DeviceOrientationEvent): void => {
    this.seenOrientation = true;
    this.orientation = {
      alpha: event.alpha ?? 0,
      beta: event.beta ?? 0,
      gamma: event.gamma ?? 0,
    };
  };

  private readonly onMotion = (event: DeviceMotionEvent): void => {
    this.seenMotion = true;
    const rate = event.rotationRate;
    if (rate) {
      this.rotationRate = { alpha: rate.alpha ?? 0, beta: rate.beta ?? 0, gamma: rate.gamma ?? 0 };
    }
    const acceleration = event.acceleration;
    if (acceleration) {
      this.acceleration = {
        x: acceleration.x ?? 0,
        y: acceleration.y ?? 0,
        z: acceleration.z ?? 0,
      };
    }
  };

  setHoldMode(mode: HoldMode): void {
    this.holdMode = mode;
  }

  get isReceiving(): boolean {
    return this.seenMotion && this.seenOrientation;
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

  read(): SensorSnapshot {
    const reported = screenOrientationValue();
    const applied: ScreenOrientationValue =
      this.holdMode === 'landscape' ? 1 : this.holdMode === 'portrait' ? 0 : reported;
    return {
      orientation: this.orientation,
      rotationRate: this.rotationRate,
      acceleration: this.acceleration,
      screenOrientation: applied,
      reportedOrientation: reported,
    };
  }
}
