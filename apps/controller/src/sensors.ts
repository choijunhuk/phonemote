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
  readonly screenOrientation: ScreenOrientationValue;
}

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
    return {
      orientation: this.orientation,
      rotationRate: this.rotationRate,
      acceleration: this.acceleration,
      screenOrientation: screenOrientationValue(),
    };
  }
}
