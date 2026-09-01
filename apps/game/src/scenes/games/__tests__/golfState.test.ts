import { describe, expect, it, vi } from 'vitest';
import { rotateAbout } from '../../../input/pose.js';
import type { CanonicalVector } from '../../../input/types.js';
import {
  CLUB_CARRY_M,
  GIMME_RADIUS_M,
  GOLF_MODES,
  PUTT_LADDER_M,
  applyStroke,
  applySwing,
  cardOf,
  createGolf,
  distanceToPin,
  dispersionOf,
  faceAngle,
  findPlayer,
  holeFor,
  leaderboard,
  puttBand,
  readPose,
  readStillness,
  refusalFor,
  setClub,
  setDrill,
  setPowerScale,
  shooter,
  stepGolf,
  suggestClub,
  syncPlayers,
  termFor,
  type Club,
  type GolfEvent,
  type GolfOptions,
  type GolfPlayer,
  type GolfState,
  type Lie,
  type PuttBand,
} from '../golfState.js';

/**
 * The rules of Golf, driven at a frame rate the test chooses.
 *
 * Everything a phone can say arrives through four calls: a gravity vector
 * (readPose), how still the hand is (readStillness), a swing and a stroke. The
 * helpers below are those four and nothing else, so a test that passes here is
 * a test the scene can reproduce.
 */

const FRAME = 1 / 60;

/** Held upright, screen towards the player: gravity-up is the phone's own +Y. */
const GRIP: CanonicalVector = { x: 0, y: 1, z: 0 };
/** The phone's aiming axis; rolling turns about this (types.ts 5.2). */
const FORWARD: CanonicalVector = { x: 0, y: 0, z: -1 };

/** What a phone rolled this far from its grip reports. + is right edge down. */
function rolled(deg: number): CanonicalVector {
  return rotateAbout(GRIP, FORWARD, -deg);
}

function golf(options: GolfOptions = {}, ids: readonly number[] = [1]): GolfState {
  const state = createGolf({ playerIds: ids, ...options });
  for (const id of ids) grip(state, id);
  return state;
}

/** Hold the phone still until the rules adopt the hold. 3.3 deg/s is measured. */
function grip(state: GolfState, id: number, up: CanonicalVector = GRIP): GolfEvent[] {
  for (let i = 0; i < 30; i++) readPose(state, id, up, i * 16);
  return readStillness(state, id, { rate: 3.3, steadyMs: 500, stalled: false });
}

/** Ask for this much aim. The rules halve the roll, so the roll is doubled. */
function aim(state: GolfState, id: number, deg: number): void {
  readPose(state, id, rolled(deg * 2), 1000);
}

function player(state: GolfState, id = 1): GolfPlayer {
  const found = findPlayer(state, id);
  if (!found) throw new Error(`player ${id} is not in this match`);
  return found;
}

function band(state: GolfState, id = 1): PuttBand {
  const found = puttBand(state, player(state, id));
  if (!found) throw new Error(`player ${id} is not on a green`);
  return found;
}

interface SwingOptions {
  readonly peak?: number;
  /** Degrees of roll through the burst: + opens the face, - closes it. */
  readonly roll?: number;
  readonly pitch?: number;
  readonly durationMs?: number;
}

function swing(state: GolfState, id: number, options: SwingOptions = {}): GolfEvent[] {
  return applySwing(state, id, {
    peakRate: options.peak ?? 1250,
    rotation: { yaw: 0, pitch: options.pitch ?? 60, roll: options.roll ?? 0 },
    durationMs: options.durationMs ?? 200,
    timestamp: 0,
  });
}

function stroke(state: GolfState, id: number, angleDeg: number, durationMs = 400): GolfEvent[] {
  return applyStroke(state, id, {
    angleDeg,
    durationMs,
    // A putting stroke lives below the swing detector's 300 deg/s floor.
    peakRate: 120,
    reversedFromPrevious: true,
    timestamp: 0,
  });
}

function run(state: GolfState, seconds: number, dt = FRAME): GolfEvent[] {
  const events: GolfEvent[] = [];
  const frames = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < frames; i++) events.push(...stepGolf(state, dt));
  return events;
}

/** Step until every ball has stopped, with a cap so a test cannot hang. */
function settle(state: GolfState, dt = FRAME): GolfEvent[] {
  const events: GolfEvent[] = [];
  for (let i = 0; i < Math.round(40 / dt); i++) {
    events.push(...stepGolf(state, dt));
    if (!state.players.some((one) => one.flight || one.pending)) break;
  }
  return events;
}

/**
 * Put a ball where the test needs it.
 *
 * Reaching a green takes three shots whose landing lies the course generator
 * decides, and a test about putting should not be a test about the shot before
 * it. Nothing else about the player is touched — strokes, card and grip stay.
 */
function place(state: GolfState, id: number, x: number, y: number, lie: Lie): GolfPlayer {
  const one = player(state, id);
  one.ball = { x, y };
  one.lie = lie;
  return one;
}

/**
 * The swing that carries this club exactly this far off a clean lie.
 *
 * Inverts carry = clubCarry * (0.35 + 0.65 * power) so a test can ask for a
 * distance rather than a number of degrees per second. The forward direction of
 * that formula is pinned by "carries further the harder it is swung" below.
 */
