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

/** Four keyboards, because four phones at once is the biggest untested claim here. */
const THIRD: Keymap = {
  left: 'j',
  right: 'l',
  up: 'i',
  down: 'k',
  swing: 'u',
  a: 'o',
  b: 'p',
  trigger: ';',
  home: "'",
};

const FOURTH: Keymap = {
  left: '4',
  right: '6',
  up: '8',
  down: '2',
  swing: '5',
  a: '7',
  b: '9',
  trigger: '1',
  home: '3',
};

/** deg/s applied while a direction key is held. */
const TURN_RATE = 90;
/**
 * Full deflection has to reach the poses the games ask for: Freeze Frame calls
 * for ninety and a hundred and eighty degrees, and at forty they were not
 * reachable from a keyboard at all.
 */
const TILT_RANGE = 180;
/**
 * Swings are segmented on angular velocity, so a keyboard swing has to be one.
 * It used to be modelled as acceleration alone, which after that change could
 * never arm the detector — the keyboard could not swing, and nobody had played
 * tennis without a phone since.
 */
/** Degrees per frame while a direction is held: 90 degrees in half a second. */
const TILT_STEP = 3;
const SWING_PEAK_RATE = 950;
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

    // Hold a direction to lean that way; let go and it stays there, because a
    // phone stays where a hand puts it. It used to spring back to level, which
    // meant no pose could be held at all — Freeze Frame was unplayable from the
    // keyboard, and a stand-in that cannot do what the real thing does is not
    // much of a stand-in. The trigger key snaps back to level.
    if (this.held.has(this.keys.trigger)) {
      this.pitch = 0;
      this.roll = 0;
    } else {
      this.roll = clamp(this.roll + horizontal * TILT_STEP, TILT_RANGE);
      this.pitch = clamp(this.pitch + vertical * TILT_STEP, TILT_RANGE);
    }

    let acceleration = { x: 0, y: 0, z: 0 };
    let swingYaw = 0;
    let swingRoll = 0;
    if (this.swingFrame >= 0) {
      const shape = Math.sin((this.swingFrame / (SWING_FRAMES - 1)) * Math.PI);
      // Sweeping right, mostly as yaw with a little roll, like a hand does.
      swingYaw = -shape * SWING_PEAK_RATE;
      swingRoll = -shape * SWING_PEAK_RATE * 0.2;
      acceleration = { x: 0, y: 0, z: -shape * 60 };
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
      // Portrait is the reference hold, so canonical axes are the device's own
      // (ARCHITECTURE.md 5.1) and alpha/beta/gamma are the rates about x/y/z.
      orientation: { alpha: 0, beta: 90 - this.pitch, gamma: this.roll },
      rotationRate: {
        alpha: vertical * TURN_RATE,
        beta: -horizontal * TURN_RATE + swingYaw,
        gamma: swingRoll,
      },
      acceleration,
      buttons: this.buttons(),
      screenOrientation: 0,
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
  const keymaps = [PRIMARY, SECONDARY, THIRD, FOURTH].slice(0, Math.max(1, Math.min(4, count)));
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

  /**
   * A hand crank for the stand-ins.
   *
   * An automated browser can have no requestAnimationFrame and heavily
   * throttled timers, which leaves both the game loop and this 60 Hz interval
   * running at about 2 Hz — twenty seconds of driving buys one second of game.
   * Feeding frames on a clock of the caller's choosing, alongside `game.step`,
   * runs a whole match in a few milliseconds and makes the result repeatable.
   */
  if (import.meta.env.DEV) {
    Object.assign(window, {
      phonemoteFake: {
        tick(now: number): void {
          for (const phone of phones) session.injectFrame(phone.nextFrame(now));
        },
        press(key: string): void {
          for (const phone of phones) phone.press(key);
        },
        release(key: string): void {
          for (const phone of phones) phone.release(key);
        },
      },
    });
  }

  console.log(
    `[fake] ${phones.length} keyboard controller(s): arrows tilt (trigger = level again), ` +
      'space swings, zxc buttons, h home' +
      (phones.length > 1 ? ' — second on wasd/q/erf/g' : ''),
  );
}
