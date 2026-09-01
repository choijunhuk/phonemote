/**
 * Statue Race rules, with no Phaser in sight (ARCHITECTURE.md 8).
 *
 * One number decides everything: the smoothed |omega| each phone reports. Green
 * turns it into forward motion, red turns it into a verdict. Nothing here needs
 * a heading, a grip or an integrated attitude, which is why the judgement can
 * be trusted — the measured classes are far apart. A hand trying to hold still
 * averages 3.3 deg/s with a worst single sample of 14, walking reads 54, and a
 * swing peaks between 297 and 1211. The 15 deg/s line below sits in empty space
 * rather than inside a distribution that would have to be tuned per player.
 *
 * The light pattern lives in here rather than in the scene because it has to
 * repeat: solo is a player replaying one board until they beat their own time,
 * and a board that reshuffles every attempt is not a board. Same seed, same
 * lights, same race.
 *
 * The design sketch gave the state one phase field with 'caught' in it. Caught
 * is per racer here instead: in a four-phone party three players can be running
 * while the fourth is frozen, and a single global phase cannot say that.
 */

export type StatueLight = 'green' | 'amber' | 'red';
export type StatuePhase = 'countdown' | StatueLight | 'finish';

export interface StatueSegment {
  readonly light: StatueLight;
  readonly seconds: number;
}

export interface StatueConfig {
  /** False in practice: there is no track, only the stopping drill. */
  readonly raced: boolean;
  /** True in solo: the previous best time runs alongside as a marker. */
  readonly ghost: boolean;
  readonly countdownSeconds: number;
  readonly trackLength: number;
  /**
   * Track units earned per degree of rotation while green.
   *
   * With the clamp below this is 18 units a second flat out, so the 100-long
   * track is 5.6 seconds of green if a player never lets up. A sustained shake
   * smooths out nearer 500 deg/s, which is ten seconds of green — four or five
   * lights, which is about as long as a party game holds a room.
   */
  readonly unitsPerDegree: number;
  /**
   * Rotation rate above which shaking harder earns nothing more, deg/s.
   *
   * A recorded hard swing peaks between 297 and 1211, so with no clamp the race
   * would reward whoever is willing to hurt their wrist. 900 is reachable by
   * anyone shaking properly and there is nothing to gain past it.
   */
  readonly maxRateDegPerSec: number;
  readonly greenMinSeconds: number;
  readonly greenMaxSeconds: number;
  /**
   * The grace between green and red, seconds.
   *
   * An arm cannot stop on the frame the light changes, and the frame that says
   * it has stopped crosses a network first. 250 ms covers both. It is also the
   * honest weakness of the whole game: jitter worse than this convicts a player
   * who had already stopped, and it cannot be checked afterwards because the
   * phone clock and the PC clock have different origins (ARCHITECTURE.md 5.7).
   */
  readonly amberSeconds: number;
  readonly redMinSeconds: number;
  readonly redMaxSeconds: number;
  /**
   * Smoothed |omega| that counts as moving under a red light, deg/s.
   *
   * Not the input layer's still/moving hysteresis of 8 and 16: that answers
   * "is this a grip I can take a reference from", and at 9 deg/s it would catch
   * a hand nobody in the room would call moving. 15 is above the p99 of a hand
   * holding still and far below anything deliberate.
   */
  readonly catchRateDegPerSec: number;
  /** What is left of a racer's progress after being caught. */
  readonly caughtKeeps: number;
  readonly freezeSeconds: number;
  /**
   * How long the race stays open after the winner crosses.
   *
   * Everyone still connected gets to finish, but a player who put their phone
   * down at 90 units must not keep the room waiting on them.
   */
  readonly finishGraceSeconds: number;
  /** Practice only: drills before the summary. Ignored when `raced`. */
  readonly attempts: number;
  /** Rounds of green/amber/red generated up front from the seed. */
  readonly patternRounds: number;
  /** Seconds of rate history kept per racer, for drawing the decay curve. */
  readonly traceSeconds: number;
}

const RACE: StatueConfig = {
  raced: true,
  ghost: false,
  countdownSeconds: 3,
  trackLength: 100,
  unitsPerDegree: 0.02,
  maxRateDegPerSec: 900,
  greenMinSeconds: 1.5,
  greenMaxSeconds: 4,
  amberSeconds: 0.25,
  redMinSeconds: 1.2,
  redMaxSeconds: 3,
  catchRateDegPerSec: 15,
  caughtKeeps: 0.85,
  freezeSeconds: 1.2,
  finishGraceSeconds: 8,
  attempts: 0,
  patternRounds: 24,
  traceSeconds: 3,
};

