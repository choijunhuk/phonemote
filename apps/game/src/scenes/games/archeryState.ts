import { captureGrip, gripQuality, signedPitch, type Grip } from '../../input/grip.js';
import { angleBetweenDeg } from '../../input/pose.js';
import type { CanonicalAngles, CanonicalVector } from '../../input/types.js';

/**
 * Archery rules, with no Phaser in sight (ARCHITECTURE.md 8).
 *
 * The one game in the set that never asks the swing detector anything. Every
 * number it reads is gravity or a button edge: elevation is signedPitch against
 * the grip this archer just took, the shake is the smoothed |omega| the
 * stillness detector already computes, and the shot is TRIGGER going up. The
 * platform's weakest number is a swing that was never detected — one of six
 * recorded hard swings peaked at 297 deg/s and produced no event at all — and
 * no shot in this file can go missing that way.
 *
 * Archers shoot at the same time, each at their own target, so there is no
 * shared physics and no turn order. The design wrote one phase for the match;
 * that only works for one archer. Phase is per archer here, and the match-level
 * phase is just which end is running.
 */

export type ArcheryModeKey = 'practice' | 'solo' | 'versus';

/** Where one archer is in their own shot cycle. */
export type ArcherPhase = 'nock' | 'draw' | 'score' | 'done';

/** Where the match is. 'loose' is an instant, not a phase you can sit in. */
export type ArcheryPhase = 'shooting' | 'end_break' | 'over';

export interface ArcheryConfig {
  readonly ends: number;
  readonly arrowsPerEnd: number;
  /** Seconds an end may last, or 0 for no clock at all. */
  readonly endSeconds: number;
  readonly drawSeconds: number;
  /** Past this, the bow arm starts to give out: see overholdGrowth. */
  readonly holdLimitSeconds: number;
  /** How long the phone must be still before its grip is taken. */
  readonly nockStillSeconds: number;
  /** Keep the rate and aim traces practice draws its coaching graph from. */
  readonly trace: boolean;
  /** How long the ring and the elevation stay up after a shot. */
  readonly scoreSeconds: number;
  readonly endBreakSeconds: number;
  /** Every phone gone for this long ends the match rather than hanging. */
  readonly abandonSeconds: number;
}

/**
 * The modes, as data.
 *
 * Practice is not the game with the scoring switched off. The design asks for
 * two drills — a hold with no target, graphed, and single arrows shown with the
 * elevation that produced them — and those two differ only in what the scene
 * draws from the same shot. So practice records the trace AND scores the ring,
 * and the scene can show either drill without a second config or a branch in
 * the rules. Twelve arrows because the design says the elevation-to-distance
 * mapping takes about ten to learn, and four ends of three is the nearest whole
 * number of ends to that.
 *
 * Only versus gets an end clock. A clock on a practice drill is the opposite of
 * what practice is for, and a solo archer alone in front of the TV is not
 * keeping anybody waiting.
 */
export const ARCHERY_MODES: Readonly<Record<ArcheryModeKey, ArcheryConfig>> = {
  practice: {
    ends: 4,
    arrowsPerEnd: 3,
    endSeconds: 0,
    drawSeconds: 1,
    holdLimitSeconds: 6,
    nockStillSeconds: 0.3,
    trace: true,
    scoreSeconds: 2.4,
    endBreakSeconds: 2,
    abandonSeconds: 20,
  },
  solo: {
    ends: 6,
    arrowsPerEnd: 3,
    endSeconds: 0,
    drawSeconds: 1,
    holdLimitSeconds: 6,
    nockStillSeconds: 0.3,
    trace: false,
    scoreSeconds: 1.6,
    endBreakSeconds: 2.5,
    abandonSeconds: 20,
  },
  versus: {
    ends: 6,
    arrowsPerEnd: 3,
    endSeconds: 45,
    drawSeconds: 1,
    holdLimitSeconds: 6,
    nockStillSeconds: 0.3,
    trace: false,
    scoreSeconds: 1.6,
    endBreakSeconds: 2.5,
    abandonSeconds: 20,
  },
};

