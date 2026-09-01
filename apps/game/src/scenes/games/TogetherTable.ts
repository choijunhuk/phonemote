import type Phaser from 'phaser';
import { session } from '../../session.js';
import { BaseGameScene } from './BaseGameScene.js';
import type { GameAction } from '../../input/types.js';
import { sfx } from '../../ui/audio.js';
import { playerAt } from './seats.js';
import {
  ABANDON_SECONDS,
  AUTO_GRIP_SECONDS,
  BALL_RADIUS,
  MAX_TILT_DEG,
  biasDeg,
  createTable,
  drivingPlayers,
  leader,
  medalFor,
  readPose,
  readStillness,
  regrip,
  ringHold,
  ringRms,
  stepTable,
  syncPlayers,
  wobbleRms,
  type TableEvent,
  type TablePlayer,
  type TableState,
} from './tableState.js';

/**
 * Together Table: one board, tilted by everybody at once.
 *
 * The rules are in tableState.ts and this scene owns none of them. It draws the
 * state, turns the events the module returns into sound and vibration, and does
 * the one thing the rules cannot: it shows each hand its own numbers, because
 * the mean is a structure where a single drifting grip biases the board for
 * everyone and nothing else on screen would ever say whose it was.
 *
 * It reads `pose` and `stillness` and no other action, which is the whole
 * sensor story (ARCHITECTURE.md P4).
 */

const SANS = 'system-ui, sans-serif';
const MONO = 'ui-monospace, monospace';

const OUT_OF_PLAY = 0x090b11;
const PLATE = 0x141a26;
const EDGE = 0x39435a;
const GRID = 0x1f2635;
const WALL = 0x4d5871;
const GOAL = 0x2ed573;
const TRAP = 0xff4757;
const BALL = 0xf1f3f8;
const MEAN = 0xffffff;
/** A hand whose frames stopped: its lean is held, and held is not driving. */
const STALLED = 0x6a7385;

/**
 * The gained degrees that draw a full-length arrow.
 *
 * Gain is the mode's (10 in practice, 3 elsewhere), so this one number has to
 * work for both: at 3 it puts the 25 degree clamp just past full length, and at
 * 10 it makes the 1 degree a steady hand actually holds a 36 px arrow on a
 * board 490 px across instead of the 4 px it is worth life size.
 */
const ARROW_FULL_DEG = 60;

/** Shorter than this the head swallows the shaft and the arrow reads as a dot. */
const ARROW_MIN_PX = 6;

/** Two rail knocks inside this are one knock; the ball can hit a corner twice. */
const RIM_GAP_MS = 90;

interface Card {
  readonly container: Phaser.GameObjects.Container;
  readonly nameText: Phaser.GameObjects.Text;
  readonly detailText: Phaser.GameObjects.Text;
  readonly panel: Phaser.GameObjects.Rectangle;
  readonly color: string;
}

export class TogetherTable extends BaseGameScene {
  private state!: TableState;
  private board!: Phaser.GameObjects.Graphics;
  private titleText!: Phaser.GameObjects.Text;
  private courseText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private roomText!: Phaser.GameObjects.Text;
  private overText!: Phaser.GameObjects.Text;
  private flashText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private seatLabels: Phaser.GameObjects.Text[] = [];
  private readonly cards = new Map<number, Card>();
  private boardLeft = 0;
  private boardTop = 0;
  private boardSide = 0;
  private lastRimAt = 0;

  constructor() {
    super('together-table');
  }

