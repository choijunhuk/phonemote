import { describe, expect, it } from 'vitest';
import type { CanonicalVector } from '../../../input/types.js';
import {
  ARCHERY_MODES,
  aimRadius,
  archeryConfigFor,
  createArchery,
  ELEVATION_FULL_DEG,
  findArcher,
  maxScore,
  overholdGrowth,
  pullTrigger,
  readPose,
  readStillness,
  releaseTrigger,
  ringFor,
  shotsThisEnd,
  standings,
  stepArchery,
  syncArchers,
  totalScore,
  WINDAGE_PER_DEG,
  type Archer,
  type ArcheryConfig,
  type ArcheryEvent,
  type ArcheryShot,
  type ArcheryState,
} from '../archeryState.js';

/**
 * The rules of Archery, driven at 60 Hz with a clock we control.
 *
 * Every test here holds the bow by feeding the exact gravity vector a phone in
 * that pose would report, and shakes it by feeding the |omega| the stillness
 * detector would report. Nothing is faked at a higher level than that.
 */

const FRAME = 1 / 60;

/** A hand trying to hold still, measured on a real phone: 3.3 deg/s. */
const STEADY_RATE = 3.3;

/**
 * Gravity as read by a phone aimed `deg` above the upright grip.
 *
 * Turning the phone by R leaves gravity where it was in the world, so in the
 * phone's frame it moves by R inverse — which is why aiming up tips the vector
 * back rather than forward.
 */
function upAtPitch(deg: number): CanonicalVector {
  const rad = (deg * Math.PI) / 180;
  return { x: 0, y: Math.cos(rad), z: -Math.sin(rad) };
}

interface Hand {
  readonly pitchDeg?: number;
  readonly rate?: number;
  readonly still?: boolean;
  /** For grips the pitch helper cannot express, like a phone on its side. */
  readonly up?: CanonicalVector;
}

interface Clock {
  ms: number;
}

function rig(config: Partial<ArcheryConfig>, players = 1): ArcheryState {
  const state = createArchery(config);
  syncArchers(
    state,
    Array.from({ length: players }, (_, index) => ({ id: index + 1, present: true })),
  );
  return state;
}

function archer(state: ArcheryState, id: number): Archer {
  const found = findArcher(state, id);
  if (!found) throw new Error(`no archer ${id}`);
  return found;
}

/** Hold the bow for a while, feeding one hand per archer. */
function hold(
  state: ArcheryState,
  clock: Clock,
  seconds: number,
  hands: Hand | ((id: number) => Hand) = {},
  dt = FRAME,
): ArcheryEvent[] {
  const events: ArcheryEvent[] = [];
  const handFor = typeof hands === 'function' ? hands : () => hands;
  const frames = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < frames; i++) {
    clock.ms += dt * 1000;
    for (const each of state.archers) {
      if (!each.present) continue;
      const hand = handFor(each.id);
      readPose(state, each.id, hand.up ?? upAtPitch(hand.pitchDeg ?? 0), clock.ms);
      readStillness(state, each.id, hand.rate ?? STEADY_RATE, hand.still ?? true, false, clock.ms);
    }
    events.push(...stepArchery(state, dt, clock.ms));
  }
  return events;
}

/** Wait for the automatic grip: through the score readout and the end break. */
function waitForNock(state: ArcheryState, clock: Clock, id: number, hand: Hand = {}): boolean {
  for (let i = 0; i < 20 * 60; i++) {
    if (archer(state, id).nocked) return true;
    if (state.phase === 'over') return false;
    hold(state, clock, FRAME, hand);
  }
  return false;
}

interface ShotPlan {
  readonly pitchDeg?: number;
  readonly drawSeconds?: number;
  readonly yawDeg?: number;
  readonly releaseRate?: number;
  readonly rate?: number;
}

