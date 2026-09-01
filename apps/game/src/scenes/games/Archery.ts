import type Phaser from 'phaser';
import { session } from '../../session.js';
import { BaseGameScene } from './BaseGameScene.js';
import type { CanonicalAngles, GameAction } from '../../input/types.js';
import { sfx } from '../../ui/audio.js';
import {
  RING_WIDTH,
  TARGET_RADIUS,
  aimRadius,
  archeryConfigFor,
  arrowNumber,
  createArchery,
  endTotal,
  maxScore,
  pullTrigger,
  readPose,
  readStillness,
  releaseTrigger,
  shotsThisEnd,
  standings,
  stepArchery,
  syncArchers,
  totalScore,
  type Archer,
  type ArcheryEvent,
  type ArcheryModeKey,
  type ArcheryState,
  type ArcheryTraceSample,
} from './archeryState.js';

/**
 * Archery: draw, hold, and let go before the shake arrives.
 *
 * Every rule is in archeryState.ts. This file owns three things the rules
 * cannot: the target face, the sound and buzz each event deserves, and the
 * practice screen — the shake curve of the hold, the aim path replayed slowly,
 * and the elevation printed beside the ring it scored.
 *
 * The design also asks for a live parabola during the draw. There is no
 * trajectory anywhere in the rules — elevation maps straight to a point on the
 * face — so drawing an arc here would be this scene inventing physics the score
 * does not come from, which is the one thing a scene must not do. The elevation
 * in degrees next to the ring teaches the same mapping from numbers the game
 * actually used.
 *
 * The release is read two ways on purpose. Archery's registry entry asks for
 * pose and stillness only, so the trigger coming up arrives as a plain
 * button_up carrying no rotation; if the entry ever gains `release`, the mapper
 * emits button_up first and the measured release immediately after. So a bare
 * button edge only arms the shot and the next frame fires it, which lets the
 * measured release overtake it. Windage is then labelled as unmeasured rather
 * than printed as a confident 0.0 degrees.
 */

/** Nothing on a TV across a room goes below this (house rule). */
const SMALL_TEXT = '22px';
const BODY_TEXT = '24px';
const HEAD_TEXT = '26px';

const SANS = 'system-ui, sans-serif';
const MONO = 'ui-monospace, monospace';

const INK = '#f1f3f8';
const DIM = '#98a0b3';
const WARN = '#ffa502';
const GOOD = '#2ed573';

/** World Archery colours, outermost band first. */
const BAND_COLORS = [0xf1f3f8, 0x20242e, 0x3ba7d8, 0xe14b4b, 0xf2c94c] as const;

const FACE_Y = 236;
const BAR_Y = 412;
const NAME_Y = 442;
const END_Y = 476;
const READING_Y = 506;
const GRAPH_TOP = 596;
const GRAPH_HEIGHT = 88;

/**
 * Slow motion for the aim replay.
 *
 * A hold lasts one to three seconds and the whole point of the replay is to
 * show the drift inside it, which at full speed is a blink.
 */
const REPLAY_SPEED = 0.35;

/** The shortest hold worth spreading across the graph's full width. */
const GRAPH_MIN_SPAN_MS = 2000;

/** Below this the graph is drawing sensor noise, not shake. */
const GRAPH_MIN_PEAK = 10;

/** A shot fired from a bare button edge has no rotation to report. */
const NO_ROTATION: CanonicalAngles = { yaw: 0, pitch: 0, roll: 0 };

const MODE_LABEL: Readonly<Record<ArcheryModeKey, string>> = {
  practice: '연습 — 버티고, 재고, 한 발씩',
  solo: '혼자 — 6엔드 18발',
  versus: '대전 — 각자 과녁, 동시에',
};

/**
 * The lobby can hand over any mode key. archeryConfigFor falls back to practice
 * and so does this, so the label on screen and the rules being played always
 * name the same mode.
 */
function asArcheryMode(mode: string): ArcheryModeKey {
  return mode === 'solo' || mode === 'versus' ? mode : 'practice';
}