/**
 * The modes, as data, so the scene draws a config rather than branching on one.
 *
 * Practice is not the race with the scoring switched off. It is the single
 * thing the race asks of a player — stop dead — repeated, with the milliseconds
 * it took shown next to how hard they were shaking beforehand. A player who
 * cannot see that number has no way to tell a late stop from a stop the game
 * never received. Its red light is a fixed length so the readout does not flash
 * past at a different speed every drill.
 */
export const STATUE_MODES: Readonly<Record<string, StatueConfig>> = {
  party: RACE,
  solo: { ...RACE, ghost: true },
  practice: {
    ...RACE,
    raced: false,
    countdownSeconds: 2,
    greenMinSeconds: 2,
    greenMaxSeconds: 5,
    redMinSeconds: 2.2,
    redMaxSeconds: 2.2,
    attempts: 6,
    traceSeconds: 4,
  },
};

/** Takes the lobby's mode key as a plain string; the rules import nothing. */
export function statueConfigFor(mode: string): StatueConfig {
  return STATUE_MODES[mode] ?? RACE;
}

export interface RateSample {
  readonly t: number;
  readonly rate: number;
}

export interface StatueAttempt {
  /** Milliseconds from the red light to the first reading under the line. */
  readonly ms: number;
  /** Fastest rate under the green before it, so the two can be compared. */
  readonly peakRate: number;
  /** They were still moving when the red arrived. */
  readonly caught: boolean;
  /** False when the red ended with the arm still going. */
  readonly stopped: boolean;
}

export interface StatueRacer {
  readonly id: number;
  /** False while this phone is not answering. Kept, not deleted (D48). */
  present: boolean;
  progress: number;
  /** The last smoothed |omega| this phone reported, deg/s. */
  rate: number;
  /** This phone stopped sending. Not the same as a phone held still. */
  stalled: boolean;
  /** A reading has arrived since the current red light began. */
  fresh: boolean;
  /** That reading has been judged at least once. */
  judged: boolean;
  /** They were moving at the first judged frame of this red. */
  movedAtRed: boolean;
  stopMs: number | null;
  frozenFor: number;
  caught: number;
  /** Fastest rate seen since the current green began. */
  peakRate: number;
  attempts: StatueAttempt[];
  trace: RateSample[];
  finishedAt: number | null;
  rank: number | null;
}

export interface StatueState {
  readonly config: StatueConfig;
  readonly seed: number;
  readonly pattern: readonly StatueSegment[];
  phase: StatuePhase;
  /** Index into the pattern; it cycles rather than running out. */
  segment: number;
  /** Seconds left in the current light. */
  timer: number;
  /** Seconds since the countdown ended. */
  clock: number;
  /** Seconds since the current red began. */
  redElapsed: number;
  /** Part of a frame not yet simulated, kept for the next one. */
  carry: number;
  finished: number;
  sinceFirstFinish: number;
  /** Solo: the time to beat, seconds. Null until the player has set one. */
  ghostSeconds: number | null;
  racers: StatueRacer[];
}

export type StatueEvent =
  | { readonly kind: 'light'; readonly light: StatueLight }
  | { readonly kind: 'caught'; readonly playerId: number; readonly progress: number }
  | { readonly kind: 'freed'; readonly playerId: number }
  | {
      readonly kind: 'stopped';
      readonly playerId: number;
      readonly ms: number;
      readonly peakRate: number;
      readonly caught: boolean;
      readonly best: boolean;
    }
  | {
      readonly kind: 'finish';
      readonly playerId: number;
      readonly rank: number;
      readonly seconds: number;
    }
  | { readonly kind: 'record'; readonly playerId: number; readonly seconds: number }
  | { readonly kind: 'over' };

/**
 * The simulation step, seconds.
 *
 * The frame rate is unknown and varies (ARCHITECTURE.md 11.2). At 15 Hz a whole
 * frame is 67 ms, so a frame straddling the red light could hand out 67 ms of
 * free running, or judge a player 67 ms before the light they are reacting to
 * appeared. Fixed sub-steps bound that error to 8 ms whatever the display does.
 */