/** One whole arrow: settle, pull, draw, loose. Null once the match is over. */
function shootArrow(
  state: ArcheryState,
  clock: Clock,
  id: number,
  plan: ShotPlan = {},
): ArcheryShot | null {
  // Nocked from the resting hold, not from the aim. The grip is the zero that
  // elevation is measured against, so capturing it while already aimed high
  // would read as no elevation at all — the archer settles, then raises.
  const hand: Hand = plan.rate === undefined ? {} : { rate: plan.rate };
  if (!waitForNock(state, clock, id, hand)) return null;

  const aimed: Hand = plan.pitchDeg === undefined ? hand : { ...hand, pitchDeg: plan.pitchDeg };

  pullTrigger(state, id, clock.ms);
  hold(state, clock, plan.drawSeconds ?? 1.05, aimed);
  const events = releaseTrigger(
    state,
    id,
    { yaw: plan.yawDeg ?? 0, pitch: 0, roll: 0 },
    plan.releaseRate ?? plan.rate ?? STEADY_RATE,
    clock.ms,
  );
  const loose = events.find((event) => event.kind === 'loose');
  return loose?.kind === 'loose' ? loose.shot : null;
}

describe('the ring bands', () => {
  it('pays ten only for the gold and one for the outermost band', () => {
    expect(ringFor(0)).toBe(10);
    expect(ringFor(0.049)).toBe(10);
    expect(ringFor(0.05)).toBe(9);
    expect(ringFor(0.12)).toBe(8);
    expect(ringFor(0.22)).toBe(6);
    expect(ringFor(0.46)).toBe(1);
    expect(ringFor(0.499)).toBe(1);
  });

  it('pays nothing at all for an arrow off the face', () => {
    expect(ringFor(0.5)).toBe(0);
    expect(ringFor(1.2)).toBe(0);
  });

  it('adds up to 180 for a full round, which is what the card says', () => {
    expect(maxScore(ARCHERY_MODES.solo)).toBe(180);
    expect(maxScore(ARCHERY_MODES.versus)).toBe(180);
  });
});

describe('a shot', () => {
  it('is a ten when the bow is drawn full and held still', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    const shot = shootArrow(state, clock, 1);

    expect(shot?.ring).toBe(10);
    expect(shot?.draw).toBe(1);
  });

  it('goes high when the phone is aimed higher, by the elevation it was aimed', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    // Two and a half degrees of lift is two ring bands: the design puts a full
    // field at 25 degrees.
    const level = shootArrow(state, clock, 1, { drawSeconds: 1.5 });
    const raised = shootArrow(state, clock, 1, { pitchDeg: 2.5, drawSeconds: 1.5 });

    expect(raised?.elevationDeg).toBeCloseTo(2.5, 1);
    // Compared against a level shot rather than against zero: the release also
    // adds the shake the archer had at that instant, and the direction that
    // shake pushes depends on the aim, so the two shots do not carry identical
    // error terms. Elevation owns the bulk of the difference, not all of it.
    const lift = (level?.y ?? 0) - (raised?.y ?? 0);
    const mapped = 2.5 / ELEVATION_FULL_DEG;
    expect(lift).toBeGreaterThan(mapped * 0.8);
    expect(lift).toBeLessThan(mapped * 1.3);
    expect(raised?.ring).toBe(8);
  });

  it('falls short when the string is let go before full draw', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    const shot = shootArrow(state, clock, 1, { drawSeconds: 0.4 });

    expect(shot?.draw).toBeCloseTo(0.4, 2);
    // Short reads as low on the face, and low costs rings.
    expect(shot?.y).toBeGreaterThan(0.2);
    expect(shot?.ring).toBe(6);
  });

  it('goes right when the archer turned right during the draw', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    const shot = shootArrow(state, clock, 1, { yawDeg: 6 });

    expect(shot?.windageDeg).toBe(6);
    expect(shot?.x).toBeGreaterThan(0);
    expect(shot?.ring).toBe(8);
  });

  it('is thrown wider by a snatch at the loose than by the shake before it', () => {
    const clock: Clock = { ms: 1000 };
    const settledState = rig(ARCHERY_MODES.solo);
    const settledClock: Clock = { ms: 1000 };
    const pluckedState = rig(ARCHERY_MODES.solo);

    // The same hold in both: steady, then the bow arm starts creeping upwards
    // in the last tenth of a second.
    const shoot = (state: ArcheryState, at: Clock, releaseRate: number): ArcheryShot | null => {
      waitForNock(state, at, 1);
      pullTrigger(state, 1, at.ms);
      hold(state, at, 1.2, { pitchDeg: 0 });
      hold(state, at, 0.1, { pitchDeg: 1 });
      const events = releaseTrigger(state, 1, { yaw: 0, pitch: 0, roll: 0 }, releaseRate, at.ms);
      const loose = events.find((event) => event.kind === 'loose');
      return loose?.kind === 'loose' ? loose.shot : null;
    };

    const settled = shoot(settledState, settledClock, STEADY_RATE);
    // 60 deg/s at the instant the string goes: a pluck, not a tremor.
    const plucked = shoot(pluckedState, clock, 60);

    expect(settled?.ring).toBe(9);
    expect(plucked?.radius ?? 0).toBeGreaterThan((settled?.radius ?? 0) * 4);
    expect(plucked?.ring ?? 10).toBeLessThan(settled?.ring ?? 0);
  });

  it('does not punish a hand that truly did not move', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    const shot = shootArrow(state, clock, 1, { rate: 14 });

    // 14 deg/s is the worst a hand holding still was measured at, and it is
    // still a ten as long as the bow was not going anywhere.
    expect(shot?.wobble).toBeCloseTo(14, 5);
    expect(shot?.radius).toBe(0);
    expect(shot?.ring).toBe(10);
  });
});

