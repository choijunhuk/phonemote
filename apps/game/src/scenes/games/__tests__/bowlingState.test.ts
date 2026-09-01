import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rotateAbout } from '../../../input/pose.js';
import type { CanonicalAngles, CanonicalVector } from '../../../input/types.js';
import {
  DRILLS,
  PIN_HEAD_Y,
  bowlingConfigFor,
  canThrow,
  createBowling,
  currentDrill,
  findPlayer,
  frameScores,
  hookFor,
  knockPins,
  leader,
  pressTrigger,
  readPose,
  readStillness,
  readSwing,
  release,
  scoreFrames,
  seededRandom,
  speedFor,
  standings,
  stepBowling,
  syncPlayers,
  upNext,
  type BowlingConfig,
  type BowlingEvent,
  type BowlingPlayer,
  type BowlingState,
} from '../bowlingState.js';

/**
 * The rules of Bowling, driven at a frame rate we choose with a clock we
 * control.
 *
 * Every throw here is made the way the scene makes one: a gravity reading for
 * the stance, a trigger press, then a release carrying the rate at that instant
 * and the burst's axis integrals. Nothing reaches into the state to place a
 * ball on the lane.
 */

const FRAME = 1 / 60;

/** Held upright, screen towards the player: gravity-up is the phone's own +Y. */
const GRIP: CanonicalVector = { x: 0, y: 1, z: 0 };
/** The phone's aiming axis; rolling the wrist turns about this (types.ts 5.2). */
const FORWARD: CanonicalVector = { x: 0, y: 0, z: -1 };
/** A phone lying on a table, which is the hold this game cannot read. */
const FLAT: CanonicalVector = { x: 0, y: 0, z: 1 };

/**
 * What a phone reports once the wrist has rolled it this far from GRIP. Turning
 * the phone by R moves gravity in its own frame by R inverse, hence the
 * negation.
 */
function rolled(deg: number): CanonicalVector {
  return rotateAbout(GRIP, FORWARD, -deg);
}

/**
 * One phone clock, shared across a test's calls.
 *
 * The burst pairing is the only thing here that reads wall time, and it reads
 * it as a difference. A clock that restarted on every call would make a
 * backswing and its delivery arrive in the wrong order.
 */
let clockMs = 1000;

function bowling(
  mode: string,
  ids: readonly number[] = [1],
  overrides: Partial<BowlingConfig> = {},
): BowlingState {
  clockMs = 1000;
  return createBowling(mode, ids, overrides);
}

/** Hold every phone still until its grip is taken without anybody pressing anything. */
function gripAll(state: BowlingState, up: CanonicalVector = GRIP): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  for (const seated of state.players) {
    for (let i = 0; i < 30; i++) readPose(state, seated.id, up);
    events.push(
      ...readStillness(state, seated.id, { still: true, steadyMs: 500, stalled: false }, clockMs),
    );
  }
  return events;
}

/** A match with everybody gripped and ready to aim. */
function ready(
  mode: string,
  ids: readonly number[] = [1],
  overrides: Partial<BowlingConfig> = {},
): BowlingState {
  const state = bowling(mode, ids, overrides);
  gripAll(state);
  return state;
}

function player(state: BowlingState, id: number): BowlingPlayer {
  const found = findPlayer(state, id);
  if (!found) throw new Error(`no player ${id}`);
  return found;
}

/** Pin numbers still up, 1-10, which is what the screen draws. */
function standing(state: BowlingState, id: number): number[] {
  return player(state, id)
    .pins.map((up, index) => (up ? index + 1 : 0))
    .filter((pin) => pin > 0);
}

interface Shot {
  /** Wrist angle held at the moment the trigger goes down. */
  readonly aim?: number;
  /** |omega| at release, deg/s. */
  readonly rate: number;
  readonly roll?: number;
  readonly pitch?: number;
}

function angles(shot: Shot): CanonicalAngles {
  return { yaw: 0, pitch: shot.pitch ?? 100, roll: shot.roll ?? 0 };
}

function run(state: BowlingState, seconds: number, frame = FRAME): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  for (let i = 0; i < Math.round(seconds / frame); i++) {
    clockMs += frame * 1000;
    events.push(...stepBowling(state, frame, clockMs));
  }
  return events;
}

/** Frames until this player's ball has rolled and their pins have settled. */
function untilSettled(state: BowlingState, id: number, frame = FRAME): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  const rolling = player(state, id);
  for (let i = 0; i < Math.ceil(20 / frame); i++) {
    if (rolling.phase !== 'roll' && rolling.phase !== 'pins') break;
    clockMs += frame * 1000;
    events.push(...stepBowling(state, frame, clockMs));
  }
  return events;
}

/** Aim, press, let go, and wait for the rack. */
function bowl(state: BowlingState, id: number, shot: Shot, frame = FRAME): BowlingEvent[] {
  const events: BowlingEvent[] = [];
  readPose(state, id, rolled(shot.aim ?? 0));
  events.push(...pressTrigger(state, id));
  events.push(...release(state, id, shot.rate, angles(shot)));
  events.push(...untilSettled(state, id, frame));
  return events;
}

