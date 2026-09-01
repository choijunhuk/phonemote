import type Phaser from 'phaser';
import { session } from '../../session.js';
import { BaseGameScene } from './BaseGameScene.js';
import type { GameAction } from '../../input/types.js';
import { sfx } from '../../ui/audio.js';
import { seatOf } from './seats.js';
import {
  GUTTER_LEFT,
  GUTTER_RIGHT,
  MAX_SPEED,
  MIN_SPEED,
  PIN_COUNT,
  PIN_SPACING,
  PIN_SPOTS,
  canThrow,
  createBowling,
  currentDrill,
  findPlayer,
  leader,
  pressTrigger,
  readPose,
  readStillness,
  readSwing,
  release,
  standings,
  stepBowling,
  syncPlayers,
  upNext,
  type BowlingEvent,
  type BowlingPlayer,
  type BowlingState,
  type Trace,
} from './bowlingState.js';

/**
 * Bowling: the wrist picks the stance, the trigger going up rolls the ball.
 *
 * Every rule is in bowlingState.ts. This draws what that module holds and turns
 * the events it returns into sound and vibration; it decides nothing about
 * pins, frames or turns (ARCHITECTURE.md 8), and it never sees a sensor frame
 * (P4).
 *
 * One lane per player, side by side, because practice is up to four people
 * rolling at once. The turn-based modes keep the same layout and dim the lanes
 * that are not on turn — a player who watched their own lane vanish when the
 * turn moved had no way to see the frame they had just thrown.
 */

/** How far up the lane the drawing goes: the back row, plus a pin's room past it. */
const LANE_END = PIN_SPOTS.reduce((far, spot) => Math.max(far, spot.y), 0) + PIN_SPACING;

/** Widest a lane column gets. Beyond this a single player's lane is a corridor. */
const COLUMN_MAX = 320;

const LANE_TOP = 96;
/** The practice screen gives the bottom of the screen to the numbers. */
const LANE_BOTTOM_PRACTICE = 400;
const LANE_BOTTOM_SCORED = 520;

const TEXT_LINE = 24;

/** Where a one-off message sits: on the lane, clear of the pins and the numbers. */
const FLASH_Y = 210;

interface Lane {
  readonly container: Phaser.GameObjects.Container;
  readonly panel: Phaser.GameObjects.Rectangle;
  readonly pins: readonly Phaser.GameObjects.Arc[];
  readonly ball: Phaser.GameObjects.Arc;
  readonly marks: Phaser.GameObjects.Graphics;
  readonly statusText: Phaser.GameObjects.Text;
  readonly scoreText: Phaser.GameObjects.Text;
  readonly readingText: Phaser.GameObjects.Text;
  readonly color: number;
  readonly width: number;
  readonly height: number;
}

export class Bowling extends BaseGameScene {
  private state!: BowlingState;
  private readonly lanes = new Map<number, Lane>();
  private modeText!: Phaser.GameObjects.Text;
  private standingsText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private flashText!: Phaser.GameObjects.Text;
  /** Who was last told their grip was too flat, so the reason stays on screen. */
  private flatRefused: number | null = null;

  constructor() {
    super('bowling');
  }

  protected build(): void {
    const { width } = this.scale;

    // Phaser hands back the same instance on a restart, so a state left in a
    // field would start the second match on the first one's tenth frame.
    this.state = createBowling(
      this.mode,
      session.presentPlayers.map((player) => player.id),
    );
    this.lanes.clear();
    this.flatRefused = null;

    this.modeText = this.add
      .text(18, 12, this.modeLine(), {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: '#c3c9d6',
      })
      .setOrigin(0, 0);

    // The column headings live once at the top rather than over every lane:
    // four copies of them cost the room four lanes' worth of width.
    this.add
      .text(18, 42, '읽은 값:  각도(°)  릴리스 속도(°/s)  훅(-1~+1)  쓰러진 핀  ·  T 트리거 · S 스윙 · * 약함 · G 거터', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '22px',
        color: '#98a0b3',
      })
      .setOrigin(0, 0)
      .setVisible(this.state.config.diagnostics);