describe('holding at full draw', () => {
  it('says when the bow arm has been out too long', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    waitForNock(state, clock, 1);
    pullTrigger(state, 1, clock.ms);

    const early = hold(state, clock, 5);
    expect(early.some((event) => event.kind === 'overhold')).toBe(false);
    const late = hold(state, clock, 2);
    expect(late.filter((event) => event.kind === 'overhold')).toHaveLength(1);

    // And it is only said once, however long they stand there.
    const later = hold(state, clock, 4);
    expect(later.some((event) => event.kind === 'overhold')).toBe(false);
  });

  it('widens the aim circle the longer it is held', () => {
    const config = ARCHERY_MODES.solo;
    // Nothing happens before the limit; 6% a second compounds after it.
    expect(overholdGrowth(3, config)).toBe(1);
    expect(overholdGrowth(config.holdLimitSeconds + 10, config)).toBeCloseTo(1.06 ** 10, 6);

    const clock: Clock = { ms: 1000 };
    const state = rig(config);
    waitForNock(state, clock, 1);
    pullTrigger(state, 1, clock.ms);
    hold(state, clock, 1);
    const fresh = aimRadius(archer(state, 1), config);
    hold(state, clock, 15);

    expect(aimRadius(archer(state, 1), config)).toBeGreaterThan(fresh);
  });

  it('measures the same growth at 15 Hz as at 60', () => {
    const config = ARCHERY_MODES.solo;
    const slow = rig(config);
    const slowClock: Clock = { ms: 1000 };
    const fast = rig(config);
    const fastClock: Clock = { ms: 1000 };

    waitForNock(slow, slowClock, 1);
    pullTrigger(slow, 1, slowClock.ms);
    hold(slow, slowClock, 9, {}, 1 / 15);
    waitForNock(fast, fastClock, 1);
    pullTrigger(fast, 1, fastClock.ms);
    hold(fast, fastClock, 9, {}, FRAME);

    expect(aimRadius(archer(slow, 1), config)).toBeCloseTo(aimRadius(archer(fast, 1), config), 4);
  });
});