  protected build(): void {
    const { width, height } = this.scale;

    // Phaser hands back the same instance on a restart, so a run's state is
    // built here and never in a field: the second match would otherwise open on
    // the first one's ball, its finished phase and its destroyed text objects.
    this.state = createTable(this.mode);
    this.cards.clear();
    this.lastRimAt = 0;

    // Square, because the rules are square: a stretched board would mean the
    // same lean rolls the ball further sideways than forwards.
    this.boardSide = Math.min(width * 0.55, height * 0.68);
    this.boardLeft = width * 0.04;
    this.boardTop = height * 0.2;

    this.board = this.add.graphics();

    this.titleText = this.add
      .text(this.boardLeft, height * 0.04, '', {
        fontFamily: SANS,
        fontSize: '30px',
        color: '#f1f3f8',
      })
      .setOrigin(0, 0);

    this.courseText = this.add
      .text(this.boardLeft, height * 0.12, '', {
        fontFamily: SANS,
        fontSize: '26px',
        color: '#c3c9d6',
      })
      .setOrigin(0, 0);

    this.clockText = this.add
      .text(this.boardLeft + this.boardSide, height * 0.12, '', {
        fontFamily: MONO,
        fontSize: '26px',
        color: '#c3c9d6',
      })
      .setOrigin(1, 0);

    // The line that always says what the game is waiting for. It sits under the
    // board rather than over it so it can be read while the ball is moving, and
    // wraps against the whole screen rather than the board, which kept pushing a
    // second line down into the hint.
    this.statusText = this.add
      .text(this.boardLeft, this.boardTop + this.boardSide + 14, '', {
        fontFamily: SANS,
        fontSize: '26px',
        color: '#ffa502',
        wordWrap: { width: width - this.boardLeft - 20 },
      })
      .setOrigin(0, 0);

    this.roomText = this.add
      .text(this.boardLeft + this.boardSide + 24, height * 0.04, '', {
        fontFamily: MONO,
        fontSize: '22px',
        color: '#98a0b3',
        lineSpacing: 4,
      })
      .setOrigin(0, 0);

    this.overText = this.add
      .text(this.boardLeft + this.boardSide / 2, this.boardTop + this.boardSide / 2, '', {
        fontFamily: SANS,
        fontSize: '40px',
        color: '#f1f3f8',
        align: 'center',
        backgroundColor: '#0f1116',
        padding: { x: 20, y: 14 },
      })
      .setOrigin(0.5)
      .setVisible(false);

    this.flashText = this.add
      .text(this.boardLeft + this.boardSide / 2, this.boardTop + this.boardSide * 0.18, '', {
        fontFamily: SANS,
        fontSize: '34px',
        color: '#ffa502',
      })
      .setOrigin(0.5)
      .setAlpha(0);

    this.hintText = this.add
      .text(this.boardLeft + this.boardSide + 24, height - 14, '', {
        fontFamily: SANS,
        fontSize: '22px',
        color: '#98a0b3',
      })
      .setOrigin(0, 1);

    // Four, which is the most seats a match can have; each one names the hole it
    // labels, so a goal is never told apart by colour alone.
    this.seatLabels = [0, 1, 2, 3].map(() =>
      this.add
        .text(0, 0, '', { fontFamily: SANS, fontSize: '22px', color: '#f1f3f8' })
        .setOrigin(0.5, 0)
        .setVisible(false),
    );

    this.onCleanup(session.onPlayersChanged(() => this.rebuildCards()));
  }

  protected override onGameAction(action: GameAction): void {
    if (action.kind === 'pose') {
      readPose(this.state, action.playerId, action.up, this.time.now);
      return;
    }
    if (action.kind === 'stillness') {
      readStillness(this.state, action.playerId, action.steadyMs, action.stalled);
      return;
    }
    if (action.kind !== 'button_down' || action.button !== 'A') return;

    if (this.state.phase === 'cleared' || this.state.phase === 'failed') {
      // With the mode spelled out: a bare restart hands init() no data, and a
      // versus match would come back as practice.
      this.scene.restart({ mode: this.mode });
      return;
    }

    // Re-levelling is A and not HOME. HOME leaves the game on every screen of
    // this console, and one game quietly meaning something else by it is how a
    // player across the room loses the only way out they can remember.
    regrip(this.state, action.playerId);
    session.vibrate(action.playerId, [30]);
    session.log(`기준 다시 P${action.playerId}`);
  }

  protected override teardown(): void {
    this.cards.clear();
    this.seatLabels = [];
  }

  protected step(dt: number): void {
    this.play(stepTable(this.state, dt, this.time.now));
    this.render();
    if (this.state.phase === 'cleared' || this.state.phase === 'failed') {
      this.returnToLobbyAfter(12);
    }
  }