/**
 * The shots the tests below are built from, each named for what a bowler would
 * call it. What they leave standing is fixed by the seed, not by luck.
 */
const POCKET: Shot = { aim: 0, rate: 700, roll: 60, pitch: 100 };
const NOSE: Shot = { aim: 0, rate: 600, roll: 0, pitch: 100 };
const GUTTER: Shot = { aim: -20, rate: 700, roll: -120, pitch: 100 };
/** The corner-pin drill shots, one for each side of the deck. */
const AT_SEVEN: Shot = { aim: -16, rate: 700, roll: 80, pitch: 100 };
const AT_TEN: Shot = { aim: 16, rate: 700, roll: -80, pitch: 100 };
/** Frame one only: the rack seed carries the frame and the ball, so the count does too. */
const LEAVES_THREE: Shot = AT_SEVEN;
const TAKES_THREE: Shot = { aim: 0, rate: 300, roll: 40, pitch: 100 };

function onTurn(state: BowlingState): number | null {
  return state.seats.find((id) => canThrow(state, id)) ?? null;
}

describe('taking a grip', () => {
  it('waits for the hand to settle before adopting one', () => {
    const state = bowling('solo');
    for (let i = 0; i < 30; i++) readPose(state, 1, GRIP);
    // Under the 400 ms the config asks for, so nothing is adopted yet.
    expect(readStillness(state, 1, { still: true, steadyMs: 300, stalled: false }, clockMs)).toEqual(
      [],
    );
    expect(player(state, 1).grip).toBeNull();

    const events = readStillness(state, 1, { still: true, steadyMs: 500, stalled: false }, clockMs);
    expect(events.map((event) => event.kind)).toEqual(['grip_set']);
    expect(player(state, 1).phase).toBe('aim');
  });

  it('does not calibrate off a phone that has stopped sending', () => {
    // A stalled stream reads perfectly steady and is not being held at all;
    // taking it would fix the whole game to a pose nobody chose.
    const state = bowling('solo');
    for (let i = 0; i < 30; i++) readPose(state, 1, GRIP);
    expect(readStillness(state, 1, { still: true, steadyMs: 900, stalled: true }, clockMs)).toEqual(
      [],
    );
    expect(player(state, 1).grip).toBeNull();
  });

  it('refuses a phone held flat, once, and says whose it is', () => {
    const state = bowling('solo');
    for (let i = 0; i < 30; i++) readPose(state, 1, FLAT);
    expect(readStillness(state, 1, { still: true, steadyMs: 500, stalled: false }, clockMs)).toEqual(
      [{ kind: 'grip_refused', playerId: 1 }],
    );
    expect(player(state, 1).grip).toBeNull();

    // Still flat, so still wrong; saying so a second time is nagging.
    expect(readStillness(state, 1, { still: true, steadyMs: 500, stalled: false }, clockMs)).toEqual(
      [],
    );
  });

  it('starts anyway for a player who never fixes their grip', () => {
    // Nobody is left in front of a screen that will not proceed, however badly
    // they are holding the phone.
    const state = bowling('solo');
    for (let i = 0; i < 30; i++) readPose(state, 1, FLAT);
    readStillness(state, 1, { still: true, steadyMs: 500, stalled: false }, clockMs);

    // Seven seconds of a grip nobody is going to fix, then the eighth.
    run(state, 7);
    expect(player(state, 1).phase).toBe('grip');
    run(state, 2);
    expect(player(state, 1).phase).toBe('aim');
    expect(player(state, 1).grip).not.toBeNull();
    // A flat phone has gravity along the axis every wrist turn happens about,
    // so there is nothing left for the hook to be read from.
    expect(player(state, 1).gripQuality).toBe(0);
  });

  it('does not run the patience clock on a phone that is not answering', () => {
    const state = bowling('solo');
    for (let i = 0; i < 30; i++) readPose(state, 1, FLAT);
    syncPlayers(state, [{ id: 1, present: false }]);
    run(state, 12);
    expect(player(state, 1).phase).toBe('grip');

    syncPlayers(state, [{ id: 1, present: true }]);
    run(state, 9);
    expect(player(state, 1).phase).toBe('aim');
  });
});