describe('the grip the bow is measured from', () => {
  it('accepts a phone lying flat, which reads elevation perfectly well', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    // Screen up on a table: gravity is along the screen normal, which is
    // square to the axis elevation turns about.
    const events = hold(state, clock, 1, { up: { x: 0, y: 0, z: 1 } });

    expect(events.some((event) => event.kind === 'grip_rejected')).toBe(false);
    expect(archer(state, 1).grip).not.toBeNull();

    // And tipping it up from there still moves the aim.
    const rad = (4 * Math.PI) / 180;
    hold(state, clock, 0.5, { up: { x: 0, y: Math.sin(rad), z: Math.cos(rad) } });
    expect(archer(state, 1).elevationDeg).toBeCloseTo(4, 1);
  });

  it('refuses a phone held on its side once, and then lets them shoot anyway', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    // Gravity along the phone's right edge is the one grip that cannot see
    // elevation at all, because elevation is a turn about that same edge.
    const sideways: Hand = { up: { x: 1, y: 0, z: 0 } };

    const first = hold(state, clock, 0.5, sideways);
    expect(first.some((event) => event.kind === 'grip_rejected')).toBe(true);
    expect(archer(state, 1).grip).toBeNull();

    const second = hold(state, clock, 1, sideways);
    expect(second.some((event) => event.kind === 'grip_taken')).toBe(true);
    expect(archer(state, 1).grip).not.toBeNull();
  });

  it('lets an archer who never holds still shoot on the trigger alone', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    hold(state, clock, 2, { rate: 80, still: false });
    expect(archer(state, 1).nocked).toBe(false);

    pullTrigger(state, 1, clock.ms);
    expect(archer(state, 1).phase).toBe('draw');
    expect(archer(state, 1).grip).not.toBeNull();
  });
});

describe('the aim landing where it was pointed', () => {
  it('starts every arrow back in the middle, whatever stance was taken', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    expect(shootArrow(state, clock, 1)?.ring).toBe(10);

    // The archer resettles holding the phone ten degrees higher. The next
    // arrow is measured from that hold, so the crosshair is back in the gold.
    waitForNock(state, clock, 1, { pitchDeg: 10 });
    expect(Math.abs(archer(state, 1).aim.y)).toBeLessThan(0.01);

    pullTrigger(state, 1, clock.ms);
    hold(state, clock, 1.1, { pitchDeg: 10 });
    const events = releaseTrigger(state, 1, { yaw: 0, pitch: 0, roll: 0 }, STEADY_RATE, clock.ms);
    const loose = events.find((event) => event.kind === 'loose');
    expect(loose?.kind === 'loose' ? loose.shot.ring : 0).toBe(10);
  });

  it('leaves the aim where the archer put it while they hold a high shot', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    waitForNock(state, clock, 1);

    // Three seconds of holding perfectly still, aimed two rings high. Taking
    // the grip again here would snap the crosshair back to the middle under a
    // player who is doing exactly what the game asked.
    const events = hold(state, clock, 3, { pitchDeg: 2.5 });
    expect(events.some((event) => event.kind === 'grip_taken')).toBe(false);
    expect(archer(state, 1).aim.y).toBeCloseTo(-0.1, 2);
  });

  it('still scores a ten with a whole draw of yaw drift under it', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    // Measured relative-yaw drift is 0.0166 fields per second, which is 0.415
    // deg/s at this gain: 1.25 degrees across a three second draw. The design
    // claims that stays inside the aim circle. It does, and only just.
    const drift = 0.0166 * ELEVATION_FULL_DEG * 3;
    const shot = shootArrow(state, clock, 1, { drawSeconds: 3, yawDeg: drift });

    expect(Math.abs(drift * WINDAGE_PER_DEG)).toBeLessThan(aimRadius(archer(state, 1), state.config));
    expect(shot?.ring).toBe(10);
  });

  it('does not score a phantom arrow when the trigger comes back with no draw under it', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    waitForNock(state, clock, 1);

    expect(releaseTrigger(state, 1, { yaw: 0, pitch: 0, roll: 0 }, 4, clock.ms)).toHaveLength(0);
    expect(archer(state, 1).shots).toHaveLength(0);

    // Nor a second arrow off a doubled button edge.
    shootArrow(state, clock, 1);
    expect(releaseTrigger(state, 1, { yaw: 0, pitch: 0, roll: 0 }, 4, clock.ms)).toHaveLength(0);
    expect(archer(state, 1).shots).toHaveLength(1);
  });
});