interface Lane {
  readonly container: Phaser.GameObjects.Container;
  readonly marks: Phaser.GameObjects.Graphics;
  readonly graph: Phaser.GameObjects.Graphics;
  readonly nameText: Phaser.GameObjects.Text;
  readonly endText: Phaser.GameObjects.Text;
  readonly readingText: Phaser.GameObjects.Text;
  readonly graphText: Phaser.GameObjects.Text;
  readonly drawBar: Phaser.GameObjects.Rectangle;
  readonly radius: number;
  readonly barWidth: number;
  readonly graphWidth: number;
  readonly color: number;
  readonly colorHex: string;
  readonly name: string;
}

export class Archery extends BaseGameScene {
  private state: ArcheryState = createArchery();
  private archeryMode: ArcheryModeKey = 'practice';
  private readonly lanes = new Map<number, Lane>();
  /** Trigger edges waiting one frame for a measured release to overtake them. */
  private readonly pendingRelease = new Set<number>();
  /** Whose last shot carried a real yaw integral rather than a bare edge. */
  private readonly measuredWindage = new Set<number>();
  /** Seconds the aim replay has been running, per archer. */
  private readonly replaySeconds = new Map<number, number>();
  private headerText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private bannerText!: Phaser.GameObjects.Text;

  constructor() {
    super('archery');
  }

  protected build(): void {
    const { width } = this.scale;

    // Phaser calls create() again on the same instance, so a second round would
    // otherwise open on the last one's end number, its shot cards and its
    // finished banner.
    this.archeryMode = asArcheryMode(this.mode);
    this.state = createArchery(archeryConfigFor(this.mode));
    this.lanes.clear();
    this.pendingRelease.clear();
    this.measuredWindage.clear();
    this.replaySeconds.clear();

    this.headerText = this.add
      .text(18, 14, MODE_LABEL[this.archeryMode], {
        fontFamily: SANS,
        fontSize: HEAD_TEXT,
        color: INK,
      })
      .setOrigin(0, 0);

    this.clockText = this.add
      .text(width - 18, 14, '', {
        fontFamily: MONO,
        fontSize: HEAD_TEXT,
        color: DIM,
      })
      .setOrigin(1, 0);

    // The one line that always says what the game is waiting for. A player
    // holding a phone that measured nothing cannot otherwise tell whether the
    // game wants a stiller hand, a trigger, or somebody else's phone.
    this.statusText = this.add
      .text(width / 2, 48, '', {
        fontFamily: SANS,
        fontSize: HEAD_TEXT,
        color: WARN,
        align: 'center',
        wordWrap: { width: width - 40 },
      })
      .setOrigin(0.5, 0);

    this.bannerText = this.add
      .text(width / 2, this.scale.height * 0.44, '', {
        fontFamily: SANS,
        fontSize: '40px',
        color: INK,
        align: 'center',
        backgroundColor: '#0f1116',
        padding: { x: 20, y: 14 },
      })
      .setOrigin(0.5)
      .setDepth(900)
      .setVisible(false);

    // The listener fires as it is registered, which is what builds the lanes
    // for whoever is already in the room.
    this.onCleanup(session.onPlayersChanged(() => this.rebuildLanes()));
  }

  protected override onGameAction(action: GameAction): void {
    switch (action.kind) {
      case 'pose':
        // Gravity, not angles: elevation is read against the archer's own grip
        // and both are `up` vectors (ARCHITECTURE.md 5.8).
        readPose(this.state, action.playerId, action.up, this.time.now);
        return;
      case 'stillness':
        readStillness(
          this.state,
          action.playerId,
          action.rate,
          action.still,
          action.stalled,
          this.time.now,
        );
        return;
      case 'button_down':
        if (action.button === 'TRIGGER') {
          this.play(pullTrigger(this.state, action.playerId, this.time.now));
        }
        return;
      case 'button_up':
        // Armed, not fired: see the release note at the top of this file.
        if (action.button === 'TRIGGER') this.pendingRelease.add(action.playerId);
        return;
      case 'release':
        this.pendingRelease.delete(action.playerId);
        this.measuredWindage.add(action.playerId);
        this.play(
          releaseTrigger(this.state, action.playerId, action.rotation, action.rate, this.time.now),
        );
        return;
      default:
        return;
    }
  }

  protected override teardown(): void {
    // The lanes hold destroyed game objects once the scene shuts down, and the
    // next run wrote to them.
    this.lanes.clear();
  }