describe('where the player stands', () => {
  it('leaves the feet alone for a wrist that is only trying to hold still', () => {
    // A hand trying to hold still reads 3.3 deg/s and wanders a degree or two.
    // Without the deadzone that wander is 0.035 of a lane, half a pin spacing.
    const state = ready('solo');
    readPose(state, 1, rolled(2));
    expect(player(state, 1).standX).toBeCloseTo(0.5, 6);
    readPose(state, 1, rolled(-2));
    expect(player(state, 1).standX).toBeCloseTo(0.5, 6);

    // Past it the feet move smoothly, not in the jump a hard deadzone makes:
    // eleven degrees is halfway to the edge of the approach.
    readPose(state, 1, rolled(11));
    expect(player(state, 1).standX).toBeCloseTo(0.675, 6);
  });

  it('reaches the edge of the approach at full wrist and goes no further', () => {
    const state = ready('solo');
    readPose(state, 1, rolled(20));
    expect(player(state, 1).standX).toBeCloseTo(0.85, 6);
    readPose(state, 1, rolled(35));
    expect(player(state, 1).standX).toBeCloseTo(0.85, 6);
    readPose(state, 1, rolled(-20));
    expect(player(state, 1).standX).toBeCloseTo(0.15, 6);
  });

  it('stops the feet the moment the throw is armed', () => {
    // The wrist turns through a delivery. If that also moved the stance, every
    // hook would drag the player sideways off the mark they had chosen.
    const state = ready('solo');
    readPose(state, 1, rolled(0));
    expect(pressTrigger(state, 1).map((event) => event.kind)).toEqual(['armed']);

    readPose(state, 1, rolled(18));
    expect(player(state, 1).aimDeg).toBeCloseTo(18, 3);
    expect(player(state, 1).standX).toBeCloseTo(0.5, 6);

    release(state, 1, 700, angles(POCKET));
    expect(player(state, 1).ball?.x).toBeCloseTo(0.5, 6);
    expect(player(state, 1).lastThrow?.standX).toBeCloseTo(0.5, 6);
  });
});

describe('letting the ball go', () => {
  it('rolls the gentle delivery a swing detector would have missed', () => {
    // The failure the design names: one of six recorded hard swings peaked at
    // 297 deg/s and fired no swing event, and a bowling delivery is the gentlest
    // motion in the set. A game that does nothing on a ball the player felt was
    // good is the complaint this project hears most.
    const state = ready('solo');
    const events = bowl(state, 1, { ...POCKET, rate: 297 });

    expect(events.some((event) => event.kind === 'released')).toBe(true);
    const knocked = events.find((event) => event.kind === 'pins');
    expect(knocked?.kind === 'pins' ? knocked.down : 0).toBeGreaterThan(0);
    expect(player(state, 1).lastThrow?.source).toBe('release');
  });

  it('rolls a release too slow to be a delivery, and says it was weak', () => {
    const state = ready('solo');
    const events = bowl(state, 1, { ...NOSE, rate: 100 });

    const letGo = events.find((event) => event.kind === 'released');
    expect(letGo?.kind === 'released' ? letGo.weak : false).toBe(true);
    expect(player(state, 1).lastThrow?.speed).toBe(0.45);
    // Rolled at the minimum rather than swallowed: a silent nothing is
    // indistinguishable from a game that is broken.
    expect(player(state, 1).frames[0]).toHaveLength(1);
  });

  it('turns the rate at release into a speed between the two ends', () => {
    // 220 deg/s is the rate at the instant the hand opens, not the peak of a
    // burst: a delivery that peaked at 300 is already well under that by then.
    expect(speedFor(220)).toBe(0.45);
    expect(speedFor(1000)).toBe(1);
    expect(speedFor(1500)).toBe(1);
    expect(speedFor(0)).toBe(0.45);
    expect(speedFor(610)).toBeCloseTo(0.725, 12);
  });

  it('reads a wrist turn as hook without letting a flick read as all of it', () => {
    // The ratio is roll over pitch because an arm swing is nearly pure pitch and
    // a wrist turn nearly pure roll. The pitch floor is what stops a delivery
    // with almost no arm in it from reading as maximum bend.
    expect(hookFor({ yaw: 0, pitch: 200, roll: 100 })).toBeCloseTo(0.5, 12);
    expect(hookFor({ yaw: 0, pitch: 5, roll: 15 })).toBeCloseTo(0.5, 12);
    expect(hookFor({ yaw: 0, pitch: -100, roll: -50 })).toBeCloseTo(-0.5, 12);
    expect(hookFor({ yaw: 0, pitch: 40, roll: 400 })).toBe(1);
    expect(hookFor({ yaw: 0, pitch: 40, roll: -400 })).toBe(-1);
  });

  it('bends the ball late, so a hook is a hook and not a diagonal', () => {
    const state = ready('practice');
    bowl(state, 1, POCKET);
    const path = player(state, 1).traces[0]?.path ?? [];
    // About 30 samples a second over a ball that takes 1.6 s to reach the deck:
    // dense enough to draw a curve with rather than a chord across it.
    expect(path.length).toBeGreaterThan(45);
    expect(path.length).toBeLessThan(60);

    const skid = path.filter((point) => point.y < 0.6);
    expect(skid.length).toBeGreaterThan(3);
    for (const point of skid) expect(point.x).toBeCloseTo(0.5, 6);
    expect(path[path.length - 1]?.x ?? 0).toBeGreaterThan(0.55);
  });
});