describe('practice, which is where the numbers are', () => {
  it('records the whole hold so the shake can be drawn as a graph', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.practice);
    const shot = shootArrow(state, clock, 1, { drawSeconds: 2, rate: 9 });

    expect(shot?.trace.length).toBeGreaterThan(50);
    expect(shot?.trace[0]?.atMs).toBeLessThan(60);
    expect(shot?.trace[shot.trace.length - 1]?.atMs).toBeGreaterThan(1900);
    // The mean shake, in deg/s, which is the number a coach reads out.
    expect(shot?.meanWobble).toBeCloseTo(9, 5);
  });

  it('says what elevation produced each ring, which is the whole drill', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.practice);
    const low = shootArrow(state, clock, 1, { pitchDeg: -1.5, drawSeconds: 1.5 });
    const high = shootArrow(state, clock, 1, { pitchDeg: 3.8, drawSeconds: 1.5 });

    expect(low?.elevationDeg).toBeCloseTo(-1.5, 1);
    expect(high?.elevationDeg).toBeCloseTo(3.8, 1);
    expect(high?.ring).toBeLessThan(low?.ring ?? 0);
  });

  it('is twelve arrows and then it is over, like every other mode', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.practice);
    for (let i = 0; i < 12; i++) expect(shootArrow(state, clock, 1)).not.toBeNull();
    hold(state, clock, 6);

    expect(archer(state, 1).shots).toHaveLength(12);
    expect(state.phase).toBe('over');
  });

  it('keeps the trace out of the scored modes, where nothing draws it', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    const shot = shootArrow(state, clock, 1, { drawSeconds: 2 });

    expect(shot?.trace).toHaveLength(0);
    expect(shot?.meanWobble).toBe(0);
  });

  it('lands on practice when the lobby hands over a mode this game does not have', () => {
    expect(archeryConfigFor('coop')).toBe(ARCHERY_MODES.practice);
    expect(archeryConfigFor('versus')).toBe(ARCHERY_MODES.versus);
  });
});

