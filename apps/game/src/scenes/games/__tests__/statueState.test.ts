import { describe, expect, it } from 'vitest';
import {
  bestStops,
  buildPattern,
  createStatue,
  findRacer,
  ghostProgress,
  greenSecondsWithin,
  readStillness,
  setGhost,
  standings,
  statueConfigFor,
  stepStatue,
  syncRacers,
  type StatueConfig,
  type StatueEvent,
  type StatueRacer,
  type StatueState,
} from '../statueState.js';

/**
 * The rules of Statue Race, driven at a frame rate we choose.
 *
 * The game reads one number per phone per frame, so every test here is a
 * sequence of smoothed |omega| values — the same thing the input layer hands
 * the scene. The two numbers used throughout are measured ones: a hand trying
 * to hold still averages 3.3 deg/s, and a swing is in the hundreds.
 */

const FRAME = 1 / 60;

/** The module's own simulation step, which bounds how late any verdict can be. */
const STEP = 1 / 120;

/** A hand doing its best to be a statue. */
const STILL = 3.3;
/** Shaking, comfortably inside the 900 deg/s clamp. */
const SHAKING = 800;

/**
 * deg/s to report this frame, `'stalled'` for a phone the input layer says has
 * gone quiet, or null for a phone sending nothing at all.
 *
 * A stalled phone reports the rate it was last seen at, because that is what
 * the input layer keeps handing over — the reading does not go still, it goes
 * stale, and the two have to be told apart by the flag rather than the number.
 */
type Plan = (racer: StatueRacer, state: StatueState) => number | 'stalled' | null;

interface Stamp {
  /** state.clock at the end of the frame the event came out of. */
  readonly at: number;
  readonly event: StatueEvent;
}

/**
 * Lights of a fixed length, so a distance can be worked out by hand instead of
 * read back off the simulation it is supposed to be checking.
 */
const METRONOME: Partial<StatueConfig> = {
  countdownSeconds: 1,
  greenMinSeconds: 2,
  greenMaxSeconds: 2,
  redMinSeconds: 1,
  redMaxSeconds: 1,
};

function field(config: StatueConfig, ids: readonly number[] = [1], seed = 1): StatueState {
  const state = createStatue(config, seed);
  syncRacers(
    state,
    ids.map((id) => ({ id, present: true })),
  );
  return state;
}

function party(overrides: Partial<StatueConfig> = {}, ids: readonly number[] = [1]): StatueState {
  return field({ ...statueConfigFor('party'), ...overrides }, ids);
}

function drive(state: StatueState, plan: Plan, seconds: number, frame = FRAME): Stamp[] {
  const stamps: Stamp[] = [];
  const frames = Math.round(seconds / frame);
  for (let i = 0; i < frames; i++) {
    for (const racer of state.racers) {
      const reading = plan(racer, state);
      if (reading === null) continue;
      const stalled = reading === 'stalled';
      readStillness(state, racer.id, stalled ? SHAKING : reading, stalled);
    }
    for (const event of stepStatue(state, frame)) stamps.push({ at: state.clock, event });
    if (state.phase === 'finish') break;
  }
  return stamps;
}

/**
 * The same plan, arriving `frames` frames late.
 *
 * This is the whole of the game's honest weakness: the rules judge the reading
 * they have, and a reading that took too long to cross the network describes an
 * arm that has already stopped.
 */
function lagging(plan: Plan, frames: number): Plan {
  const queues = new Map<number, (number | 'stalled' | null)[]>();
  return (racer, state) => {
    const queue = queues.get(racer.id) ?? [];
    queue.push(plan(racer, state));
    queues.set(racer.id, queue);
    if (queue.length <= frames) return null;
    return queue.shift() ?? null;
  };
}

function kinds(stamps: readonly Stamp[]): string[] {
  return stamps.map((stamp) => stamp.event.kind);
}

function firstAt(stamps: readonly Stamp[], kind: StatueEvent['kind']): number {
  const found = stamps.find((stamp) => stamp.event.kind === kind);
  if (!found) throw new Error(`no ${kind} event`);
  return found.at;
}