describe('a player who never touches the trigger', () => {
  it('rolls on the delivery, not on the backswing that came first', () => {
    // Taking the first burst would roll the ball backwards at the speed of a
    // windup.
    const state = ready('solo');
    readPose(state, 1, rolled(0));
    expect(readSwing(state, 1, 400, { yaw: 0, pitch: -100, roll: 0 }, clockMs)).toEqual([]);

    clockMs += 600;
    const events = readSwing(state, 1, 700, angles(POCKET), clockMs);
    expect(events.map((event) => event.kind)).toEqual(['released']);
    untilSettled(state, 1);
    expect(player(state, 1).lastThrow?.source).toBe('swing');
    expect(player(state, 1).lastThrow?.rate).toBe(700);
  });

  it('still pairs a delivery a full second after its backswing', () => {
    // An arm that goes back slowly is one delivery, not two unrelated bursts.
    const state = ready('solo');
    readPose(state, 1, rolled(0));
    readSwing(state, 1, 400, { yaw: 0, pitch: -100, roll: 0 }, clockMs);

    clockMs += 1000;
    const events = readSwing(state, 1, 700, angles(POCKET), clockMs);
    expect(events.map((event) => event.kind)).toEqual(['released']);
  });

  it('does not pair a burst with one that was something else entirely', () => {
    const state = ready('solo');
    readPose(state, 1, rolled(0));
    readSwing(state, 1, 400, { yaw: 0, pitch: -100, roll: 0 }, clockMs);

    // 1250 ms later, which is past the window a delivery follows its backswing in.
    clockMs += 1250;
    expect(readSwing(state, 1, 700, angles(POCKET), clockMs)).toEqual([]);
    expect(player(state, 1).phase).toBe('aim');
  });

  it('rolls a half swing that never came back rather than swallowing it', () => {
    const state = ready('solo');
    readPose(state, 1, rolled(0));
    readSwing(state, 1, 700, angles(POCKET), clockMs);

    run(state, 1.3);
    expect(player(state, 1).phase).toBe('aim');
    run(state, 0.4);
    expect(player(state, 1).phase).toBe('roll');
    untilSettled(state, 1);
    expect(player(state, 1).frames[0]).toEqual([10]);
  });
});