function rateFor(club: Club, carryM: number): number {
  const power = (carryM / CLUB_CARRY_M[club] - 0.35) / 0.65;
  return 350 + power * 900;
}

/** Waste a stroke: the putter carries nothing, so the ball stops where it was. */
function whiff(state: GolfState, id: number): void {
  setClub(state, id, 'putter');
  swing(state, id, { peak: 500 });
  settle(state);
  // Clear of STRIKE_WINDOW_S, so the next whiff is a new shot rather than a
  // harder burst taking this one back.
  run(state, 0.5);
}

/** Seed 10 opens on a par 4 of 319 m with no sand in it. */
const PAR_SEED = 10;

/** A scored par 4 with the ball three metres from the cup. */
function threeMetresOut(): GolfState {
  const state = golf({ mode: 'solo', config: { holes: 1 }, seed: PAR_SEED });
  const hole = holeFor(state, player(state));
  place(state, 1, 0, hole.lengthM - 3, 'green');
  return state;
}

/** The stroke that leaves the ball this far short of the cup; negative is past. */
function shortOf(state: GolfState, metres: number, id = 1): number {
  const putt = band(state, id);
  return (putt.targetDeg * (putt.distanceM - metres)) / putt.distanceM;
}

/**
 * The first two shots of a par 4: 210 m of driver runs out to 244, and the
 * wedge is asked for eight metres short of the flag so that it lands on the
 * green rather than plugging into the front of it.
 */
function driveAndApproach(state: GolfState, id = 1): GolfEvent[] {
  const events: GolfEvent[] = [];
  setClub(state, id, 'driver');
  events.push(...swing(state, id, { peak: 1250 }));
  events.push(...settle(state));

  const carry = distanceToPin(state, player(state, id)) - 8;
  setClub(state, id, 'wedge');
  events.push(...swing(state, id, { peak: rateFor('wedge', carry) }));
  events.push(...settle(state));
  return events;
}

describe('taking a grip and aiming with it', () => {
  it('waits for the hand to settle before adopting a hold', () => {
    const state = createGolf({ playerIds: [1] });
    for (let i = 0; i < 30; i++) readPose(state, 1, GRIP, i * 16);
    expect(readStillness(state, 1, { rate: 3.3, steadyMs: 120, stalled: false })).toEqual([]);
    expect(refusalFor(state, player(state))).toBe('no_grip');

    const events = readStillness(state, 1, { rate: 3.3, steadyMs: 500, stalled: false });
    expect(events).toEqual([{ kind: 'grip', playerId: 1 }]);
    expect(refusalFor(state, player(state))).toBeNull();
  });

  it('never calibrates on the pose a phone was in when it stopped answering', () => {
    const state = createGolf({ playerIds: [1] });
    for (let i = 0; i < 30; i++) readPose(state, 1, GRIP, i * 16);
    expect(readStillness(state, 1, { rate: 0.2, steadyMs: 5000, stalled: true })).toEqual([]);
    expect(player(state).grip).toBeNull();
  });

  it('measures aim from the hold the player chose, not from upright', () => {
    // Somebody holding the phone tipped 25 degrees over is not aiming right.
    const state = createGolf({ playerIds: [1] });
    grip(state, 1, rolled(25));
    readPose(state, 1, rolled(25), 1000);
    expect(player(state).aimDeg).toBeCloseTo(0, 6);

    readPose(state, 1, rolled(45), 1016);
    expect(player(state).aimDeg).toBeCloseTo(10, 3);
  });

  it('gives half the roll as aim, and stops at fifteen degrees', () => {
    const state = golf();
    aim(state, 1, 6);
    expect(player(state).aimDeg).toBeCloseTo(6, 3);
    readPose(state, 1, rolled(70), 1016);
    expect(player(state).aimDeg).toBe(15);
    readPose(state, 1, rolled(-70), 1032);
    expect(player(state).aimDeg).toBe(-15);
  });

  it('sends the ball where it was aimed', () => {
    const state = golf({ mode: 'practice' });
    aim(state, 1, 10);
    swing(state, 1);
    settle(state);

    const shot = player(state).lastShot;
    // Ten degrees right of the flag for as far as it went, and nothing sideways
    // the player did not ask for: no wind and no face on the range.
    const straight = Math.sin((10 * Math.PI) / 180) * (shot?.distanceM ?? 0);
    expect(shot?.lineErrorM ?? 0).toBeCloseTo(straight, 3);
    expect(shot?.lineErrorM ?? 0).toBeGreaterThan(30);
  });
});

