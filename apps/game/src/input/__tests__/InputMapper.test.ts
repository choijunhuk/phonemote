import { describe, expect, it } from 'vitest';
import {
  BUTTON,
  SENSOR_FLAG,
  SENSOR_FRAME_VERSION,
  type SensorFrame,
} from '@phonemote/protocol';
import { InputMapper } from '../InputMapper.js';
import type { GameAction } from '../types.js';

/** Every frame from a live phone carries a new motion event counter. */
let motionSeq = 0;

function raw(overrides: Partial<SensorFrame> = {}): SensorFrame {
  motionSeq++;
  return {
    playerId: 1,
    seq: 0,
    timestamp: 0,
    orientation: { alpha: 90, beta: 0, gamma: -90 },
    rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    acceleration: { x: 0, y: 0, z: 0 },
    buttons: 0,
    screenOrientation: 1,
    version: SENSOR_FRAME_VERSION,
    motionSeq,
    flags: SENSOR_FLAG.LINEAR_ACCEL | SENSOR_FLAG.ROTATION_RATE | SENSOR_FLAG.ORIENTATION,
    ...overrides,
  };
}

function kinds(actions: GameAction[]): string[] {
  return actions.map((action) => action.kind);
}

describe('button edges', () => {
  it('emits a down only on the transition', () => {
    const mapper = new InputMapper();
    expect(kinds(mapper.update(raw({ timestamp: 0 })))).toEqual([]);

    const pressed = mapper.update(raw({ timestamp: 16, buttons: BUTTON.A }));
    expect(pressed).toEqual([{ kind: 'button_down', playerId: 1, button: 'A' }]);

    // Still held: no repeat.
    expect(mapper.update(raw({ timestamp: 32, buttons: BUTTON.A }))).toEqual([]);

    const released = mapper.update(raw({ timestamp: 48, buttons: 0 }));
    expect(released).toEqual([{ kind: 'button_up', playerId: 1, button: 'A' }]);
  });

  it('handles several buttons at once', () => {
    const mapper = new InputMapper();
    mapper.update(raw());
    const actions = mapper.update(raw({ timestamp: 16, buttons: BUTTON.A | BUTTON.TRIGGER }));
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => (a.kind === 'button_down' ? a.button : null)).sort()).toEqual([
      'A',
      'TRIGGER',
    ]);
  });

  it('keeps players independent', () => {
    const mapper = new InputMapper();
    mapper.update(raw({ playerId: 1 }));
    mapper.update(raw({ playerId: 2 }));

    const actions = mapper.update(raw({ playerId: 2, timestamp: 16, buttons: BUTTON.B }));
    expect(actions).toEqual([{ kind: 'button_down', playerId: 2, button: 'B' }]);
    expect(mapper.update(raw({ playerId: 1, timestamp: 16 }))).toEqual([]);
  });
});

describe('modes', () => {
  it('emits nothing but buttons when no mode is configured', () => {
    const mapper = new InputMapper();
    expect(kinds(mapper.update(raw()))).toEqual([]);
  });

  it('emits tilt when tilt is enabled', () => {
    const mapper = new InputMapper({ tilt: {} });
    const actions = mapper.update(raw());
    expect(kinds(actions)).toEqual(['tilt']);
  });

  it('emits pointer moves when the pointer is enabled', () => {
    const mapper = new InputMapper({ pointer: {} });
    expect(kinds(mapper.update(raw()))).toEqual(['pointer_move']);
  });

  it('re-centres the pointer on HOME', () => {
    const mapper = new InputMapper({ pointer: {} });
    mapper.update(raw({ timestamp: 0 }));
    for (let i = 1; i <= 60; i++) {
      mapper.update(raw({ timestamp: i * 16, rotationRate: { alpha: 0, beta: -60, gamma: 0 } }));
    }
    const moved = mapper.update(raw({ timestamp: 2000 }));
    const before = moved.find((a) => a.kind === 'pointer_move');
    expect(before?.kind === 'pointer_move' && before.x).toBeGreaterThan(0.5);

    const afterHome = mapper.update(raw({ timestamp: 2016, buttons: BUTTON.HOME }));
    const recentred = afterHome.find((a) => a.kind === 'pointer_move');
    expect(recentred?.kind === 'pointer_move' && recentred.x).toBe(0.5);
  });

  it('emits a swing when the phone is thrust forward', () => {
    const mapper = new InputMapper({ swing: true });
    mapper.update(raw({ timestamp: 0 }));
    mapper.update(raw({ timestamp: 16, acceleration: { x: 0, y: 0, z: -40 } }));
    mapper.update(raw({ timestamp: 60, acceleration: { x: 0, y: 0, z: -90 } }));
    mapper.update(raw({ timestamp: 130, acceleration: { x: 0, y: 0, z: 0 } }));
    const actions = mapper.update(raw({ timestamp: 190, acceleration: { x: 0, y: 0, z: 0 } }));

    const swing = actions.find((action) => action.kind === 'swing');
    expect(swing).toBeDefined();
    if (swing?.kind !== 'swing') return;
    expect(swing.strength).toBe(1);
    expect(swing.playerId).toBe(1);
  });

  it('centres tilt on calibration', () => {
    const mapper = new InputMapper({ tilt: {} });
    // Held 20 degrees rolled to the right the whole time.
    const tilted = raw({ orientation: { alpha: 90, beta: 20, gamma: -90 } });

    const before = mapper.update(tilted);
    expect(before[0]?.kind === 'tilt' && before[0].x).toBeGreaterThan(0.3);

    mapper.requestCalibration(1);
    // A new reading, not a repeat: a stalled frame would be frozen, not centred.
    const after = mapper.update({ ...tilted, timestamp: 16, motionSeq: tilted.motionSeq + 1 });
    expect(after[0]?.kind === 'tilt' && after[0].x).toBe(0);
  });
});

