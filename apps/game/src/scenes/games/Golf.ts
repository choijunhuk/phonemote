import type Phaser from 'phaser';
import { session } from '../../session.js';
import { BaseGameScene } from './BaseGameScene.js';
import type { GameAction } from '../../input/types.js';
import { sfx } from '../../ui/audio.js';
import { seatOf } from './seats.js';
import {
  GIMME_RADIUS_M,
  HOLE_TERMS,
  RANGE_FLAGS_M,
  applyStroke,
  applySwing,
  cardOf,
  createGolf,
  dispersionOf,
  distanceToPin,
  findPlayer,
  holeFor,
  leaderboard,
  pinOf,
  puttBand,
  readPose,
  readStillness,
  refusalFor,
  setClub,
  setDrill,
  setGrip,
  shooter,
  stepGolf,
  syncPlayers,
  termFor,
  type Club,
  type GolfEvent,
  type GolfHole,
  type GolfMode,
  type GolfPlayer,
  type GolfState,
  type Lie,
  type RefusedReason,
} from './golfState.js';

/**
 * Golf: the scene that draws golfState and turns its events into sound.
 *
 * Every rule is in golfState.ts (ARCHITECTURE.md 8). Nothing here decides
 * whether a shot counted, how far it went or whose turn it is — it reads the
 * state, draws it, and plays the events the module hands back. The one place
 * that was tempting to break that is the practice readout, and it is exactly
 * where it matters least: the numbers on the cards are the plan and the record
 * the rules built, not a second calculation off the same action.
 *
 * The picture is top-down with the tee at the bottom. Across and along get
 * separate scales, deliberately: at a single scale a 350 m hole puts the whole
 * playable corridor inside 6% of the screen width, and aim, face angle and line
 * error — the only things a player can actually change — would move the ball by
 * a pixel. Distances are therefore read from the cards, not from the picture.
 *
 * There is no fairway edge drawn. golfState keeps the corridor width to itself,
 * and a second copy of it here would be a picture that disagrees with the lie
 * the rules assigned. The ring around each ball is coloured by the lie the
 * rules gave it and the card prints that lie in words.
 */

/**
 * The same course every time.
 *
 * The design asks for a fixed seed so a round can be replayed hole for hole; a
 * clock-derived seed would make "the same course again" impossible to offer.
 */
const COURSE_SEED = 7;

const FIELD_TOP = 88;
/** Tall enough for the seven practice readout lines plus the backstroke bar. */
const PRACTICE_CARD_H = 268;
const ROUND_CARD_H = 156;
const CARD_GAP = 14;
const MAX_CARD_W = 300;

/** Metres either side of the line to the pin that the picture shows. */
const HALF_ACROSS_M = 45;
/** Head room past the pin, as a fraction of the hole, so the flag is not on the edge. */
const ALONG_MARGIN = 0.18;

/**
 * The top of the backstroke bar, in degrees.
 *
 * puttBand asks for 42.7 degrees on the ten metre rung at the practice green's
 * speed, so a 60 degree bar keeps the longest putt's band on screen with room
 * left to see an overswing rather than a bar that is simply full.
 */
const BAR_MAX_DEG = 60;

/** A putt is not struck hard, and plan.power is 0 for one by definition. */
const PUTT_FEEDBACK = 0.25;

const GRASS = 0x18331e;
const GREEN_SURFACE = 0x2f8a45;
const SAND = 0xd9c48d;

const CLUB_ORDER: readonly Club[] = ['driver', 'iron', 'wedge', 'putter'];

const CLUB_NAMES: Record<Club, string> = {
  driver: '드라이버',
  iron: '아이언',
  wedge: '웨지',
  putter: '퍼터',
};

const LIE_NAMES: Record<Lie, string> = {
  tee: '티',
  fairway: '페어웨이',
  rough: '러프',
  bunker: '벙커',
  green: '그린',
};

/** The ring around the ball, so the lie is visible as well as written. */
const LIE_TINT: Record<Lie, number> = {
  tee: 0xf1f3f8,
  fairway: 0x2ed573,
  rough: 0x7a8f4a,
  bunker: 0xd9c48d,
  green: 0xffffff,
};

/**
 * Every refusal reaches the screen.
 *
 * A shot that is dropped in silence is indistinguishable from one the detector
 * never saw, and the room reads the second as a broken game — the reason
 * golfState reports a reason at all rather than returning nothing.
 */
const REFUSED_TEXT: Record<RefusedReason, string> = {
  not_your_turn: '차례 아님',
  no_grip: '그립 없음',
  ball_moving: '공이 구르는 중',
  green_needs_putt: '그린은 퍼팅',
  too_small: '너무 작음',
  hole_finished: '홀 끝남',
};