/** The lobby may hand over any mode key; practice is the safe one to land on. */
export function archeryConfigFor(mode: string): ArcheryConfig {
  const known = (Object.keys(ARCHERY_MODES) as ArcheryModeKey[]).find((key) => key === mode);
  return ARCHERY_MODES[known ?? 'practice'];
}

/**
 * The target face, in aim units: 1.0 is the full aiming field, so the face
 * covers the middle half of it and the rings are ten bands of 0.05.
 */
export const TARGET_RADIUS = 0.5;
export const RING_WIDTH = 0.05;

/**
 * The elevation that swings the aim a full field, from the design.
 *
 * One ring band is therefore 1.25 degrees of pitch. Gravity moves 0.11 degrees
 * per frame in a hand that is trying to hold still, a tenth of a band —
 * visible on the crosshair, survivable on the score.
 */
export const ELEVATION_FULL_DEG = 25;

/**
 * How far the hit moves per degree the phone turned left or right during the
 * draw. Half the elevation gain, deliberately.
 *
 * Elevation is aimed against a crosshair the archer can watch. Windage cannot
 * be: no GameAction carries a live signed yaw (see releaseTrigger), so the only
 * left-right number this game ever sees arrives at the shot. Charging the same
 * gain for a motion nobody can see would make the measured yaw drift — 0.0166
 * fields per second, so 1.2 degrees across a three second draw — cost a whole
 * ring band per arrow. At half gain that drift lands inside the aim circle,
 * which is what the design assumed when it called the drift harmless.
 */
export const WINDAGE_PER_DEG = 1 / (2 * ELEVATION_FULL_DEG);

/** Smoothing for the shake, from the design's 250 ms window. */
export const WOBBLE_TAU_SECONDS = 0.25;

/**
 * Aim units of error per deg/s of shake.
 *
 * The measured numbers set both ends. A hand holding still reads 3.3 deg/s and
 * lands 0.02 out, half a ring band, so a steady archer still shoots tens. A
 * hand at the top of that band, 14 deg/s, lands 0.084 out — nearly two bands,
 * and the difference between a gold and a seven. Two orders of magnitude below
 * the 300 deg/s a swing has to cross, which is the point: this game is played
 * entirely inside the noise the other five have to reject.
 */
export const WOBBLE_GAIN = 0.006;

/** The sight itself has width, so the aim circle never collapses to a dot. */
export const SIGHT_RADIUS = 0.008;

/** Fraction the shake grows per second held past the limit, from the design. */
export const OVERHOLD_GROWTH_PER_SECOND = 0.06;

/** How far short an arrow released at zero draw falls, from the design. */
export const UNDERDRAW_DROP = 0.4;

/** A phone pointed at the ceiling still has to produce a drawable number. */
export const AIM_LIMIT = 1.4;

/** Gravity this close to the phone's right edge cannot see elevation at all. */
export const ELEVATION_BLIND_DEG = 25;

/**
 * How long the aim's own recent travel is remembered, for the direction the
 * shake throws the arrow. Short enough to mean "where it was going as you let
 * go", long enough not to be one frame of sensor quantisation.
 */
const DRIFT_TAU_SECONDS = 0.2;

/** Half a second of readings, the window freezeState calibrates from. */
const POSE_WINDOW = 30;

/** 40 Hz is finer than the phone sends and is plenty to draw a curve from. */
const TRACE_INTERVAL_MS = 25;

/** Twelve seconds of trace. A longer hold has nothing left to teach. */
const MAX_TRACE_SAMPLES = 480;

export interface ArcheryTraceSample {
  /** Milliseconds since the trigger went down. */
  readonly atMs: number;
  /** |omega| at that moment, deg/s, unsmoothed. */
  readonly rate: number;
  readonly x: number;
  readonly y: number;
}