describe('what the swing is read as', () => {
  it('carries further the harder it is swung', () => {
    const state = golf({ mode: 'practice' });
    swing(state, 1, { peak: 350 });
    settle(state);
    const soft = player(state).lastShot?.distanceM ?? 0;

    swing(state, 1, { peak: 1250 });
    settle(state);
    const hard = player(state).lastShot?.distanceM ?? 0;

    // The gentlest swing this player has still gets 35% of the club.
    expect(soft).toBeCloseTo(hard * 0.35, 0);
    expect(hard).toBeCloseTo(243.9, 0);
  });

  it('lets a player who cannot swing at 1250 deg/s reach full power anyway', () => {
    const state = golf({ mode: 'practice' });
    setPowerScale(state, 1, { softRate: 200, hardRate: 600 });
    swing(state, 1, { peak: 600 });
    settle(state);

    const shot = player(state).lastShot;
    expect(shot?.power).toBe(1);
    expect(shot?.distanceM ?? 0).toBeCloseTo(243.9, 0);
  });

  it('reads the face from the roll through the ball, not from a flick', () => {
    // Ten degrees of roll over a burst that barely swung is not a ten degree
    // face: the pitch floor is what keeps it from reading as a full slice.
    expect(faceAngle({ yaw: 0, pitch: 5, roll: 10 })).toBeCloseTo(4, 6);
    expect(faceAngle({ yaw: 0, pitch: 90, roll: 30 })).toBeCloseTo(4, 6);
    // And a real slice is capped where the design caps it.
    expect(faceAngle({ yaw: 0, pitch: 60, roll: 120 })).toBe(12);
    expect(faceAngle({ yaw: 0, pitch: 60, roll: -120 })).toBe(-12);
  });

  it('bends the ball the way the face was pointing', () => {
    const state = golf({ mode: 'practice' });
    swing(state, 1, { roll: -30 });
    settle(state);
    const closed = player(state).lastShot;

    swing(state, 1, { roll: 30 });
    settle(state);
    const open = player(state).lastShot;

    expect(closed?.faceDeg).toBeCloseTo(-6, 6);
    // A third of the face shows up in the line the ball starts on and the rest
    // arrives as bend: six degrees of closed face sets off 2.1 degrees left and
    // finishes 19.6 m left of the flag. A slice that started straight and then
    // hooked back would be the same number on the card and a different shot to
    // watch, which is why both halves are checked.
    expect(closed?.startHeadingDeg).toBeCloseTo(-2.1, 6);
    expect(closed?.lineErrorM ?? 0).toBeCloseTo(-19.6, 1);
    expect(open?.lineErrorM ?? 0).toBeCloseTo(-(closed?.lineErrorM ?? 0), 6);
    // A shaped shot also gives up distance to the line it took.
    expect(open?.distanceM ?? 0).toBeLessThan(243.9);
  });

  it('loses carry to a bad lie, and gets some back for hitting down on it', () => {
    const state = golf({ mode: 'practice' });
    swing(state, 1);
    settle(state);
    const clean = player(state).lastShot;

    for (const [lie, expected] of [
      ['rough', 0.82],
      ['bunker', 0.6],
    ] as const) {
      place(state, 1, 0, 0, lie);
      swing(state, 1);
      settle(state);
      const shot = player(state).lastShot;
      expect((shot?.carryM ?? 0) / (clean?.carryM ?? 1)).toBeCloseTo(expected, 6);
      // And it reaches the field: the run-out is not somewhere else making the
      // carry back up.
      expect((shot?.distanceM ?? 0) / (clean?.distanceM ?? 1)).toBeCloseTo(expected, 2);
    }

    // The design's bunker escape: struck downwards, it comes out further.
    place(state, 1, 0, 0, 'bunker');
    swing(state, 1, { pitch: -25 });
    settle(state);
    expect((player(state).lastShot?.carryM ?? 0) / (clean?.carryM ?? 1)).toBeCloseTo(0.85, 6);
  });

  it('punishes an open face harder out of the rough', () => {
    const state = golf({ mode: 'practice' });
    swing(state, 1, { roll: 30 });
    settle(state);
    const fromTee = player(state).lastShot;

    place(state, 1, 0, 0, 'rough');
    swing(state, 1, { roll: 30 });
    settle(state);
    const fromRough = player(state).lastShot;

    // The same face, with 40% more of it reaching the ball, on the start line
    // and on the bend. The grass turning the club is what dispersion out of a
    // bad lie is here, since nothing in these rules may invent an error the
    // player did not make.
    expect((fromRough?.startHeadingDeg ?? 0) / (fromTee?.startHeadingDeg ?? 1)).toBeCloseTo(1.4, 6);
    expect((fromRough?.curveDegPerM ?? 0) / (fromTee?.curveDegPerM ?? 1)).toBeCloseTo(1.4, 6);
    // A shorter shot that is further offline for its length.
    const offRough = (fromRough?.lineErrorM ?? 0) / (fromRough?.distanceM ?? 1);
    const offTee = (fromTee?.lineErrorM ?? 0) / (fromTee?.distanceM ?? 1);
    expect(offRough / offTee).toBeGreaterThan(1.15);
  });
});

