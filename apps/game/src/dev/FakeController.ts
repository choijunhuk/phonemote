import {
  BUTTON,
  PLAYER_COLORS,
  SENSOR_FLAG,
  SENSOR_FRAME_VERSION,
  type SensorFrame,
} from '@phonemote/protocol';
import { session } from '../session.js';

/**
 * A keyboard pretending to be a phone (ARCHITECTURE.md 8).
 *
 * It synthesises raw sensor frames and pushes them through the same pipeline
 * the network uses, rather than short-circuiting to GameActions. That makes it
 * useful for more than convenience: a game is playable with no phone in the
 * room, tennis has a second player when only one phone is present, and a
 * normaliser or detector change can be felt immediately without walking over
 * to fetch a device.
 *
 *   ?fake=1        one keyboard player
 *   ?fake=2        two, the second on WASD
 */

const FRAME_MS = 1000 / 60;
/** Well clear of the 1-4 the relay hands out, so it can never collide. */
const FAKE_ID_BASE = 90;

interface Keymap {
  readonly left: string;
  readonly right: string;
  readonly up: string;
  readonly down: string;
  readonly swing: string;
  readonly a: string;
  readonly b: string;
  readonly trigger: string;
  readonly home: string;
}

const PRIMARY: Keymap = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  swing: ' ',
  a: 'z',
  b: 'x',
  trigger: 'c',
  home: 'h',
};

const SECONDARY: Keymap = {
  left: 'a',
  right: 'd',
  up: 'w',
  down: 's',
  swing: 'q',
  a: 'e',
  b: 'r',
  trigger: 'f',
  home: 'g',
};

/** deg/s applied while a direction key is held. */
const TURN_RATE = 90;
/** Degrees of tilt reached at full deflection. */
const TILT_RANGE = 40;
const SWING_PEAK = 90;
const SWING_FRAMES = 9;

class FakePhone {
  private readonly held = new Set<string>();
  private swingFrame = -1;
  private motionSeq = 0;
  private seq = 0;
  private pitch = 0;
  private roll = 0;

  constructor(
    readonly playerId: number,
    private readonly keys: Keymap,
  ) {}

  press(key: string): void {
    if (key === this.keys.swing && this.swingFrame < 0) this.swingFrame = 0;
    this.held.add(key);
  }

  release(key: string): void {
    this.held.delete(key);
  }

  private axis(negative: string, positive: string): number {
    return (this.held.has(positive) ? 1 : 0) - (this.held.has(negative) ? 1 : 0);
  }

  private buttons(): number {
    let mask = 0;
    if (this.held.has(this.keys.a)) mask |= BUTTON.A;
    if (this.held.has(this.keys.b)) mask |= BUTTON.B;
    if (this.held.has(this.keys.trigger)) mask |= BUTTON.TRIGGER;
    if (this.held.has(this.keys.home)) mask |= BUTTON.HOME;
    return mask;
  }

  nextFrame(now: number): SensorFrame {
    const horizontal = this.axis(this.keys.left, this.keys.right);
    const vertical = this.axis(this.keys.down, this.keys.up);

    // Hold a direction and the pose leans that way and stays there, which is
    // what a hand does; releasing lets it fall back to level.
    this.roll = clamp(this.roll + horizontal * 3 - Math.sign(this.roll) * (horizontal === 0 ? 2 : 0), TILT_RANGE);
    this.pitch = clamp(this.pitch + vertical * 3 - Math.sign(this.pitch) * (vertical === 0 ? 2 : 0), TILT_RANGE);

    let acceleration = { x: 0, y: 0, z: 0 };
    if (this.swingFrame >= 0) {
      const shape = Math.sin((this.swingFrame / (SWING_FRAMES - 1)) * Math.PI);
      acceleration = { x: 0, y: 0, z: -shape * SWING_PEAK };
      this.swingFrame = this.swingFrame >= SWING_FRAMES - 1 ? -1 : this.swingFrame + 1;
    }

    this.motionSeq++;
    this.seq++;

    return {
      playerId: this.playerId,
      seq: this.seq,
      timestamp: now,
      // Built from the canonical landscape pose (ARCHITECTURE.md 5.7): alpha 90,
      // beta 0, gamma -90 reads as level and aiming straight ahead.
      orientation: { alpha: 90, beta: this.roll, gamma: -90 - this.pitch },
      rotationRate: {
        alpha: 0,
        beta: -horizontal * TURN_RATE,
        gamma: -vertical * TURN_RATE,
      },
      acceleration,
      buttons: this.buttons(),
      screenOrientation: 1,
      version: SENSOR_FRAME_VERSION,
      motionSeq: this.motionSeq,
      flags: SENSOR_FLAG.LINEAR_ACCEL | SENSOR_FLAG.ROTATION_RATE | SENSOR_FLAG.ORIENTATION,
    };
  }
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

export function startFakeControllers(count: number): void {
  const keymaps = [PRIMARY, SECONDARY].slice(0, Math.max(1, Math.min(2, count)));
  const phones = keymaps.map((keys, index) => {
    const playerId = FAKE_ID_BASE + index;
    session.addLocalPlayer({
      id: playerId,
      name: `KB${index + 1}`,
      color: PLAYER_COLORS[index % PLAYER_COLORS.length] ?? '#ffffff',
    });
    return new FakePhone(playerId, keys);
  });

  window.addEventListener('keydown', (event) => {
    for (const phone of phones) phone.press(event.key);
  });
  window.addEventListener('keyup', (event) => {
    for (const phone of phones) phone.release(event.key);
  });

  window.setInterval(() => {
    const now = performance.now();
    for (const phone of phones) session.injectFrame(phone.nextFrame(now));
  }, FRAME_MS);

  console.log(
    `[fake] ${phones.length} keyboard controller(s): arrows/space/zxc/h` +
      (phones.length > 1 ? ' and wasd/q/erf/g' : ''),
  );
}