function stops(stamps: readonly Stamp[]): Extract<StatueEvent, { kind: 'stopped' }>[] {
  const found: Extract<StatueEvent, { kind: 'stopped' }>[] = [];
  for (const stamp of stamps) if (stamp.event.kind === 'stopped') found.push(stamp.event);
  return found;
}

function racer(state: StatueState, id = 1): StatueRacer {
  const found = findRacer(state, id);
  if (!found) throw new Error(`nobody with id ${id}`);
  return found;
}

/** How many seconds of rate history this racer is still holding. */
function traceSpan(subject: StatueRacer): number {
  const trace = subject.trace;
  return (trace[trace.length - 1]?.t ?? 0) - (trace[0]?.t ?? 0);
}

/** Flat out under green, a statue the moment the light changes. */
const honest: Plan = (_racer, state) => (state.phase === 'green' ? SHAKING : STILL);
/** Never notices the light. */
const oblivious: Plan = () => SHAKING;
const statue: Plan = () => STILL;

/** A player who takes this many seconds to get their arm to stop, drill by drill. */
function reactsIn(seconds: readonly number[]): Plan {
  return (subject, state) => {
    if (state.phase !== 'red') return SHAKING;
    if (subject.stopMs !== null) return STILL;
    const want = seconds[subject.attempts.length] ?? 0.5;
    return state.redElapsed >= want ? STILL : SHAKING;
  };
}

/** A player who shakes at a different rate each drill and stops at the same moment. */
function drillsAt(rates: readonly number[], stopAfter: number): Plan {
  return (subject, state) => {
    const rate = rates[subject.attempts.length] ?? SHAKING;
    if (state.phase !== 'red') return rate;
    if (subject.stopMs !== null) return STILL;
    return state.redElapsed >= stopAfter ? STILL : rate;
  };
}

describe('covering the track', () => {
  it('pays out distance for how hard the phone is being shaken', () => {
    // Two seconds of green each, so the answer is arithmetic: 300 deg/s is
    // twelve units of the track and 600 is twenty-four.
    const gentle = party({ ...METRONOME, trackLength: 1000 });
    drive(gentle, () => 300, 3.1);
    const hard = party({ ...METRONOME, trackLength: 1000 });
    drive(hard, () => 600, 3.1);

    expect(gentle.phase).toBe('amber');
    expect(racer(gentle).progress).toBeCloseTo(12, 0);
    expect(racer(hard).progress).toBeCloseTo(24, 0);
  });

  it('stops paying above the rate anybody can shake at, so nobody has to hurt a wrist', () => {
    const half = party({ ...METRONOME, trackLength: 1000 });
    drive(half, () => 450, 3.1);
    const full = party({ ...METRONOME, trackLength: 1000 });
    drive(full, () => 900, 3.1);
    const wild = party({ ...METRONOME, trackLength: 1000 });
    drive(wild, () => 3000, 3.1);

    expect(racer(half).progress).toBeCloseTo(18, 0);
    expect(racer(full).progress).toBeCloseTo(36, 0);
    expect(racer(wild).progress).toBeCloseTo(36, 0);
  });

  it('gives nothing away during the amber, however hard the arm is still going', () => {
    const state = party({ ...METRONOME, trackLength: 1000 });
    drive(state, oblivious, 3.05);
    expect(state.phase).toBe('amber');

    const atAmber = racer(state).progress;
    drive(state, oblivious, 0.1);
    expect(state.phase).toBe('amber');
    expect(racer(state).progress).toBe(atAmber);
  });

  it('puts whoever is furthest down the track at the top while the race is on', () => {
    const state = party({ ...METRONOME, trackLength: 1000 }, [1, 2, 3]);
    drive(state, (subject) => (subject.id === 1 ? 200 : subject.id === 2 ? 800 : 400), 3.1);

    expect(standings(state).map((entry) => entry.id)).toEqual([2, 3, 1]);
  });

  it('puts anyone who crossed the line above everyone still running', () => {
    const state = party({ ...METRONOME, trackLength: 20 }, [1, 2, 3]);
    drive(
      state,
      (subject, s) =>
        s.phase !== 'green' ? STILL : subject.id === 3 ? 800 : subject.id === 2 ? 300 : 100,
      2.5,
    );

    expect(racer(state, 3).rank).toBe(1);
    expect(racer(state, 1).rank).toBeNull();
    expect(standings(state).map((entry) => entry.id)).toEqual([3, 2, 1]);
  });

  it('does not move a phone whose last reading is all that is left of it', () => {
    // The input layer is still repeating 800 deg/s; the flag is the only thing
    // that says the phone stopped talking a second ago.
    const state = party({ ...METRONOME, trackLength: 1000 });
    drive(state, () => 'stalled', 3.1);
    expect(racer(state).progress).toBe(0);
  });
});