describe('the shot that arrives behind its own backswing', () => {
  it('plays the swing, not the wind-up that reached the detector first', () => {
    // The failure the whole shot pipeline is built around: the detector fires
    // on the backswing and on the strike, and the softer one gets there first.
    const state = golf({ mode: 'practice' });
    swing(state, 1, { peak: 420 });
    run(state, 0.2);
    swing(state, 1, { peak: 1250 });
    settle(state);

    const one = player(state);
    expect(one.shots).toHaveLength(1);
    expect(one.lastShot?.peakRate).toBe(1250);
    // Replayed from where the ball was struck, not from where the backswing
    // had already carried it.
    expect(one.lastShot?.startY).toBe(0);
    expect(one.lastShot?.distanceM ?? 0).toBeCloseTo(243.9, 0);
  });

  it('takes back a half shot when the swing it belonged to lands', () => {
    // A stroke commits after 150 ms and a downswing takes longer than that, so
    // the half shot is already in the air when the real swing arrives.
    const state = golf({ mode: 'practice' });
    stroke(state, 1, 60);
    run(state, 0.2);
    expect(player(state).strokes).toBe(1);
    expect(player(state).plan?.kind).toBe('half');

    swing(state, 1, { peak: 1250 });
    settle(state);
    // One shot on the card, and it is the swing rather than the wind-up: the
    // range resets the stroke count with every ball, so the history is what
    // says how many shots were played.
    expect(player(state).shots).toHaveLength(1);
    expect(player(state).lastShot?.kind).toBe('full');
    expect(player(state).lastShot?.distanceM ?? 0).toBeCloseTo(243.9, 0);
  });

  it('counts a rehearsal from three seconds ago as a shot of its own', () => {
    const state = golf({ mode: 'practice' });
    swing(state, 1, { peak: 420 });
    settle(state);
    run(state, 4);
    swing(state, 1, { peak: 1250 });
    settle(state);

    expect(player(state).shots).toHaveLength(2);
  });

  it('shows the tempo it measured and scores nothing on it', () => {
    // 19 Hz puts +/-53 ms on each boundary, so a 3:1 tempo reads anywhere from
    // 2.4 to 3.8 and cannot be a number that costs anybody a shot.
    const state = golf({ mode: 'practice' });
    stroke(state, 1, 60, 600);
    run(state, 0.1);
    swing(state, 1, { peak: 1250, durationMs: 200 });
    settle(state);
    const quick = player(state).lastShot;

    stroke(state, 1, 60, 200);
    run(state, 0.1);
    swing(state, 1, { peak: 1250, durationMs: 200 });
    settle(state);
    const slow = player(state).lastShot;

    expect(quick?.tempoRatio).toBeCloseTo(3, 6);
    expect(slow?.tempoRatio).toBeCloseTo(1, 6);
    expect(slow?.distanceM).toBe(quick?.distanceM);
  });
});

describe('putting', () => {
  it('asks the ladder for angles the stroke detector can actually report', () => {
    const state = golf({ mode: 'practice' });
    setDrill(state, 'putting');
    const asked: number[] = [];
    for (const rung of PUTT_LADDER_M) {
      expect(distanceToPin(state, player(state))).toBeCloseTo(rung, 6);
      const target = band(state).targetDeg;
      asked.push(target);
      // The detector segments strokes between 40 and 300 deg/s and reports 4 to
      // 45 degrees; a ladder that asked for 111 degrees would ask for a stroke
      // nobody can make.
      expect(target).toBeGreaterThan(4);
      expect(target).toBeLessThan(45);
      stroke(state, 1, target);
      settle(state);
    }
    expect(asked.map((deg) => Math.round(deg * 10) / 10)).toEqual([8.5, 21.4, 42.7]);
  });

  it('holes the putt the band asks for, and moves the ladder on', () => {
    const state = golf({ mode: 'practice' });
    setDrill(state, 'putting');
    const events = [...stroke(state, 1, band(state).targetDeg), ...settle(state)];

    expect(distanceToPin(state, player(state))).toBeCloseTo(PUTT_LADDER_M[1] ?? 0, 6);
    expect(events).toContainEqual({ kind: 'target', playerId: 1, distanceM: PUTT_LADDER_M[1] });
  });

  it('leaves a putt that was hit short where it stopped', () => {
    const state = golf({ mode: 'practice' });
    setDrill(state, 'putting');
    stroke(state, 1, band(state).targetDeg * 0.5);
    settle(state);

    const left = distanceToPin(state, player(state));
    expect(left).toBeGreaterThan(GIMME_RADIUS_M);
    expect(left).toBeCloseTo(1, 1);
    expect(player(state).holedOut).toBe(false);
  });

  it('refuses a twitch rather than spending a stroke on it', () => {
    const state = golf({ mode: 'practice' });
    setDrill(state, 'putting');
    expect(stroke(state, 1, 2)).toEqual([{ kind: 'refused', playerId: 1, reason: 'too_small' }]);
    expect(player(state).strokes).toBe(0);
  });

  it('plays a ball at the side of the green back towards the cup', () => {
    // Aim is an offset from the line to the flag. Measured from the field
    // instead, a ball four metres to the side of the cup is 80 degrees off it
    // and the fifteen degrees a player has could never bring it back.
    const state = golf({ mode: 'practice' });
    setDrill(state, 'putting');
    const hole = holeFor(state, player(state));
    place(state, 1, 4, hole.lengthM, 'green');

    stroke(state, 1, band(state).targetDeg);
    settle(state);
    expect(player(state).lastShot?.holed).toBe(true);
  });
});

