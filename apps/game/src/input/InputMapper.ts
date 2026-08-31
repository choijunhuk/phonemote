import { BUTTON, type ButtonName, type SensorFrame } from '@phonemote/protocol';
import { ComplementaryFilter, type FusionOptions } from './ComplementaryFilter.js';
import { normalize } from './SensorNormalizer.js';
import { PointerMode, type PointerOptions } from './PointerMode.js';
import { SwingDetector } from './SwingDetector.js';
import { TiltMode, type TiltOptions } from './TiltMode.js';
import type { CanonicalAngles, CanonicalSensorFrame, GameAction } from './types.js';

/**
 * Turns canonical frames into the GameAction stream scenes consume
 * (ARCHITECTURE.md 7.3). Scenes never see anything upstream of this.
 *
 * Button edges are produced here, not on the phone: the phone reports the
 * current mask and this compares it with the previous frame, so a dropped
 * packet cannot strand a button in the "held" state forever.
 */

export interface InputMapperConfig {
  readonly pointer?: PointerOptions | false;
  readonly swing?: boolean;
  /** Emit the gravity direction every frame, for pose-holding games. */
  readonly pose?: boolean;
  readonly tilt?: TiltOptions | false;
  /**
   * Fuse gyro with gravity before the modes see the pose. On by default: it
   * costs nothing and takes the shake out of tilt. The debug overlay keeps
   * showing the unfused canonical values, so the axis check stays honest.
   */
  readonly fusion?: FusionOptions | false;
}

export interface PlayerInputState {
  /** True while the phone is resending a reading its sensors already gave. */
  readonly sensorStalled: boolean;
  readonly motionSeq: number;
}

const BUTTON_ENTRIES = Object.entries(BUTTON) as ReadonlyArray<[ButtonName, number]>;

interface PlayerState {
  lastTimestamp: number | null;
  /** For the trapezoid step (ARCHITECTURE.md D39). */
  lastRate: CanonicalAngles | null;
  lastMotionSeq: number | null;
  stalled: boolean;
  buttons: number;
  lastCanonical: CanonicalSensorFrame | null;
  lastFused: CanonicalSensorFrame | null;
  pointer: PointerMode | null;
  swing: SwingDetector | null;
  tilt: TiltMode | null;
  fusion: ComplementaryFilter | null;
  calibrationPending: boolean;
}

export class InputMapper {
  private readonly players = new Map<number, PlayerState>();

  constructor(private config: InputMapperConfig = {}) {}

  private makePointer(): PointerMode | null {
    const { pointer } = this.config;
    return pointer === false || pointer === undefined ? null : new PointerMode(pointer);
  }

  private makeTilt(): TiltMode | null {
    const { tilt } = this.config;
    return tilt === false || tilt === undefined ? null : new TiltMode(tilt);
  }

  private makeFusion(): ComplementaryFilter | null {
    return this.config.fusion === false ? null : new ComplementaryFilter(this.config.fusion);
  }

  private stateFor(playerId: number): PlayerState {
    const existing = this.players.get(playerId);
    if (existing) return existing;

    const created: PlayerState = {
      lastTimestamp: null,
      lastRate: null,
      lastMotionSeq: null,
      stalled: false,
      buttons: 0,
      lastCanonical: null,
      lastFused: null,
      pointer: this.makePointer(),
      swing: this.config.swing === true ? new SwingDetector() : null,
      tilt: this.makeTilt(),
      fusion: this.makeFusion(),
      calibrationPending: false,
    };
    this.players.set(playerId, created);
    return created;
  }

