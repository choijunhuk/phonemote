import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSensor, parseTrace, type SensorFrame } from '@phonemote/protocol';
import { InputMapper } from '../InputMapper.js';
import type { GameAction } from '../types.js';

/**
 * Golden tests over recorded sensor traces (ARCHITECTURE.md 8).
 *
 * A swing cannot be repeated exactly, so tuning the detector against a live
 * phone means arguing with a memory of how it felt. These traces are the same
 * motion every run, which is what makes a threshold change something you can
 * evaluate rather than something you can only believe in.
 *
 * The negative traces matter more than the positive one. Loosening a threshold
 * until every swing registers is easy; these say what that costs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(here, '../../../../../traces/corpus');

interface Replayed {
  readonly actions: readonly GameAction[];
  readonly frames: readonly SensorFrame[];
}

function replay(name: string, mapper: InputMapper): Replayed {
  const trace = parseTrace(readFileSync(join(CORPUS, name), 'utf8'));
  const actions: GameAction[] = [];
  const frames: SensorFrame[] = [];

  for (const encoded of trace.frames) {
    const frame = decodeSensor(encoded);
    frames.push(frame);
    actions.push(...mapper.update(frame));
  }
  return { actions, frames };
}

function swings(actions: readonly GameAction[]): GameAction[] {
  return actions.filter((action) => action.kind === 'swing');
}

function pointerPath(actions: readonly GameAction[]): Array<{ x: number; y: number }> {
  return actions
    .filter((action) => action.kind === 'pointer_move')
    .map((action) => (action.kind === 'pointer_move' ? { x: action.x, y: action.y } : { x: 0, y: 0 }));
}

/** How far the cursor wandered from where it started. */
function drift(path: ReadonlyArray<{ x: number; y: number }>): number {
  const last = path.at(-1);
  if (!last) return 0;
  return Math.hypot(last.x - 0.5, last.y - 0.5);
}

describe('a phone lying still', () => {
  it('produces no swings at all', () => {
    const { actions } = replay('phone-on-table.pmtrace', new InputMapper({ swing: true }));
    expect(swings(actions)).toHaveLength(0);
  });

  it('holds the pointer within a twentieth of the screen over ten seconds', () => {
    const { actions } = replay('phone-on-table.pmtrace', new InputMapper({ pointer: {} }));
    expect(drift(pointerPath(actions))).toBeLessThan(0.05);
  });
});

describe('a phone carried at a walk', () => {
  it('produces no swings', () => {
    const { actions } = replay('walk-around.pmtrace', new InputMapper({ swing: true }));
    expect(swings(actions)).toHaveLength(0);
  });
});

describe('a sensor that stops with acceleration frozen high', () => {
  it('produces no swings after it dies', () => {
    // The frozen reading sits at 60 m/s^2, three times the swing threshold.
    const { actions } = replay('sensor-stall.pmtrace', new InputMapper({ swing: true }));
    expect(swings(actions)).toHaveLength(0);
  });

  it('stops moving the pointer instead of integrating a dead rate', () => {
    const mapper = new InputMapper({ pointer: {} });
    const { actions } = replay('sensor-stall.pmtrace', mapper);
    const path = pointerPath(actions);

    // The live section turns at 40 deg/s, so the cursor should have moved.
    expect(drift(path)).toBeGreaterThan(0.1);
    expect(mapper.inputState(1).sensorStalled).toBe(true);

    // Five further seconds of frozen frames must add nothing.
    const settled = path.slice(-30);
    const first = settled[0];
    for (const point of settled) {
      expect(point.x).toBeCloseTo(first?.x ?? 0, 10);
      expect(point.y).toBeCloseTo(first?.y ?? 0, 10);
    }
  });
});

describe('ten deliberate swings', () => {
  it('detects each one exactly once', () => {
    const { actions } = replay('swing-forward.pmtrace', new InputMapper({ swing: true }));
    expect(swings(actions)).toHaveLength(10);
  });

  it('reports them at full strength and pointing away from the player', () => {
    const { actions } = replay('swing-forward.pmtrace', new InputMapper({ swing: true }));
    for (const action of swings(actions)) {
      if (action.kind !== 'swing') continue;
      expect(action.strength).toBeGreaterThan(0.9);
      // A forward thrust accelerates along canonical -Z.
      expect(action.direction.z).toBeLessThan(0);
    }
  });
});

describe('the corpus itself', () => {
  it('is v2 frames that survive a decode', () => {
    const { frames } = replay('swing-forward.pmtrace', new InputMapper());
    expect(frames.length).toBeGreaterThan(100);
    for (const frame of frames.slice(0, 20)) expect(frame.version).toBe(2);
  });

  it('advances motionSeq except where a stall is being simulated', () => {
    const { frames } = replay('walk-around.pmtrace', new InputMapper());
    const seqs = frames.map((frame) => frame.motionSeq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