describe('the pins', () => {
  it('takes all ten on a hook into the pocket', () => {
    const state = ready('solo');
    const events = bowl(state, 1, POCKET);
    const knocked = events.find((event) => event.kind === 'pins');
    expect(knocked).toEqual({ kind: 'pins', playerId: 1, down: 10, standing: 0 });
    expect(events.some((event) => event.kind === 'strike')).toBe(true);
    expect(player(state, 1).frames[0]).toEqual([10]);
  });

  it('leaves the Big Four on a straight ball dead on the nose', () => {
    // The classic way to leave a split: the ball spends itself on every pin it
    // hits, so it reaches the back row too weak to pass anything to the corners.
    const state = ready('solo');
    bowl(state, 1, NOSE);
    expect(standing(state, 1)).toEqual([4, 6, 7, 10]);
    expect(player(state, 1).frames[0]).toEqual([6]);
  });

  it('leaves the pins down long enough to be seen before the next ball', () => {
    const state = ready('solo');
    readPose(state, 1, rolled(0));
    pressTrigger(state, 1);
    release(state, 1, 700, angles(POCKET));

    // The ball reaches the deck at 1.6 s; a third of a second later the rack is
    // still on the floor.
    run(state, 2);
    expect(player(state, 1).phase).toBe('pins');
    run(state, 1.2);
    expect(player(state, 1).phase).toBe('aim');
  });

  it('takes nothing at all in the gutter, and says so', () => {
    const state = ready('solo');
    const events = bowl(state, 1, GUTTER);
    expect(events.some((event) => event.kind === 'gutter')).toBe(true);
    expect(standing(state, 1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(player(state, 1).frames[0]).toEqual([0]);

    // Called out at the edge of the lane, not once the ball is well down the
    // gutter, so the ball the screen draws is where the ball went.
    const trace = player(state, 1).traces[0];
    const end = trace?.path[trace.path.length - 1];
    expect(end?.x ?? 0).toBeGreaterThan(0.049);
    expect(end?.x ?? 0).toBeLessThanOrEqual(0.05);
  });

  it('judges each row against the line the ball had when it got there', () => {
    const rack = new Array<boolean>(10).fill(true);
    // A ball that never reached the deck knocks nothing over on its way.
    expect(knockPins(rack, [], seededRandom(1)).some(Boolean)).toBe(false);
    // Nor does one that went down the far left of it.
    expect(knockPins(rack, [0.1, 0.1, 0.1, 0.1], seededRandom(1)).some(Boolean)).toBe(false);
  });
});

describe('the scoring rule', () => {
  it('pays a strike ten plus the next two balls', () => {
    expect(scoreFrames([[10], [4, 3]])).toBe(17 + 7);
    // Two strikes running: the first frame is paid by both of the next balls,
    // and they live in two different frames.
    expect(scoreFrames([[10], [10], [4, 3]])).toBe(24 + 17 + 7);
  });

  it('pays a spare ten plus the next one', () => {
    expect(scoreFrames([[7, 3], [4, 3]])).toBe(14 + 7);
    expect(scoreFrames([[0, 10], [9, 0]])).toBe(19 + 9);
  });

  it('adds up an open frame and nothing more', () => {
    expect(scoreFrames([[4, 3], [0, 0], [9, 0]])).toBe(16);
    expect(scoreFrames([[0, 0]])).toBe(0);
  });

  it('runs the tenth frame to three balls when it earns them', () => {
    const nine = Array.from({ length: 9 }, () => [0, 0]);
    expect(scoreFrames([...nine, [10, 10, 10]])).toBe(30);
    expect(scoreFrames([...nine, [10, 3, 4]])).toBe(17);
    expect(scoreFrames([...nine, [3, 7, 5]])).toBe(15);
    expect(scoreFrames([...nine, [3, 4]])).toBe(7);
    // There is no eleventh frame, whatever is handed in.
    expect(scoreFrames([...nine, [10, 10, 10], [10, 10, 10]])).toBe(30);
  });

  it('makes twelve strikes three hundred and twelve gutters nothing', () => {
    const strikes = Array.from({ length: 9 }, () => [10]).concat([[10, 10, 10]]);
    expect(scoreFrames(strikes)).toBe(300);
    expect(scoreFrames(Array.from({ length: 10 }, () => [0, 0]))).toBe(0);
    // Nine and a spare in every frame is the other number every bowler knows.
    expect(scoreFrames(Array.from({ length: 9 }, () => [9, 1]).concat([[9, 1, 9]]))).toBe(190);
  });

  it('prints nothing under a frame whose bonus balls are still to come', () => {
    // A scoreboard that guesses at a strike and then corrects itself is how a
    // player loses track of what they are watching.
    expect(frameScores([[10]])).toEqual([null]);
    expect(frameScores([[10], [4]])).toEqual([null]);
    expect(frameScores([[10], [4, 3]])).toEqual([17, 24]);
    expect(frameScores([[7, 3]])).toEqual([null]);
    expect(frameScores([[7, 3], [4]])).toEqual([14, null]);
    expect(frameScores([[4]])).toEqual([null]);
  });
});

describe('a game as it is actually bowled', () => {
  it('writes the card from the balls that were rolled', () => {
    const state = ready('solo');
    bowl(state, 1, LEAVES_THREE);
    expect(player(state, 1).frames[0]).toEqual([7]);
    const spare = bowl(state, 1, TAKES_THREE);
    expect(spare.some((event) => event.kind === 'spare')).toBe(true);

    bowl(state, 1, POCKET);
    bowl(state, 1, NOSE);
    bowl(state, 1, GUTTER);

    expect(player(state, 1).frames).toEqual([[7, 3], [10], [6, 0], []]);
    // 10 + 10 for the spare, 10 + 6 + 0 for the strike, then the open frame.
    expect(frameScores(player(state, 1).frames)).toEqual([20, 36, 42]);
    expect(player(state, 1).score).toBe(42);
    expect(upNext(player(state, 1))).toEqual({ frame: 4, ball: 1 });
  });

  it('re-racks inside the tenth frame and pays three hundred for twelve strikes', () => {
    const state = ready('solo');
    const events: BowlingEvent[] = [];
    for (let ball = 0; ball < 20 && !state.over; ball++) events.push(...bowl(state, 1, POCKET));

    expect(player(state, 1).frames).toEqual([
      [10],
      [10],
      [10],
      [10],
      [10],
      [10],
      [10],
      [10],
      [10],
      [10, 10, 10],
    ]);
    expect(player(state, 1).score).toBe(300);
    expect(player(state, 1).phase).toBe('done');
    expect(state.over).toBe(true);
    expect(events.filter((event) => event.kind === 'strike')).toHaveLength(12);
    expect(events.filter((event) => event.kind === 'frame')).toHaveLength(10);
    expect(events.filter((event) => event.kind === 'over')).toHaveLength(1);
  });

  it('ends a game in which nothing was ever knocked down', () => {
    // Ten frames of gutters is the shortest road to the end of a match, and the
    // one a game that cannot end fails first.
    const state = ready('solo');
    for (let ball = 0; ball < 40 && !state.over; ball++) bowl(state, 1, GUTTER);

    expect(state.over).toBe(true);
    expect(player(state, 1).score).toBe(0);
    expect(player(state, 1).frames).toHaveLength(10);
    expect(player(state, 1).frames.every((frame) => frame.length === 2)).toBe(true);
  });
});

describe('taking turns', () => {
  it('hands the lane on after a frame, not after a ball', () => {
    const state = ready('versus', [1, 2, 3]);
    expect(onTurn(state)).toBe(1);

    bowl(state, 1, NOSE);
    expect(onTurn(state)).toBe(1);
    bowl(state, 1, GUTTER);
    expect(onTurn(state)).toBe(2);

    bowl(state, 2, POCKET);
    expect(onTurn(state)).toBe(3);
    bowl(state, 3, POCKET);
    expect(onTurn(state)).toBe(1);
  });

  it('will not let anybody else arm a throw', () => {
    const state = ready('versus', [1, 2]);
    readPose(state, 2, rolled(0));
    expect(pressTrigger(state, 2)).toEqual([]);
    expect(release(state, 2, 700, angles(POCKET))).toEqual([]);
    expect(canThrow(state, 2)).toBe(false);
    expect(player(state, 2).frames[0]).toEqual([]);
  });

  it('seats a phone that arrived after the match started as a spectator', () => {
    const state = ready('versus', [1, 2]);
    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
      { id: 3, present: true },
    ]);
    expect(findPlayer(state, 3)).toBeDefined();
    expect(canThrow(state, 3)).toBe(false);
    // No seat, so no line on the scoreboard either.
    expect(standings(state).map((seated) => seated.id)).toEqual([1, 2]);
  });

  it('puts the higher score first and leaves a tie in seating order', () => {
    const state = ready('versus', [1, 2]);
    expect(leader(state)?.id).toBe(1);
    bowl(state, 1, NOSE);
    bowl(state, 1, GUTTER);
    bowl(state, 2, GUTTER);
    bowl(state, 2, GUTTER);

    expect(standings(state).map((seated) => seated.id)).toEqual([1, 2]);
    expect(leader(state)?.score).toBe(6);
  });

  it('gives a player long enough to pick the phone up and aim', () => {
    // A frame includes standing up and getting ready. A turn that expires under
    // somebody who is still doing that is worse than one that hangs.
    const state = ready('versus', [1, 2]);
    run(state, 45);
    expect(onTurn(state)).toBe(1);

    const events = run(state, 20);
    expect(events.some((event) => event.kind === 'timed_out')).toBe(true);
    expect(onTurn(state)).toBe(2);
  });

  it('gives up on a turn nobody takes without charging them a zero', () => {
    // An expired turn is usually a phone put down. Coming back to a card
    // somebody else's inattention had written on is worse than losing the turn.
    const state = ready('versus', [1, 2], { turnSeconds: 5 });
    readPose(state, 1, rolled(0));
    pressTrigger(state, 1);
    expect(player(state, 1).phase).toBe('armed');

    const events = run(state, 6);
    expect(events.some((event) => event.kind === 'timed_out')).toBe(true);
    expect(onTurn(state)).toBe(2);
    expect(player(state, 1).frames[0]).toEqual([]);
    // Whatever was armed is dropped, so the ball cannot arrive on a lane that
    // has moved on.
    expect(player(state, 1).phase).toBe('aim');
    expect(release(state, 1, 700, angles(POCKET))).toEqual([]);
  });
});