    this.standingsText = this.add
      .text(width - 18, 12, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '24px',
        color: '#f1f3f8',
      })
      .setOrigin(1, 0)
      .setVisible(this.state.config.frames > 0);

    // One line that always says what the game is waiting for. Without it a
    // screen full of still lanes says nothing about whose move it is.
    this.hintText = this.add
      .text(width / 2, this.scale.height - 14, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#c3c9d6',
        align: 'center',
      })
      .setOrigin(0.5, 1);

    // Over the lane it belongs to, because with four lanes a message in the
    // middle of the screen belongs to nobody.
    this.flashText = this.add
      .text(width / 2, FLASH_Y, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        color: '#ffa502',
        align: 'center',
        backgroundColor: '#0f1116',
        padding: { x: 10, y: 6 },
      })
      .setOrigin(0.5)
      .setDepth(900)
      .setAlpha(0);

    this.onCleanup(session.onPlayersChanged(() => this.rebuildLanes()));
  }

  protected override onGameAction(action: GameAction): void {
    switch (action.kind) {
      case 'pose':
        // Gravity, not angles: the stance is read off `up` so that a phone held
        // near vertical does not swing the reading by 1/cos(pitch).
        readPose(this.state, action.playerId, action.up);
        return;
      case 'stillness':
        this.play(readStillness(this.state, action.playerId, action, this.time.now));
        return;
      case 'release':
        this.play(release(this.state, action.playerId, action.rate, action.rotation));
        return;
      case 'swing':
        // The fallback for a player who never touches the trigger. The pairing
        // of backswing and delivery is the module's rule, not this scene's.
        this.play(
          readSwing(this.state, action.playerId, action.peakRate, action.rotation, this.time.now),
        );
        return;
      case 'button_down':
        this.pressButton(action.playerId, action.button);
        return;
      default:
        return;
    }
  }

  protected override teardown(): void {
    // The map held destroyed containers into the next run, which then drew the
    // new match's balls onto objects that no longer existed.
    this.lanes.clear();
  }

  protected step(dt: number): void {
    this.play(stepBowling(this.state, dt, this.time.now));
    this.render();
    if (this.state.over) this.returnToLobbyAfter(12);
  }

  private pressButton(playerId: number, button: string): void {
    if (button === 'A' && this.state.over) {
      // Restarting without the mode would drop a versus match into practice,
      // because init() defaults anything it does not recognise.
      this.scene.restart({ mode: this.mode });
      return;
    }
    if (button !== 'TRIGGER') return;
    if (!canThrow(this.state, playerId)) {
      // A press that the rules refuse must not be silence: silence is what a
      // game that never saw the phone looks like.
      session.vibrate(playerId, [25, 60, 25]);
      session.log(`트리거 무시 P${playerId} (${this.refusalReason(playerId)})`);
      return;
    }
    this.play(pressTrigger(this.state, playerId));
  }

  private refusalReason(playerId: number): string {
    const player = findPlayer(this.state, playerId);
    if (!player) return '이 판에 없음';
    if (this.state.over) return '경기 종료';
    if (player.phase === 'grip') return '그립 설정 전';
    if (player.phase === 'done') return '다 던짐';
    if (this.state.config.turnBased && seatOf(this.state.seats, playerId) === null) {
      return '자리 없음, 다음 판부터';
    }
    return '자기 차례 아님';
  }

  /** Sound and vibration, which are the only things the rules cannot do. */
  private play(events: readonly BowlingEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'grip_set':
          this.flatRefused = null;
          sfx.tick();
          session.vibrate(event.playerId, [40]);
          session.log(`그립 P${event.playerId} 품질 ${event.quality.toFixed(2)}`);
          break;
        case 'grip_refused':
          this.flatRefused = event.playerId;
          sfx.whiff();
          // Pulses under 25 ms never survive an Android motor's spin-up, so a
          // refusal felt exactly like a phone that was not listening.
          session.vibrate(event.playerId, [25, 60, 25]);
          break;
        case 'armed':
          sfx.tick();
          session.vibrate(event.playerId, [30]);
          break;
        case 'released':
          this.playRelease(event.playerId, event.weak);
          // The design's rule, kept: a delivery too slow to read still rolls,
          // and the screen says so rather than looking like nothing happened.
          if (event.weak) this.flash(event.playerId, '약하게 굴렸습니다 — 최저 속도', '#ffa502');
          break;
        case 'gutter':
          // Its own low sound rather than a second whiff: the pins event that
          // follows it reports zero, and two failure noises on top of each
          // other read as one thing going wrong twice.
          sfx.wall();
          session.vibrate(event.playerId, [30, 60, 30]);
          this.flash(event.playerId, '거터', '#ff4757');
          session.log(`거터 P${event.playerId}`);
          break;
        case 'pins':
          if (event.down > 0) {
            sfx.hit(event.down / PIN_COUNT);
            session.vibrate(event.playerId, [Math.round(30 + event.down * 7)]);
          } else {
            sfx.whiff();
          }
          session.log(`P${event.playerId} ${event.down}핀, ${event.standing}개 남음`);
          break;
        case 'strike':
          sfx.win();
          session.vibrate(event.playerId, [60, 40, 60, 40, 120]);
          this.flash(event.playerId, '스트라이크', '#2ed573');
          break;
        case 'spare':
          sfx.point();
          session.vibrate(event.playerId, [40, 50, 90]);
          this.flash(event.playerId, '스페어', '#2ed573');
          break;
        case 'frame':
          sfx.tick();
          session.log(`P${event.playerId} ${event.frame}프레임 종료, 합계 ${event.score}`);
          break;
        case 'drill_cleared':
          sfx.point();
          session.vibrate(event.playerId, [40, 60, 40]);
          this.flash(event.playerId, `성공 ${event.clears}/${this.state.config.drillClears}`, '#2ed573');
          session.log(`P${event.playerId} ${event.drill} 성공 ${event.clears}회`);
          break;
        case 'drill_next':
          sfx.tick();
          session.log(`P${event.playerId} 다음 드릴 ${event.drill ?? '없음, 종료'}`);
          break;
        case 'turn':
          sfx.tick();
          // The player whose turn it now is may well be looking at their phone
          // rather than at the television across the room.
          session.vibrate(event.playerId, [60]);
          break;
        case 'timed_out':
          sfx.whiff();
          session.vibrate(event.playerId, [200]);
          this.flash(event.playerId, '시간 초과 — 다음 사람', '#ffa502');
          session.log(`P${event.playerId} 시간 초과, 다음 사람`);
          break;
        default:
          sfx.win();
          session.log('경기 종료');
          break;
      }
    }
  }

  /** One message, on one player's lane, gone again a second later. */
  private flash(playerId: number, text: string, color: string): void {
    const lane = this.lanes.get(playerId);
    if (!lane) return;
    this.flashText.setPosition(lane.container.x, FLASH_Y);
    this.flashText.setText(text).setColor(color).setAlpha(1);
    this.tweens.killTweensOf(this.flashText);
    this.tweens.add({ targets: this.flashText, alpha: 0, duration: 700, delay: 900 });
  }

  /**
   * How hard the ball was rolled, read back off the throw the rules recorded
   * rather than recomputed here from the rate.
   */
  private playRelease(playerId: number, weak: boolean): void {
    const reading = findPlayer(this.state, playerId)?.lastThrow;
    const power = reading ? (reading.speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED) : 0;
    sfx.hit(power);
    session.vibrate(playerId, [Math.round(30 + power * 70)]);
    if (!reading) return;
    session.log(
      `릴리스 P${playerId} ${Math.round(reading.rate)}°/s 훅 ${reading.hook.toFixed(2)}` +
        `${weak ? ' (약함)' : ''}`,
    );
  }

  /**
   * Lanes follow the roster.
   *
   * The state keeps everybody it has ever seen, so a phone that dropped keeps
   * its lane, its frames and its score; a phone that joins mid-match gets a
   * lane and is told on it that it plays from the next match.
   */
  private rebuildLanes(): void {
    const present = session.presentPlayers.map((player) => player.id);
    // Nobody was connected when this scene started, so there is no match yet to
    // protect: seating the first phones that arrive beats a versus screen whose
    // seats are empty and whose turn can never come round.
    if (this.state.seats.length === 0 && present.length > 0) {
      this.state = createBowling(this.mode, present);
    }
    this.play(
      syncPlayers(
        this.state,
        session.players.map((player) => ({ id: player.id, present: player.present })),
      ),
    );

    for (const lane of this.lanes.values()) lane.container.destroy();
    this.lanes.clear();

    const { width } = this.scale;
    const laneBottom = this.state.config.diagnostics ? LANE_BOTTOM_PRACTICE : LANE_BOTTOM_SCORED;
    const count = Math.max(1, this.state.players.length);
    const columnWidth = Math.min(COLUMN_MAX, width / count);
    const left = (width - columnWidth * count) / 2;

    this.state.players.forEach((player, index) => {
      const centre = left + columnWidth * (index + 0.5);
      this.lanes.set(player.id, this.buildLane(player, centre, laneBottom, columnWidth));
    });
    this.modeText.setText(this.modeLine());
  }

  private buildLane(
    player: BowlingPlayer,
    centre: number,
    bottom: number,
    columnWidth: number,
  ): Lane {
    const info = session.players.find((entry) => entry.id === player.id);
    const colorHex = info?.color ?? '#98a0b3';
    const color = Number(`0x${colorHex.slice(1)}`);
    const laneWidth = columnWidth - 60;
    const laneHeight = bottom - LANE_TOP;
    const perUnit = laneHeight / LANE_END;

    const panel = this.add
      .rectangle(0, -laneHeight / 2, laneWidth, laneHeight, 0x2a2113)
      .setStrokeStyle(3, color);
    const gutters = [
      { from: 0, to: GUTTER_LEFT },
      { from: GUTTER_RIGHT, to: 1 },
    ].map((strip) =>
      this.add.rectangle(
        ((strip.from + strip.to) / 2 - 0.5) * laneWidth,
        -laneHeight / 2,
        (strip.to - strip.from) * laneWidth,
        laneHeight,
        0x0f1116,
      ),
    );
    const foul = this.add.rectangle(0, -2, laneWidth, 4, 0xf1f3f8).setAlpha(0.6);

    const pins = PIN_SPOTS.map((spot) =>
      this.add.circle((spot.x - 0.5) * laneWidth, -spot.y * perUnit, 7, 0xf1f3f8),
    );
    const marks = this.add.graphics();
    const ball = this.add.circle(0, 0, 9, color).setVisible(false);

    const nameText = this.add
      .text(0, 14, info?.name ?? `P${player.id}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: colorHex,
      })
      .setOrigin(0.5, 0);
    const statusText = this.add
      .text(0, 44, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '22px',
        color: '#c3c9d6',
        align: 'center',
      })
      .setOrigin(0.5, 0);
    const scoreText = this.add
      .text(0, 76, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '30px',
        color: '#f1f3f8',
      })
      .setOrigin(0.5, 0);
    // The practice numbers sit under their own lane, so four people can each
    // read their own delivery without working out which column is theirs.
    const readingText = this.add
      .text(0, 104, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '22px',
        color: '#98a0b3',
        align: 'center',
        lineSpacing: TEXT_LINE - 22,
      })
      .setOrigin(0.5, 0)
      .setVisible(this.state.config.diagnostics);

    const container = this.add.container(centre, bottom, [
      panel,
      ...gutters,
      foul,
      marks,
      ...pins,
      ball,
      nameText,
      statusText,
      scoreText,
      readingText,
    ]);
    if (this.state.config.diagnostics) scoreText.setVisible(false);

    return {
      container,
      panel,
      pins,
      ball,
      marks,
      statusText,
      scoreText,
      readingText,
      color,
      width: laneWidth,
      height: laneHeight,
    };
  }

  private render(): void {
    for (const player of this.state.players) {
      const lane = this.lanes.get(player.id);
      if (lane) this.renderLane(player, lane);
    }

    this.standingsText.setText(this.standingsLine());
    this.hintText.setText(this.hintLine());
    this.showWaiting(this.waitingMessage());

    const phases = this.state.players.map((player) => `P${player.id} ${player.phase}`).join(' ');
    session.status =
      `bowling ${this.state.config.mode}${this.state.over ? ' 종료' : ''}  ` +
      `${phases}  ${this.state.turn ? `차례 P${this.state.turn.seats[this.state.turn.index] ?? '-'}` : '동시'}`;
  }

  private renderLane(player: BowlingPlayer, lane: Lane): void {
    const perUnit = lane.height / LANE_END;
    const onTurn = canThrow(this.state, player.id);

    // Never colour alone: the lane on turn is brighter, wider-bordered and says
    // so in words on its own status line.
    lane.container.setAlpha(player.present ? 1 : 0.45);
    lane.panel.setStrokeStyle(onTurn ? 6 : 3, lane.color);

    for (let pin = 0; pin < lane.pins.length; pin++) {
      const mark = lane.pins[pin];
      if (!mark) continue;
      const standing = player.pins[pin] === true;
      mark.setRadius(standing ? 7 : 4);
      mark.setFillStyle(standing ? 0xf1f3f8 : 0x39405a);
      mark.setAlpha(standing ? 1 : 0.55);
    }

    const ball = player.ball;
    lane.ball.setVisible(ball !== null);
    if (ball) lane.ball.setPosition((ball.x - 0.5) * lane.width, -ball.y * perUnit);

    lane.marks.clear();
    this.drawStance(player, lane, perUnit);
    // Newest first, so the freshest throw is the brightest line on the lane.
    player.traces.forEach((trace, index) => {
      const alpha = Math.max(0.18, 0.85 - index * 0.16);
      this.drawPath(lane, trace.path, trace.gutter ? 0xff4757 : 0xffffff, alpha, 2, perUnit);
    });
    if (player.phase === 'roll') {
      this.drawPath(lane, player.path, lane.color, 0.9, 4, perUnit);
    }

    lane.statusText.setText(this.laneStatus(player, onTurn));
    if (this.state.config.diagnostics) lane.readingText.setText(this.readingBlock(player));
    else lane.scoreText.setText(`합계 ${player.score}`);
  }

  /** Where this player is standing, and the straight line out of that stance. */
  private drawStance(player: BowlingPlayer, lane: Lane, perUnit: number): void {
    if (player.phase !== 'aim' && player.phase !== 'armed') return;
    const x = (player.standX - 0.5) * lane.width;
    lane.marks.fillStyle(lane.color, 1);
    // On the lane rather than below the foul line, where the player's name is.
    lane.marks.fillRect(x - 8, -14, 16, 12);
    lane.marks.lineStyle(2, lane.color, player.phase === 'armed' ? 0.85 : 0.4);
    lane.marks.beginPath();
    lane.marks.moveTo(x, 0);
    lane.marks.lineTo(x, -0.45 * perUnit);
    lane.marks.strokePath();
  }

  private drawPath(
    lane: Lane,
    path: ReadonlyArray<{ readonly x: number; readonly y: number }>,
    color: number,
    alpha: number,
    thickness: number,
    perUnit: number,
  ): void {
    if (path.length < 2) return;
    lane.marks.lineStyle(thickness, color, alpha);
    lane.marks.beginPath();
    path.forEach((point, index) => {
      const x = (point.x - 0.5) * lane.width;
      const y = -point.y * perUnit;
      if (index === 0) lane.marks.moveTo(x, y);
      else lane.marks.lineTo(x, y);
    });
    lane.marks.strokePath();
  }

  private laneStatus(player: BowlingPlayer, onTurn: boolean): string {
    if (!player.present) return '연결 끊김 — 기록 보존';
    if (this.state.config.turnBased && seatOf(this.state.seats, player.id) === null) {
      return '관전 — 다음 판부터';
    }
    if (this.state.config.diagnostics) {
      const drill = currentDrill(this.state, player);
      if (!drill) return '드릴 끝';
      return (
        `${drill.label}  성공 ${player.drillClears}/${this.state.config.drillClears}\n` +
        `시도 ${player.drillAttempts}/${this.state.config.drillAttempts}`
      );
    }
    if (player.phase === 'done') return '10프레임 종료';
    const next = upNext(player);
    return `${next.frame}프레임 ${next.ball}구${onTurn ? '  ◀ 차례' : ''}`;
  }

  /**
   * The practice screen's whole point: the numbers this player's own movement
   * produced, next to the path it produced them on. Somebody who cannot see
   * what their delivery measured cannot tell a bad ball from one the game never
   * saw, which is the complaint this project hears most.
   */
  private readingBlock(player: BowlingPlayer): string {
    const lines = [
      `각도 ${player.aimDeg.toFixed(1)}°  자리 ${player.standX.toFixed(2)}`,
      `그립 품질 ${player.gripQuality.toFixed(2)}`,
    ];
    if (player.traces.length === 0) {
      lines.push('', '아직 굴린 공 없음');
      return lines.join('\n');
    }
    for (const trace of player.traces) lines.push(this.traceLine(trace));
    return lines.join('\n');
  }

  /** Fixed columns, in the order the legend at the top of the screen names. */
  private traceLine(trace: Trace): string {
    const aim = trace.aimDeg.toFixed(1).padStart(5);
    const rate = Math.round(trace.rate).toString().padStart(4);
    const hook = `${trace.hook >= 0 ? '+' : ''}${trace.hook.toFixed(2)}`;
    const pins = (trace.gutter ? 'G' : String(trace.pinsDown)).padStart(2);
    const source = trace.source === 'release' ? 'T' : 'S';
    return `${aim} ${rate} ${hook} ${pins} ${source}${trace.weak ? '*' : ''}`;
  }

  private modeLine(): string {
    const phones = `폰 ${session.presentPlayers.length}대`;
    switch (this.state.config.mode) {
      case 'solo':
        return `혼자 — 10프레임 정식 스코어링 (${phones})`;
      case 'versus':
        return `대전 — 한 프레임씩 돌아가며, ${this.state.config.turnSeconds}초 제한 (${phones})`;
      default:
        return `연습 — 스페어 드릴, 각자 자기 레인 (${phones})`;
    }
  }

  private standingsLine(): string {
    const ranked = standings(this.state);
    if (ranked.length === 0) return '';
    const best = leader(this.state);
    return ranked
      .map((player) => `${player === best ? '선두 ' : ''}P${player.id} ${player.score}`)
      .join('  ·  ');
  }

  /**
   * What the game is waiting for, in one line, always.
   *
   * In the turn-based modes that is one player; in practice every lane is its
   * own answer, so it lists them.
   */
  private hintLine(): string {
    if (this.state.players.length === 0) return 'HOME 또는 ESC: 로비';
    if (this.state.over) {
      const best = leader(this.state);
      const result = best ? `P${best.id} ${best.score}점` : '기록 없음';
      return `경기 종료 — ${result}   ·   A: 다시   ·   12초 뒤 로비`;
    }

    if (this.state.turn) {
      const onTurn = this.state.turn.seats[this.state.turn.index];
      const player = onTurn === undefined ? undefined : findPlayer(this.state, onTurn);
      if (!player) return '차례를 받을 폰을 기다리는 중';
      const left = Math.max(0, this.state.config.turnSeconds - this.state.turn.elapsed);
      return `${this.phaseLine(player)}   ·   남은 시간 ${Math.ceil(left)}초`;
    }

    // Four full sentences do not fit across one screen, so the practice line
    // names the state of every lane and says how to throw once, at the end.
    const busy = this.state.players
      .filter((player) => player.phase !== 'done')
      .map((player) => this.phaseTag(player));
    if (busy.length === 0) return '연습 종료 — 12초 뒤 로비';
    return `${busy.join('  ·  ')}   ·   트리거를 놓는 순간 굴러갑니다`;
  }

  /** The same states in one or two words, for the line that lists every lane. */
  private phaseTag(player: BowlingPlayer): string {
    if (!player.present) return `P${player.id} 연결 대기`;
    switch (player.phase) {
      case 'grip':
        return `P${player.id} 그립`;
      case 'aim':
        return `P${player.id} 조준`;
      case 'armed':
        return `P${player.id} 백스윙`;
      case 'roll':
        return `P${player.id} 굴러감`;
      case 'pins':
        return `P${player.id} 핀 정리`;
      default:
        return `P${player.id} 종료`;
    }
  }

  private phaseLine(player: BowlingPlayer): string {
    if (!player.present) return `P${player.id} 연결 대기`;
    switch (player.phase) {
      case 'grip':
        return `P${player.id} 그립 대기`;
      case 'aim':
        return `P${player.id} 조준 — 트리거를 당겨 백스윙`;
      case 'armed':
        return `P${player.id} 백스윙 — 굴리면서 트리거를 놓기`;
      case 'roll':
        return `P${player.id} 굴러가는 중`;
      case 'pins':
        return `P${player.id} 핀 정리 중`;
      default:
        return `P${player.id} 종료`;
    }
  }

  /**
   * The overlay, for the two things that are not the game being slow: a phone
   * that is not answering, and a phone that has not said how it is being held.
   */
  private waitingMessage(): string | null {
    if (session.players.length === 0) {
      return '폰을 연결하세요\n(?fake=1 로 키보드 사용)';
    }
    // Only phones still inside their rejoin window. A player the session has
    // given up on keeps their lane and their score, but leaving "waiting for
    // P2" across the middle of the screen for the rest of the match is the
    // frozen game this overlay exists to rule out.
    const absent = this.state.players.filter(
      (player) => !player.present && session.players.some((entry) => entry.id === player.id),
    );
    if (absent.length > 0) {
      const who = absent.map((player) => `P${player.id}`).join(', ');
      return `${who} 연결 대기 중\n점수와 프레임은 그대로 있습니다`;
    }
    if (this.flatRefused !== null) {
      return (
        `P${this.flatRefused}: 폰을 세워서 잡으세요\n` +
        '눕혀 잡으면 손목을 틀어도 자리가 움직이지 않습니다'
      );
    }
    const gripping = this.state.players.filter((player) => player.phase === 'grip');
    if (gripping.length > 0) {
      const who = gripping.map((player) => `P${player.id}`).join(', ');
      return (
        `${who}: 던질 자세로 폰을 들고 잠깐 멈추세요\n` +
        `그 자세가 기준이 됩니다 (${this.state.config.autoGripSeconds}초 뒤 자동)`
      );
    }
    return null;
  }
}
