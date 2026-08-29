import { BUTTON, type ButtonName, type SensorFrame } from '@phonemote/protocol';
import { normalize } from './SensorNormalizer.js';
import { PointerMode, type PointerOptions } from './PointerMode.js';
import { SwingDetector } from './SwingDetector.js';
import { TiltMode, type TiltOptions } from './TiltMode.js';
import type { CanonicalSensorFrame, GameAction } from './types.js';

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
  readonly tilt?: TiltOptions | false;
}

const BUTTON_ENTRIES = Object.entries(BUTTON) as ReadonlyArray<[ButtonName, number]>;

interface PlayerState {
  lastTimestamp: number | null;
  buttons: number;
  lastCanonical: CanonicalSensorFrame | null;
  pointer: PointerMode | null;
  swing: SwingDetector | null;
  tilt: TiltMode | null;
  calibrationPending: boolean;
}

export class InputMapper {
  private readonly players = new Map<number, PlayerState>();

  constructor(private readonly config: InputMapperConfig = {}) {}

  private stateFor(playerId: number): PlayerState {
    const existing = this.players.get(playerId);
    if (existing) return existing;

    const created: PlayerState = {
      lastTimestamp: null,
      buttons: 0,
      lastCanonical: null,
      pointer:
        this.config.pointer === false || this.config.pointer === undefined
          ? null
          : new PointerMode(this.config.pointer),
      swing: this.config.swing === true ? new SwingDetector() : null,
      tilt:
        this.config.tilt === false || this.config.tilt === undefined
          ? null
          : new TiltMode(this.config.tilt),
      calibrationPending: false,
    };
    this.players.set(playerId, created);
    return created;
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

  removePlayer(playerId: number): void {
    this.players.delete(playerId);
  }

  update(frame: SensorFrame): GameAction[] {
    const state = this.stateFor(frame.playerId);
    const canonical = normalize(frame, state.lastTimestamp);
    state.lastTimestamp = frame.timestamp;
    state.lastCanonical = canonical;

    const actions: GameAction[] = [];

    for (const [name, bit] of BUTTON_ENTRIES) {
      const wasDown = (state.buttons & bit) !== 0;
      const isDown = (canonical.buttons & bit) !== 0;
      if (wasDown === isDown) continue;
      actions.push({
        kind: isDown ? 'button_down' : 'button_up',
        playerId: canonical.playerId,
        button: name,
      });
      // HOME re-centres the pointer; drift is expected and this is the cure.
      if (isDown && name === 'HOME') state.pointer?.reset();
    }
    state.buttons = canonical.buttons;

    if (state.calibrationPending && state.tilt) {
      state.tilt.calibrate(canonical);
      state.calibrationPending = false;
    }

    if (state.pointer) {
      const { x, y } = state.pointer.update(canonical);
      actions.push({ kind: 'pointer_move', playerId: canonical.playerId, x, y });
    }

    if (state.tilt) {
      const { x, y } = state.tilt.update(canonical);
      actions.push({ kind: 'tilt', playerId: canonical.playerId, x, y });
    }

    if (state.swing) {
      const swing = state.swing.update(canonical);
      if (swing) actions.push({ kind: 'swing', ...swing });
    }

    return actions;
  }
}