  /**
   * Turns modes on and off in place.
   *
   * Rebuilding the mapper between scenes used to throw away the tilt
   * calibration the previous scene had just taken, along with the fused pose,
   * the swing cooldown and the frame timing. That is why the calibration
   * screen was pure ceremony.
   */
  setConfig(config: InputMapperConfig): void {
    this.config = config;
    for (const state of this.players.values()) {
      // The pointer is per-scene state and starts centred. The modes that carry
      // a calibration or an integrated pose are kept when still wanted.
      state.pointer = this.makePointer();
      state.swing = this.config.swing === true ? (state.swing ?? new SwingDetector()) : null;
      state.tilt = this.makeTilt() === null ? null : (state.tilt ?? this.makeTilt());
      state.fusion = this.config.fusion === false ? null : (state.fusion ?? this.makeFusion());
    }
  }

  /** Takes the next frame from this player as the tilt centre. */
  requestCalibration(playerId: number): void {
    this.stateFor(playerId).calibrationPending = true;
  }

  resetPointer(playerId: number): void {
    this.stateFor(playerId).pointer?.reset();
  }

  /** For the debug overlay, which shows raw and canonical side by side. */
  lastCanonical(playerId: number): CanonicalSensorFrame | null {
    return this.players.get(playerId)?.lastCanonical ?? null;
  }

  /** The fused pose the modes actually consumed, when fusion is enabled. */
  lastFused(playerId: number): CanonicalSensorFrame | null {
    return this.players.get(playerId)?.lastFused ?? null;
  }

  /** Whether this player's phone is still producing new sensor readings. */
  inputState(playerId: number): PlayerInputState {
    const state = this.players.get(playerId);
    return { sensorStalled: state?.stalled ?? false, motionSeq: state?.lastMotionSeq ?? 0 };
  }

  removePlayer(playerId: number): void {
    this.players.delete(playerId);
  }

  update(frame: SensorFrame): GameAction[] {
    const state = this.stateFor(frame.playerId);
    const actions: GameAction[] = [];

    // Buttons come from the touchscreen, not the motion sensor, so they are
    // still meaningful on a frame whose sensor reading is a repeat.
    for (const [name, bit] of BUTTON_ENTRIES) {
      const wasDown = (state.buttons & bit) !== 0;
      const isDown = (frame.buttons & bit) !== 0;
      if (wasDown === isDown) continue;
      actions.push({
        kind: isDown ? 'button_down' : 'button_up',
        playerId: frame.playerId,
        button: name,
      });
      // HOME re-centres the pointer; drift is expected and this is the cure.
      if (isDown && name === 'HOME') state.pointer?.reset();
    }
    state.buttons = frame.buttons;

    // A repeated motionSeq means the phone sent a keep-alive carrying a reading
    // its sensors already produced. Integrating it would turn a dead sensor into
    // drift, and a frozen |a| sitting above the threshold into an endless train
    // of phantom swings, all while the stream still reads a healthy 60 Hz.
    const stale = state.lastMotionSeq !== null && frame.motionSeq === state.lastMotionSeq;
    state.stalled = stale;
    state.lastMotionSeq = frame.motionSeq;
    if (stale) return actions;

    const canonical = normalize(frame, state.lastTimestamp, state.lastRate);
    state.lastTimestamp = frame.timestamp;
    state.lastRate = canonical.angularVelocity;
    state.lastCanonical = canonical;

    // Modes read the fused pose; the raw canonical one is kept for the overlay.
    const fused = state.fusion
      ? { ...canonical, orientation: state.fusion.update(canonical) }
      : canonical;
    state.lastFused = fused;

    if (state.calibrationPending && state.tilt) {
      state.tilt.calibrate(fused);
      state.calibrationPending = false;
    }

    if (state.pointer) {
      const { x, y } = state.pointer.update(fused);
      actions.push({ kind: 'pointer_move', playerId: canonical.playerId, x, y });
    }

    if (state.tilt) {
      const { x, y } = state.tilt.update(fused);
      actions.push({ kind: 'tilt', playerId: canonical.playerId, x, y });
    }

    if (this.config.pose === true) {
      actions.push({ kind: 'pose', playerId: canonical.playerId, up: canonical.up });
    }

    if (state.swing) {
      const swing = state.swing.update(fused);
      if (swing) actions.push({ kind: 'swing', ...swing });
    }

    return actions;
  }
}