describe('a phone that drops out mid-game', () => {
  it('keeps its frames, its pins and its place in the order', () => {
    const state = ready('versus', [1, 2]);
    bowl(state, 1, POCKET);
    bowl(state, 2, NOSE);
    expect(player(state, 2).frames).toEqual([[6]]);

    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    expect(onTurn(state)).toBe(1);
    bowl(state, 1, POCKET);

    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
    ]);
    // They come back into the order rather than on top of it, so P1 keeps the
    // frame they are in the middle of.
    expect(onTurn(state)).toBe(1);
    bowl(state, 1, POCKET);
    expect(onTurn(state)).toBe(2);

    // Half a frame thrown, four pins standing, and the second ball still theirs.
    expect(player(state, 2).frames).toEqual([[6]]);
    expect(player(state, 2).score).toBe(6);
    expect(standing(state, 2)).toEqual([4, 6, 7, 10]);
    expect(player(state, 2).grip).not.toBeNull();
    expect(upNext(player(state, 2))).toEqual({ frame: 1, ball: 2 });
  });

  it('does not take the lane from whoever has it while its own ball rolls', () => {
    // P1 drops after letting go. setAbsent has already passed the turn over
    // them, and their ball landing must not pass it on a second time — P2 lost a
    // whole frame to a ball somebody else had thrown before they dropped.
    const state = ready('versus', [1, 2, 3]);
    readPose(state, 1, rolled(0));
    pressTrigger(state, 1);
    release(state, 1, 700, angles(POCKET));

    syncPlayers(state, [
      { id: 1, present: false },
      { id: 2, present: true },
      { id: 3, present: true },
    ]);
    expect(onTurn(state)).toBe(2);
    untilSettled(state, 1);

    expect(onTurn(state)).toBe(2);
    expect(player(state, 1).frames).toEqual([[10], []]);
  });

  it('does not roll a ball for a phone that left between backswing and delivery', () => {
    const state = ready('versus', [1, 2]);
    readPose(state, 1, rolled(0));
    readSwing(state, 1, 700, angles(POCKET), clockMs);

    syncPlayers(state, [
      { id: 1, present: false },
      { id: 2, present: true },
    ]);
    run(state, 2.3);

    expect(player(state, 1).phase).toBe('aim');
    expect(player(state, 1).frames).toEqual([[]]);
    expect(onTurn(state)).toBe(2);
  });

  it('finishes the match rather than waiting for a phone that never comes back', () => {
    const state = ready('versus', [1, 2]);
    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    for (let ball = 0; ball < 20 && !state.over; ball++) {
      const who = onTurn(state);
      if (who === null) break;
      bowl(state, who, POCKET);
    }

    expect(state.over).toBe(true);
    expect(player(state, 1).score).toBe(300);
    // The phone that left keeps its seat and its card in the final table.
    expect(standings(state).map((seated) => seated.id)).toEqual([1, 2]);
    expect(player(state, 2).phase).toBe('aim');
  });
});