const STEP_SECONDS = 1 / 120;

/**
 * The largest frame simulated at all, seconds.
 *
 * A backgrounded tab returns with a delta of several seconds, and replaying it
 * would run a red light the player never saw.
 */
const MAX_FRAME_SECONDS = 0.25;

/** Deterministic by construction: the rules must never reach for Math.random. */
function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Green, then amber, then red, for as many rounds as the config asks.
 *
 * Amber is added after the green rather than carved out of it, so a green of
 * 1.5 s is the 1.5 s of running the design asks for and the grace is extra.
 */
export function buildPattern(config: StatueConfig, seed: number): StatueSegment[] {
  const random = seededRandom(seed);
  const segments: StatueSegment[] = [];
  const greenSpan = config.greenMaxSeconds - config.greenMinSeconds;
  const redSpan = config.redMaxSeconds - config.redMinSeconds;
  for (let round = 0; round < config.patternRounds; round++) {
    const green = config.greenMinSeconds + random() * greenSpan;
    const red = config.redMinSeconds + random() * redSpan;
    segments.push({ light: 'green', seconds: green });
    segments.push({ light: 'amber', seconds: config.amberSeconds });
    segments.push({ light: 'red', seconds: red });
  }
  return segments;
}

export function createStatue(config: StatueConfig = RACE, seed = 1): StatueState {
  return {
    config,
    seed,
    pattern: buildPattern(config, seed),
    phase: 'countdown',
    segment: 0,
    timer: config.countdownSeconds,
    clock: 0,
    redElapsed: 0,
    carry: 0,
    finished: 0,
    sinceFirstFinish: 0,
    ghostSeconds: null,
    racers: [],
  };
}

export function findRacer(state: StatueState, id: number): StatueRacer | undefined {
  return state.racers.find((racer) => racer.id === id);
}

/**
 * Bring the roster in line with who is connected.
 *
 * Everyone already racing keeps their progress, their attempts and their rank.
 * A phone going quiet also has its last reading cleared: that reading is from
 * before the outage, and letting it stand would convict the player of moving
 * during a red light they were not connected for.
 */
export function syncRacers(
  state: StatueState,
  roster: ReadonlyArray<{ readonly id: number; readonly present: boolean }>,
): void {
  state.racers = roster.map(({ id, present }) => {
    const racer = findRacer(state, id);
    if (!racer) return newRacer(id, present);
    if (!present) {
      racer.fresh = false;
      racer.rate = 0;
    }
    racer.present = present;
    return racer;
  });
}

function newRacer(id: number, present: boolean): StatueRacer {
  // Somebody joining mid-race starts at the line. There is nowhere else honest
  // to put them, and the alternative is restarting the room's race.
  return {
    id,
    present,
    progress: 0,
    rate: 0,
    stalled: false,
    fresh: false,
    judged: false,
    movedAtRed: false,
    stopMs: null,
    frozenFor: 0,
    caught: 0,
    peakRate: 0,
    attempts: [],
    trace: [],
    finishedAt: null,
    rank: null,
  };
}

export function setGhost(state: StatueState, seconds: number | null): void {
  state.ghostSeconds = seconds;
}

/**
 * One stillness reading from one phone.
 *
 * `rate` is the input layer's smoothed |omega| and `stalled` is that layer
 * saying the phone has gone quiet, which is the only place the difference
 * between a silent phone and a still one is known.
 */
export function readStillness(state: StatueState, id: number, rate: number, stalled: boolean): void {
  const racer = findRacer(state, id);
  if (!racer) return;
  racer.rate = rate;
  racer.stalled = stalled;
  racer.fresh = true;
  if (rate > racer.peakRate) racer.peakRate = rate;
  racer.trace.push({ t: state.clock, rate });
  pruneTrace(state, racer);
}

function pruneTrace(state: StatueState, racer: StatueRacer): void {
  // Dropped by age rather than by count: at an unknown frame rate a fixed
  // number of samples is a different length of history on every phone.
  const oldest = state.clock - state.config.traceSeconds;
  while (racer.trace.length > 0 && (racer.trace[0]?.t ?? 0) < oldest) racer.trace.shift();
}

function phaseOf(state: StatueState): StatuePhase {
  return state.phase;
}