export interface ArcheryShot {
  readonly end: number;
  /** 1-based within the end. */
  readonly arrow: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** 10 in the gold, 1 on the outer band, 0 off the face. */
  readonly ring: number;
  /** The pitch that produced it. Practice puts this next to the ring. */
  readonly elevationDeg: number;
  /** Net turn left or right across the draw, degrees, + right. */
  readonly windageDeg: number;
  /** Smoothed shake at the loose, deg/s. */
  readonly wobble: number;
  /** Mean shake across the whole hold; 0 when the trace is off. */
  readonly meanWobble: number;
  readonly draw: number;
  readonly holdMs: number;
  /** The end clock ran out with this arrow unshot. */
  readonly timedOut: boolean;
  /** The hold, for practice to graph. Empty unless config.trace. */
  readonly trace: readonly ArcheryTraceSample[];
}

export interface Archer {
  readonly id: number;
  /** False while this phone is not answering. Kept, not deleted (D48). */
  present: boolean;
  phase: ArcherPhase;
  /** The hold this arrow is measured from. Survives a drop and a rejoin. */
  grip: Grip | null;
  /** How much elevation signal that grip leaves, 0 to 1. */
  gripQuality: number;
  /** A grip has been taken for the arrow currently on the string. */
  nocked: boolean;
  /** The one refusal this archer gets before the game proceeds regardless. */
  gripRejected: boolean;
  poseSamples: CanonicalVector[];
  lastPoseAt: number;
  still: boolean;
  steadySeconds: number;
  /** Raw |omega| from the last stillness reading, deg/s. */
  rate: number;
  /** Smoothed |omega|, which is what the aim circle is drawn from. */
  wobble: number;
  lastStillnessAt: number;
  /** 0 to 1. */
  draw: number;
  /** Seconds since the trigger went down. */
  holdSeconds: number;
  announcedFullDraw: boolean;
  announcedOverhold: boolean;
  /** Where the archer is pointing, in aim units, 0,0 being the gold. */
  aim: { x: number; y: number };
  /** The aim a fifth of a second ago, so the shake has a direction. */
  aimLagY: number;
  elevationDeg: number;
  trace: ArcheryTraceSample[];
  nextTraceAt: number;
  scoreSeconds: number;
  shots: ArcheryShot[];
  lastShot: ArcheryShot | null;
}

export interface ArcheryState {
  readonly config: ArcheryConfig;
  phase: ArcheryPhase;
  end: number;
  /** Seconds this end has run, only counted when config.endSeconds is set. */
  endClock: number;
  breakTimer: number;
  /** Seconds with nobody answering at all. */
  emptySeconds: number;
  archers: Archer[];
}

export type ArcheryEvent =
  | { readonly kind: 'grip_taken'; readonly playerId: number }
  | {
      readonly kind: 'grip_rejected';
      readonly playerId: number;
      readonly reason: 'elevation_blind';
    }
  | { readonly kind: 'draw_started'; readonly playerId: number }
  | { readonly kind: 'full_draw'; readonly playerId: number }
  | { readonly kind: 'overhold'; readonly playerId: number }
  | { readonly kind: 'loose'; readonly playerId: number; readonly shot: ArcheryShot }
  | { readonly kind: 'arrows_lost'; readonly playerId: number; readonly arrows: number }
  | { readonly kind: 'end_started'; readonly end: number }
  | { readonly kind: 'end_finished'; readonly end: number }
  | { readonly kind: 'over' };

export function createArchery(config: Partial<ArcheryConfig> = {}): ArcheryState {
  return {
    config: { ...ARCHERY_MODES.practice, ...config },
    phase: 'shooting',
    end: 1,
    endClock: 0,
    breakTimer: 0,
    emptySeconds: 0,
    archers: [],
  };
}

export function findArcher(state: ArcheryState, id: number): Archer | undefined {
  return state.archers.find((archer) => archer.id === id);
}