describe('the red light', () => {
  it('catches an arm that is still going and takes a slice of the track for it', () => {
    const state = party({ ...METRONOME, trackLength: 1000, redMinSeconds: 0.5, redMaxSeconds: 0.5 });
    const stamps = drive(state, oblivious, 3.5);

    // Thirty-two units of green, less fifteen per cent for being caught.
    expect(racer(state).caught).toBe(1);
    expect(racer(state).progress).toBeCloseTo(27.2, 0);
    const caught = stamps.find((stamp) => stamp.event.kind === 'caught');
    expect(caught?.event.kind === 'caught' ? caught.event.progress : -1).toBe(
      racer(state).progress,
    );
  });

  it('holds the player it caught still into the next green, not just to the end of the red', () => {
    const state = party({ ...METRONOME, trackLength: 1000, redMinSeconds: 0.5, redMaxSeconds: 0.5 });
    drive(state, oblivious, 3.8);
    expect(state.phase).toBe('green');
    expect(racer(state).caught).toBe(1);

    // The light is green and the arm is going flat out, and the track does not
    // move: this is the half second that makes being caught matter.
    const frozen = racer(state).progress;
    drive(state, oblivious, 0.5);
    expect(state.phase).toBe('green');
    expect(racer(state).progress).toBe(frozen);

    const stamps = drive(state, oblivious, 0.5);
    expect(kinds(stamps)).toContain('freed');
    expect(racer(state).progress).toBeGreaterThan(frozen);
  });

  it('freezes the player it caught for long enough to be worth avoiding', () => {
    const state = party({ ...METRONOME, trackLength: 1000, redMinSeconds: 0.5, redMaxSeconds: 0.5 });
    const stamps = drive(state, oblivious, 6, 1 / 100);

    expect(firstAt(stamps, 'freed') - firstAt(stamps, 'caught')).toBeCloseTo(1.2, 1);
  });

  it('leaves a hand that is only a hand alone', () => {
    // 14 deg/s is the worst single sample from a hand told to hold still, and
    // 16 is somebody moving on purpose. The line has to fall between them.
    const held = party({ ...METRONOME });
    const heldStamps = drive(held, (_racer, state) => (state.phase === 'green' ? SHAKING : 14), 5);
    const moved = party({ ...METRONOME });
    const movedStamps = drive(moved, (_racer, state) => (state.phase === 'green' ? SHAKING : 16), 5);

    expect(kinds(heldStamps)).not.toContain('caught');
    expect(kinds(movedStamps)).toContain('caught');
  });

  it('cannot convict a player on a reading sent before the light changed', () => {
    // Flat out through the green, then the phone says nothing at all: the
    // reading in hand describes a green light and is not evidence of anything.
    const state = party({ ...METRONOME, trackLength: 1000 });
    const stamps = drive(state, (_racer, s) => (s.phase === 'red' ? null : SHAKING), 4);

    expect(state.phase).toBe('red');
    expect(kinds(stamps)).not.toContain('caught');
    expect(racer(state).progress).toBeCloseTo(32, 0);
  });

  it('does not punish a phone for going quiet', () => {
    const state = party({ ...METRONOME, trackLength: 1000 });
    const stamps = drive(state, (_racer, s) => (s.phase === 'red' ? 'stalled' : SHAKING), 5);

    expect(kinds(stamps)).not.toContain('caught');
    expect(racer(state).caught).toBe(0);
  });
});