describe('the scoring rule', () => {
  it('plays a par 4 in four and calls it a par', () => {
    const state = golf({ mode: 'solo', config: { holes: 2 }, seed: PAR_SEED });
    const hole = holeFor(state, player(state));
    expect(hole.par).toBe(4);

    const events = [...driveAndApproach(state), ...stroke(state, 1, band(state).targetDeg)];
    events.push(...settle(state));

    const one = player(state);
    expect(one.strokes).toBe(4);
    expect(one.card[0]).toBe(4);
    expect(events).toContainEqual({
      kind: 'holed',
      playerId: 1,
      strokes: 4,
      par: 4,
      term: 'par',
      // Stopped inside the concession radius rather than dropping: the tap-in
      // is the fourth stroke.
      conceded: true,
    });
    expect(cardOf(state, one)).toEqual({ playerId: 1, total: 4, toPar: 0, holesPlayed: 1 });
  });

  it('concedes a ball that stops by the cup, and charges the tap-in for it', () => {
    // A 55 mm cup asks for 0.6 degrees of line from five metres, which no hand
    // holding a phone across a room produces; without the concession every hole
    // would end in the pick-up rule. It costs the stroke the player would have
    // had to make.
    const state = threeMetresOut();
    const events = [...stroke(state, 1, shortOf(state, 0.4)), ...settle(state)];

    expect(distanceToPin(state, player(state))).toBeCloseTo(0.39, 1);
    expect(events).toContainEqual({
      kind: 'holed',
      playerId: 1,
      strokes: 2,
      par: 4,
      term: 'eagle',
      conceded: true,
    });
  });

  it('leaves a ball that stopped a step further out to be putted again', () => {
    const state = threeMetresOut();
    stroke(state, 1, shortOf(state, 0.6));
    settle(state);

    expect(distanceToPin(state, player(state))).toBeCloseTo(0.59, 1);
    expect(player(state).holedOut).toBe(false);
    expect(player(state).strokes).toBe(1);
    expect(state.phase).toBe('aim');
  });

  it('drops a putt that is still rolling when it reaches the cup', () => {
    // Struck to finish 300 mm past: it crosses the cup below the capture speed
    // and there is no tap-in to add.
    const state = threeMetresOut();
    const events = [...stroke(state, 1, shortOf(state, -0.3)), ...settle(state)];

    expect(events).toContainEqual({
      kind: 'holed',
      playerId: 1,
      strokes: 1,
      par: 4,
      term: 'albatross',
      conceded: false,
    });
  });

  it('adds up only the holes that were played', () => {
    const state = golf({ mode: 'solo', config: { holes: 2 }, seed: PAR_SEED });
    driveAndApproach(state);
    stroke(state, 1, band(state).targetDeg);
    settle(state);
    run(state, 3.1);
    expect(state.hole).toBe(2);

    // The second hole is never finished: nine strokes is par plus five and the
    // ball is picked up.
    for (let i = 0; i < 9; i++) whiff(state, 1);

    const one = player(state);
    expect(one.card).toEqual([4, 9]);
    const par = state.course.reduce((total, hole) => total + hole.par, 0);
    expect(cardOf(state, one)).toEqual({ playerId: 1, total: 13, toPar: 13 - par, holesPlayed: 2 });
  });

  it('names the score the room reads', () => {
    expect(termFor(2, 5)).toBe('albatross');
    expect(termFor(3, 5)).toBe('eagle');
    expect(termFor(3, 4)).toBe('birdie');
    expect(termFor(4, 4)).toBe('par');
    expect(termFor(5, 4)).toBe('bogey');
    expect(termFor(6, 4)).toBe('double');
    expect(termFor(9, 4)).toBe('other');
  });

  it('ranks the lowest card first and says how much of a round it is', () => {
    const state = golf({ mode: 'versus', config: { holes: 2 }, seed: PAR_SEED }, [1, 2]);
    place(state, 1, 0, 0, 'tee');
    player(state, 1).card[0] = 4;
    player(state, 2).card[0] = 6;
    player(state, 2).card[1] = 5;

    expect(leaderboard(state).map((card) => card.playerId)).toEqual([1, 2]);
    expect(leaderboard(state)[0]?.holesPlayed).toBe(1);
    expect(leaderboard(state)[1]?.total).toBe(11);
  });

  it('keeps practice off the card and the round on it', () => {
    // Practice is not the round with the scoring switched off: no card, no last
    // hole, no waiting for a turn, and two screens rather than a course.
    expect(GOLF_MODES.practice.holes).toBe(0);
    expect(GOLF_MODES.practice.turnBased).toBe(false);
    expect(GOLF_MODES.practice.drills).toEqual(['range', 'putting']);
    for (const mode of ['solo', 'versus'] as const) {
      expect(GOLF_MODES[mode].holes).toBe(9);
      expect(GOLF_MODES[mode].turnBased).toBe(true);
      expect(GOLF_MODES[mode].drills).toEqual([]);
    }

    expect(player(golf({ mode: 'practice' })).card).toEqual([]);
    expect(player(golf({ mode: 'solo' })).card).toHaveLength(9);
    expect(shooter(golf({ mode: 'practice' }))).toBeNull();
    expect(shooter(golf({ mode: 'versus' }, [1, 2]))).toBe(1);
  });

  it('suggests the club the distance asks for until the player says otherwise', () => {
    expect(suggestClub(240, 'fairway')).toBe('driver');
    expect(suggestClub(120, 'fairway')).toBe('iron');
    expect(suggestClub(40, 'rough')).toBe('wedge');
    expect(suggestClub(3, 'green')).toBe('putter');

    const state = golf({ mode: 'solo', config: { holes: 1 }, seed: PAR_SEED });
    setClub(state, 1, 'wedge');
    expect(player(state).clubChosen).toBe(true);
    swing(state, 1);
    settle(state);
    // The choice lasts one shot; the next one is suggested again.
    expect(player(state).clubChosen).toBe(false);
    expect(player(state).club).toBe(suggestClub(distanceToPin(state, player(state)), 'fairway'));
  });
});