/**
 * Bring the roster in line with who is connected.
 *
 * Everybody already here keeps their record — shots, grip and all. Rebuilding
 * the list from the session on every player change is how a mid-match join used
 * to wipe the room's calibration (freezeState.syncPlayers, same reason).
 */
export function syncArchers(
  state: ArcheryState,
  roster: ReadonlyArray<{ readonly id: number; readonly present: boolean }>,
): void {
  state.archers = roster.map(({ id, present }) => {
    const existing = findArcher(state, id);
    if (existing) {
      existing.present = present;
      return existing;
    }
    return {
      id,
      present,
      phase: 'nock' as ArcherPhase,
      grip: null,
      gripQuality: 0,
      nocked: false,
      gripRejected: false,
      poseSamples: [],
      lastPoseAt: 0,
      still: false,
      steadySeconds: 0,
      rate: 0,
      wobble: 0,
      lastStillnessAt: 0,
      draw: 0,
      holdSeconds: 0,
      announcedFullDraw: false,
      announcedOverhold: false,
      aim: { x: 0, y: 0 },
      aimLagY: 0,
      elevationDeg: 0,
      trace: [],
      nextTraceAt: 0,
      scoreSeconds: 0,
      shots: [],
      lastShot: null,
    };
  });
}

/**
 * Gravity, from this archer's phone.
 *
 * Kept for the grip window whether or not there is a grip yet, and turned into
 * elevation as soon as there is one. This is the whole aiming input: exact, no
 * singularity anywhere a bow is held, and back at the same reading every time
 * the phone returns to the same pose.
 */
export function readPose(
  state: ArcheryState,
  id: number,
  up: CanonicalVector,
  nowMs: number,
): void {
  const archer = findArcher(state, id);
  if (!archer) return;

  archer.lastPoseAt = nowMs;
  archer.poseSamples.push(up);
  if (archer.poseSamples.length > POSE_WINDOW) archer.poseSamples.shift();

  const grip = archer.grip;
  if (!grip) return;
  archer.elevationDeg = signedPitch(grip, up);
  archer.aim.y = clamp(-archer.elevationDeg / ELEVATION_FULL_DEG, -AIM_LIMIT, AIM_LIMIT);
}

/**
 * How still the phone is being held.
 *
 * `stalled` is not stillness: a phone that stopped sending reads perfectly calm
 * and would otherwise be handed a grip and a gold. The smoothing is written as
 * a time constant against the reading's own clock rather than a per-frame
 * coefficient, so it means the same 250 ms whether the phone sends at 15 Hz or
 * at 100.
 */
export function readStillness(
  state: ArcheryState,
  id: number,
  rate: number,
  still: boolean,
  stalled: boolean,
  nowMs: number,
): void {
  const archer = findArcher(state, id);
  if (!archer) return;
  if (stalled) {
    archer.still = false;
    return;
  }

  archer.still = still;
  archer.rate = rate;
  const gap = archer.lastStillnessAt === 0 ? 0 : (nowMs - archer.lastStillnessAt) / 1000;
  archer.lastStillnessAt = nowMs;
  if (gap <= 0) {
    if (archer.wobble === 0) archer.wobble = rate;
    return;
  }
  const alpha = 1 - Math.exp(-Math.min(gap, 1) / WOBBLE_TAU_SECONDS);
  archer.wobble += (rate - archer.wobble) * alpha;
}

/** TRIGGER down: the string comes back. */
export function pullTrigger(state: ArcheryState, id: number, nowMs: number): ArcheryEvent[] {
  const archer = findArcher(state, id);
  if (!archer || !archer.present) return [];
  if (state.phase !== 'shooting' || archer.phase !== 'nock') return [];

  const events: ArcheryEvent[] = [];
  // An archer who never holds still enough for the automatic grip still has to
  // be able to shoot, and a trigger press that visibly does nothing is the
  // failure this whole game exists to avoid. Refusing the grip here would be
  // exactly that, so the refusal is skipped and the grip taken as it stands.
  if (!archer.nocked) events.push(...takeGrip(archer, nowMs, false));

  archer.phase = 'draw';
  archer.draw = 0;
  archer.holdSeconds = 0;
  archer.announcedFullDraw = false;
  archer.announcedOverhold = false;
  archer.trace = [];
  archer.nextTraceAt = nowMs;
  archer.aimLagY = archer.aim.y;
  events.push({ kind: 'draw_started', playerId: archer.id });
  return events;
}