describe('the frames that arrive late', () => {
  /** 20 ms a frame, so a lag in frames is a lag in round tens of milliseconds. */
  const LATE = 1 / 50;

  it('lets a player who stopped on the light through, on a link 200 ms behind', () => {
    const state = party({ ...METRONOME });
    const stamps = drive(state, lagging(honest, 10), 5, LATE);

    expect(kinds(stamps)).not.toContain('caught');
    // Their stop reads as instant, because the frame that proves it describes
    // an arm that was already down when the light came on.
    expect(bestStops(racer(state), 1)[0]).toBe(0);
  });

  it('convicts a player who had already stopped, once the link is slower than the amber', () => {
    // The weakness the design admits to, pinned rather than papered over: at
    // 320 ms of lag the first frame to arrive under the red was recorded while
    // the light was still green, and the amber is only 250 ms wide.
    const state = party({ ...METRONOME });
    const stamps = drive(state, lagging(honest, 16), 5, LATE);

    expect(kinds(stamps)).toContain('caught');
    expect(racer(state).caught).toBe(1);
  });
});

describe('a phone that drops out mid-race', () => {
  it('comes back to the light it left rather than to a race that ran without it', () => {
    const state = party({ ...METRONOME, trackLength: 1000 });
    drive(state, oblivious, 2);
    const clock = state.clock;
    const progress = racer(state).progress;

    syncRacers(state, [{ id: 1, present: false }]);
    expect(drive(state, () => null, 10)).toEqual([]);
    expect(state.clock).toBe(clock);
    expect(state.phase).toBe('green');

    syncRacers(state, [{ id: 1, present: true }]);
    drive(state, oblivious, 0.5);
    expect(racer(state).progress).toBeGreaterThan(progress);
  });

  it('keeps its distance, its punishments and its record of drills', () => {
    const state = party({ ...METRONOME, trackLength: 1000 }, [1, 2]);
    drive(state, oblivious, 5);
    const progress = racer(state, 2).progress;
    const caught = racer(state, 2).caught;
    const attempts = racer(state, 2).attempts.length;
    expect(progress).toBeGreaterThan(0);
    expect(caught).toBe(1);

    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    // The bar on screen stops shaking the moment the phone stops answering,
    // rather than holding the last reading and looking like a player who is
    // somehow still going.
    expect(racer(state, 2).rate).toBe(0);

    drive(state, (subject) => (subject.id === 1 ? SHAKING : null), 6);
    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
    ]);

    expect(racer(state, 2).progress).toBe(progress);
    expect(racer(state, 2).caught).toBe(caught);
    expect(racer(state, 2).attempts.length).toBe(attempts);
  });

  it('is neither caught nor credited for a red light it was disconnected for', () => {
    const state = party({ ...METRONOME, trackLength: 1000 }, [1, 2]);
    drive(state, oblivious, 2.9);
    // Phone two drops while its arm is still going, so the reading left behind
    // is a reading of somebody shaking.
    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    const away = drive(state, (subject) => (subject.id === 1 ? STILL : null), 0.6);
    expect(state.phase).toBe('red');

    // Back on the roster, but nothing has arrived from it yet. The only thing
    // the game holds is the reading from before the outage, and that reading
    // must count neither against the player nor for them.
    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
    ]);
    const silent = drive(state, (subject) => (subject.id === 1 ? STILL : null), 0.3);
    expect(state.phase).toBe('red');
    expect(racer(state, 2).caught).toBe(0);
    expect(racer(state, 2).attempts).toHaveLength(0);

    const talking = drive(state, () => STILL, 0.2);
    expect(state.phase).toBe('red');
    expect(kinds([...away, ...silent, ...talking])).not.toContain('caught');
    // Judged from the frame it spoke, which is the first frame it can answer for.
    expect(racer(state, 2).attempts).toHaveLength(1);
  });

  it('does not judge a phone the room has not yet counted as back', () => {
    // The roster and the input stream are separate: a phone can be sending
    // again a frame or two before the lobby has noticed it is back.
    const state = party({ ...METRONOME, trackLength: 1000 }, [1, 2]);
    drive(state, oblivious, 2.9);
    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);

    const stamps = drive(state, oblivious, 0.8);
    expect(state.phase).toBe('red');
    expect(racer(state, 2).caught).toBe(0);
    expect(racer(state, 2).attempts).toHaveLength(0);
    expect(stamps.filter((stamp) => stamp.event.kind === 'caught')).toHaveLength(1);

    // Nor is it carried up the track while it is off the roster.
    const progress = racer(state, 2).progress;
    drive(state, oblivious, 2.5);
    expect(state.phase).toBe('green');
    expect(racer(state, 2).progress).toBe(progress);
  });

  it('does not put a stop on the board for a red it was away for', () => {
    // A long red, so the 1.2 s freeze from being caught ends well inside it.
    const state = party(
      { ...METRONOME, trackLength: 1000, redMinSeconds: 3, redMaxSeconds: 3 },
      [1, 2],
    );
    const early = drive(state, oblivious, 3.4);
    expect(state.phase).toBe('red');
    expect(racer(state, 2).caught).toBe(1);

    // Phone two drops while it is frozen and is still away when the freeze
    // ends, so the game holds a reading of it from earlier in this same red.
    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    const alone = drive(state, (subject) => (subject.id === 1 ? STILL : null), 2);
    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
    ]);
    const back = drive(state, (subject) => (subject.id === 1 ? STILL : null), 0.5);

    expect(state.phase).toBe('red');
    // Phone one thawed and held still, so it has a time. Phone two has nothing,
    // because nothing has been heard from it since the light turned red.
    expect(stops([...early, ...alone, ...back]).map((event) => event.playerId)).toEqual([1]);
    expect(racer(state, 2).attempts).toHaveLength(0);
  });

  it('does not hold the finish screen open for a phone that is not there', () => {
    const state = party({ ...METRONOME, trackLength: 20 }, [1, 2]);
    syncRacers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    const stamps = drive(state, (subject) => (subject.id === 1 ? SHAKING : null), 30);

    expect(state.phase).toBe('finish');
    expect(firstAt(stamps, 'over') - firstAt(stamps, 'finish')).toBeLessThan(0.5);
  });
});