export function stepStatue(state: StatueState, dt: number): StatueEvent[] {
  const events: StatueEvent[] = [];
  if (state.phase === 'finish') return events;
  // With nobody connected the race pauses rather than running on without them.
  // A player whose phone dropped comes back to the light they left, not to a
  // race that finished while they were reconnecting.
  if (!state.racers.some((racer) => racer.present)) return events;

  state.carry += Math.min(Math.max(dt, 0), MAX_FRAME_SECONDS);
  while (state.carry >= STEP_SECONDS) {
    state.carry -= STEP_SECONDS;
    events.push(...substep(state, STEP_SECONDS));
    // Read through a function so control flow cannot narrow it: substep can
    // finish the race, which the checks before this loop do not know about.
    if (phaseOf(state) === 'finish') {
      state.carry = 0;
      break;
    }
  }
  return events;
}

function substep(state: StatueState, h: number): StatueEvent[] {
  const events: StatueEvent[] = [];

  if (state.phase === 'countdown') {
    state.timer -= h;
    if (state.timer <= 0) events.push(...enterSegment(state, 0));
    return events;
  }

  state.clock += h;
  if (state.phase === 'red') state.redElapsed += h;

  for (const racer of state.racers) {
    if (racer.frozenFor > 0) {
      racer.frozenFor = Math.max(0, racer.frozenFor - h);
      if (racer.frozenFor === 0) events.push({ kind: 'freed', playerId: racer.id });
    }
    pruneTrace(state, racer);
    if (!racer.present) continue;
    if (state.phase === 'green') events.push(...advanceRacer(state, racer, h));
    if (state.phase === 'red') events.push(...judgeRacer(state, racer));
  }

  state.timer -= h;
  if (state.timer <= 0) events.push(...enterSegment(state, state.segment + 1));
  events.push(...checkOver(state, h));
  return events;
}

function advanceRacer(state: StatueState, racer: StatueRacer, h: number): StatueEvent[] {
  const config = state.config;
  if (!config.raced || racer.frozenFor > 0 || racer.finishedAt !== null) return [];

  // Path length: distance is the integral of the rate, so shaking harder moves
  // further and the total does not depend on how often frames arrive.
  const rate = racer.stalled ? 0 : Math.min(racer.rate, config.maxRateDegPerSec);
  racer.progress = Math.min(config.trackLength, racer.progress + rate * h * config.unitsPerDegree);
  if (racer.progress < config.trackLength) return [];

  racer.finishedAt = state.clock;
  state.finished++;
  racer.rank = state.finished;
  if (racer.rank === 1) state.sinceFirstFinish = 0;

  const events: StatueEvent[] = [
    { kind: 'finish', playerId: racer.id, rank: racer.rank, seconds: state.clock },
  ];
  if (config.ghost && (state.ghostSeconds === null || state.clock < state.ghostSeconds)) {
    events.push({ kind: 'record', playerId: racer.id, seconds: state.clock });
  }
  return events;
}

/**
 * The red light, judged.
 *
 * Two conditions the design is explicit about, and both are about not punishing
 * a player for something their phone did. A stalled phone is not caught: it is
 * simply not there. And nothing is judged until a reading has arrived since the
 * light changed, because whatever reading was in hand at that instant was sent
 * before the player could have seen the light.
 */
function judgeRacer(state: StatueState, racer: StatueRacer): StatueEvent[] {
  const config = state.config;
  if (!racer.fresh || racer.stalled || racer.frozenFor > 0 || racer.finishedAt !== null) return [];

  const moving = racer.rate > config.catchRateDegPerSec;
  if (!racer.judged) {
    racer.judged = true;
    racer.movedAtRed = moving;
  }

  if (moving) {
    if (!config.raced) return [];
    racer.progress *= config.caughtKeeps;
    racer.caught++;
    racer.frozenFor = config.freezeSeconds;
    return [{ kind: 'caught', playerId: racer.id, progress: racer.progress }];
  }

  if (racer.stopMs !== null) return [];
  // A player who was already still when red came scores 0, not the handful of
  // milliseconds their phone took to say so.
  racer.stopMs = racer.movedAtRed ? Math.round(state.redElapsed * 1000) : 0;
  return [record(racer, racer.stopMs, racer.movedAtRed, true)];
}

function record(racer: StatueRacer, ms: number, caught: boolean, stopped: boolean): StatueEvent {
  const previous = bestStops(racer, 1)[0];
  const attempt: StatueAttempt = { ms, peakRate: racer.peakRate, caught, stopped };
  racer.attempts.push(attempt);
  return {
    kind: 'stopped',
    playerId: racer.id,
    ms,
    peakRate: attempt.peakRate,
    caught,
    best: stopped && (previous === undefined || ms <= previous),
  };
}