describe('the practice screens', () => {
  it('lets four phones roll at once, on four private lanes', () => {
    const state = ready('practice', [1, 2, 3, 4]);
    for (const id of [1, 2, 3, 4]) expect(canThrow(state, id)).toBe(true);
    expect(state.turn).toBeNull();
    expect(state.config.frames).toBe(0);

    for (const id of [1, 2, 3, 4]) bowl(state, id, GUTTER);
    for (const id of [1, 2, 3, 4]) expect(player(state, id).drillAttempts).toBe(1);
  });

  it('sets up the corner pins and the splits the drill asks for', () => {
    const state = ready('practice');
    expect(currentDrill(state, player(state, 1))?.key).toBe('seven');
    expect(standing(state, 1)).toEqual([7]);
    expect(DRILLS.map((drill) => drill.standing)).toEqual([[7], [10], [4, 6], [3, 6, 10]]);
  });

  it('moves on once the drill has been cleared three times', () => {
    const state = ready('practice');
    const events: BowlingEvent[] = [];
    for (let ball = 0; ball < 3; ball++) events.push(...bowl(state, 1, AT_SEVEN));

    expect(events.filter((event) => event.kind === 'drill_cleared')).toHaveLength(3);
    expect(currentDrill(state, player(state, 1))?.key).toBe('ten');
    expect(standing(state, 1)).toEqual([10]);
  });

  it('moves on from a split nobody can make, instead of locking the screen', () => {
    // The 4 and 6 pins are 0.17 of a lane apart against a 0.11 reach, so the
    // ball cannot take one with the other and the drill can never be cleared.
    const state = ready('practice');
    for (let ball = 0; ball < 3; ball++) bowl(state, 1, AT_SEVEN);
    for (let ball = 0; ball < 3; ball++) bowl(state, 1, AT_TEN);
    expect(currentDrill(state, player(state, 1))?.key).toBe('split-4-6');

    const events: BowlingEvent[] = [];
    for (let ball = 0; ball < 5; ball++) events.push(...bowl(state, 1, POCKET));
    expect(events.some((event) => event.kind === 'drill_cleared')).toBe(false);
    expect(currentDrill(state, player(state, 1))?.key).toBe('split-3-6-10');
  });

  it('ends when the drills run out, however badly they went', () => {
    const state = ready('practice');
    const events: BowlingEvent[] = [];
    for (let ball = 0; ball < 60 && !state.over; ball++) events.push(...bowl(state, 1, GUTTER));

    expect(state.over).toBe(true);
    expect(player(state, 1).phase).toBe('done');
    expect(currentDrill(state, player(state, 1))).toBeNull();
    const moved = events.filter((event) => event.kind === 'drill_next');
    expect(moved).toHaveLength(4);
    expect(moved[moved.length - 1]).toEqual({ kind: 'drill_next', playerId: 1, drill: null });
    // Four drills, five balls each, and nothing knocked down in any of them.
    expect(player(state, 1).throws).toBe(20);
  });

  it('keeps five throws with their numbers, where a game keeps one', () => {
    // The lane-reading screen exists so a player can tell a bad ball from one
    // the game never saw, and that needs the numbers, not the result.
    const practice = ready('practice');
    for (let ball = 0; ball < 7; ball++) bowl(practice, 1, POCKET);
    expect(player(practice, 1).traces).toHaveLength(5);
    expect(practice.config.diagnostics).toBe(true);

    const trace = player(practice, 1).traces[0];
    expect(trace?.rate).toBe(700);
    expect(trace?.rollDeg).toBe(60);
    expect(trace?.pitchDeg).toBe(100);
    expect(trace?.hook).toBeCloseTo(0.6, 12);
    expect(trace?.gripQuality).toBe(1);

    const solo = ready('solo');
    bowl(solo, 1, POCKET);
    bowl(solo, 1, POCKET);
    expect(player(solo, 1).traces).toHaveLength(1);
    expect(solo.config.diagnostics).toBe(false);
  });

  it('sends an unrecognised mode somewhere nothing can go wrong', () => {
    expect(bowlingConfigFor('solo').mode).toBe('solo');
    expect(bowlingConfigFor('versus').mode).toBe('versus');
    expect(bowlingConfigFor('coop').mode).toBe('practice');
    expect(bowlingConfigFor('coop').frames).toBe(0);
    expect(bowlingConfigFor('coop').turnBased).toBe(false);
  });
});