describe('every way a race can end', () => {
  it('ends when everyone still connected is over the line', () => {
    const state = party({ ...METRONOME, trackLength: 20 }, [1, 2]);
    const stamps = drive(
      state,
      (subject, s) => (s.phase !== 'green' ? STILL : subject.id === 1 ? 800 : 400),
      30,
    );

    expect(state.phase).toBe('finish');
    expect(racer(state, 1).rank).toBe(1);
    expect(racer(state, 2).rank).toBe(2);
    expect(standings(state)[0]?.id).toBe(1);
    expect(kinds(stamps).filter((kind) => kind === 'finish')).toHaveLength(2);
    expect(kinds(stamps)).toContain('over');
    // Nobody is drawn past the end of the track they were running down.
    expect(racer(state, 1).progress).toBe(20);

    // Ten seconds of a scene that has not switched screens yet: no light
    // changes, no distance, no second race started underneath the results.
    for (let i = 0; i < 600; i++) {
      readStillness(state, 1, SHAKING, false);
      expect(stepStatue(state, FRAME)).toEqual([]);
    }
    expect(state.phase).toBe('finish');
    expect(racer(state, 1).progress).toBe(20);
  });

  it('closes the race a fixed grace after the winner, so one player cannot hold the room', () => {
    const state = party({ ...METRONOME, trackLength: 20 }, [1, 2]);
    const stamps = drive(
      state,
      (subject, s) => (subject.id === 2 ? STILL : s.phase === 'green' ? SHAKING : STILL),
      40,
      1 / 100,
    );

    expect(racer(state, 2).finishedAt).toBeNull();
    expect(state.phase).toBe('finish');
    expect(firstAt(stamps, 'over') - firstAt(stamps, 'finish')).toBeCloseTo(8, 1);
    // The player who crossed is above the player who never left the line.
    expect(standings(state).map((entry) => entry.id)).toEqual([1, 2]);
  });

  it('ends a practice session after the drills it promised', () => {
    const state = field(statueConfigFor('practice'));
    const stamps = drive(state, reactsIn([0.6, 0.2, 1, 0.4, 0.8, 0.3]), 200);

    expect(racer(state).attempts).toHaveLength(6);
    expect(state.phase).toBe('finish');
    expect(kinds(stamps)).toContain('over');
  });

  it('ends a practice session for a player who never once stops', () => {
    const state = field(statueConfigFor('practice'));
    const stamps = drive(state, oblivious, 200);

    expect(state.phase).toBe('finish');
    expect(kinds(stamps)).toContain('over');
    // Six drills on the sheet, no times on the board, and no track to lose.
    expect(racer(state).attempts).toHaveLength(6);
    expect(bestStops(racer(state))).toEqual([]);
    expect(racer(state).caught).toBe(0);
    expect(racer(state).progress).toBe(0);
  });
});