interface Card {
  readonly container: Phaser.GameObjects.Container;
  readonly name: Phaser.GameObjects.Text;
  readonly note: Phaser.GameObjects.Text;
  readonly body: Phaser.GameObjects.Text;
  readonly barTrack: Phaser.GameObjects.Rectangle;
  readonly band: Phaser.GameObjects.Rectangle;
  readonly sweep: Phaser.GameObjects.Rectangle;
  readonly barWidth: number;
  /** The strip of field directly above this card, in practice. */
  readonly laneX: number;
  readonly laneW: number;
  readonly colorHex: string;
}

/** A hole mapped onto a rectangle of screen. */
interface View {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Pixels per metre across the hole, and along it. Not the same number. */
  readonly across: number;
  readonly along: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(digits)}`;
}

export class Golf extends BaseGameScene {
  private state!: GolfState;
  private field!: Phaser.GameObjects.Graphics;
  private headText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private holeText!: Phaser.GameObjects.Text;
  private waitLine!: Phaser.GameObjects.Text;
  private resultText!: Phaser.GameObjects.Text;
  private cardHeight = ROUND_CARD_H;
  private fieldBottom = 0;
  private readonly cards = new Map<number, Card>();
  /** Card order, which is also lane order: a lane sits above its own card. */
  private laneOrder: number[] = [];
  private flagLabels: Phaser.GameObjects.Text[] = [];

  constructor() {
    super('golf');
  }

  protected build(): void {
    const { width, height } = this.scale;
    const mode = this.golfMode();

    // Seats freeze here, from the roster as it stands now: a phone that arrives
    // mid-round is a spectator until the next game rather than a player who
    // pushes everybody else down a seat (seats.ts).
    this.state = createGolf({
      mode,
      playerIds: session.players.map((player) => player.id),
      seed: COURSE_SEED,
    });

    this.cardHeight = mode === 'practice' ? PRACTICE_CARD_H : ROUND_CARD_H;
    this.fieldBottom = height - this.cardHeight - 46;

    // Cleared rather than trusted. Phaser calls build() again on the same
    // instance, and a map still holding last run's destroyed cards is how a
    // scene ends up writing text into objects that are no longer on screen.
    this.cards.clear();
    this.laneOrder = [];
    this.flagLabels = [];

    this.field = this.add.graphics();

    this.headText = this.add
      .text(18, 12, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#f1f3f8',
      })
      .setOrigin(0, 0);

    this.hintText = this.add
      .text(width - 18, 14, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '22px',
        color: '#98a0b3',
      })
      .setOrigin(1, 0);

    this.holeText = this.add
      .text(18, 48, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '22px',
        color: '#c3c9d6',
      })
      .setOrigin(0, 0);

    // The one line that always says what the game is waiting for. Directly
    // above the cards, because that is where a player looks for their own name.
    this.waitLine = this.add
      .text(width / 2, this.fieldBottom + 6, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: '#ffa502',
      })
      .setOrigin(0.5, 0);

    this.resultText = this.add
      .text(width / 2, FIELD_TOP + 40, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '26px',
        color: '#f1f3f8',
        align: 'center',
        backgroundColor: '#0f1116',
        padding: { x: 16, y: 12 },
      })
      .setOrigin(0.5, 0)
      .setVisible(false);

    for (const metres of RANGE_FLAGS_M) {
      this.flagLabels.push(
        this.add
          .text(6, 0, `${metres}m`, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '22px',
            color: '#c3c9d6',
          })
          .setOrigin(0, 0.5)
          .setVisible(false),
      );
    }

    // Fires immediately with the current roster, which is what builds the cards
    // the first time.
    this.onCleanup(session.onPlayersChanged(() => this.rebuildCards()));
  }

  protected override onGameAction(action: GameAction): void {
    switch (action.kind) {
      case 'pose':
        // Gravity, never yaw: aim is a roll against the player's own grip, so a
        // phone that has drifted forty degrees since the last HOME aims the
        // same as one that has not.
        readPose(this.state, action.playerId, action.up, this.time.now);
        return;
      case 'stillness':
        this.play(
          readStillness(this.state, action.playerId, {
            rate: action.rate,
            steadyMs: action.steadyMs,
            stalled: action.stalled,
          }),
        );
        return;
      case 'swing':
        this.play(
          applySwing(this.state, action.playerId, {
            peakRate: action.peakRate,
            rotation: action.rotation,
            durationMs: action.durationMs,
            timestamp: action.timestamp,
          }),
        );
        return;
      case 'stroke':
        this.play(
          applyStroke(this.state, action.playerId, {
            angleDeg: action.angleDeg,
            durationMs: action.durationMs,
            peakRate: action.peakRate,
            reversedFromPrevious: action.reversedFromPrevious,
            timestamp: action.timestamp,
          }),
        );
        return;
      case 'button_down':
        this.press(action.playerId, action.button);
        return;
      default:
        return;
    }
  }

  protected override teardown(): void {
    this.cards.clear();
    this.laneOrder = [];
    this.flagLabels = [];
  }

  protected step(dt: number): void {
    this.play(stepGolf(this.state, dt));
    // Never a dead screen: a round that ended while everybody had put their
    // phone down would otherwise sit there until somebody found the keyboard.
    if (this.state.phase === 'over') this.returnToLobbyAfter(15);
    this.render();
  }

  override debugState(): unknown {
    return {
      scene: 'golf',
      mode: this.mode,
      phase: this.state.phase,
      hole: this.state.hole,
      drill: this.state.drill,
      shooter: shooter(this.state),
      players: this.state.players.map((player) => ({
        id: player.id,
        present: player.present,
        grip: player.grip !== null,
        lie: player.lie,
        strokes: player.strokes,
        rate: player.rate,
        sweptDeg: player.sweptDeg,
      })),
    };
  }

  /**
   * The lobby's mode key, as a golf mode.
   *
   * coop and party are not in golf's registry entry, so they only arrive from a
   * direct start; practice is the one mode it is safe to land in, because it
   * has no card to get wrong and no turn to be stuck on.
   */
  private golfMode(): GolfMode {
    if (this.mode === 'versus') return 'versus';
    if (this.mode === 'solo') return 'solo';
    return 'practice';
  }

  private press(playerId: number, button: string): void {
    if (button === 'A') {
      if (this.state.phase === 'over') {
        // The mode is handed back deliberately. scene.restart() with no data
        // re-inits at the default, so a versus round would restart as practice
        // and take the seats with it.
        this.scene.restart({ mode: this.mode });
        return;
      }
      this.play(setGrip(this.state, playerId, this.time.now));
      return;
    }
    if (button === 'B') {
      // A no-op outside practice: setDrill refuses a drill this mode does not
      // offer, so there is no branch here to keep in step with the rules.
      const before = this.state.drill;
      setDrill(this.state, before === 'range' ? 'putting' : 'range');
      if (this.state.drill === before) return;
      sfx.tick();
      session.log(`연습 화면 ${this.state.drill === 'range' ? '레인지' : '퍼팅 그린'}`);
      return;
    }
    if (button === 'PLUS') this.cycleClub(playerId, 1);
    if (button === 'MINUS') this.cycleClub(playerId, -1);
  }

  private cycleClub(playerId: number, step: number): void {
    const player = findPlayer(this.state, playerId);
    if (!player) return;
    const index = CLUB_ORDER.indexOf(player.club);
    const next = CLUB_ORDER[(index + step + CLUB_ORDER.length) % CLUB_ORDER.length];
    if (!next) return;
    setClub(this.state, playerId, next);
    sfx.tick();
    this.note(playerId, CLUB_NAMES[next]);
  }

  /**
   * Sound and vibration, which are the only two things the rules cannot do.
   *
   * Driven entirely by the events handed back: nothing here re-decides whether
   * a shot was good, and every branch reads a field off the event it was given.
   */
  private play(events: readonly GolfEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'grip':
          sfx.tick();
          session.vibrate(event.playerId, [30]);
          session.log(`그립 ${this.nameOf(event.playerId)}`);
          break;
        case 'struck': {
          const plan = event.plan;
          const strength = plan.kind === 'putt' ? PUTT_FEEDBACK : plan.power;
          sfx.hit(strength);
          // Under 25 ms an Android motor never spins up, so a soft shot and a
          // dead phone felt identical in the hand.
          session.vibrate(event.playerId, [Math.round(25 + strength * 55)]);
          session.log(
            `${this.nameOf(event.playerId)} ${CLUB_NAMES[plan.club]} ` +
              `${Math.round(plan.peakRate)}°/s 페이스 ${plan.faceDeg.toFixed(1)}° ` +
              `캐리 ${Math.round(plan.carryM)}m`,
          );
          break;
        }
        case 'landed':
          sfx.wall();
          break;
        case 'rested':
          if (event.record.holed) {
            sfx.point();
            session.vibrate(event.playerId, [40, 60, 140]);
            this.note(event.playerId, '들어감');
          } else {
            sfx.tick();
          }
          break;
        case 'refused':
          sfx.whiff();
          session.vibrate(event.playerId, [25, 60, 25]);
          this.note(event.playerId, REFUSED_TEXT[event.reason]);
          break;
        case 'holed':
          this.note(
            event.playerId,
            `${HOLE_TERMS[event.term]} ${event.strokes}타${event.conceded ? ' (컨시드)' : ''}`,
          );
          session.log(
            `${this.nameOf(event.playerId)} ${event.strokes}타 (파 ${event.par}) ` +
              HOLE_TERMS[event.term],
          );
          break;
        case 'picked_up':
          sfx.whiff();
          this.note(event.playerId, `픽업 ${event.strokes}타`);
          break;
        case 'turn':
          sfx.tick();
          // The phone is where the player is looking, not the screen.
          session.vibrate(event.playerId, [40]);
          break;
        case 'target':
          sfx.tick();
          this.note(event.playerId, `${event.distanceM.toFixed(0)}m`);
          break;
        case 'hole_started':
          sfx.tick();
          session.log(`${event.hole}홀 파 ${event.par}`);
          break;
        case 'hole_over':
          sfx.point();
          break;
        default:
          sfx.win();
          break;
      }
    }
  }

  private rebuildCards(): void {
    const { width } = this.scale;
    for (const card of this.cards.values()) card.container.destroy();
    this.cards.clear();

    const players = session.players;
    // The roster is merged into the state, never used to rebuild it: a phone
    // that drops for two seconds keeps its grip, its ball and its card (D48).
    this.play(
      syncPlayers(
        this.state,
        players.map((player) => ({ id: player.id, present: player.present })),
      ),
    );

    this.laneOrder = players.map((player) => player.id);
    const count = Math.max(1, players.length);
    const cardW = Math.min(MAX_CARD_W, (width - CARD_GAP * (count + 1)) / count);
    const cardH = this.cardHeight;
    const centreY = this.scale.height - 10 - cardH / 2;
    const barWidth = cardW - 32;

    players.forEach((player, index) => {
      const color = Number(`0x${player.color.slice(1)}`);
      const x = width / 2 + (index - (players.length - 1) / 2) * (cardW + CARD_GAP);

      const panel = this.add.rectangle(0, 0, cardW, cardH, 0x171b24).setStrokeStyle(2, color);
      const name = this.add
        .text(-cardW / 2 + 12, -cardH / 2 + 18, player.name, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '24px',
          color: player.color,
        })
        .setOrigin(0, 0.5);
      const note = this.add
        .text(cardW / 2 - 12, -cardH / 2 + 18, '', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '22px',
          color: '#ffa502',
        })
        .setOrigin(1, 0.5)
        .setAlpha(0);
      const body = this.add
        .text(-cardW / 2 + 12, -cardH / 2 + 40, '', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '22px',
          color: '#c3c9d6',
          lineSpacing: 4,
        })
        .setOrigin(0, 0);

      // The backstroke bar, which is the ninety percent of putting nobody can
      // see: the fill is the angle being swept right now and the band over it
      // is the angle that holes the putt.
      const barY = cardH / 2 - 28;
      const barTrack = this.add.rectangle(0, barY, barWidth, 18, 0x232838);
      const band = this.add
        .rectangle(-barWidth / 2, barY, barWidth, 18, 0x2ed573)
        .setOrigin(0, 0.5)
        .setAlpha(0.35);
      const sweep = this.add
        .rectangle(-barWidth / 2, barY, barWidth, 12, color)
        .setOrigin(0, 0.5)
        .setScale(0, 1);

      const container = this.add.container(x, centreY, [
        panel,
        name,
        note,
        body,
        barTrack,
        band,
        sweep,
      ]);

      this.cards.set(player.id, {
        container,
        name,
        note,
        body,
        barTrack,
        band,
        sweep,
        barWidth,
        laneX: x - cardW / 2,
        laneW: cardW,
        colorHex: player.color,
      });
    });
  }

  /** A short line on one player's own card, so four rooms' worth do not collide. */
  private note(playerId: number, text: string): void {
    const card = this.cards.get(playerId);
    if (!card) return;
    card.note.setText(text).setAlpha(1);
    this.tweens.killTweensOf(card.note);
    this.tweens.add({ targets: card.note, alpha: 0, duration: 700, delay: 1400 });
  }

  private nameOf(playerId: number): string {
    const player = session.players.find((entry) => entry.id === playerId);
    if (player) return player.name;
    return `P${seatOf(this.state.seats, playerId) ?? playerId}`;
  }

  private colorOf(playerId: number): string {
    return session.players.find((entry) => entry.id === playerId)?.color ?? '#98a0b3';
  }

  private render(): void {
    this.renderHeader();
    this.renderField();
    this.renderCards();
    this.waitLine.setText(this.waitingLine());
    this.renderOverlay();
    this.renderStatus();
  }

  private renderHeader(): void {
    const config = this.state.config;
    if (config.mode === 'practice') {
      const drill = this.state.drill === 'range' ? '드라이빙 레인지' : '퍼팅 그린';
      this.headText.setText(`골프 — 연습: ${drill}`);
      this.hintText.setText('A 그립 · +/− 클럽 · B 화면 · HOME 로비');
      // Asked of the rules rather than written down here: the range is 250 m
      // and the ladder is 2/5/10 m in golfState, and a second copy of either
      // would be a caption that can disagree with the hole being played.
      const first = this.state.players[0];
      const range = first ? `${holeFor(this.state, first).lengthM.toFixed(0)}m 레인지 · ` : '';
      this.holeText.setText(
        this.state.drill === 'range'
          ? `${range}깃발 ${RANGE_FLAGS_M.join('·')}m · 점수 없음, 공 무제한`
          : `사다리 · 컨시드 반경 ${GIMME_RADIUS_M.toFixed(2)}m · 백스트로크 각도로 거리 조절`,
      );
      return;
    }

    this.headText.setText(
      `골프 — ${config.mode === 'versus' ? '대전' : '혼자'} ${config.holes}홀`,
    );
    this.hintText.setText('A 그립 · +/− 클럽 · HOME 로비');
    const hole = this.state.course[this.state.hole - 1];
    if (!hole) {
      this.holeText.setText('');
      return;
    }
    this.holeText.setText(
      `${this.state.hole}/${config.holes}홀 · 파 ${hole.par} · ${Math.round(hole.lengthM)}m · ` +
        `바람 ${hole.wind >= 0 ? '오른쪽' : '왼쪽'} ${Math.abs(hole.wind).toFixed(1)}m/s · ` +
        `그린 경사 ${hole.slopeDegPerM >= 0 ? '오른쪽' : '왼쪽'} ` +
        `${Math.abs(hole.slopeDegPerM).toFixed(1)}°/m`,
    );
  }

  private renderField(): void {
    const graphics = this.field;
    graphics.clear();
    const height = this.fieldBottom - FIELD_TOP;
    for (const label of this.flagLabels) label.setVisible(false);

    if (this.state.config.mode === 'practice') {
      // One lane per player, because in the putting drill each of them is on
      // their own rung of the ladder and a single shared field would be drawing
      // somebody else's hole under their ball.
      for (const id of this.laneOrder) {
        const card = this.cards.get(id);
        const player = findPlayer(this.state, id);
        if (!card || !player) continue;
        const hole = holeFor(this.state, player);
        const view = this.viewOf(card.laneX, FIELD_TOP, card.laneW, height, hole);
        this.drawHole(view, hole);
        graphics.lineStyle(2, Number(`0x${card.colorHex.slice(1)}`), 0.55);
        graphics.strokeRect(view.x + 1, view.y + 1, view.w - 2, view.h - 2);
        this.drawShots(view, player);
        this.drawBall(view, player);
        if (this.state.drill === 'range') this.placeFlagLabels(view, hole);
      }
      return;
    }

    const hole = this.state.course[this.state.hole - 1];
    if (!hole) return;
    const view = this.viewOf(20, FIELD_TOP, this.scale.width - 40, height, hole);
    this.drawHole(view, hole);
    for (const player of this.state.players) this.drawBall(view, player);
  }

  private viewOf(x: number, y: number, w: number, h: number, hole: GolfHole): View {
    const lengthM = Math.max(1, hole.lengthM);
    const alongSpan = lengthM * (1 + ALONG_MARGIN) + 1;
    // A ladder green is as wide as it is long, so the across window comes from
    // the putt itself; on anything else it is the corridor a shot can be played
    // from and still be worth drawing.
    const halfAcross =
      hole.greenRadiusM >= lengthM ? Math.max(0.8, lengthM * 0.3) : HALF_ACROSS_M;
    return { x, y, w, h, across: w / (2 * halfAcross), along: h / alongSpan };
  }

  private vx(view: View, metres: number): number {
    return view.x + view.w / 2 + metres * view.across;
  }

  private vy(view: View, metres: number): number {
    return view.y + view.h - metres * view.along;
  }

  private drawHole(view: View, hole: GolfHole): void {
    const graphics = this.field;
    graphics.fillStyle(GRASS, 1);
    graphics.fillRect(view.x, view.y, view.w, view.h);

    // The line to the pin. Aim, face and wind are all measured against it, so
    // it is the one piece of scenery the cards' numbers refer to.
    graphics.lineStyle(2, 0xffffff, 0.16);
    graphics.lineBetween(
      this.vx(view, 0),
      this.vy(view, 0),
      this.vx(view, 0),
      this.vy(view, hole.lengthM),
    );

    for (const bunker of hole.bunkers) {
      graphics.fillStyle(SAND, 0.9);
      graphics.fillEllipse(
        this.vx(view, bunker.x),
        this.vy(view, bunker.y),
        bunker.radiusM * 2 * view.across,
        bunker.radiusM * 2 * view.along,
      );
    }

    if (hole.greenRadiusM > 0) {
      const cupX = this.vx(view, 0);
      const cupY = this.vy(view, hole.lengthM);
      graphics.fillStyle(GREEN_SURFACE, 1);
      graphics.fillEllipse(
        cupX,
        cupY,
        hole.greenRadiusM * 2 * view.across,
        hole.greenRadiusM * 2 * view.along,
      );

      // The concession radius, drawn at exactly the size the rules concede
      // from: a player being asked to stop the ball inside it should be able to
      // see how big it is. Skipped when it would be a few pixels of noise.
      const gimmeW = GIMME_RADIUS_M * 2 * view.across;
      if (gimmeW >= 10) {
        graphics.lineStyle(3, 0xffffff, 0.8);
        graphics.strokeEllipse(cupX, cupY, gimmeW, GIMME_RADIUS_M * 2 * view.along);
      }

      graphics.fillStyle(0x0f1116, 1);
      graphics.fillCircle(cupX, cupY, 5);
      graphics.lineStyle(3, 0xffffff, 0.9);
      graphics.lineBetween(cupX, cupY, cupX, cupY - 34);
      graphics.fillStyle(0xff4757, 1);
      graphics.fillTriangle(cupX, cupY - 34, cupX, cupY - 20, cupX + 18, cupY - 27);
    } else {
      for (const metres of RANGE_FLAGS_M) {
        if (metres > hole.lengthM) continue;
        graphics.lineStyle(2, 0xffffff, 0.28);
        graphics.lineBetween(
          view.x + 4,
          this.vy(view, metres),
          view.x + view.w - 4,
          this.vy(view, metres),
        );
      }
    }

    graphics.fillStyle(0xffffff, 0.5);
    graphics.fillCircle(this.vx(view, 0), this.vy(view, 0), 4);
  }

  /** Range flags carry their distance in metres; every lane shares the scale. */
  private placeFlagLabels(view: View, hole: GolfHole): void {
    RANGE_FLAGS_M.forEach((metres, index) => {
      const label = this.flagLabels[index];
      if (!label || metres > hole.lengthM) return;
      label.setPosition(6, this.vy(view, metres)).setVisible(true);
    });
  }

  private drawBall(view: View, player: GolfPlayer): void {
    const graphics = this.field;
    const x = this.vx(view, player.ball.x);
    const y = this.vy(view, player.ball.y);
    const color = Number(`0x${this.colorOf(player.id).slice(1)}`);

    // The intended start line, drawn only while this player may actually hit:
    // an aim line on a ball that is rolling, or on somebody else's turn, is the
    // game promising something it will refuse.
    if (refusalFor(this.state, player) === null) {
      const pin = pinOf(this.state, player);
      const bearing = (Math.atan2(pin.x - player.ball.x, pin.y - player.ball.y) * 180) / Math.PI;
      const heading = ((bearing + player.aimDeg) * Math.PI) / 180;
      const reach = Math.max(4, Math.min(60, distanceToPin(this.state, player)));
      graphics.lineStyle(3, color, 0.55);
      graphics.lineBetween(
        x,
        y,
        this.vx(view, player.ball.x + Math.sin(heading) * reach),
        this.vy(view, player.ball.y + Math.cos(heading) * reach),
      );
    }

    graphics.lineStyle(3, LIE_TINT[player.lie], player.present ? 0.9 : 0.35);
    graphics.strokeCircle(x, y, 12);
    graphics.fillStyle(color, player.present ? 1 : 0.4);
    graphics.fillCircle(x, y, 7);
  }

  /**
   * Where the last shots finished, and the ellipse they scatter into.
   *
   * The record keeps how far the ball went and how far right of the intended
   * line it ended, which is exactly a distance along the aim vector and a
   * distance along its right-perpendicular.
   */
  private drawShots(view: View, player: GolfPlayer): void {
    const graphics = this.field;
    const shots = player.shots;
    shots.forEach((shot, index) => {
      const across = shot.lineErrorM;
      const along = Math.sqrt(Math.max(0, shot.distanceM ** 2 - across ** 2));
      const x = shot.startX + shot.aimX * along + shot.aimY * across;
      const y = shot.startY + shot.aimY * along - shot.aimX * across;
      const newest = index === shots.length - 1;
      graphics.fillStyle(0xf1f3f8, newest ? 0.95 : 0.4);
      graphics.fillCircle(this.vx(view, x), this.vy(view, y), newest ? 6 : 4);
    });

    // Two standard deviations, so about nineteen shots in twenty land inside
    // it. Only on the range: on the ladder the shots start from three different
    // distances and one ellipse over the three would mean nothing.
    if (this.state.drill !== 'range') return;
    const spread = dispersionOf(player);
    if (spread.count < 3) return;
    graphics.lineStyle(2, 0xffffff, 0.5);
    graphics.strokeEllipse(
      this.vx(view, spread.meanLine),
      this.vy(view, spread.meanDistance),
      Math.max(6, 4 * spread.sdLine * view.across),
      Math.max(6, 4 * spread.sdDistance * view.along),
    );
  }

  private renderCards(): void {
    const onTurn = shooter(this.state);
    for (const [id, card] of this.cards) {
      const player = findPlayer(this.state, id);
      if (!player) continue;

      card.container.setAlpha(player.present ? 1 : 0.45);
      card.name.setColor(id === onTurn ? '#ffffff' : card.colorHex);
      card.body.setText(this.cardLines(player).join('\n'));

      const band = puttBand(this.state, player);
      const showBar =
        this.state.config.mode === 'practice' && this.state.drill === 'putting' && band !== null;
      card.barTrack.setVisible(showBar);
      card.band.setVisible(showBar);
      card.sweep.setVisible(showBar);
      if (!showBar || !band) continue;

      const low = clamp01(band.minDeg / BAR_MAX_DEG);
      const high = clamp01(band.maxDeg / BAR_MAX_DEG);
      card.band.setX(-card.barWidth / 2 + low * card.barWidth);
      card.band.setScale(Math.max(0.02, high - low), 1);
      card.sweep.setScale(clamp01(player.sweptDeg / BAR_MAX_DEG), 1);
      // Green while the backstroke is inside the band that holes it, so the bar
      // says "now" as well as "how far".
      const inside = player.sweptDeg >= band.minDeg && player.sweptDeg <= band.maxDeg;
      card.sweep.setFillStyle(inside ? 0x2ed573 : Number(`0x${card.colorHex.slice(1)}`));
    }
  }

  /**
   * The numbers a player came to practice for.
   *
   * A player who cannot see what their own movement measured has no way to tell
   * a bad swing from one the game never saw, and that confusion is the single
   * most common complaint this project has had. Every figure here is read back
   * off the plan and the record the rules built, never recomputed.
   */
  private cardLines(player: GolfPlayer): string[] {
    const live = `지금 ${player.rate.toFixed(0)}°/s ${
      player.stalled ? '센서멈춤' : player.grip ? '그립' : '그립없음'
    }`;

    if (this.state.config.mode !== 'practice') {
      const card = cardOf(this.state, player);
      const standing = player.holedOut
        ? '홀아웃'
        : player.pickedUp
          ? '픽업'
          : player.abandoned
            ? '기권'
            : shooter(this.state) === player.id
              ? '▶ 칠 차례'
              : '대기';
      return [
        `${player.strokes}타  홀까지 ${distanceToPin(this.state, player).toFixed(0)}m`,
        `${CLUB_NAMES[player.club]}  ${LIE_NAMES[player.lie]}`,
        `합계 ${card.total} (${signed(card.toPar, 0)}) ${card.holesPlayed}홀`,
        standing,
      ];
    }

    if (this.state.drill === 'putting') {
      const band = puttBand(this.state, player);
      const holed = player.shots.filter((shot) => shot.holed).length;
      const last = player.lastShot;
      return [
        live,
        `사다리 ${player.ladder + 1}/3 · ${holeFor(this.state, player).lengthM.toFixed(0)}m`,
        band
          ? `목표 ${band.targetDeg.toFixed(0)}° (${band.minDeg.toFixed(0)}~${band.maxDeg.toFixed(0)}°)`
          : '그린 밖',
        `백스트로크 ${player.sweptDeg.toFixed(0)}°`,
        last
          ? `지난 퍼트 ${last.strokeAngleDeg.toFixed(0)}° ${last.distanceM.toFixed(1)}m`
          : '아직 친 퍼트 없음',
        last && last.distanceErrorM !== null
          ? `거리 ${signed(last.distanceErrorM, 2)}m 좌우 ${signed(last.lineErrorM, 2)}m`
          : '거리·좌우 오차 대기',
        `넣음 ${holed} / ${player.shots.length}퍼트`,
      ];
    }

    const last = player.lastShot;
    const spread = dispersionOf(player);
    return [
      live,
      last ? `속도 ${last.peakRate.toFixed(0)}°/s 파워 ${last.power.toFixed(2)}` : '아직 친 공 없음',
      last ? `페이스 ${signed(last.faceDeg, 1)}° 조준 ${signed(last.aimDeg, 1)}°` : '스윙을 하세요',
      last ? `비거리 ${last.distanceM.toFixed(0)}m 좌우 ${signed(last.lineErrorM, 1)}m` : '',
      last && last.tempoRatio !== null
        ? `템포 ${last.tempoRatio.toFixed(1)} : 1 (표시만)`
        : '템포 —',
      spread.count > 0
        ? `최근${spread.count}구 ${spread.meanDistance.toFixed(0)}m ±${spread.sdDistance.toFixed(0)}m`
        : `기준 ${player.power.softRate.toFixed(0)}-${player.power.hardRate.toFixed(0)}°/s`,
      spread.count > 0
        ? `좌우 ${signed(spread.meanLine, 1)}m ±${spread.sdLine.toFixed(1)}m`
        : `클럽 ${CLUB_NAMES[player.club]}`,
    ];
  }

  /**
   * The line that always says what the game is waiting for.
   *
   * A game that is waiting and a game that is broken look the same from across
   * a room, and every state this scene can sit in is named here.
   */
  private waitingLine(): string {
    const state = this.state;
    if (session.players.length === 0) return '폰을 연결하세요';
    if (state.phase === 'over') return '라운드 종료 — 잠시 뒤 로비로 (A: 다시)';
    if (state.phase === 'hole_over') {
      return `${state.hole}홀 종료 — ${Math.max(0, Math.ceil(state.timer))}초 뒤 다음 홀`;
    }

    const rolling = state.players.filter(
      (player) => player.flight !== null || player.pending !== null,
    );
    if (rolling.length > 0) {
      return `공이 멈추기를 기다리는 중 — ${rolling.map((p) => this.nameOf(p.id)).join(', ')}`;
    }

    if (state.config.turnBased) {
      const id = shooter(state);
      if (id === null) return '칠 사람이 없음 — 폰 연결을 기다리는 중';
      const player = findPlayer(state, id);
      if (player && !player.grip) {
        return `${this.nameOf(id)} 그립 대기 — 폰을 들고 0.4초 가만히`;
      }
      const left = Math.max(0, Math.ceil(state.order.timeoutSeconds - state.order.elapsed));
      return `${this.nameOf(id)} 차례 — 스윙을 기다리는 중 (${left}초)`;
    }

    const ungripped = state.players.filter((player) => player.present && !player.grip);
    if (ungripped.length > 0) {
      return `${ungripped.map((p) => this.nameOf(p.id)).join(', ')} 그립 대기 — 폰을 들고 0.4초 가만히`;
    }
    return state.drill === 'range'
      ? '아무나 치세요 — 스윙을 기다리는 중'
      : '아무나 퍼팅하세요 — 스트로크를 기다리는 중';
  }

  /**
   * The overlay, and the scorecard.
   *
   * showWaiting covers the middle of the field, so it is raised only when
   * nothing can happen at all: one straggler out of four is named on the
   * waiting line instead of stopping the three who are ready.
   */
  private renderOverlay(): void {
    const state = this.state;
    const missing = state.seats.filter(
      (id) => !session.players.some((player) => player.id === id && player.present),
    );

    if (state.config.turnBased && missing.length > 0) {
      this.showWaiting(
        `${missing.map((id) => this.nameOf(id)).join(', ')} 폰 연결 대기 중\n점수와 카드는 그대로입니다`,
      );
    } else if (state.players.length === 0) {
      this.showWaiting('폰을 연결하세요\n(?fake=1 로 키보드 사용)');
    } else if (this.nobodyCanAct()) {
      this.showWaiting('폰을 편하게 들고 0.4초 가만히\n그 자세가 조준의 기준이 됩니다');
    } else {
      this.showWaiting(null);
    }

    if (state.phase === 'over') {
      this.resultText.setVisible(true).setText(this.finalCard());
      return;
    }
    if (state.phase === 'hole_over') {
      this.resultText.setVisible(true).setText(this.holeCard());
      return;
    }
    this.resultText.setVisible(false);
  }

  private nobodyCanAct(): boolean {
    const here = this.state.players.filter((player) => player.present);
    if (here.length === 0) return true;
    if (this.state.config.turnBased) {
      const id = shooter(this.state);
      if (id === null) return true;
      const player = findPlayer(this.state, id);
      return player === undefined || player.grip === null;
    }
    return here.every((player) => !player.grip);
  }

  private holeCard(): string {
    const hole = this.state.course[this.state.hole - 1];
    const par = hole?.par ?? 0;
    const lines = this.state.seats.map((id) => {
      const strokes = findPlayer(this.state, id)?.card[this.state.hole - 1] ?? null;
      if (strokes === null) return `${this.nameOf(id)}  기록 없음`;
      return `${this.nameOf(id)}  ${strokes}타  ${HOLE_TERMS[termFor(strokes, par)]}`;
    });
    return [`${this.state.hole}홀 결과 (파 ${par})`, ...lines].join('\n');
  }

  private finalCard(): string {
    const lines = leaderboard(this.state).map(
      (card, index) =>
        `${index + 1}  ${this.nameOf(card.playerId)}  ${card.total}타 ` +
        `(${signed(card.toPar, 0)})  ${card.holesPlayed}홀`,
    );
    return ['라운드 종료', ...lines].join('\n');
  }

  private renderStatus(): void {
    const state = this.state;
    const players = state.players
      .map(
        (player) =>
          `P${player.id} ${player.strokes}타 ${player.lie} ` +
          `${player.ball.x.toFixed(1)},${player.ball.y.toFixed(1)}`,
      )
      .join('  ');
    session.status =
      `golf ${state.config.mode} ${state.phase}  ` +
      (state.config.mode === 'practice'
        ? `연습 ${state.drill}  `
        : `${state.hole}/${state.config.holes}홀  `) +
      `차례 ${shooter(state) ?? '-'}  ${players}`;
  }
}