describe('a phone that drops out', () => {
  it('puts the arrow back on the string rather than shooting it for them', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.versus, 2);
    expect(shootArrow(state, clock, 1)?.ring).toBe(10);

    waitForNock(state, clock, 2);
    pullTrigger(state, 2, clock.ms);
    hold(state, clock, 0.5);
    syncArchers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    hold(state, clock, 0.5);

    expect(archer(state, 2).phase).toBe('nock');
    expect(archer(state, 2).shots).toHaveLength(0);
    // And the trigger coming back up over a dead connection scores nothing.
    expect(releaseTrigger(state, 2, { yaw: 0, pitch: 0, roll: 0 }, 4, clock.ms)).toHaveLength(0);
  });

  it('keeps their card and their grip for when they come back', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.versus, 2);
    expect(shootArrow(state, clock, 2, { pitchDeg: 1 })?.ring).toBeGreaterThan(0);
    const scored = totalScore(archer(state, 2));
    const grip = archer(state, 2).grip;

    syncArchers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    hold(state, clock, 3);
    syncArchers(state, [
      { id: 1, present: true },
      { id: 2, present: true },
    ]);

    expect(totalScore(archer(state, 2))).toBe(scored);
    expect(archer(state, 2).grip).toBe(grip);
    expect(shootArrow(state, clock, 2)?.ring).toBe(10);
  });

  it('does not make the rest of the room wait out the end clock for them', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.versus, 2);
    syncArchers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    for (let i = 0; i < 3; i++) shootArrow(state, clock, 1);
    // Long enough to cover the score readout and the break between ends, but
    // nowhere near the 45 second end clock that an absent archer would
    // otherwise make everyone sit through.
    const events = hold(state, clock, 8);

    expect(clock.ms - 1000).toBeLessThan(45_000);
    expect(events.some((event) => event.kind === 'end_finished')).toBe(true);
    expect(state.end).toBe(2);
  });

  it('takes no arrows off an absent archer when the end clock runs out', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.versus, 2);
    syncArchers(state, [
      { id: 1, present: true },
      { id: 2, present: false },
    ]);
    // P1 is there and shoots nothing; P2's phone is gone.
    const events = hold(state, clock, 46, {}, 1 / 20);

    const lost = events.filter((event) => event.kind === 'arrows_lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]?.kind === 'arrows_lost' ? lost[0].playerId : 0).toBe(1);
    expect(shotsThisEnd(archer(state, 1), 1)).toHaveLength(3);
    expect(archer(state, 1).shots.every((shot) => shot.timedOut)).toBe(true);
    expect(archer(state, 2).shots).toHaveLength(0);
  });
});

describe('reaching the end', () => {
  it('ends itself after six ends, with 180 on the card for a perfect round', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.solo);
    for (let i = 0; i < 18; i++) expect(shootArrow(state, clock, 1)?.ring).toBe(10);
    hold(state, clock, 6);

    expect(state.end).toBe(6);
    expect(archer(state, 1).shots).toHaveLength(18);
    expect(totalScore(archer(state, 1))).toBe(maxScore(state.config));
    expect(state.phase).toBe('over');
  });

  it('ends by itself when every phone has gone quiet', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.versus, 2);
    shootArrow(state, clock, 1);
    syncArchers(state, [
      { id: 1, present: false },
      { id: 2, present: false },
    ]);
    const events = hold(state, clock, 25, {}, 1 / 20);

    expect(events.some((event) => event.kind === 'over')).toBe(true);
    expect(state.phase).toBe('over');
    // And the scores are still there to put on the screen it leaves behind.
    expect(totalScore(archer(state, 1))).toBe(10);
  });

  it('sorts the room by total so the winner can be named', () => {
    const clock: Clock = { ms: 1000 };
    const state = rig(ARCHERY_MODES.versus, 2);
    shootArrow(state, clock, 1);
    shootArrow(state, clock, 2, { pitchDeg: 6, drawSeconds: 1.5 });

    expect(standings(state)[0]?.id).toBe(1);
    expect(totalScore(archer(state, 1))).toBeGreaterThan(totalScore(archer(state, 2)));
  });
});

describe('replaying a round', () => {
  it('gives the same score twice for the same shooting, with no rng anywhere', () => {
    const script = (): ArcheryState => {
      const clock: Clock = { ms: 1000 };
      const state = rig(ARCHERY_MODES.versus, 2);
      shootArrow(state, clock, 1, { pitchDeg: 1.4, yawDeg: 3, drawSeconds: 1.3, rate: 7 });
      shootArrow(state, clock, 2, { pitchDeg: -2.2, yawDeg: -5, drawSeconds: 0.7, rate: 11 });
      shootArrow(state, clock, 1, { pitchDeg: 4, releaseRate: 40 });
      hold(state, clock, 2, (id) => ({ pitchDeg: id, rate: id * 3 }));
      return state;
    };

    const first = script();
    const second = script();

    expect(second.archers.map((each) => each.shots)).toEqual(
      first.archers.map((each) => each.shots),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