/**
 * TRIGGER up: the arrow leaves.
 *
 * `rotation` is the input layer's integral of the turn since the trigger went
 * down, in degrees per axis, and its yaw is the entire left-right story of this
 * shot. Nothing continuous carries a signed yaw — pose cannot see a turn about
 * gravity, and the stroke detector only reports once a motion has turned
 * around, so a crosshair driven from it would jump after the fact rather than
 * track. So windage is not drawn during the draw; it is revealed here, with the
 * number of degrees that caused it, which is what the archer needs told anyway.
 *
 * A release with no draw under it scores nothing. The trigger can arrive during
 * the score readout or between ends, and a phantom arrow off a stray button
 * edge would be a hole in a card nobody shot at.
 */
export function releaseTrigger(
  state: ArcheryState,
  id: number,
  rotation: CanonicalAngles,
  releaseRate: number,
  nowMs: number,
): ArcheryEvent[] {
  const archer = findArcher(state, id);
  if (!archer || archer.phase !== 'draw') return [];

  const shot = shotFrom(state, archer, rotation, releaseRate);
  archer.shots.push(shot);
  archer.lastShot = shot;
  archer.phase = 'score';
  archer.scoreSeconds = state.config.scoreSeconds;
  archer.nocked = false;
  archer.steadySeconds = 0;
  archer.lastPoseAt = nowMs;
  // The hit is left on the aim so the scene can draw the crosshair sitting
  // where the arrow actually went, windage included. That is the only sight the
  // archer gets of the left-right error they had no way to watch happen.
  archer.aim.x = shot.x;
  return [{ kind: 'loose', playerId: archer.id, shot }];
}

function shotFrom(
  state: ArcheryState,
  archer: Archer,
  rotation: CanonicalAngles,
  releaseRate: number,
): ArcheryShot {
  const growth = overholdGrowth(archer.holdSeconds, state.config);
  // The aim circle shows the settled shake, but a hand that snatches at the
  // loose has not been shaking for 250 ms yet and the smoothed value has not
  // caught up with it. `release.rate` is |omega| at the exact instant the
  // string goes, which is the whole reason that action carries it. Plucking is
  // a real archery fault, and this is where it costs something.
  const shake = Math.max(archer.wobble, releaseRate);
  const kick = shake * WOBBLE_GAIN * growth;
  const drift = driftDirection(archer, rotation.yaw);

  const x = rotation.yaw * WINDAGE_PER_DEG + kick * drift.x;
  // A bow released short shoots short, and short reads as low on the face.
  const y = archer.aim.y + kick * drift.y + (1 - archer.draw) * UNDERDRAW_DROP;
  const radius = Math.hypot(x, y);

  return {
    end: state.end,
    arrow: shotsThisEnd(archer, state.end).length + 1,
    x,
    y,
    radius,
    ring: ringFor(radius),
    elevationDeg: archer.elevationDeg,
    windageDeg: rotation.yaw,
    wobble: archer.wobble,
    meanWobble: meanRate(archer.trace),
    draw: archer.draw,
    holdMs: archer.holdSeconds * 1000,
    timedOut: false,
    trace: archer.trace,
  };
}

/**
 * Which way the shake throws the arrow.
 *
 * There is no RNG in this file, so the error needs a direction that came from
 * the archer. It is the direction the bow was already travelling: the yaw
 * integral sideways, and the aim's own movement over the last fifth of a second
 * vertically. A hand that genuinely did not move gets no kick at all, which is
 * the correct reward and the one case a shake penalty must not invent.
 */