describe('the practice drill', () => {
  it('reports how long the arm took to stop, to within a frame', () => {
    const state = field(statueConfigFor('practice'));
    const wanted = [0.6, 0.2, 1, 0.4, 0.8, 0.3];
    const stamps = drive(state, reactsIn(wanted), 200);

    const measured = stops(stamps).map((event) => event.ms);
    expect(measured).toHaveLength(6);
    for (let i = 0; i < wanted.length; i++) {
      const want = (wanted[i] ?? 0) * 1000;
      expect(measured[i] ?? -1).toBeGreaterThanOrEqual(want);
      expect(measured[i] ?? 1e9).toBeLessThan(want + 40);
    }
  });

  it('tells the player the moment they beat their own best, and keeps the best three', () => {
    const state = field(statueConfigFor('practice'));
    const stamps = drive(state, reactsIn([0.6, 0.2, 1, 0.4, 0.8, 0.3]), 200);

    expect(stops(stamps).map((event) => event.best)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    const best = bestStops(racer(state));
    expect(best).toHaveLength(3);
    expect(best[0] ?? 0).toBeLessThan(best[1] ?? 0);
    expect(best[1] ?? 0).toBeLessThan(best[2] ?? 0);
    expect(best[0] ?? 0).toBeGreaterThanOrEqual(200);
    expect(best[2] ?? 0).toBeLessThan(440);
  });

  it('puts each stop next to the shake that drill was shaken at, not the hardest so far', () => {
    // A stop time with no rate beside it cannot tell a player why the slow ones
    // were slow, and a rate carried over from an earlier drill would tell them
    // the opposite of the truth: here the shaking gets gentler and harder in
    // turn, and every drill has to report its own.
    const rates = [800, 300, 600, 200, 900, 400];
    const state = field(statueConfigFor('practice'));
    const stamps = drive(state, drillsAt(rates, 0.4), 200);

    expect(stops(stamps).map((event) => event.peakRate)).toEqual(rates);
  });

  it('keeps a fixed window of rates for the decay curve drawn beside the number', () => {
    // Kept by age rather than by count: a fixed number of samples would be a
    // different length of history on every phone. The drill holds four seconds
    // of it against a race's three, because on the drill screen the curve is
    // the thing being read rather than decoration.
    const drill = field(statueConfigFor('practice'));
    drive(drill, oblivious, 12);
    const room = party({ trackLength: 1000 });
    drive(room, oblivious, 12);

    expect(racer(drill).trace.length).toBeGreaterThan(0);
    expect(traceSpan(racer(drill))).toBeGreaterThan(3.9);
    expect(traceSpan(racer(drill))).toBeLessThanOrEqual(4);
    expect(traceSpan(racer(room))).toBeGreaterThan(2.9);
    expect(traceSpan(racer(room))).toBeLessThanOrEqual(3);
  });

  it('is the stopping drill and not the race with the scoring switched off', () => {
    expect(statueConfigFor('practice').raced).toBe(false);
    expect(statueConfigFor('practice').attempts).toBeGreaterThan(0);
    // A fixed red, so the readout does not flash past at a new speed each time.
    expect(statueConfigFor('practice').redMinSeconds).toBe(
      statueConfigFor('practice').redMaxSeconds,
    );
    expect(statueConfigFor('solo').ghost).toBe(true);
    expect(statueConfigFor('party').ghost).toBe(false);
    // A mode nobody has heard of still gets a race rather than nothing.
    expect(statueConfigFor('kickabout')).toBe(statueConfigFor('party'));
  });
});

describe('the ghost of a previous run', () => {
  function soloState(overrides: Partial<StatueConfig> = {}): StatueState {
    return field({ ...statueConfigFor('solo'), ...METRONOME, ...overrides });
  }

  it('stands still whenever the player has to', () => {
    const state = soloState();
    setGhost(state, 20);
    drive(state, statue, 3.1);
    expect(state.phase).toBe('amber');

    const atAmber = ghostProgress(state) ?? -1;
    expect(atAmber).toBeGreaterThan(0);
    drive(state, statue, 1);
    expect(state.phase).toBe('red');
    expect(ghostProgress(state) ?? -1).toBeCloseTo(atAmber, 6);
  });

  it('crosses the line at exactly the time it recorded', () => {
    const state = soloState({ trackLength: 100 });
    setGhost(state, 10);
    drive(state, statue, 6);
    expect(ghostProgress(state) ?? 0).toBeLessThan(100);

    drive(state, statue, 5.1);
    expect(ghostProgress(state) ?? 0).toBeCloseTo(100, 6);
  });

  it('is not drawn at all in a party, or before a time has been set', () => {
    const solo = soloState();
    expect(ghostProgress(solo)).toBeNull();
    setGhost(solo, 20);
    expect(ghostProgress(solo)).not.toBeNull();

    const room = party({ ...METRONOME });
    setGhost(room, 20);
    expect(ghostProgress(room)).toBeNull();
  });

  it('offers the run as a record only when it beats the time on the board', () => {
    const first = soloState({ trackLength: 100 });
    const opening = drive(first, honest, 40);
    expect(kinds(opening)).toContain('record');
    const seconds = racer(first).finishedAt ?? 0;
    expect(seconds).toBeGreaterThan(0);

    const second = soloState({ trackLength: 100 });
    setGhost(second, seconds / 2);
    const slower = drive(second, honest, 40);
    expect(kinds(slower)).toContain('finish');
    expect(kinds(slower)).not.toContain('record');
  });

  it('counts only the green in the stretch of pattern the ghost has run', () => {
    const pattern = buildPattern({ ...statueConfigFor('party'), ...METRONOME }, 3);
    expect(greenSecondsWithin(pattern, 0)).toBe(0);
    expect(greenSecondsWithin(pattern, 1)).toBe(1);
    // Two of green, then the amber and the whole red add nothing.
    expect(greenSecondsWithin(pattern, 3.25)).toBe(2);
    expect(greenSecondsWithin(pattern, 4.25)).toBe(3);
  });
});

describe('determinism', () => {
  it('deals the same lights for the same seed and different ones otherwise', () => {
    const config = statueConfigFor('party');
    expect(buildPattern(config, 7)).toEqual(buildPattern(config, 7));
    expect(buildPattern(config, 8)).not.toEqual(buildPattern(config, 7));

    for (const seed of [1, 2, 7, 99, 40503]) {
      for (const segment of buildPattern(config, seed)) {
        if (segment.light === 'amber') expect(segment.seconds).toBe(config.amberSeconds);
        if (segment.light === 'green') {
          expect(segment.seconds).toBeGreaterThanOrEqual(config.greenMinSeconds);
          expect(segment.seconds).toBeLessThanOrEqual(config.greenMaxSeconds);
        }
        if (segment.light === 'red') {
          expect(segment.seconds).toBeGreaterThanOrEqual(config.redMinSeconds);
          expect(segment.seconds).toBeLessThanOrEqual(config.redMaxSeconds);
        }
      }
    }
  });

  it('replays a race move for move, which is what makes it a board to practise', () => {
    const once = party({ trackLength: 100 });
    drive(once, honest, 40);
    const twice = party({ trackLength: 100 });
    drive(twice, honest, 40);

    expect(racer(twice).finishedAt).toBe(racer(once).finishedAt);
    expect(racer(twice).progress).toBe(racer(once).progress);
    expect(racer(twice).attempts).toEqual(racer(once).attempts);
  });

  it('never reaches for Math.random', () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error('the rules reached for Math.random');
    };
    try {
      const state = party({ trackLength: 100 }, [1, 2]);
      const stamps = drive(state, (subject) => (subject.id === 1 ? honest(subject, state) : 400), 60);
      expect(state.phase).toBe('finish');
      expect(kinds(stamps)).toContain('over');
    } finally {
      Math.random = original;
    }
  });
});