  /**
   * Sound and vibration, which are the only two things the rules cannot do.
   *
   * Every one of these comes off an event the module returned. Deciding here
   * that a knock was hard enough to buzz, or that a hand was the roughest in the
   * room, would be a second set of rules quietly disagreeing with the first.
   */
  private play(events: readonly TableEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'grip':
          sfx.tick();
          session.vibrate(event.playerId, [30]);
          session.log(`기준 잡음 P${event.playerId}`);
          break;
        case 'joined':
          session.log(`합류 P${event.playerId}`);
          break;
        case 'left':
          // Not a failure and not silent: this hand has just stopped counting
          // towards the board, and the room can see the arrow shrink.
          session.log(`이탈 P${event.playerId}`);
          break;
        case 'rim':
          if (this.time.now - this.lastRimAt >= RIM_GAP_MS) {
            this.lastRimAt = this.time.now;
            // Terminal speed is about 1.1 boards a second, so that is where a
            // knock is as loud as it gets.
            sfx.hit(Math.min(1, event.speed / 1.1));
          }
          break;
        case 'goal':
          sfx.point();
          if (event.playerId !== null) {
            session.vibrate(event.playerId, [40, 60, 120]);
            this.showFlash(`${this.nameOf(event.playerId)} ${event.goals}골`, '#2ed573');
          }
          break;
        case 'trap':
          sfx.whiff();
          for (const player of drivingPlayers(this.state)) {
            session.vibrate(player.id, [25, 60, 25]);
          }
          this.showFlash('함정', '#ff4757');
          break;
        case 'collapse':
          sfx.whiff();
          this.cameras.main.shake(180, 0.008);
          // The long pulse goes to the hand the rules blamed. The point of the
          // hazard is that the room finds out who shoved the board, and the
          // person who did it is looking at their phone, not at the screen.
          if (event.playerId !== null) session.vibrate(event.playerId, [200]);
          this.vibrateRoom([25, 50, 25], event.playerId);
          this.showFlash(
            event.playerId === null
              ? `탑이 무너졌다 — 판 속도 ${event.rate.toFixed(0)}°/s`
              : `${this.nameOf(event.playerId)} 너무 급함 — ${event.rate.toFixed(0)}°/s`,
            '#ff4757',
          );
          break;
        case 'course':
          sfx.tick();
          this.showFlash(this.state.course.label, '#2ed573');
          session.log(`다음 코스 ${this.state.course.label}`);
          break;
        case 'cleared':
          sfx.win();
          this.vibrateRoom([40, 60, 140]);
          session.log(event.winner === null ? '통과' : `승리 P${event.winner}`);
          break;
        case 'failed':
          sfx.point();
          this.vibrateRoom([180]);
          session.log(`실패 (${event.reason})`);
          break;
      }
    }
  }

  private vibrateRoom(pattern: number[], exceptId: number | null = null): void {
    for (const player of session.presentPlayers) {
      if (player.id !== exceptId) session.vibrate(player.id, pattern);
    }
  }

  private showFlash(text: string, color: string): void {
    this.flashText.setText(text).setColor(color).setAlpha(1);
    this.tweens.killTweensOf(this.flashText);
    this.tweens.add({ targets: this.flashText, alpha: 0, duration: 800, delay: 500 });
  }

  private nameOf(playerId: number): string {
    return session.players.find((player) => player.id === playerId)?.name ?? `P${playerId}`;
  }

  private colorOf(playerId: number): number {
    const hex = session.players.find((player) => player.id === playerId)?.color;
    return hex === undefined ? STALLED : Number(`0x${hex.slice(1)}`);
  }

  /**
   * One card per phone, rebuilt whenever the roster changes.
   *
   * The cards are scenery; the scores, grips and drill totals stay in the state,
   * which keeps every player it has ever seen. Somebody joining halfway must not
   * cost the rest of the room the match they are playing.
   */
  private rebuildCards(): void {
    const { width, height } = this.scale;
    for (const card of this.cards.values()) card.container.destroy();
    this.cards.clear();

    const players = session.players;
    syncPlayers(
      this.state,
      players.map((player) => ({ id: player.id, present: player.present })),
    );

    const left = this.boardLeft + this.boardSide + 24;
    const cardW = Math.min(420, width - left - 20);
    const top = height * 0.22;
    const slot = (height * 0.72) / Math.max(1, players.length);
    const cardH = Math.min(this.state.config.showNumbers ? 154 : 104, slot - 10);

    players.forEach((player, index) => {
      const color = Number(`0x${player.color.slice(1)}`);
      const panel = this.add.rectangle(0, 0, cardW, cardH, 0x171b24).setStrokeStyle(2, color);
      const nameText = this.add
        .text(-cardW / 2 + 14, -cardH / 2 + 10, '', {
          fontFamily: SANS,
          fontSize: '24px',
          color: player.color,
        })
        .setOrigin(0, 0);
      const detailText = this.add
        .text(-cardW / 2 + 14, -cardH / 2 + 42, '', {
          fontFamily: MONO,
          fontSize: '22px',
          color: '#c3c9d6',
          lineSpacing: 3,
        })
        .setOrigin(0, 0);

      const container = this.add.container(left + cardW / 2, top + index * slot + cardH / 2, [
        panel,
        nameText,
        detailText,
      ]);
      this.cards.set(player.id, { container, nameText, detailText, panel, color: player.color });
    });
  }

  private render(): void {
    const state = this.state;
    const config = state.config;

    this.titleText.setText(`TOGETHER TABLE — ${this.modeTitle()}`);
    this.courseText.setText(this.courseLine());
    this.clockText.setText(this.clockLine());
    this.statusText.setText(this.waitingLine());
    this.roomText.setText(this.roomLines());
    this.hintText.setText(this.hint());

    this.showWaiting(this.blockingLine());

    const over = state.phase === 'cleared' || state.phase === 'failed';
    this.overText.setVisible(over);
    if (over) this.overText.setText(this.overLines());

    this.drawBoard();
    for (const player of state.players) this.drawCard(player);

    const hands = `${drivingPlayers(state).length}/${state.players.length}`;
    session.status =
      `together-table ${config.mode} ${state.phase}  ` +
      `판 x${state.table.x.toFixed(1)}° y${state.table.y.toFixed(1)}° ` +
      `${state.tableRate.toFixed(0)}°/s  ` +
      `공 ${state.ball.x.toFixed(2)},${state.ball.y.toFixed(2)}  손 ${hands}`;
  }

  private modeTitle(): string {
    switch (this.state.config.mode) {
      case 'practice':
        return '기울기 보기';
      case 'solo':
        return '혼자';
      case 'coop':
        return '협동';
      default:
        return '줄다리기';
    }
  }

  private courseLine(): string {
    const state = this.state;
    const total = state.config.courses.length;
    return total > 1
      ? `${state.course.label}  ${state.courseIndex + 1}/${total}`
      : state.course.label;
  }

  private clockLine(): string {
    const state = this.state;
    if (state.course.seconds <= 0) return `경과 ${state.elapsed.toFixed(1)}초`;
    // Survival inverts the clock, so the label has to invert with it: the same
    // number counting down means "hurry" on one course and "hold on" on another.
    const verb = state.course.onTimeout === 'clear' ? '버티기' : '남은 시간';
    return `${verb} ${state.timeLeft.toFixed(1)}초`;
  }

  /**
   * What the game is waiting for, in one line, at all times.
   *
   * Every branch names something a player can act on. "기다리는 중" with no
   * object is the message that leaves a room poking at phones.
   */
  private waitingLine(): string {
    const state = this.state;
    if (session.players.length === 0) return '폰을 연결하세요 (?fake=1 로 키보드 사용)';

    const absent = state.players.filter((player) => !player.present);
    if (absent.length > 0) {
      const names = absent.map((player) => this.nameOf(player.id)).join(', ');
      return `${names} 재접속 대기 중 — 남은 손으로 판은 계속 기울어집니다`;
    }

    if (state.phase === 'grip') {
      const waiting = state.players.filter((player) => player.present && !player.grip);
      const left = Math.max(0, AUTO_GRIP_SECONDS - state.gripFor);
      if (waiting.length === 0) return '기준 완료 — 시작합니다';
      const names = waiting.map((player) => this.nameOf(player.id)).join(', ');
      return `${names} 기준 잡는 중 — 편한 자세로 들고 잠깐 멈추세요 (${left.toFixed(0)}초 뒤 자동)`;
    }

    if (state.phase === 'cleared') return 'A: 다시   ·   HOME: 로비';
    if (state.phase === 'failed') return 'A: 다시   ·   HOME: 로비';

    if (state.pause > 0) return '공을 다시 놓는 중…';

    // A phone that joined mid-match has no level yet and is told how to take
    // one. Lumping it in with the stalled phones below would tell somebody whose
    // connection is fine that their signal is missing.
    const ungripped = state.players.filter((player) => !player.grip);
    if (ungripped.length > 0) {
      const names = ungripped.map((player) => this.nameOf(player.id)).join(', ');
      return `${names} 기준 잡는 중 — 폰을 편한 자세로 들고 잠깐 멈추세요`;
    }

    const driving = drivingPlayers(state).length;
    if (driving === 0) {
      const left = Math.max(0, ABANDON_SECONDS - state.idleFor);
      return `기울이는 폰이 없습니다 — 폰을 기울여 주세요 (${left.toFixed(0)}초 뒤 종료)`;
    }
    if (driving < state.players.length) {
      const quiet = state.players
        .filter((player) => !player.driving)
        .map((player) => this.nameOf(player.id))
        .join(', ');
      return `${quiet} 신호 없음 — 나머지 ${driving}명이 판을 잡고 있습니다`;
    }

    switch (this.state.config.mode) {
      case 'practice':
        return '공을 원 안에 유지하세요 — 화살표는 실제 기울기의 10배입니다';
      case 'versus':
        return `자기 색 구멍에 ${this.state.config.goalsToWin}골 먼저`;
      case 'coop':
        return '초록 구멍으로 — 판은 전원의 평균입니다';
      default:
        return '초록 구멍으로';
    }
  }

  /** The overlay, for the two things that stop the game rather than slow it. */
  private blockingLine(): string | null {
    const state = this.state;
    if (session.players.length === 0) return '폰을 연결하세요\n(?fake=1 로 키보드 사용)';

    const absent = state.players.filter((player) => !player.present);
    if (absent.length > 0) {
      const names = absent.map((player) => this.nameOf(player.id)).join(', ');
      return `${names} 연결 끊김\n점수와 기준은 그대로입니다`;
    }

    if (state.phase === 'grip') {
      const waiting = state.players.filter((player) => player.present && !player.grip);
      if (waiting.length === 0) return null;
      return `${waiting.length}명 기준 잡는 중\n폰을 편한 자세로 들고 잠깐 멈추세요`;
    }
    return null;
  }

  private hint(): string {
    if (this.state.phase === 'cleared' || this.state.phase === 'failed') {
      return 'A: 다시   ·   HOME 또는 ESC: 로비 (12초 뒤 자동)';
    }
    return 'A: 자기 기준만 다시 잡기   ·   HOME 또는 ESC: 로비';
  }

  /**
   * The numbers that belong to the room rather than to one hand.
   *
   * Practice prints all of them, because the drill's answer is a number and a
   * player who cannot see it has no way to tell a bad attempt from an attempt
   * the game never measured. The other modes keep the two that carry a rule.
   */
  private roomLines(): string {
    const state = this.state;
    const config = state.config;
    const lines: string[] = [];

    if (config.showNumbers) {
      lines.push(
        `판 기울기  x${signed(state.table.x)}°  y${signed(state.table.y)}°  (최대 ${MAX_TILT_DEG}°)`,
      );
      lines.push(`판 속도    ${state.tableRate.toFixed(0)}°/s`);
      lines.push(
        `원 안 유지 ${(ringHold(state) * 100).toFixed(0)}%   ` +
          `평균 이탈 ${(ringRms(state) * 100).toFixed(0)}%`,
      );
      lines.push(`공 위치    ${state.ball.x.toFixed(2)}, ${state.ball.y.toFixed(2)}`);
      return lines.join('\n');
    }

    if (config.collapseDegPerSecond > 0) {
      lines.push(
        `판 속도 ${state.tableRate.toFixed(0)}/${config.collapseDegPerSecond}°/s   ` +
          `무너짐 ${state.collapses}회`,
      );
    }
    if (config.goalsToWin > 0) lines.push(`${config.goalsToWin}골 선취`);
    if (state.course.medals.length > 0) {
      lines.push(`메달 ${state.course.medals.map((seconds) => `${seconds}초`).join(' / ')}`);
    }
    return lines.join('\n');
  }

  private overLines(): string {
    const state = this.state;
    if (state.phase === 'failed') {
      return `실패 — ${state.courseIndex + 1}번째 코스\n${this.courseSummary()}`;
    }
    const best = leader(state);
    if (state.config.goalsToWin > 0 && best) {
      return `${this.nameOf(best.id)} 승리 — ${best.goals}골`;
    }
    return `통과!\n${this.courseSummary()}`;
  }

  private courseSummary(): string {
    const state = this.state;
    if (state.courseTimes.length === 0) return '';
    return state.courseTimes
      .map((seconds, index) => {
        const course = state.config.courses[index];
        if (!course) return `${seconds.toFixed(1)}초`;
        const medal = medalFor(course, seconds);
        const mark =
          medal === 'gold' ? '금' : medal === 'silver' ? '은' : medal === 'bronze' ? '동' : '—';
        return `${course.label} ${seconds.toFixed(1)}초 ${mark}`;
      })
      .join('   ');
  }

  private drawCard(player: TablePlayer): void {
    const card = this.cards.get(player.id);
    if (!card) return;

    const status = !player.present
      ? '연결 끊김'
      : !player.grip
        ? '기준 잡는 중'
        : player.stalled
          ? '신호 없음'
          : player.driving
            ? '조종 중'
            : '대기';

    const reaching = player.driving && !player.stalled;
    card.nameText.setText(`${this.nameOf(player.id)} · ${status}`);
    card.nameText.setColor(reaching ? card.color : '#98a0b3');
    card.panel.setStrokeStyle(2, reaching ? Number(`0x${card.color.slice(1)}`) : EDGE);
    card.detailText.setText(this.cardDetail(player));
    card.container.setAlpha(player.present ? 1 : 0.45);
  }

  private cardDetail(player: TablePlayer): string {
    const config = this.state.config;
    if (!player.grip) return '폰을 들고 잠깐 멈추면\n그 자세가 기준이 됩니다';

    if (config.showNumbers) {
      // Six numbers, and every one of them answers a question a player has
      // actually asked out loud: how far am I leaning, is the game seeing it,
      // how much of the board is mine, and has my grip wandered off level.
      const wobble = player.wobbleTime > 0 ? `${wobbleRms(player).toFixed(1)}°` : '—';
      return (
        `기울기 x${signed(player.tilt.x)}° y${signed(player.tilt.y)}°   ` +
        `그립 ${(player.quality * 100).toFixed(0)}%\n` +
        `속도 ${player.rate.toFixed(0)}°/s   지분 ${(player.share * 100).toFixed(0)}%\n` +
        `드리프트 ${biasDeg(player).toFixed(1)}°   흔들림 ${wobble}`
      );
    }

    const first = `지분 ${(player.share * 100).toFixed(0)}%   속도 ${player.rate.toFixed(0)}°/s`;
    if (config.goalsToWin > 0) return `${first}\n골 ${player.goals}/${config.goalsToWin}`;
    if (config.collapseDegPerSecond > 0) {
      return `${first}\n급함 ${player.rate.toFixed(0)}/${config.collapseDegPerSecond}°/s`;
    }
    return `${first}\n기울기 ${Math.hypot(player.tilt.x, player.tilt.y).toFixed(1)}°`;
  }

  private bx(x: number): number {
    return this.boardLeft + x * this.boardSide;
  }

  private by(y: number): number {
    return this.boardTop + y * this.boardSide;
  }

  private drawBoard(): void {
    const state = this.state;
    const config = state.config;
    const side = this.boardSide;
    const g = this.board;
    g.clear();

    // Out of play under the live area, so a course whose walls close in is the
    // same two rectangles as one whose walls never move.
    g.fillStyle(OUT_OF_PLAY, 1).fillRect(this.boardLeft, this.boardTop, side, side);
    const bounds = state.bounds;
    const boxX = this.bx(bounds.minX);
    const boxY = this.by(bounds.minY);
    const boxW = (bounds.maxX - bounds.minX) * side;
    const boxH = (bounds.maxY - bounds.minY) * side;
    g.fillStyle(PLATE, 1).fillRect(boxX, boxY, boxW, boxH);
    g.lineStyle(3, EDGE, 1).strokeRect(boxX, boxY, boxW, boxH);

    if (config.showNumbers) {
      g.lineStyle(1, GRID, 1);
      for (let step = 1; step < 8; step++) {
        const at = step / 8;
        g.lineBetween(this.bx(at), this.by(0), this.bx(at), this.by(1));
        g.lineBetween(this.bx(0), this.by(at), this.bx(1), this.by(at));
      }
    }

    if (config.ringRadius > 0) {
      g.lineStyle(3, GOAL, 0.8).strokeCircle(
        this.bx(state.course.start.x),
        this.by(state.course.start.y),
        config.ringRadius * side,
      );
    }

    g.fillStyle(WALL, 1);
    for (const wall of state.course.walls) {
      g.fillRect(this.bx(wall.x), this.by(wall.y), wall.w * side, wall.h * side);
    }

    this.drawHoles();
    this.drawArrows();

    const radius = Math.max(11, BALL_RADIUS * side);
    g.fillStyle(BALL, 1).fillCircle(this.bx(state.ball.x), this.by(state.ball.y), radius);
    g.lineStyle(3, 0x0b0d13, 1).strokeCircle(this.bx(state.ball.x), this.by(state.ball.y), radius);
  }

  private drawHoles(): void {
    const g = this.board;
    const side = this.boardSide;
    let labelled = 0;

    for (const hole of this.state.holes) {
      const x = this.bx(hole.x);
      const y = this.by(hole.y);
      const r = hole.r * side;
      const seatId = hole.seat === null ? null : playerAt(this.state.seats, hole.seat);
      const color = hole.kind === 'trap' ? TRAP : seatId === null ? GOAL : this.colorOf(seatId);

      g.fillStyle(0x05070b, 1).fillCircle(x, y, r);
      g.lineStyle(4, color, 1).strokeCircle(x, y, r);
      if (hole.kind === 'trap') {
        // A cross, because a television across a room is exactly where "the red
        // ones" stops being a distinction anybody can make.
        g.lineStyle(3, TRAP, 0.9);
        g.lineBetween(x - r * 0.45, y - r * 0.45, x + r * 0.45, y + r * 0.45);
        g.lineBetween(x - r * 0.45, y + r * 0.45, x + r * 0.45, y - r * 0.45);
        continue;
      }

      const label = this.seatLabels[labelled];
      if (!label) continue;
      labelled++;
      label
        .setPosition(x, y + r + 4)
        .setText(seatId === null ? '골' : this.nameOf(seatId))
        .setColor(seatId === null ? '#2ed573' : (session.players.find((p) => p.id === seatId)?.color ?? '#f1f3f8'))
        .setVisible(true);
    }

    for (let index = labelled; index < this.seatLabels.length; index++) {
      this.seatLabels[index]?.setVisible(false);
    }
  }

  /**
   * Every hand's pull on the board, from one origin, plus the board itself.
   *
   * An arrow is that hand's tilt times its share, so the arrows literally add up
   * to the white one: two people pulling against each other draw two long
   * arrows and a short board, which is the thing the room needs to see and the
   * one thing a single averaged number can never show.
   */
  private drawArrows(): void {
    const centre = { x: this.bx(0.5), y: this.by(0.5) };
    const state = this.state;

    this.board.lineStyle(2, EDGE, 1).strokeCircle(centre.x, centre.y, 6);

    for (const player of state.players) {
      if (!player.grip || player.weight <= 0) continue;
      const color = player.stalled ? STALLED : this.colorOf(player.id);
      this.drawArrow(
        centre.x,
        centre.y,
        player.tilt.x * player.share,
        player.tilt.y * player.share,
        color,
        0.35 + 0.65 * player.weight,
        6,
      );
    }

    this.drawArrow(centre.x, centre.y, state.table.x, state.table.y, MEAN, 0.95, 3);
  }

  private drawArrow(
    x: number,
    y: number,
    dx: number,
    dy: number,
    color: number,
    alpha: number,
    width: number,
  ): void {
    const size = Math.hypot(dx, dy);
    if (size === 0) return;
    const length =
      Math.min((size * this.state.config.arrowGain) / ARROW_FULL_DEG, 1) * this.boardSide * 0.44;
    if (length < ARROW_MIN_PX) return;

    const ux = dx / size;
    const uy = dy / size;
    const tipX = x + ux * length;
    const tipY = y + uy * length;
    const head = Math.min(20, length * 0.5);
    const baseX = tipX - ux * head;
    const baseY = tipY - uy * head;

    const g = this.board;
    g.lineStyle(width, color, alpha).lineBetween(x, y, baseX, baseY);
    g.fillStyle(color, alpha).fillTriangle(
      tipX,
      tipY,
      baseX - uy * head * 0.5,
      baseY + ux * head * 0.5,
      baseX + uy * head * 0.5,
      baseY - ux * head * 0.5,
    );
  }
}

/** Sign always printed, so a column of readings does not jump a character. */
function signed(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(1)}`;
}