function driftDirection(archer: Archer, yawDeg: number): { x: number; y: number } {
  const x = yawDeg;
  const y = archer.aim.y - archer.aimLagY;
  const length = Math.hypot(x, y);
  if (length < 1e-9) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

/**
 * What holding at full draw costs.
 *
 * A bow arm gives out. Written as a power of the seconds held past the limit
 * rather than a per-frame multiplier, so 6% per second is 6% per second at
 * every frame rate.
 */
export function overholdGrowth(holdSeconds: number, config: ArcheryConfig): number {
  const over = Math.max(0, holdSeconds - config.holdLimitSeconds);
  return (1 + OVERHOLD_GROWTH_PER_SECOND) ** over;
}

/**
 * The circle the scene draws round the crosshair.
 *
 * Deliberately the same number the shake will cost at the loose, not a separate
 * display constant: an archer who can see a circle two ring bands wide and then
 * loses two ring bands has learned something, and one whose circle disagrees
 * with their score has learned that the game is lying to them.
 */
export function aimRadius(archer: Archer, config: ArcheryConfig): number {
  return (SIGHT_RADIUS + archer.wobble * WOBBLE_GAIN) * overholdGrowth(archer.holdSeconds, config);
}

/** Ten in the gold, one on the outer band, nothing off the face. */
export function ringFor(radius: number): number {
  if (radius >= TARGET_RADIUS) return 0;
  return Math.max(1, 10 - Math.floor(radius / RING_WIDTH));
}

export function shotsThisEnd(archer: Archer, end: number): ArcheryShot[] {
  return archer.shots.filter((shot) => shot.end === end);
}

/** 1-based, and stays on the last arrow once the end is shot out. */
export function arrowNumber(state: ArcheryState, archer: Archer): number {
  const shot = shotsThisEnd(archer, state.end).length;
  return Math.min(shot + 1, state.config.arrowsPerEnd);
}

export function endTotal(archer: Archer, end: number): number {
  return shotsThisEnd(archer, end).reduce((sum, shot) => sum + shot.ring, 0);
}

export function totalScore(archer: Archer): number {
  return archer.shots.reduce((sum, shot) => sum + shot.ring, 0);
}

export function maxScore(config: ArcheryConfig): number {
  return config.ends * config.arrowsPerEnd * 10;
}

/** Highest total first, for the scoreboard and the winner line. */
export function standings(state: ArcheryState): Archer[] {
  return [...state.archers].sort((a, b) => totalScore(b) - totalScore(a));
}

/**
 * One frame.
 *
 * `nowMs` is a clock, used for the trace timestamps and the grip; every
 * duration in the rules is integrated from `dt`, never counted in frames.
 */
export function stepArchery(state: ArcheryState, dt: number, nowMs: number): ArcheryEvent[] {
  const events: ArcheryEvent[] = [];
  if (state.phase === 'over') return events;

  for (const archer of state.archers) events.push(...stepArcher(state, archer, dt, nowMs));

  const present = state.archers.filter((archer) => archer.present);
  if (present.length === 0) {
    state.emptySeconds += dt;
    // Every phone gone is a terminal state like any other. Waiting forever for
    // a room that walked away is the dead screen the house rules forbid; the
    // scene can say so and head for the lobby.
    if (state.emptySeconds >= state.config.abandonSeconds) events.push(...finish(state));
    return events;
  }
  state.emptySeconds = 0;

  if (state.phase === 'end_break') {
    state.breakTimer -= dt;
    if (state.breakTimer <= 0) events.push(...startEnd(state));
    return events;
  }

  if (state.config.endSeconds > 0) {
    state.endClock += dt;
    if (state.endClock >= state.config.endSeconds) {
      events.push(...closeEnd(state, true));
      return events;
    }
  }
  // Only archers who are answering are waited on. An end that waited for a
  // phone inside its rejoin window would stall the other three for the whole
  // of that window.
  if (present.every((archer) => archer.phase === 'done')) events.push(...closeEnd(state, false));
  return events;
}

function stepArcher(
  state: ArcheryState,
  archer: Archer,
  dt: number,
  nowMs: number,
): ArcheryEvent[] {
  const events: ArcheryEvent[] = [];
  const { config } = state;

  if (!archer.present) {
    // A phone that dropped mid-draw does not get to shoot the arrow it was
    // holding, and must not lose it either: the arrow goes back on the string
    // and the grip and the card stay exactly as they were (D48).
    if (archer.phase === 'draw') archer.phase = 'nock';
    archer.draw = 0;
    archer.nocked = false;
    archer.steadySeconds = 0;
    return events;
  }

  if (archer.phase === 'nock') {
    // The wait is counted here rather than read off the stillness action's own
    // steadyMs, because a refused grip has to start the wait over and nothing
    // in this file can reset a number the input layer owns.
    if (!archer.still) archer.steadySeconds = 0;
    else if (!archer.nocked) archer.steadySeconds += dt;
    if (!archer.nocked && archer.steadySeconds >= config.nockStillSeconds) {
      events.push(...takeGrip(archer, nowMs, true));
    }
    return events;
  }

  if (archer.phase === 'draw') {
    archer.draw = Math.min(1, archer.draw + dt / config.drawSeconds);
    if (archer.draw >= 1 && !archer.announcedFullDraw) {
      archer.announcedFullDraw = true;
      events.push({ kind: 'full_draw', playerId: archer.id });
    }
    archer.holdSeconds += dt;
    if (archer.holdSeconds >= config.holdLimitSeconds && !archer.announcedOverhold) {
      archer.announcedOverhold = true;
      events.push({ kind: 'overhold', playerId: archer.id });
    }
    archer.aimLagY += (archer.aim.y - archer.aimLagY) * (1 - Math.exp(-dt / DRIFT_TAU_SECONDS));
    if (config.trace) sampleTrace(archer, nowMs);
    return events;
  }

  if (archer.phase === 'score') {
    archer.scoreSeconds -= dt;
    if (archer.scoreSeconds <= 0) {
      const shot = shotsThisEnd(archer, state.end).length;
      archer.phase = shot >= config.arrowsPerEnd ? 'done' : 'nock';
      archer.steadySeconds = 0;
    }
  }
  return events;
}

/**
 * Adopt the hold this archer is standing in, and re-zero the aim onto it.
 *
 * Once per arrow, which is the point. Re-taking it whenever the phone happened
 * to be still would snap the crosshair back to the middle under an archer who
 * was holding a high shot steady — the aim would refuse to stay where it was
 * put, which from across the room is indistinguishable from a broken game.
 *
 * `refusable` separates the automatic grip from the one the trigger forces.
 */
function takeGrip(archer: Archer, nowMs: number, refusable: boolean): ArcheryEvent[] {
  if (archer.poseSamples.length === 0) return [];

  const grip = captureGrip(archer.poseSamples, nowMs);
  if (refusable && !archer.gripRejected && elevationBlind(grip.up)) {
    archer.gripRejected = true;
    archer.steadySeconds = 0;
    return [{ kind: 'grip_rejected', playerId: archer.id, reason: 'elevation_blind' }];
  }

  archer.grip = grip;
  archer.gripQuality = gripQuality(grip.up);
  archer.nocked = true;
  archer.elevationDeg = 0;
  archer.aim = { x: 0, y: 0 };
  archer.aimLagY = 0;
  return [{ kind: 'grip_taken', playerId: archer.id }];
}

/**
 * A grip that cannot see elevation at all.
 *
 * The design says to refuse a flat phone, and that is the wrong grip to refuse:
 * with gravity along the screen normal, the pitch axis is exactly perpendicular
 * to it and elevation reads at full gain — a phone lying on a table measures
 * being tipped up perfectly. The grip that kills this game is gravity along the
 * phone's right edge, because elevation is a turn about that same edge and a
 * turn about gravity moves gravity nowhere. Same 25 degree line pose.ts already
 * draws for the roll games, applied to the axis this game actually reads.
 */
function elevationBlind(up: CanonicalVector): boolean {
  const angle = angleBetweenDeg(up, { x: 1, y: 0, z: 0 });
  return Math.min(angle, 180 - angle) < ELEVATION_BLIND_DEG;
}

/**
 * The hold, sampled for practice's graph.
 *
 * On a wall clock at a fixed interval, so the curve has the same shape at 15 Hz
 * as at 100 and the mean shake underneath it is not weighted by frame rate.
 */
function sampleTrace(archer: Archer, nowMs: number): void {
  if (nowMs < archer.nextTraceAt) return;
  archer.nextTraceAt = nowMs + TRACE_INTERVAL_MS;
  if (archer.trace.length >= MAX_TRACE_SAMPLES) return;
  archer.trace.push({
    atMs: archer.holdSeconds * 1000,
    rate: archer.rate,
    x: archer.aim.x,
    y: archer.aim.y,
  });
}

function meanRate(trace: readonly ArcheryTraceSample[]): number {
  if (trace.length === 0) return 0;
  return trace.reduce((sum, sample) => sum + sample.rate, 0) / trace.length;
}

/**
 * End of an end.
 *
 * `timedOut` is the versus clock expiring. An archer who was there and did not
 * shoot loses those arrows — that is what a shooting clock is. An archer whose
 * phone is not answering loses nothing: their card simply has fewer arrows on
 * it, because a wifi hiccup must never read as a miss (D48).
 */
function closeEnd(state: ArcheryState, timedOut: boolean): ArcheryEvent[] {
  const events: ArcheryEvent[] = [];
  if (timedOut) {
    for (const archer of state.archers) {
      if (!archer.present) continue;
      const missing = state.config.arrowsPerEnd - shotsThisEnd(archer, state.end).length;
      if (missing <= 0) continue;
      for (let i = 0; i < missing; i++) archer.shots.push(lostArrow(state, archer));
      events.push({ kind: 'arrows_lost', playerId: archer.id, arrows: missing });
    }
  }
  for (const archer of state.archers) {
    archer.phase = 'done';
    archer.draw = 0;
  }

  events.push({ kind: 'end_finished', end: state.end });
  if (state.end >= state.config.ends) {
    events.push(...finish(state));
    return events;
  }
  state.phase = 'end_break';
  state.breakTimer = state.config.endBreakSeconds;
  return events;
}

function lostArrow(state: ArcheryState, archer: Archer): ArcheryShot {
  return {
    end: state.end,
    arrow: shotsThisEnd(archer, state.end).length + 1,
    x: 0,
    y: 0,
    radius: Number.POSITIVE_INFINITY,
    ring: 0,
    elevationDeg: 0,
    windageDeg: 0,
    wobble: archer.wobble,
    meanWobble: 0,
    draw: 0,
    holdMs: 0,
    timedOut: true,
    trace: [],
  };
}

function startEnd(state: ArcheryState): ArcheryEvent[] {
  if (state.end >= state.config.ends) return finish(state);
  state.end++;
  state.phase = 'shooting';
  state.endClock = 0;
  for (const archer of state.archers) {
    archer.phase = 'nock';
    // The grip is not thrown away between ends. It is all that stands between
    // an archer who put their phone down for a moment and a re-calibration,
    // and the next nock replaces it anyway.
    archer.nocked = false;
    archer.draw = 0;
    archer.holdSeconds = 0;
    archer.steadySeconds = 0;
    archer.scoreSeconds = 0;
  }
  return [{ kind: 'end_started', end: state.end }];
}

function finish(state: ArcheryState): ArcheryEvent[] {
  if (state.phase === 'over') return [];
  state.phase = 'over';
  return [{ kind: 'over' }];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
