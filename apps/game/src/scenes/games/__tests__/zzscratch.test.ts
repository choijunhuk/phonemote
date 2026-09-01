import { describe, expect, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
const OUT = 'C:/Users/choij/AppData/Local/Temp/claude/C--Users-choij-Desktop-wii-project/335c8481-8b39-4036-b1a7-756058c0a538/scratchpad/out.txt';
writeFileSync(OUT, '');
const log = (...a: unknown[]) => appendFileSync(OUT, a.map(String).join(' ') + String.fromCharCode(10));
import { rotateAbout } from '../../../input/pose.js';
import type { CanonicalAngles, CanonicalVector } from '../../../input/types.js';
import {
  createBowling, findPlayer, readPose, readStillness, pressTrigger, release,
  stepBowling, type BowlingConfig, type BowlingEvent, type BowlingState,
} from '../bowlingState.js';

const FRAME = 1 / 60;
const GRIP: CanonicalVector = { x: 0, y: 1, z: 0 };
const FORWARD: CanonicalVector = { x: 0, y: 0, z: -1 };
function rolled(deg: number): CanonicalVector { return rotateAbout(GRIP, FORWARD, -deg); }

let clockMs = 1000;

function game(mode: string, ids: readonly number[] = [1], overrides: Partial<BowlingConfig> = {}): BowlingState {
  clockMs = 1000;
  const state = createBowling(mode, ids, overrides);
  for (const player of state.players) {
    for (let i = 0; i < 30; i++) readPose(state, player.id, GRIP, clockMs + i * 16);
    readStillness(state, player.id, { still: true, steadyMs: 500, stalled: false }, clockMs);
  }
  return state;
}

interface Shot { readonly aim?: number; readonly rate: number; readonly roll?: number; readonly pitch?: number }
function angles(shot: Shot): CanonicalAngles {
  return { yaw: 0, pitch: shot.pitch ?? 100, roll: shot.roll ?? 0 };
}

function settle(state: BowlingState, id: number, frame = FRAME): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  const player = findPlayer(state, id);
  for (let i = 0; i < Math.ceil(20 / frame); i++) {
    if (!player || (player.phase !== 'roll' && player.phase !== 'pins')) break;
    clockMs += frame * 1000;
    events.push(...stepBowling(state, frame, clockMs));
  }
  return events;
}

function bowl(state: BowlingState, id: number, shot: Shot, frame = FRAME): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  readPose(state, id, rolled(shot.aim ?? 0), clockMs);
  events.push(...pressTrigger(state, id));
  events.push(...release(state, id, shot.rate, angles(shot)));
  events.push(...settle(state, id, frame));
  return events;
}

const POCKET: Shot = { aim: 0, rate: 700, roll: 60, pitch: 100 };
const NOSE: Shot = { aim: 0, rate: 600, roll: 0, pitch: 100 };
const GUTTER: Shot = { aim: -20, rate: 700, roll: -100, pitch: 100 };

describe('scratch2', () => {
  it('perfect game', () => {
    const state = game('solo');
    for (let i = 0; i < 14 && !state.over; i++) {
      const events = bowl(state, 1, POCKET);
      const p = findPlayer(state, 1);
      log(`ball ${i}: phase=${p?.phase} frames=${JSON.stringify(p?.frames)} score=${p?.score} ev=${events.map((e) => e.kind).join(',')}`);
    }
    log('over', state.over, 'score', findPlayer(state, 1)?.score);
  });

  it('nose then what', () => {
    const state = game('solo');
    bowl(state, 1, NOSE);
    const p = findPlayer(state, 1);
    log('after nose frames', JSON.stringify(p?.frames), 'standing', p?.pins.map((s, i) => (s ? i + 1 : null)).filter((v) => v !== null));
    // try to clear the big four with various second balls
    for (const aim of [-16, -12, -8, -4, 0, 4, 8, 12, 16]) {
      for (const roll of [-100, -60, 0, 60, 100]) {
        const s2 = game('solo');
        bowl(s2, 1, NOSE);
        bowl(s2, 1, { aim, rate: 700, roll, pitch: 100 });
        const q = findPlayer(s2, 1);
        log(`  second aim=${aim} roll=${roll} -> frames=${JSON.stringify(q?.frames)}`);
      }
    }
  });

  it('gutter', () => {
    const state = game('solo');
    const ev = bowl(state, 1, GUTTER);
    const p = findPlayer(state, 1);
    log('gutter frames', JSON.stringify(p?.frames), ev.map((e) => e.kind).join(','));
  });

  it('weak', () => {
    const state = game('solo');
    const ev = bowl(state, 1, { aim: 0, rate: 100, roll: 0, pitch: 100 });
    log('weak', JSON.stringify(ev), JSON.stringify(findPlayer(state, 1)?.frames));
  });
  it('placeholder', () => { expect(true).toBe(true); });
});