describe('the frame rate the browser happens to give us', () => {
  it('covers the same ground at 15 Hz as at 100', () => {
    // The catch line is put out of reach so the two runs differ in one thing
    // only: how the same shake was integrated.
    const overrides = { ...METRONOME, trackLength: 100, catchRateDegPerSec: 5000 };
    const slow = party(overrides);
    drive(slow, oblivious, 40, 1 / 15);
    const fast = party(overrides);
    drive(fast, oblivious, 40, 1 / 100);

    expect(slow.phase).toBe('finish');
    expect(fast.phase).toBe('finish');
    expect(racer(slow).finishedAt ?? 0).toBeGreaterThan(0);
    expect(Math.abs((racer(slow).finishedAt ?? 0) - (racer(fast).finishedAt ?? 1e9))).toBeLessThan(
      0.05,
    );
  });

  it('reaches the same verdicts at 15 Hz as at 100', () => {
    const overrides = { ...METRONOME, trackLength: 1000 };
    const slow = party(overrides, [1, 2]);
    drive(slow, (subject, state) => (subject.id === 1 ? honest(subject, state) : SHAKING), 12, 1 / 15);
    const fast = party(overrides, [1, 2]);
    drive(fast, (subject, state) => (subject.id === 1 ? honest(subject, state) : SHAKING), 12, 1 / 100);

    expect(racer(slow, 2).caught).toBeGreaterThan(0);
    expect(racer(slow, 2).caught).toBe(racer(fast, 2).caught);
    expect(racer(slow, 1).caught).toBe(0);
    expect(racer(fast, 1).caught).toBe(0);
    expect(racer(slow, 1).attempts.length).toBe(racer(fast, 1).attempts.length);
    expect(slow.segment).toBe(fast.segment);
  });

  it('keeps every light the length it was dealt, however the frames land', () => {
    // Nothing lines up with a frame here: the lights are the real random ones,
    // and the simulation steps them 8 ms at a time. A light that quietly ran
    // long by the leftover of each frame would drift the whole pattern away
    // from the times the solo ghost is being drawn against.
    for (const frame of [1 / 15, 1 / 100]) {
      const state = party();
      const lights = drive(state, statue, 150, frame).filter(
        (stamp) => stamp.event.kind === 'light',
      );
      expect(lights.length).toBeGreaterThan(20);

      let due = 0;
      for (let i = 0; i + 1 < lights.length && i < state.pattern.length; i++) {
        due += state.pattern[i]?.seconds ?? 0;
        const at = lights[i + 1]?.at ?? -1;
        // A light can only ever land within one 8 ms simulation step of where
        // the pattern says, plus the frame the stamp was taken at the end of.
        // What it must not do is wander further out the longer the race runs.
        expect(at).toBeGreaterThan(due - STEP - 1e-9);
        expect(at).toBeLessThan(due + STEP + frame + 1e-9);
      }
    }
  });

  it('drops a frame it cannot simulate rather than running a red nobody saw', () => {
    // A backgrounded tab hands back several seconds at once. Replaying that
    // whole delta would run lights the player was never shown.
    const state = party({ ...METRONOME, trackLength: 1000 });
    drive(state, oblivious, 1.5);
    const progress = racer(state).progress;
    const clock = state.clock;

    readStillness(state, 1, SHAKING, false);
    stepStatue(state, 10);

    expect(state.phase).toBe('green');
    expect(state.clock - clock).toBeLessThanOrEqual(0.26);
    expect(racer(state).progress - progress).toBeCloseTo(4, 0);
  });
});