describe('determinism', () => {
  it('has no Math.random in it at all', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../bowlingState.ts', import.meta.url)),
      'utf8',
    );
    // The two mentions left in the file are comments saying it is not called.
    expect(source).not.toContain('Math.random(');
  });

  it('deals the same rack for the same seed, and a different one otherwise', () => {
    // A hit 0.041 of a lane off the head pin carries 0.256, which passes 0.179
    // to its neighbours against a 0.18 threshold — inside the +-8% jitter, so
    // this is the one rack where the seed alone decides what falls.
    const rack = new Array<boolean>(10).fill(true);
    const marginal = [0.5409];
    const once = knockPins(rack, marginal, seededRandom(4));
    expect(knockPins(rack, marginal, seededRandom(4))).toEqual(once);

    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      outcomes.add(knockPins(rack, marginal, seededRandom(seed)).join(''));
    }
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it('plays the same game twice for the same seed', () => {
    const script: Shot[] = [LEAVES_THREE, TAKES_THREE, POCKET, NOSE, GUTTER];
    const once = ready('solo');
    for (const shot of script) bowl(once, 1, shot);
    const twice = ready('solo');
    for (const shot of script) bowl(twice, 1, shot);

    expect(player(twice, 1).frames).toEqual(player(once, 1).frames);
    expect(player(twice, 1).score).toBe(player(once, 1).score);
    expect(player(twice, 1).traces[0]?.path).toEqual(player(once, 1).traces[0]?.path);
  });

  it('gives one player the same rack whatever the others do', () => {
    // The seed carries the player id, so two people on two lanes cannot deal
    // each other a different set of pins.
    const alone = ready('versus', [1, 2]);
    bowl(alone, 1, NOSE);
    const crowded = ready('versus', [1, 2]);
    bowl(crowded, 1, NOSE);
    bowl(crowded, 1, GUTTER);
    bowl(crowded, 2, POCKET);
    bowl(crowded, 1, NOSE);

    expect(player(crowded, 1).frames[1]).toEqual(player(alone, 1).frames[0]);
  });
});

describe('a frame rate that is never the same twice', () => {
  it('rolls the same ball at 15 Hz as at 100', () => {
    const slow = ready('solo');
    bowl(slow, 1, POCKET, 1 / 15);
    bowl(slow, 1, NOSE, 1 / 15);
    const fast = ready('solo');
    bowl(fast, 1, POCKET, 1 / 100);
    bowl(fast, 1, NOSE, 1 / 100);

    expect(player(slow, 1).frames).toEqual(player(fast, 1).frames);
    const slowTrace = player(slow, 1).traces[0];
    const fastTrace = player(fast, 1).traces[0];
    expect(slowTrace?.pinsDown).toBe(fastTrace?.pinsDown);
    // Not just the same result: the same trail, point for point, because the
    // practice screen draws it and a hook that thins out at one frame rate is a
    // different picture of the same ball.
    expect(slowTrace?.path.length).toBeGreaterThan(45);
    expect(slowTrace?.path).toEqual(fastTrace?.path);
  });

  it('plays a whole game to the same card at either rate', () => {
    const slow = ready('solo');
    for (let ball = 0; ball < 24 && !slow.over; ball++) bowl(slow, 1, NOSE, 1 / 15);
    const fast = ready('solo');
    for (let ball = 0; ball < 24 && !fast.over; ball++) bowl(fast, 1, NOSE, 1 / 100);

    expect(slow.over).toBe(true);
    expect(fast.over).toBe(true);
    expect(player(slow, 1).frames).toEqual(player(fast, 1).frames);
    expect(player(slow, 1).score).toBe(player(fast, 1).score);
  });

  it('drops a frame it cannot simulate rather than flying the ball through the rack', () => {
    // A backgrounded tab hands back a ten-second delta. Integrating it whole
    // would put the ball past the pins without its line ever having crossed a
    // row of them.
    const state = ready('solo');
    readPose(state, 1, rolled(0));
    pressTrigger(state, 1);
    release(state, 1, 700, angles(POCKET));

    clockMs += 10_000;
    stepBowling(state, 10, clockMs);
    expect(player(state, 1).phase).toBe('roll');
    expect(player(state, 1).ball?.y ?? 99).toBeLessThan(PIN_HEAD_Y);
    expect(player(state, 1).crossings).toEqual([]);

    untilSettled(state, 1);
    expect(player(state, 1).frames[0]).toEqual([10]);
  });
});