describe('whose turn it is', () => {
  it('hands the next stroke to the ball furthest from the cup', () => {
    const state = golf({ mode: 'versus', config: { holes: 1 }, seed: PAR_SEED }, [1, 2, 3]);
    const hole = holeFor(state, player(state));
    place(state, 2, 0, hole.lengthM - 120, 'fairway');
    place(state, 3, 0, hole.lengthM - 260, 'fairway');

    expect(shooter(state)).toBe(1);
    setClub(state, 1, 'putter');
    swing(state, 1, { peak: 500 });
    settle(state);
    // Not the next seat along: the player 260 m out.
    expect(shooter(state)).toBe(3);
  });

  it('refuses a swing from a player who is not on the clock, and says so', () => {
    const state = golf({ mode: 'versus', config: { holes: 1 }, seed: PAR_SEED }, [1, 2]);
    expect(swing(state, 2)).toEqual([{ kind: 'refused', playerId: 2, reason: 'not_your_turn' }]);
    expect(player(state, 2).strokes).toBe(0);
  });

  it('never leaves the shot clock running on a player who has finished', () => {
    // Three players, two of them holed out: the seat after the one who just
    // finished is another finisher, and a minute of nothing is what the room
    // sees.
    const state = golf({ mode: 'versus', config: { holes: 1 }, seed: PAR_SEED }, [1, 2, 3]);
    const hole = holeFor(state, player(state));
    place(state, 1, 0, hole.lengthM - 1, 'green');
    place(state, 2, 0, hole.lengthM - 1.2, 'green');

    stroke(state, 1, band(state, 1).targetDeg);
    settle(state);
    expect(player(state, 1).holedOut).toBe(true);

    // P3 is on the tee and furthest out, so play comes to them first.
    expect(shooter(state)).toBe(3);
    whiff(state, 3);
    expect(shooter(state)).toBe(2);

    stroke(state, 2, band(state, 2).targetDeg);
    settle(state);
    expect(player(state, 2).holedOut).toBe(true);
    expect(shooter(state)).toBe(3);
    expect(state.phase).not.toBe('hole_over');
  });

  it('tees off in the order the last hole finished in', () => {
    const state = golf({ mode: 'versus', config: { holes: 2 }, seed: PAR_SEED }, [1, 2]);
    const hole = holeFor(state, player(state));
    place(state, 1, 0, hole.lengthM - 1, 'green');

    stroke(state, 1, band(state, 1).targetDeg);
    settle(state);
    expect(player(state, 1).card[0]).toBe(1);

    for (let i = 0; i < 9; i++) whiff(state, 2);
    expect(player(state, 2).card[0]).toBe(9);

    run(state, 3.1);
    expect(state.hole).toBe(2);
    // Honours: the two on the first hole plays first on the second.
    expect(shooter(state)).toBe(1);
  });

  it('gives up on a player who is there but never plays', () => {
    const state = golf({ mode: 'solo', config: { holes: 1, turnSeconds: 1 }, seed: PAR_SEED });
    run(state, 1.1);
    // One expired turn is a player who put the phone down for a moment.
    expect(player(state).abandoned).toBe(false);

    run(state, 1.1);
    expect(player(state).abandoned).toBe(true);
    // A hole they were never going to finish still ends, and their card records
    // it as unplayed rather than as a score they did not make.
    expect(state.phase).toBe('hole_over');
    expect(player(state).card[0]).toBeNull();
    expect(cardOf(state, player(state)).holesPlayed).toBe(0);
  });
});