function enterSegment(state: StatueState, index: number): StatueEvent[] {
  const events: StatueEvent[] = [];
  if (state.pattern.length === 0) return events;
  if (state.phase === 'red') closeRed(state);

  const wrapped = index % state.pattern.length;
  const segment = state.pattern[wrapped];
  if (!segment) return events;

  state.segment = wrapped;
  state.phase = segment.light;
  // The overshoot of the light that just ended is carried into the next one, so
  // the pattern keeps the length it was generated with however dt lands.
  state.timer = segment.seconds + Math.min(0, state.timer);

  if (segment.light === 'green') {
    for (const racer of state.racers) racer.peakRate = 0;
  }
  if (segment.light === 'red') {
    state.redElapsed = 0;
    for (const racer of state.racers) {
      racer.fresh = false;
      racer.judged = false;
      racer.movedAtRed = false;
      racer.stopMs = null;
    }
  }
  events.push({ kind: 'light', light: segment.light });
  return events;
}

/**
 * A red that ended with somebody's arm still going, recorded as the attempt it
 * was. It is silent: the caught event already told the room, and in practice
 * the number the player is watching is being drawn live anyway.
 */
function closeRed(state: StatueState): void {
  for (const racer of state.racers) {
    if (!racer.judged || racer.stopMs !== null) continue;
    racer.attempts.push({
      ms: Math.round(state.redElapsed * 1000),
      peakRate: racer.peakRate,
      caught: true,
      stopped: false,
    });
  }
}

function checkOver(state: StatueState, h: number): StatueEvent[] {
  if (state.phase === 'finish') return [];
  const present = state.racers.filter((racer) => racer.present);
  if (present.length === 0) return [];

  if (state.config.raced) {
    if (state.finished === 0) return [];
    state.sinceFirstFinish += h;
    const waiting = present.some((racer) => racer.finishedAt === null);
    // Absent racers are not waited for. A phone that dropped at the start would
    // otherwise hold the finish screen open for the full grace every time.
    if (waiting && state.sinceFirstFinish < state.config.finishGraceSeconds) return [];
  } else if (present.some((racer) => racer.attempts.length < state.config.attempts)) {
    return [];
  }

  state.phase = 'finish';
  return [{ kind: 'over' }];
}

/** The best few stop times, ascending. The practice screen shows three. */
export function bestStops(racer: StatueRacer, count = 3): number[] {
  return racer.attempts
    .filter((attempt) => attempt.stopped)
    .map((attempt) => attempt.ms)
    .sort((a, b) => a - b)
    .slice(0, count);
}

/** Ranked if they finished, by distance if they have not. */
export function standings(state: StatueState): StatueRacer[] {
  return [...state.racers].sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return b.progress - a.progress;
  });
}

/**
 * Where the previous best run would be now, or null if there is nothing to race
 * against.
 *
 * Only the total time was kept, not the shape of the run, so the ghost's
 * distance is spread evenly across the green light. The pattern is identical,
 * so the ghost stops when the player stops and crosses the line at exactly the
 * time it recorded; only the middle of its run is an estimate.
 */
export function ghostProgress(state: StatueState): number | null {
  if (!state.config.ghost || state.ghostSeconds === null) return null;
  const total = greenSecondsWithin(state.pattern, state.ghostSeconds);
  if (total <= 0) return null;
  const done = greenSecondsWithin(state.pattern, state.clock);
  return Math.min(state.config.trackLength, (done / total) * state.config.trackLength);
}

/** How much of the first `seconds` of a pattern is green. */
export function greenSecondsWithin(pattern: readonly StatueSegment[], seconds: number): number {
  if (pattern.length === 0 || seconds <= 0) return 0;
  let green = 0;
  let elapsed = 0;
  // Bounded rather than a while loop on elapsed: a config with a zero-length
  // segment would otherwise spin here forever.
  for (let i = 0; elapsed < seconds && i < pattern.length * 64; i++) {
    const segment = pattern[i % pattern.length];
    if (!segment) break;
    const take = Math.min(segment.seconds, seconds - elapsed);
    if (segment.light === 'green') green += take;
    elapsed += take;
  }
  return green;
}