describe('a stalled sensor', () => {
  it('freezes the modes but still reports buttons', () => {
    const mapper = new InputMapper({ pointer: {}, tilt: {}, swing: true });
    mapper.update(raw({ timestamp: 0 }));
    const moving = mapper.update(
      raw({ timestamp: 16, rotationRate: { alpha: 0, beta: -60, gamma: 0 } }),
    );
    const before = moving.find((action) => action.kind === 'pointer_move');
    expect(before?.kind === 'pointer_move' && before.x).toBeGreaterThan(0.5);

    // The phone keeps sending, but its sensors have stopped: same motionSeq.
    const frozen = mapper.update({
      ...raw({ timestamp: 200, rotationRate: { alpha: 0, beta: -60, gamma: 0 } }),
      motionSeq: mapper.inputState(1).motionSeq,
    });

    expect(mapper.inputState(1).sensorStalled).toBe(true);
    expect(frozen.some((action) => action.kind === 'pointer_move')).toBe(false);
    expect(frozen.some((action) => action.kind === 'tilt')).toBe(false);
  });

  it('lets a button through while the sensor is stalled', () => {
    const mapper = new InputMapper({ pointer: {} });
    mapper.update(raw());
    const stalledSeq = mapper.inputState(1).motionSeq;

    const actions = mapper.update({ ...raw({ buttons: BUTTON.A }), motionSeq: stalledSeq });
    expect(actions).toEqual([{ kind: 'button_down', playerId: 1, button: 'A' }]);
  });

  it('emits no phantom swing from a frozen acceleration above the threshold', () => {
    const mapper = new InputMapper({ swing: true });
    const held = { x: 0, y: 0, z: -60 };
    mapper.update(raw({ timestamp: 0, acceleration: held }));
    const stuckSeq = mapper.inputState(1).motionSeq;

    // 5 seconds of a phone insisting it is being swung, without a new reading.
    for (let t = 16; t < 5000; t += 16) {
      const actions = mapper.update({
        ...raw({ timestamp: t, acceleration: held }),
        motionSeq: stuckSeq,
      });
      expect(actions.some((action) => action.kind === 'swing')).toBe(false);
    }
  });

  it('picks up again once the sensor resumes', () => {
    const mapper = new InputMapper({ tilt: {} });
    mapper.update(raw({ timestamp: 0 }));
    const stalledSeq = mapper.inputState(1).motionSeq;
    mapper.update({ ...raw({ timestamp: 100 }), motionSeq: stalledSeq });
    expect(mapper.inputState(1).sensorStalled).toBe(true);

    const resumed = mapper.update(raw({ timestamp: 200 }));
    expect(mapper.inputState(1).sensorStalled).toBe(false);
    expect(resumed.some((action) => action.kind === 'tilt')).toBe(true);
  });
});

describe('changing modes between scenes', () => {
  it('keeps the tilt calibration', () => {
    const mapper = new InputMapper({ tilt: {} });
    const tilted = raw({ orientation: { alpha: 90, beta: 20, gamma: -90 } });
    mapper.update(tilted);
    mapper.requestCalibration(1);
    mapper.update({ ...tilted, motionSeq: motionSeq + 1, timestamp: 16 });

    // The next scene wants swings as well; the calibration must survive it.
    mapper.setConfig({ tilt: {}, swing: true });
    const after = mapper.update({ ...tilted, motionSeq: motionSeq + 2, timestamp: 32 });
    const tilt = after.find((action) => action.kind === 'tilt');
    expect(tilt?.kind === 'tilt' && tilt.x).toBe(0);
  });

  it('drops a mode the new scene does not want', () => {
    const mapper = new InputMapper({ pointer: {}, tilt: {} });
    mapper.update(raw());
    mapper.setConfig({ swing: true });

    const actions = mapper.update(raw({ timestamp: 16 }));
    expect(actions.some((action) => action.kind === 'pointer_move')).toBe(false);
    expect(actions.some((action) => action.kind === 'tilt')).toBe(false);
  });
});

describe('canonical snapshot', () => {
  it('exposes the last canonical frame for the debug overlay', () => {
    const mapper = new InputMapper();
    expect(mapper.lastCanonical(1)).toBeNull();
    mapper.update(raw({ rotationRate: { alpha: 0, beta: 0, gamma: -10 } }));
    expect(mapper.lastCanonical(1)?.angularVelocity.pitch).toBeCloseTo(10, 6);
  });

  it('drops state when a player leaves', () => {
    const mapper = new InputMapper();
    mapper.update(raw({ buttons: BUTTON.A }));
    mapper.removePlayer(1);
    // A fresh join must not inherit the old button state.
    expect(mapper.update(raw({ buttons: BUTTON.A }))).toEqual([
      { kind: 'button_down', playerId: 1, button: 'A' },
    ]);
  });
});