describe('a phone that drops out mid-hole', () => {
  it('keeps its strokes, its ball, its card and its grip', () => {
    const state = golf({ mode: 'solo', config: { holes: 2 }, seed: PAR_SEED });
    driveAndApproach(state);
    const before = { ...player(state).ball };
    const strokes = player(state).strokes;

    syncPlayers(state, [{ id: 1, present: false }]);
    run(state, 5);
    syncPlayers(state, [{ id: 1, present: true }]);

    const one = player(state);
    expect(one.strokes).toBe(strokes);
    expect(one.ball).toEqual(before);
    expect(one.grip).not.toBeNull();
    expect(one.card).toEqual([null, null]);
  });

  it('gives the turn back to the phone that dropped during it', () => {
    const state = golf({ mode: 'solo', config: { holes: 1 }, seed: PAR_SEED });
    syncPlayers(state, [{ id: 1, present: false }]);
    expect(shooter(state)).toBeNull();

    syncPlayers(state, [{ id: 1, present: true }]);
    expect(shooter(state)).toBe(1);
    expect(refusalFor(state, player(state))).toBeNull();
  });

  it('does not play the hole out while the room is empty', () => {
    // Every phone reconnecting at once used to let the whole course play itself
    // through in a second.
    const state = golf({ mode: 'solo', config: { holes: 2 }, seed: PAR_SEED });
    syncPlayers(state, [{ id: 1, present: false }]);
    run(state, 30);

    expect(state.hole).toBe(1);
    expect(state.phase).not.toBe('over');
    expect(player(state).card).toEqual([null, null]);
  });

  it('lets the rest of the room finish the hole without waiting for it', () => {
    const state = golf({ mode: 'versus', config: { holes: 2 }, seed: PAR_SEED }, [1, 2]);
    const hole = holeFor(state, player(state));
    place(state, 1, 0, hole.lengthM - 1, 'green');
    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);

    const events = [...stroke(state, 1, band(state, 1).targetDeg), ...settle(state)];
    expect(events).toContainEqual({ kind: 'hole_over', hole: 1 });
    expect(player(state, 2).card[0]).toBeNull();
  });

  it('brings a phone back to the hole the room is on, with its card intact', () => {
    const state = golf({ mode: 'versus', config: { holes: 2 }, seed: PAR_SEED }, [1, 2]);
    const hole = holeFor(state, player(state));
    place(state, 1, 0, hole.lengthM - 1, 'green');
    place(state, 2, 0, hole.lengthM - 1.2, 'green');

    stroke(state, 1, band(state, 1).targetDeg);
    settle(state);
    const card = [...player(state, 1).card];

    syncPlayers(state, [
      { id: 1, present: false },
      { id: 2, present: true },
    ]);
    stroke(state, 2, band(state, 2).targetDeg);
    settle(state);
    run(state, 3.1);
    syncPlayers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
    ]);

    expect(state.hole).toBe(2);
    expect(player(state, 1).card[0]).toBe(card[0]);
    expect(player(state, 1).grip).not.toBeNull();
    // Back on the tee with the room, not stranded on the green of hole one.
    expect(player(state, 1).ball).toEqual({ x: 0, y: 0 });
    expect(shooter(state)).not.toBeNull();
  });
});

describe('every way a hole and a round can end', () => {
  it('reaches aim, flight, hole over and over in a single round', () => {
    const state = golf({ mode: 'solo', config: { holes: 2 }, seed: PAR_SEED });
    const seen = new Set<string>([state.phase]);
    const watch = (): void => {
      seen.add(state.phase);
    };

    expect(state.phase).toBe('aim');
    swing(state, 1);
    run(state, 0.2);
    watch();
    expect(state.phase).toBe('flight');
    settle(state);
    watch();

    setClub(state, 1, 'wedge');
    swing(state, 1, { peak: rateFor('wedge', distanceToPin(state, player(state)) - 8) });
    settle(state);
    stroke(state, 1, band(state).targetDeg);
    settle(state);
    watch();
    expect(state.phase).toBe('hole_over');

    run(state, 3.1);
    for (let i = 0; i < 9; i++) whiff(state, 1);
    run(state, 3.1);
    watch();

    expect(state.phase).toBe('over');
    expect(seen).toEqual(new Set(['aim', 'flight', 'hole_over', 'over']));
  });

  it('picks the ball up rather than leaving the hole open forever', () => {
    const state = golf({ mode: 'solo', config: { holes: 1 }, seed: PAR_SEED });
    for (let i = 0; i < 9; i++) whiff(state, 1);

    const one = player(state);
    expect(one.pickedUp).toBe(true);
    expect(one.card[0]).toBe(9);
    expect(state.phase).toBe('hole_over');

    run(state, 3.1);
    expect(state.phase).toBe('over');
    // Nothing else moves once the round is over.
    expect(run(state, 5)).toEqual([]);
  });

  it('refuses everything a finished player tries, and says which', () => {
    const state = golf({ mode: 'solo', config: { holes: 1 }, seed: PAR_SEED });
    const hole = holeFor(state, player(state));
    place(state, 1, 0, hole.lengthM - 1, 'green');

    expect(swing(state, 1)).toEqual([
      { kind: 'refused', playerId: 1, reason: 'green_needs_putt' },
    ]);
    stroke(state, 1, band(state).targetDeg);
    expect(stroke(state, 1, 20)).toEqual([
      { kind: 'refused', playerId: 1, reason: 'ball_moving' },
    ]);
    settle(state);
    expect(stroke(state, 1, 20)).toEqual([
      { kind: 'refused', playerId: 1, reason: 'hole_finished' },
    ]);
  });

  it('never ends the practice screens, and hands out another ball', () => {
    const state = golf({ mode: 'practice' });
    for (let i = 0; i < 4; i++) {
      swing(state, 1);
      settle(state);
      expect(player(state).ball).toEqual({ x: 0, y: 0 });
      expect(player(state).strokes).toBe(0);
    }
    run(state, 120);

    expect(state.phase).not.toBe('over');
    expect(player(state).card).toEqual([]);
    expect(dispersionOf(player(state)).count).toBe(4);
  });

  it('keeps only the last fifteen shots in the scatter it draws', () => {
    const state = golf({ mode: 'practice' });
    for (let i = 0; i < 18; i++) {
      swing(state, 1, { peak: 600 + i * 30, roll: i % 2 === 0 ? 20 : -20 });
      settle(state);
    }

    const scatter = dispersionOf(player(state));
    expect(scatter.count).toBe(15);
    expect(scatter.sdLine).toBeGreaterThan(1);
    expect(scatter.sdDistance).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('lays out the same course for the same seed and a different one otherwise', () => {
    const of = (seed: number): unknown => createGolf({ playerIds: [1], seed }).course;
    expect(of(7)).toEqual(of(7));
    expect(of(7)).not.toEqual(of(8));

    // Whatever the seed, nine holes are par 36, or two rounds cannot be
    // compared with each other.
    for (const seed of [1, 2, 7, 8, 77]) {
      const state = createGolf({ playerIds: [1], seed });
      expect(state.course.reduce((total, hole) => total + hole.par, 0)).toBe(36);
    }
  });

  it('plays the same round twice the same way', () => {
    const play = (): GolfState => {
      const state = golf({ mode: 'solo', config: { holes: 2 }, seed: PAR_SEED });
      aim(state, 1, 3);
      driveAndApproach(state);
      stroke(state, 1, band(state).targetDeg);
      settle(state);
      return state;
    };

    const once = play();
    const twice = play();
    expect(twice.players[0]?.card).toEqual(once.players[0]?.card);
    expect(twice.players[0]?.shots).toEqual(once.players[0]?.shots);
  });

  it('never rolls a die the player cannot see', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('the rules rolled a die');
    });
    try {
      const state = golf({ mode: 'solo', config: { holes: 2 }, seed: PAR_SEED });
      driveAndApproach(state);
      stroke(state, 1, band(state).targetDeg);
      settle(state);
      run(state, 3.1);
      for (let i = 0; i < 9; i++) whiff(state, 1);
      run(state, 3.1);
      expect(state.phase).toBe('over');
    } finally {
      random.mockRestore();
    }
  });
});