  protected step(dt: number): void {
    for (const playerId of this.pendingRelease) {
      this.measuredWindage.delete(playerId);
      // Zero rotation is the honest reading of a bare button edge, and a zero
      // release rate leaves the shake to the smoothed wobble the rules kept.
      this.play(releaseTrigger(this.state, playerId, NO_ROTATION, 0, this.time.now));
    }
    this.pendingRelease.clear();

    this.play(stepArchery(this.state, dt, this.time.now));

    for (const archer of this.state.archers) {
      this.replaySeconds.set(archer.id, (this.replaySeconds.get(archer.id) ?? 0) + dt);
    }

    if (this.state.phase === 'over') this.returnToLobbyAfter(10);
    this.render();
  }

  /** Sound and vibration, which are the only things the rules cannot do. */
  private play(events: readonly ArcheryEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'grip_taken':
          sfx.tick();
          // Every pulse here is at least 25 ms: shorter than that an Android
          // motor never finishes spinning up and the phone feels dead.
          session.vibrate(event.playerId, [30]);
          session.log(`그립 P${event.playerId}`);
          break;
        case 'grip_rejected':
          sfx.whiff();
          session.vibrate(event.playerId, [25, 60, 25]);
          session.log(`그립 거부 P${event.playerId} (앙각을 못 읽는 자세)`);
          break;
        case 'draw_started':
          sfx.wall();
          session.vibrate(event.playerId, [30]);
          this.replaySeconds.set(event.playerId, 0);
          break;
        case 'full_draw':
          sfx.tick();
          session.vibrate(event.playerId, [45]);
          break;
        case 'overhold':
          sfx.whiff();
          session.vibrate(event.playerId, [25, 60, 25]);
          break;
        case 'loose': {
          const { shot } = event;
          // A shot that missed the face has no ring to celebrate, and hit()
          // rises in pitch with its argument, so the gold is the brightest
          // sound in the game.
          if (shot.ring > 0) sfx.hit(shot.ring / 10);
          else sfx.whiff();
          // Longer for a full draw, because that is the string that had the
          // most in it.
          session.vibrate(event.playerId, [Math.round(30 + shot.draw * 40)]);
          this.replaySeconds.set(event.playerId, 0);
          session.log(
            `발사 P${event.playerId} ${shot.ring}점 앙각 ${shot.elevationDeg.toFixed(1)}° ` +
              `흔들림 ${shot.wobble.toFixed(1)}°/s`,
          );
          break;
        }
        case 'arrows_lost':
          sfx.whiff();
          session.vibrate(event.playerId, [200]);
          session.log(`시간 초과 P${event.playerId} — ${event.arrows}발 잃음`);
          break;
        case 'end_started':
          sfx.tick();
          session.log(`${event.end}엔드 시작`);
          break;
        case 'end_finished':
          sfx.point();
          break;
        case 'over':
          sfx.win();
          session.log('경기 종료');
          break;
      }
    }
  }

  private rebuildLanes(): void {
    const { width } = this.scale;
    for (const lane of this.lanes.values()) lane.container.destroy();
    this.lanes.clear();

    const players = session.players;
    // Scores, grips and cards live in the state, which keeps every archer it
    // already knows: somebody joining must not cost the room its match.
    syncArchers(
      this.state,
      players.map((player) => ({ id: player.id, present: player.present })),
    );

    const columnWidth = width / Math.max(1, players.length);
    // Practice gives the bottom third of the lane to the shake graph, so the
    // face is smaller there than in a match.
    const radius = Math.min(columnWidth * 0.32, this.archeryMode === 'practice' ? 150 : 178);
    const barWidth = columnWidth - 96;
    const graphWidth = columnWidth - 70;

    players.forEach((player, index) => {
      const color = Number(`0x${player.color.slice(1)}`);
      const laneX = columnWidth * (index + 0.5);

      const face = this.add.graphics();
      this.drawFace(face, radius);
      const marks = this.add.graphics();
      const graph = this.add.graphics();

      const nameText = this.add
        .text(0, NAME_Y, player.name, {
          fontFamily: SANS,
          fontSize: HEAD_TEXT,
          color: player.color,
        })
        .setOrigin(0.5, 0);
      const endText = this.add
        .text(0, END_Y, '', {
          fontFamily: MONO,
          fontSize: BODY_TEXT,
          color: INK,
        })
        .setOrigin(0.5, 0);
      const readingText = this.add
        .text(0, READING_Y, '', {
          fontFamily: MONO,
          fontSize: SMALL_TEXT,
          color: DIM,
          align: 'center',
          wordWrap: { width: columnWidth - 24 },
        })
        .setOrigin(0.5, 0)
        .setLineSpacing(4);
      const graphText = this.add
        .text(0, GRAPH_TOP + GRAPH_HEIGHT + 4, '', {
          fontFamily: MONO,
          fontSize: SMALL_TEXT,
          color: DIM,
          align: 'center',
          wordWrap: { width: columnWidth - 24 },
        })
        .setOrigin(0.5, 0)
        .setVisible(this.archeryMode === 'practice');

      const barTrack = this.add.rectangle(0, BAR_Y, barWidth, 16, 0x232838);
      const drawBar = this.add
        .rectangle(-barWidth / 2, BAR_Y, barWidth, 16, color)
        .setOrigin(0, 0.5)
        .setScale(0, 1);

      const container = this.add.container(laneX, 0, [
        face,
        marks,
        graph,
        barTrack,
        drawBar,
        nameText,
        endText,
        readingText,
        graphText,
      ]);

      this.lanes.set(player.id, {
        container,
        marks,
        graph,
        nameText,
        endText,
        readingText,
        graphText,
        drawBar,
        radius,
        barWidth,
        graphWidth,
        color,
        colorHex: player.color,
        name: player.name,
      });
    });
  }

  /** The ten bands, from the rules' own face rather than a redrawn ten. */
  private drawFace(face: Phaser.GameObjects.Graphics, radius: number): void {
    const bands = Math.round(TARGET_RADIUS / RING_WIDTH);
    for (let band = 0; band < bands; band++) {
      const outer = radius * ((bands - band) / bands);
      const color = BAND_COLORS[Math.min(BAND_COLORS.length - 1, Math.floor(band / 2))] ?? 0xf1f3f8;
      face.fillStyle(color, 1);
      face.fillCircle(0, FACE_Y, outer);
      face.lineStyle(2, 0x0f1116, 0.5);
      face.strokeCircle(0, FACE_Y, outer);
    }
  }

  private render(): void {
    const { config } = this.state;
    const shooting = this.state.phase === 'shooting';

    this.headerText.setText(
      `${MODE_LABEL[this.archeryMode]}   ${this.state.end}/${config.ends} 엔드`,
    );
    this.clockText.setText(
      config.endSeconds > 0 && shooting
        ? `남은 시간 ${Math.max(0, config.endSeconds - this.state.endClock).toFixed(0)}초`
        : `한 엔드 ${config.arrowsPerEnd}발`,
    );

    for (const archer of this.state.archers) {
      const lane = this.lanes.get(archer.id);
      if (!lane) continue;
      this.renderLane(archer, lane);
    }

    this.statusText.setText(this.statusLine());
    this.renderWaiting();
    this.renderBanner();

    session.status =
      `archery ${this.state.phase} ${this.state.end}/${config.ends}  ` +
      this.state.archers
        .map(
          (archer) =>
            `P${archer.id} ${archer.phase} ${totalScore(archer)}점 ` +
            `앙각 ${archer.elevationDeg.toFixed(1)}° 흔들림 ${archer.wobble.toFixed(1)}°/s`,
        )
        .join('  ');
  }

  private renderLane(archer: Archer, lane: Lane): void {
    const { config } = this.state;
    const drawing = archer.phase === 'draw';

    lane.container.setAlpha(archer.present ? 1 : 0.45);
    lane.drawBar.setScale(archer.draw, 1);
    // The bar turns to the warning colour on the same event that buzzes the
    // phone, so the screen and the hand never disagree about the bow arm.
    lane.drawBar.setFillStyle(archer.announcedOverhold ? 0xffa502 : lane.color);
    lane.nameText.setColor(drawing ? GOOD : lane.colorHex);
    lane.nameText.setText(`${lane.name}   ${totalScore(archer)}점`);

    const shots = shotsThisEnd(archer, this.state.end);
    const card = shots
      .map((shot) => (shot.timedOut ? '시간초과' : shot.ring === 0 ? 'M' : String(shot.ring)))
      .join(' · ');
    lane.endText.setText(
      `${this.state.end}엔드 ${arrowNumber(this.state, archer)}/${config.arrowsPerEnd}` +
        (card === '' ? '' : `   ${card}`),
    );

    lane.readingText.setText(this.readings(archer));
    this.drawMarks(archer, lane);
    if (this.archeryMode === 'practice') this.drawGraph(archer, lane);
  }

  /**
   * The archer's own measurements, in practice mode.
   *
   * This is what practice is for. A player who cannot see what their movement
   * measured cannot tell a bad shot from one the game never saw, so every
   * number the shot was built from is on the screen: the elevation that aimed
   * it, the shake at the loose and across the hold, how far the string came
   * back, and how long the arm held it.
   */
  private readings(archer: Archer): string {
    const shot = archer.lastShot;
    if (this.archeryMode !== 'practice') {
      return `앙각 ${signed(archer.elevationDeg)}°`;
    }

    const live =
      `앙각 ${signed(archer.elevationDeg)}°   흔들림 ${archer.wobble.toFixed(1)}°/s` +
      ` (raw ${archer.rate.toFixed(1)})\n` +
      `당김 ${Math.round(archer.draw * 100)}%   버팀 ${archer.holdSeconds.toFixed(1)}초   ` +
      `그립 ${archer.gripQuality.toFixed(2)}`;

    if (!shot) return `${live}\n마지막 발 —\n첫 발을 쏘면 여기에 숫자가 남습니다`;

    // A shot fired from a plain button edge carries no yaw integral, and
    // printing 0.0° for a number nobody measured is exactly the lie this
    // screen exists to prevent.
    const windage = this.measuredWindage.has(archer.id)
      ? `${signed(shot.windageDeg)}°`
      : '측정 안 됨';
    return (
      `${live}\n` +
      `마지막 ${shot.ring === 0 ? 'M' : `${shot.ring}점`} · 앙각 ${signed(shot.elevationDeg)}° · ` +
      `좌우 ${windage}\n` +
      `놓는 순간 ${shot.wobble.toFixed(1)}°/s · 홀드 평균 ${shot.meanWobble.toFixed(1)}°/s · ` +
      `당김 ${Math.round(shot.draw * 100)}%`
    );
  }

  /**
   * The face: this end's arrows, the aim circle, and the replayed aim path.
   *
   * Only this end is drawn. Eighteen arrows on one face stops being a card the
   * archer can read at a glance, and the totals under it carry the round.
   */
  private drawMarks(archer: Archer, lane: Lane): void {
    const { marks } = lane;
    marks.clear();

    for (const shot of shotsThisEnd(archer, this.state.end)) {
      if (shot.timedOut) continue;
      const point = this.facePoint(lane, shot.x, shot.y);
      marks.fillStyle(0xf1f3f8, 1);
      marks.fillCircle(point.x, point.y, 6);
      marks.lineStyle(2, 0x0f1116, 1);
      marks.strokeCircle(point.x, point.y, 6);
    }

    const trace = this.shownTrace(archer);
    if (this.archeryMode === 'practice' && trace.length > 1) {
      marks.lineStyle(2, lane.color, 0.45);
      marks.beginPath();
      trace.forEach((sample, index) => {
        const point = this.facePoint(lane, sample.x, sample.y);
        if (index === 0) marks.moveTo(point.x, point.y);
        else marks.lineTo(point.x, point.y);
      });
      marks.strokePath();

      const head = traceAt(trace, this.replayMs(archer, trace));
      if (head) {
        const point = this.facePoint(lane, head.x, head.y);
        marks.fillStyle(lane.color, 1);
        marks.fillCircle(point.x, point.y, 7);
      }
    }

    if (!archer.present || !archer.grip) return;
    if (archer.phase !== 'nock' && archer.phase !== 'draw') return;

    const centre = this.facePoint(lane, archer.aim.x, archer.aim.y);
    // The same radius the shake will cost at the loose, not a display number of
    // its own: a circle that disagrees with the score teaches nothing.
    const sight = Math.max(6, aimRadius(archer, this.state.config) * (lane.radius / TARGET_RADIUS));
    marks.lineStyle(3, lane.color, 0.9);
    marks.strokeCircle(centre.x, centre.y, sight);
    marks.lineBetween(centre.x - sight - 10, centre.y, centre.x + sight + 10, centre.y);
    marks.lineBetween(centre.x, centre.y - sight - 10, centre.x, centre.y + sight + 10);
  }

  /**
   * The shake curve of the hold: |omega| against time, with the mean and the
   * moment the string went.
   *
   * The trace grows while the archer holds and freezes on the shot, so the
   * curve is being drawn as the hand is doing it rather than only afterwards.
   */
  private drawGraph(archer: Archer, lane: Lane): void {
    const { graph } = lane;
    graph.clear();

    const trace = this.shownTrace(archer);
    const left = -lane.graphWidth / 2;
    const bottom = GRAPH_TOP + GRAPH_HEIGHT;

    graph.fillStyle(0x171b24, 1);
    graph.fillRect(left, GRAPH_TOP, lane.graphWidth, GRAPH_HEIGHT);
    graph.lineStyle(2, 0x232838, 1);
    graph.strokeRect(left, GRAPH_TOP, lane.graphWidth, GRAPH_HEIGHT);

    if (trace.length === 0) {
      lane.graphText.setText('당기면 흔들림 곡선이 그려집니다');
      return;
    }

    const spanMs = Math.max(GRAPH_MIN_SPAN_MS, trace[trace.length - 1]?.atMs ?? 0);
    const peak = Math.max(GRAPH_MIN_PEAK, ...trace.map((sample) => sample.rate));
    const xFor = (atMs: number): number => left + (atMs / spanMs) * lane.graphWidth;
    const yFor = (rate: number): number => bottom - (Math.min(rate, peak) / peak) * GRAPH_HEIGHT;

    const shot = archer.phase === 'draw' ? null : archer.lastShot;
    if (shot && shot.meanWobble > 0) {
      graph.lineStyle(2, 0x98a0b3, 0.8);
      graph.lineBetween(left, yFor(shot.meanWobble), left + lane.graphWidth, yFor(shot.meanWobble));
    }

    graph.lineStyle(3, lane.color, 1);
    graph.beginPath();
    trace.forEach((sample, index) => {
      const x = xFor(sample.atMs);
      const y = yFor(sample.rate);
      if (index === 0) graph.moveTo(x, y);
      else graph.lineTo(x, y);
    });
    graph.strokePath();

    const last = trace[trace.length - 1];
    if (shot && last) {
      graph.lineStyle(3, 0xffa502, 1);
      graph.lineBetween(xFor(last.atMs), GRAPH_TOP, xFor(last.atMs), bottom);
    }

    // The playhead ties the curve to the aim path on the face above it: the
    // bump in the line and the lurch in the crosshair are the same instant.
    if (shot) {
      const headMs = this.replayMs(archer, trace);
      graph.lineStyle(2, 0xf1f3f8, 0.6);
      graph.lineBetween(xFor(headMs), GRAPH_TOP, xFor(headMs), bottom);
    }

    lane.graphText.setText(
      `|ω| 0–${peak.toFixed(0)}°/s · 0–${(spanMs / 1000).toFixed(1)}초` +
        (shot ? `\n평균 ${shot.meanWobble.toFixed(1)}°/s (가로선) · 세로선이 놓은 지점` : ''),
    );
  }

  /** The hold being drawn now, or the one the last arrow was shot from. */
  private shownTrace(archer: Archer): readonly ArcheryTraceSample[] {
    if (archer.phase === 'draw') return archer.trace;
    return archer.lastShot?.trace ?? [];
  }

  /** Where the slow replay has got to, looping so a fault can be watched twice. */
  private replayMs(archer: Archer, trace: readonly ArcheryTraceSample[]): number {
    const span = trace[trace.length - 1]?.atMs ?? 0;
    if (span <= 0) return 0;
    return ((this.replaySeconds.get(archer.id) ?? 0) * 1000 * REPLAY_SPEED) % span;
  }

  /**
   * Aim units to pixels on this lane's face.
   *
   * Clamped well outside the face but inside the column: a phone pointed at the
   * ceiling reads 1.4 aim units, which unclamped would draw a crosshair over
   * the neighbouring archer's target.
   */
  private facePoint(lane: Lane, x: number, y: number): { x: number; y: number } {
    const scale = lane.radius / TARGET_RADIUS;
    const limit = lane.radius * 1.5;
    return { x: clampAbs(x * scale, limit), y: FACE_Y + clampAbs(y * scale, limit) };
  }

  /** What the game is waiting for, in one line, always. */
  private statusLine(): string {
    if (this.state.archers.length === 0) return '폰을 연결하세요 (?fake=1 로 키보드 사용)';
    if (this.state.phase === 'over') return '경기 종료 — 10초 뒤 로비 (HOME: 지금)';
    if (this.state.phase === 'end_break') {
      return `${this.state.end}엔드 종료 — ${Math.max(0, this.state.breakTimer).toFixed(1)}초 뒤 다음 엔드`;
    }
    return this.state.archers.map((archer) => this.archerWaitLine(archer)).join('   ·   ');
  }

  private archerWaitLine(archer: Archer): string {
    const name = this.lanes.get(archer.id)?.name ?? `P${archer.id}`;
    if (!archer.present) return `${name} 연결 대기`;
    switch (archer.phase) {
      case 'nock':
        if (!archer.nocked) return `${name} 멈춰 잡기 대기`;
        return `${name} TRIGGER 당기기`;
      case 'draw':
        return `${name} 당기는 중 — 놓으면 발사`;
      case 'score':
        return `${name} ${archer.lastShot?.ring ?? 0}점`;
      default:
        return `${name} 엔드 종료`;
    }
  }

  /**
   * The big label, for the two things that stop the game: a phone that is not
   * answering, and a phone that has never given the game a grip to measure
   * against. Both are waits, not failures — the card and the grip survive.
   */
  private renderWaiting(): void {
    if (this.state.phase === 'over') {
      this.showWaiting(null);
      return;
    }
    if (this.state.archers.length === 0) {
      this.showWaiting('폰을 연결하세요\n연결되면 바로 시작합니다');
      return;
    }

    const lines: string[] = [];
    for (const archer of this.state.archers) {
      const name = this.lanes.get(archer.id)?.name ?? `P${archer.id}`;
      if (!archer.present) {
        lines.push(`${name} 폰 연결 대기 중 — 점수와 기준 자세는 그대로입니다`);
        continue;
      }
      if (archer.grip) continue;
      lines.push(
        archer.gripRejected
          ? `${name}: 폰을 세워서 잡으세요 — 오른쪽 모서리가 아래를 보면 앙각을 못 읽습니다`
          : `${name}: 활을 든 자세로 ${this.state.config.nockStillSeconds.toFixed(1)}초만 멈추세요 (그 자세가 기준이 됩니다)`,
      );
    }

    this.showWaiting(lines.length === 0 ? null : lines.join('\n'));
  }

  private renderBanner(): void {
    if (this.state.phase === 'end_break') {
      const line = this.state.archers
        .map(
          (archer) =>
            `${this.lanes.get(archer.id)?.name ?? `P${archer.id}`} ` +
            `${endTotal(archer, this.state.end)}점`,
        )
        .join('   ');
      this.bannerText.setText(`${this.state.end}엔드 종료\n${line}`).setVisible(true);
      return;
    }
    if (this.state.phase !== 'over') {
      this.bannerText.setVisible(false);
      return;
    }

    const [best, second] = standings(this.state);
    if (!best) {
      this.bannerText.setText('경기 종료').setVisible(true);
      return;
    }
    const name = this.lanes.get(best.id)?.name ?? `P${best.id}`;
    const perfect = maxScore(this.state.config);
    // One archer has nobody to beat, and a draw is not a win. Announcing one
    // anyway is how a match ends with the wrong name on the screen.
    const headline =
      second === undefined
        ? `${totalScore(best)} / ${perfect}점`
        : totalScore(second) === totalScore(best)
          ? `동점 — ${totalScore(best)} / ${perfect}점`
          : `${name} 우승 — ${totalScore(best)} / ${perfect}점`;
    this.bannerText.setText(`경기 종료\n${headline}`).setVisible(true);
  }
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function clampAbs(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/** The sample nearest a point in the hold, for the replay head. */
function traceAt(
  trace: readonly ArcheryTraceSample[],
  atMs: number,
): ArcheryTraceSample | undefined {
  let found = trace[0];
  for (const sample of trace) {
    if (sample.atMs > atMs) break;
    found = sample;
  }
  return found;
}