describe('a frame rate nobody controls', () => {
  it('finishes a shot in the same place at 15 Hz as at 100', () => {
    const played = (dt: number): GolfPlayer => {
      const state = golf({ mode: 'solo', config: { holes: 1 }, seed: PAR_SEED });
      aim(state, 1, 5);
      swing(state, 1, { roll: 24 });
      settle(state, dt);
      return player(state);
    };

    const slow = played(1 / 15);
    const fast = played(1 / 100);
    expect(slow.ball.x).toBeCloseTo(fast.ball.x, 9);
    expect(slow.ball.y).toBeCloseTo(fast.ball.y, 9);
    expect(slow.lie).toBe(fast.lie);
    expect(slow.lastShot?.lineErrorM).toBeCloseTo(fast.lastShot?.lineErrorM ?? 0, 9);
  });

  it('holes the same putt at both rates', () => {
    const played = (dt: number): GolfPlayer => {
      const state = golf({ mode: 'practice' });
      setDrill(state, 'putting');
      stroke(state, 1, band(state).targetDeg);
      settle(state, dt);
      return player(state);
    };

    expect(played(1 / 15).lastShot?.holed).toBe(true);
    expect(played(1 / 100).lastShot?.holed).toBe(true);
    expect(played(1 / 15).ladder).toBe(played(1 / 100).ladder);
  });

  it('waits the same milliseconds for a half shot at either rate', () => {
    for (const dt of [1 / 15, 1 / 100]) {
      const state = golf({ mode: 'practice' });
      stroke(state, 1, 70);
      run(state, 0.1, dt);
      expect(player(state).strokes).toBe(0);

      run(state, 0.15, dt);
      expect(player(state).strokes).toBe(1);
      expect(player(state).lastShot?.kind ?? player(state).plan?.kind).toBe('half');
    }
  });

  it('runs the shot clock in seconds, not in frames', () => {
    for (const dt of [1 / 15, 1 / 100]) {
      const state = golf({
        mode: 'solo',
        config: { holes: 1, turnSeconds: 2, timeoutsPerHole: 1 },
        seed: PAR_SEED,
      });
      run(state, 1.9, dt);
      expect(player(state).abandoned).toBe(false);
      run(state, 0.2, dt);
      expect(player(state).abandoned).toBe(true);
    }
  });
});

describe('the half shot', () => {
  it('carries the fraction of the club the stroke asks for, and never nothing at all', () => {
    const state = golf({ mode: 'practice' });
    stroke(state, 1, 70);
    settle(state);
    const half = player(state).lastShot;

    stroke(state, 1, 140);
    settle(state);
    const full = player(state).lastShot;

    expect(half?.kind).toBe('half');
    expect(half?.carryM).toBeCloseTo(CLUB_CARRY_M.driver * 0.5, 6);
    expect(full?.carryM).toBeCloseTo(CLUB_CARRY_M.driver, 6);
    // Above 140 degrees it is still a shot, not a silent miss.
    stroke(state, 1, 200);
    settle(state);
    expect(player(state).lastShot?.carryM).toBeCloseTo(CLUB_CARRY_M.driver, 6);
  });
});
