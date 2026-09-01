import type Phaser from 'phaser';
import { session } from '../../session.js';
import { BaseGameScene } from './BaseGameScene.js';
import type { GameAction } from '../../input/types.js';
import { sfx } from '../../ui/audio.js';
import {
  CARVE,
  EDGE_FULL_DEG,
  POOR_GRIP,
  createSki,
  findRacer,
  idealEdgeDeg,
  idealX,
  presentRacers,
  readPose,
  readStillness,
  recordedGhost,
  regrip,
  resultSeconds,
  skiConfigFor,
  standings,
  stepSki,
  syncRacers,
  type GhostRun,
  type Racer,
  type SkiDrill,
  type SkiEvent,
  type SkiState,
} from './skiState.js';

/**
 * Alpine Ski: the phone is the skier, and leaning it is the whole game.
 *
 * Every rule lives in skiState.ts. This scene feeds that module the gravity
 * readings arriving as GameActions, draws the state it hands back, and turns
 * the events it returns into sound and vibration. It decides nothing about the
 * race itself — not a gate, not a penalty, not a finish (ARCHITECTURE.md 8, P4).
 *
 * The one thing it does own is the view, and the view is the reason the game is
 * playable at all: the racer sits low on screen with the next two gates above
 * them, because a gate that appears at the moment it has to be skied cannot be
 * skied.
 */

/** Where a best run is kept between visits, so a ghost survives the lobby. */
const GHOST_KEY = 'skiBest';

interface BestRun {
  readonly ghost: GhostRun;
  /** Elapsed plus penalties, which is what the record actually is. */
  readonly seconds: number;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * How much hill is on screen, metres.
 *
 * Straight running settles at 21.9 m/s (skiState DRAG), so this is five seconds
 * of hill. Less than that and a gate arrives with no time to set an edge for
 * it; much more and the 9 m corridor stops being a shape anyone can read from
 * a sofa.
 */
const VIEW_METRES = 110;

/**
 * How much of the view is downhill of the leader.
 *
 * Gates come every 42 m, so two of them are always in sight ahead. The
 * remaining 24 m behind is where racers who are not leading get drawn.
 */
const AHEAD_METRES = 86;

/** Metres between samples of the drawn line. The line eases, so this is smooth. */
const LINE_STEP_METRES = 4;

/** Nothing on a TV across a room goes below this (ARCHITECTURE.md 10). */
const SMALL_TEXT = '22px';

const GREY = '#98a0b3';
const WARN = '#ffa502';
const GOOD = '#2ed573';

interface Card {
  readonly container: Phaser.GameObjects.Container;
  readonly valueText: Phaser.GameObjects.Text;
  readonly detail: readonly Phaser.GameObjects.Text[];
  /** Where this player's edge is right now. */
  readonly needle: Phaser.GameObjects.Rectangle;
  /** Where the line wants it, drawn only where the line is drawn. */
  readonly target: Phaser.GameObjects.Rectangle;
  /** The racer's name over their marker on the hill. */
  readonly marker: Phaser.GameObjects.Text;
  readonly gaugeHalf: number;
  readonly color: string;
}

/** Signed degrees, rounded, with the sign kept: it is which edge, not how much. */
function deg(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return '0°';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}°`;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export class Ski extends BaseGameScene {
  private state!: SkiState;
  /** Which practice drill is loaded. Races ignore it (skiConfigFor does). */
  private drill!: SkiDrill;
  private view!: Rect;
  private cardArea!: Rect;
  private slope!: Phaser.GameObjects.Graphics;
  private headerText!: Phaser.GameObjects.Text;
  private legendText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private gateText!: Phaser.GameObjects.Text;
  private ghostText!: Phaser.GameObjects.Text;
  private finishText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private readonly cards = new Map<number, Card>();

  constructor() {
    super('ski');
  }

  protected build(): void {
    const { width, height } = this.scale;
    // A restarted scene is the same object with the same fields, which is how
    // the lobby lost its QR code and a match its winner screen. Everything a
    // run owns is written here.
    this.drill = 'lane';
    this.view = { x: 24, y: 62, w: 716, h: 596 };
    this.cardArea = { x: 760, y: 62, w: width - 760 - 24, h: 596 };
    this.cards.clear();

    this.add.rectangle(
      this.view.x + this.view.w / 2,
      this.view.y + this.view.h / 2,
      this.view.w,
      this.view.h,
      0x141821,
    );
    this.slope = this.add.graphics();

    this.headerText = this.add
      .text(24, 14, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '30px',
        color: '#f1f3f8',
      })
      .setOrigin(0, 0);
    this.legendText = this.add
      .text(430, 22, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: SMALL_TEXT,
        color: GREY,
      })
      .setOrigin(0, 0);
    this.clockText = this.add
      .text(width - 24, 12, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '34px',
        color: '#f1f3f8',
      })
      .setOrigin(1, 0);

    this.phaseText = this.add
      .text(this.view.x + this.view.w / 2, this.view.y + 110, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '72px',
        color: '#f1f3f8',
        align: 'center',
      })
      .setOrigin(0.5);

    // The one thing that says what just happened at a gate, on the swinger's
    // own side of the piste so four racers do not have to guess whose it was.
    this.gateText = this.add
      .text(0, 0, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '30px',
        color: WARN,
      })
      .setOrigin(0.5)
      .setAlpha(0);

    this.ghostText = this.add
      .text(0, 0, '고스트', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: SMALL_TEXT,
        color: GREY,
      })
      .setOrigin(0.5, 1)
      .setVisible(false);

    this.finishText = this.add
      .text(0, 0, '결승선', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: SMALL_TEXT,
        color: GOOD,
      })
      .setOrigin(0.5, 1)
      .setVisible(false);

    this.statusText = this.add
      .text(24, height - 34, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#f1f3f8',
      })
      .setOrigin(0, 0);
    this.hintText = this.add
      .text(width - 24, height - 30, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: SMALL_TEXT,
        color: GREY,
      })
      .setOrigin(1, 0);

    this.startRun();

    this.onCleanup(
      session.onPlayersChanged(() => {
        // Scores, grips and distance live in the state, which keeps every racer
        // it already has: one phone joining must not restart the room's run.
        this.syncRoster();
      }),
    );
  }

  protected override onGameAction(action: GameAction): void {
    switch (action.kind) {
      case 'pose':
        // Gravity, not angles: roll is an atan2 that blows up as the phone
        // stands on end, and this game is played by rolling the phone.
        readPose(this.state, action.playerId, action.up, this.time.now);
        return;
      case 'stillness':
        // A stalled phone is not a phone being held still, and only the input
        // layer can tell them apart.
        readStillness(
          this.state,
          action.playerId,
          action.steadyMs,
          action.stalled,
          this.time.now,
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
    this.cards.clear();
  }

  protected step(dt: number): void {
    this.play(stepSki(this.state, dt, this.time.now));
    this.render();

    // A run that ended while everyone had put their phone down would otherwise
    // sit there until somebody found the keyboard.
    if (this.state.phase === 'finish') this.returnToLobbyAfter(12);

    const edges = this.state.racers
      .map((racer) => `P${racer.id} ${racer.edgeDeg.toFixed(0)}° y${racer.y.toFixed(0)}`)
      .join(' ');
    session.status =
      `ski ${this.state.phase} ${this.state.config.label}  ` +
      `t ${this.state.t.toFixed(2)}s  ${edges}`;
  }

  /**
   * Load a course and put the current room on the start line.
   *
   * Also the answer to A after a run and to B between drills: both want the
   * same course reloaded from the top, and both want the best ghost re-read,
   * because the run that just ended may have become it.
   */
  private startRun(): void {
    this.state = createSki(skiConfigFor(this.mode, this.drill), this.bestGhost());
    this.syncRoster();
  }

  private syncRoster(): void {
    syncRacers(
      this.state,
      session.players.map((player) => ({ id: player.id, present: player.present })),
    );
    this.rebuildCards();
  }

  /** A is the re-zero, and after a run it is another run. */
  private pressButton(playerId: number, button: string): void {
    if (button === 'B' && !this.state.config.timed) {
      // Only where there is no clock, which is the practice modes: swapping the
      // course under a race would throw away the time it was being run for.
      this.drill = this.drill === 'lane' ? 'gate' : 'lane';
      this.startRun();
      session.vibrate(playerId, [40]);
      session.log(`드릴 ${this.state.config.label}`);
      return;
    }
    if (button !== 'A') return;

    if (this.state.phase === 'finish') {
      this.startRun();
      session.vibrate(playerId, [40]);
      return;
    }
    if (!regrip(this.state, playerId, this.time.now)) {
      // No readings yet means the phone has not sent a single frame, so there
      // is nothing to buzz and nothing to zero.
      session.log(`재영점 실패 P${playerId} (센서 값 없음)`);
      return;
    }
    const racer = findRacer(this.state, playerId);
    const power = racer?.gripPower ?? 0;
    sfx.tick();
    // A grip with no roll left in it is the failure the player has to be told
    // about here rather than halfway down the course, and it has to feel
    // different in the hand from a grip that was accepted.
    session.vibrate(playerId, power < POOR_GRIP ? [25, 60, 25] : [40]);
    session.log(`재영점 P${playerId} 여유 ${Math.round(power * 100)}%`);
  }

  /**
   * Sound and vibration, which are the only two things the rules cannot do.
   *
   * Every case here is driven by an event the module returned. Nothing in this
   * method looks at a gate, a corridor or a clock to decide what happened.
   */
  private play(events: readonly SkiEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'grip':
          sfx.tick();
          session.vibrate(event.playerId, event.power < POOR_GRIP ? [25, 60, 25] : [40]);
          session.log(`그립 P${event.playerId} 여유 ${Math.round(event.power * 100)}%`);
          break;
        case 'start':
          sfx.wall();
          // In the hand, not on the screen: at the gate a racer is looking at
          // the course rather than at the countdown.
          for (const racer of presentRacers(this.state)) session.vibrate(racer.id, [60]);
          break;
        case 'gate':
          if (event.passed) {
            sfx.tick();
            session.vibrate(event.playerId, [30]);
          } else {
            sfx.whiff();
            // A miss that costs seconds has to feel heavier than one that does
            // not, because in practice and after a stall it costs nothing.
            session.vibrate(event.playerId, event.penalty > 0 ? [40, 60, 120] : [25, 60, 25]);
          }
          this.showGateFeedback(event.playerId, event.passed, event.penalty);
          break;
        case 'steering':
          // Both edges matter: losing steering is a thing the player has to
          // notice, and getting it back is the thing they are waiting for. The
          // return is silent because the first one of a run lands in the same
          // frame as the grip that caused it, and two ticks on top of each
          // other read as a fault rather than as a confirmation.
          if (event.lost) sfx.whiff();
          else session.vibrate(event.playerId, [30]);
          break;
        case 'drift':
          sfx.whiff();
          session.vibrate(event.playerId, [25, 60, 25, 60, 25]);
          session.log(`그립 밀림 P${event.playerId} ${Math.round(event.edgeDeg)}°`);
          break;
        case 'finish':
          sfx.point();
          session.vibrate(event.playerId, [200]);
          this.rememberGhost(event.playerId);
          session.log(
            `완주 P${event.playerId} ${event.seconds.toFixed(2)}초 ` +
              `(벌점 ${event.penaltySeconds.toFixed(0)}초)`,
          );
          break;
        case 'retired':
          sfx.whiff();
          session.vibrate(event.playerId, [200]);
          session.log(`리타이어 P${event.playerId}`);
          break;
        case 'over':
          sfx.win();
          break;
      }
    }
  }

  /** Keep this run only if it beat the one already stored. */
  private rememberGhost(playerId: number): void {
    if (!this.state.config.ghostEnabled) return;
    const ghost = recordedGhost(this.state, playerId);
    const racer = findRacer(this.state, playerId);
    const seconds = racer ? resultSeconds(racer) : null;
    if (!ghost || seconds === null) return;

    const key = `${GHOST_KEY}:${playerId}`;
    const best = this.registry.get(key) as BestRun | undefined;
    if (best && best.seconds <= seconds) return;
    this.registry.set(key, { ghost, seconds });
    session.log(`최고 기록 P${playerId} ${seconds.toFixed(2)}초`);
  }

  /**
   * The ghost to race, which is this phone's own best run.
   *
   * Only the time trial has one, and only one phone plays it, so the ghost
   * belongs to whoever is holding a phone right now. createSki drops it in
   * every other mode.
   */
  private bestGhost(): GhostRun | null {
    const owner = session.presentPlayers[0]?.id ?? session.players[0]?.id;
    if (owner === undefined) return null;
    const best = this.registry.get(`${GHOST_KEY}:${owner}`) as BestRun | undefined;
    return best?.ghost ?? null;
  }

  private rebuildCards(): void {
    for (const card of this.cards.values()) {
      card.container.destroy();
      card.marker.destroy();
    }
    this.cards.clear();

    const players = session.players;
    const gap = 8;
    const count = Math.max(1, players.length);
    // Capped so a single racer does not get a card half the screen tall with
    // three lines of text floating in the middle of it.
    const height = Math.min(168, (this.cardArea.h - gap * (count - 1)) / count);
    const gaugeHalf = (this.cardArea.w - 40) / 2;

    players.forEach((player, index) => {
      const color = Number(`0x${player.color.slice(1)}`);
      const gaugeY = height - 18;
      const panel = this.add
        .rectangle(this.cardArea.w / 2, height / 2, this.cardArea.w, height, 0x171b24)
        .setStrokeStyle(2, color);
      const nameText = this.add.text(14, 10, player.name, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: player.color,
      });
      const valueText = this.add
        .text(this.cardArea.w - 14, 6, '', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '30px',
          color: '#f1f3f8',
        })
        .setOrigin(1, 0);
      const detail = [0, 1].map((row) =>
        this.add.text(14, 46 + row * 28, '', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: SMALL_TEXT,
          color: '#c3c9d6',
        }),
      );
      const track = this.add.rectangle(this.cardArea.w / 2, gaugeY, gaugeHalf * 2, 8, 0x232838);
      const centreMark = this.add.rectangle(this.cardArea.w / 2, gaugeY, 2, 22, 0x39415a);
      const target = this.add.rectangle(this.cardArea.w / 2, gaugeY, 6, 30, 0x4f6bff);
      const needle = this.add.rectangle(this.cardArea.w / 2, gaugeY, 12, 22, color);

      const container = this.add.container(this.cardArea.x, this.cardArea.y + index * (height + gap), [
        panel,
        nameText,
        valueText,
        ...detail,
        track,
        centreMark,
        target,
        needle,
      ]);
      // A name is what four people in a room recognise; a colour alone is not
      // enough on a TV, and one of them is always sitting too far away.
      const marker = this.add
        .text(0, 0, player.name.slice(0, 6), {
          fontFamily: 'system-ui, sans-serif',
          fontSize: SMALL_TEXT,
          color: player.color,
        })
        .setOrigin(0.5, 1);

      this.cards.set(player.id, {
        container,
        valueText,
        detail,
        needle,
        target,
        marker,
        gaugeHalf,
        color: player.color,
      });
    });
  }

  /**
   * Where the view is looking, in metres down the hill.
   *
   * The furthest racer, including the ones who have finished or retired. A
   * maximum over values that never decrease never decreases either, so the
   * course scrolls one way at one speed and the picture cannot jump backwards
   * when the lead changes hands.
   */
  private cameraY(): number {
    let lead = 0;
    for (const racer of this.state.racers) lead = Math.max(lead, racer.y);
    return lead;
  }

  private slopeX(metres: number): number {
    const half = this.state.config.laneHalfWidth;
    return this.view.x + this.view.w / 2 + (metres / half) * (this.view.w / 2);
  }

  private slopeY(metres: number, camera: number): number {
    return this.view.y + (camera + AHEAD_METRES - metres) * (this.view.h / VIEW_METRES);
  }

  private drawSlope(): void {
    const graphics = this.slope;
    const { config } = this.state;
    const camera = this.cameraY();
    const from = camera - (VIEW_METRES - AHEAD_METRES);
    const to = camera + AHEAD_METRES;
    graphics.clear();

    graphics.lineStyle(3, 0x39415a, 1);
    graphics.lineBetween(this.view.x + 1, this.view.y, this.view.x + 1, this.view.y + this.view.h);
    graphics.lineBetween(
      this.view.x + this.view.w - 1,
      this.view.y,
      this.view.x + this.view.w - 1,
      this.view.y + this.view.h,
    );

    if (config.showsLine) this.drawIdealLine(from, to, camera);
    this.drawGates(from, to, camera);

    if (config.courseLength >= from && config.courseLength <= to) {
      const y = this.slopeY(config.courseLength, camera);
      graphics.lineStyle(6, 0x2ed573, 0.9);
      graphics.lineBetween(this.view.x, y, this.view.x + this.view.w, y);
      this.finishText.setVisible(true).setPosition(this.view.x + this.view.w / 2, y - 6);
    } else {
      this.finishText.setVisible(false);
    }

    const ghost = this.state.ghostPos;
    if (ghost && this.state.phase === 'run' && ghost.y >= from && ghost.y <= to) {
      const gx = this.slopeX(ghost.x);
      const gy = this.slopeY(ghost.y, camera);
      graphics.lineStyle(3, 0x98a0b3, 0.9);
      graphics.strokeCircle(gx, gy, 13);
      this.ghostText.setVisible(true).setPosition(gx, gy - 16);
    } else {
      this.ghostText.setVisible(false);
    }

    for (const racer of this.state.racers) this.drawRacer(racer, camera);
  }

  private drawIdealLine(from: number, to: number, camera: number): void {
    const graphics = this.slope;
    graphics.lineStyle(5, 0x4f6bff, 0.5);
    let previousX = this.slopeX(idealX(this.state.config, from));
    let previousY = this.slopeY(from, camera);
    for (let y = from + LINE_STEP_METRES; y <= to; y += LINE_STEP_METRES) {
      const x = this.slopeX(idealX(this.state.config, y));
      const screenY = this.slopeY(y, camera);
      graphics.lineBetween(previousX, previousY, x, screenY);
      previousX = x;
      previousY = screenY;
    }
  }

  private drawGates(from: number, to: number, camera: number): void {
    const graphics = this.slope;
    for (const gate of this.state.config.gates) {
      if (gate.y < from - 2 || gate.y > to + 2) continue;
      const y = this.slopeY(gate.y, camera);
      const left = this.slopeX(gate.x - gate.halfWidth);
      const right = this.slopeX(gate.x + gate.halfWidth);

      graphics.lineStyle(4, 0x6c7590, 0.9);
      graphics.lineBetween(left, y, right, y);
      graphics.fillStyle(0xf1f3f8, 1);
      graphics.fillRect(left - 5, y - 22, 10, 44);
      graphics.fillRect(right - 5, y - 22, 10, 44);

      // Which way the course turns here, as an arrow rather than as a colour:
      // half the room is watching from an angle and a colour-blind player is
      // not a special case (ARCHITECTURE.md 10).
      const direction = gate.side === 'right' ? 1 : -1;
      const centre = this.slopeX(gate.x);
      graphics.fillStyle(0xffa502, 0.9);
      graphics.fillTriangle(
        centre + direction * 28,
        y,
        centre + direction * 6,
        y - 16,
        centre + direction * 6,
        y + 16,
      );
    }
  }

  private drawRacer(racer: Racer, camera: number): void {
    const card = this.cards.get(racer.id);
    const graphics = this.slope;
    const x = this.slopeX(racer.x);
    const trueY = this.slopeY(racer.y, camera);
    const y = clamp(trueY, this.view.y + 26, this.view.y + this.view.h - 12);
    // A racer far enough behind the leader to be off the view is still drawn,
    // pinned to the edge and dimmed: vanishing entirely reads as having been
    // dropped from the race, which is what retiring looks like and this is not.
    const pinned = Math.abs(trueY - y) > 0.5;

    // The skis point where the steering equation is actually pointing them:
    // dx/dy is edge * CARVE, so this is the same number the physics uses.
    const heading = Math.atan(racer.edge * CARVE);
    const sin = Math.sin(heading);
    const cos = Math.cos(heading);
    const point = (dx: number, dy: number): { x: number; y: number } => ({
      x: x + dx * cos - dy * sin,
      y: y + dx * sin + dy * cos,
    });
    const tip = point(0, -20);
    const leftTail = point(-13, 14);
    const rightTail = point(13, 14);

    const colour = card ? Number(`0x${card.color.slice(1)}`) : 0x98a0b3;
    // Grey is the whole report on a phone that stopped answering: the racer
    // keeps their last edge and slides on, and that has to be visible.
    const body = racer.steering && !racer.dnf ? colour : 0x6c7590;
    graphics.fillStyle(body, racer.dnf ? 0.35 : pinned ? 0.6 : 1);
    graphics.fillTriangle(tip.x, tip.y, leftTail.x, leftTail.y, rightTail.x, rightTail.y);

    if (racer.driftWarning) {
      graphics.lineStyle(3, 0xffa502, 0.95);
      graphics.strokeCircle(x, y, 30);
    }

    card?.marker
      .setVisible(true)
      .setPosition(x, y - 26)
      .setAlpha(racer.dnf ? 0.4 : 1);
  }

  private showGateFeedback(playerId: number, passed: boolean, penalty: number): void {
    const racer = findRacer(this.state, playerId);
    const name = this.nameOf(playerId);
    const text = passed
      ? `${name} 통과`
      : penalty > 0
        ? `${name} 놓침 +${penalty.toFixed(0)}초`
        : `${name} 놓침`;
    this.gateText
      .setText(text)
      .setColor(passed ? GOOD : WARN)
      .setPosition(
        clamp(
          racer ? this.slopeX(racer.x) : this.view.x + this.view.w / 2,
          this.view.x + 110,
          this.view.x + this.view.w - 110,
        ),
        this.view.y + this.view.h * 0.45,
      )
      .setAlpha(1);
    this.tweens.killTweensOf(this.gateText);
    this.tweens.add({ targets: this.gateText, alpha: 0, duration: 700, delay: 500 });
  }

  private render(): void {
    const { config } = this.state;
    this.drawSlope();

    this.headerText.setText(`ALPINE SKI — ${config.label}`);
    this.legendText.setText(
      config.showsLine
        ? '+ 오른쪽 엣지 / − 왼쪽 엣지   ·   파란 선이 이상적인 주행 라인'
        : '+ 오른쪽 엣지 / − 왼쪽 엣지',
    );
    // Practice has no clock at all by design, so it gets the one number that is
    // still true there: how much hill is left.
    this.clockText.setText(
      config.timed
        ? `${this.state.t.toFixed(2)}초`
        : `${Math.max(0, config.courseLength - this.cameraY()).toFixed(0)} m`,
    );

    this.phaseText.setText(this.phaseMessage());
    this.statusText.setText(this.waitingLine());
    this.hintText.setText(
      config.timed
        ? 'A: 그립 다시 잡기   ·   HOME/ESC: 로비'
        : 'A: 그립 다시 잡기   ·   B: 드릴 바꾸기   ·   HOME/ESC: 로비',
    );
    this.showWaiting(this.blockingMessage());

    for (const racer of this.state.racers) this.updateCard(racer);
  }

  private updateCard(racer: Racer): void {
    const card = this.cards.get(racer.id);
    if (!card) return;
    const { config } = this.state;
    const ideal = idealEdgeDeg(config, racer.y);

    card.container.setAlpha(racer.dnf ? 0.45 : 1);
    card.valueText.setText(this.cardValue(racer));
    card.valueText.setColor(racer.finished ? GOOD : '#f1f3f8');

    const warning = this.warningFor(racer);
    const lines = this.cardDetail(racer, ideal);
    card.detail[0]?.setText(lines[0] ?? '').setColor('#c3c9d6');
    card.detail[1]
      ?.setText(warning ?? lines[1] ?? '')
      .setColor(warning === null ? '#c3c9d6' : WARN);

    // The gauge is the same two numbers as the text, for anyone who reads a
    // position faster than a figure: where the edge is, and where the line
    // wants it. The target only exists where the line is drawn.
    card.needle.setX(
      this.cardArea.w / 2 + clamp(racer.edgeDeg / EDGE_FULL_DEG, -1, 1) * card.gaugeHalf,
    );
    card.needle.setFillStyle(racer.steering ? Number(`0x${card.color.slice(1)}`) : 0x6c7590);
    card.target
      .setVisible(config.showsLine && this.state.phase === 'run')
      .setX(this.cardArea.w / 2 + clamp(ideal / EDGE_FULL_DEG, -1, 1) * card.gaugeHalf);
  }

  private cardValue(racer: Racer): string {
    const { config } = this.state;
    if (config.timed) {
      const result = resultSeconds(racer);
      if (result !== null) return `${result.toFixed(2)}초`;
      if (racer.dnf) return '기록 없음';
      return `${this.state.t.toFixed(2)}초`;
    }
    // Practice leads with the number the player is actually producing.
    return `엣지 ${deg(racer.edgeDeg)}`;
  }

  /**
   * The two lines under the name.
   *
   * Practice puts the player's own measurements on screen — what their lean
   * measured, what the line asked for, and the gap between them — because a
   * player who cannot see that has no way to tell a bad turn from a turn the
   * game never received, which is the complaint this platform keeps hearing.
   */
  private cardDetail(racer: Racer, ideal: number): readonly string[] {
    const { config } = this.state;
    if (config.timed) {
      const judged = racer.gateResults.length;
      const passed = judged - racer.missed;
      return [
        `게이트 ${passed}/${config.gates.length}   벌점 +${racer.penaltySeconds.toFixed(0)}초   ` +
          `속도 ${racer.speed.toFixed(1)} m/s`,
        `${this.placeLine(racer)}   엣지 ${deg(racer.edgeDeg)}   ` +
          `남은 거리 ${Math.max(0, config.courseLength - racer.y).toFixed(0)} m`,
      ];
    }

    const first = config.showsLine
      ? `필요 ${deg(ideal)}   차이 ${deg(racer.edgeDeg - ideal)}   속도 ${racer.speed.toFixed(1)} m/s`
      : `속도 ${racer.speed.toFixed(1)} m/s`;
    const grip = `그립 여유 ${Math.round(racer.gripPower * 100)}%`;
    if (!config.judgeGates) {
      return [first, `${grip}   내려온 거리 ${racer.y.toFixed(0)} / ${config.courseLength.toFixed(0)} m`];
    }
    const judged = racer.gateResults.length;
    const last = racer.gateResults[judged - 1];
    const lastLine =
      last === undefined
        ? '첫 게이트 전'
        : `마지막 게이트 ${last.passed ? '통과' : '놓침'} ` +
          `${last.offBy >= 0 ? '오른쪽' : '왼쪽'} ${Math.abs(last.offBy).toFixed(1)} m`;
    return [first, `${grip}   ${judged - racer.missed}/${judged} 통과   ${lastLine}`];
  }

  /** Where this racer stands, once there is anyone to stand against. */
  private placeLine(racer: Racer): string {
    const ghost = this.state.ghost;
    if (ghost && this.state.ghostPos) {
      const gap = this.state.ghostPos.y - racer.y;
      return `고스트 ${gap >= 0 ? '앞서' : '뒤져'} ${Math.abs(gap).toFixed(0)} m`;
    }
    const place = standings(this.state).findIndex((other) => other.id === racer.id) + 1;
    return `${place}위`;
  }

  /** The single most urgent thing wrong with this racer, or nothing. */
  private warningFor(racer: Racer): string | null {
    if (racer.dnf) return '리타이어 — 기록은 남아 있습니다';
    if (!racer.present) {
      const left = this.state.config.absentGraceSeconds - racer.absentSeconds;
      return `폰 연결 끊김 — ${Math.max(0, left).toFixed(0)}초 뒤 리타이어`;
    }
    if (racer.finished) return null;
    if (racer.grip === null) return '폰을 편하게 들고 가만히 (또는 A)';
    if (!racer.steering) return '조향 없음 — 폰 응답을 기다리는 중';
    if (racer.driftWarning) return `그립이 밀렸습니다 ${deg(racer.edgeDeg)} — A로 재영점`;
    if (racer.gripPower < POOR_GRIP) return '폰이 너무 눕혀졌습니다 — 세워 잡고 A';
    return null;
  }

  /**
   * The line that always says what the game is waiting for.
   *
   * A game that is waiting and a game that has frozen look identical from a
   * sofa. This is the difference.
   */
  private waitingLine(): string {
    const { state } = this;
    if (session.players.length === 0) return '폰 연결을 기다리는 중 — 로비 QR로 접속하세요';

    const present = presentRacers(state);
    if (present.length === 0) return '폰 응답을 기다리는 중 — 기록은 그대로입니다';

    if (state.phase === 'ready') {
      const missing = present.filter((racer) => racer.grip === null);
      if (missing.length > 0) {
        const auto = Math.max(0, state.config.autoStartSeconds - state.readyFor);
        return (
          `그립을 기다리는 중: ${this.namesOf(missing)} — 폰을 편한 자세로 들고 가만히 ` +
          `(${auto.toFixed(0)}초 뒤 자동 출발)`
        );
      }
      return `출발까지 ${Math.max(0, state.countdown).toFixed(1)}초`;
    }

    if (state.phase === 'run') {
      const gone = state.racers.filter(
        (racer) => !racer.present && !racer.dnf && !racer.finished,
      );
      if (gone.length > 0) {
        const worst = Math.min(...gone.map((racer) => racer.absentSeconds));
        const left = Math.max(0, state.config.absentGraceSeconds - worst);
        return `${this.namesOf(gone)} 폰 응답 없음 — ${left.toFixed(0)}초 더 기다립니다`;
      }
      const left = Math.max(0, state.config.courseLength - this.cameraY());
      return `완주를 기다리는 중 — 결승선까지 ${left.toFixed(0)} m`;
    }

    return 'A: 다시 달리기   ·   HOME: 로비 (잠시 뒤 자동으로 돌아갑니다)';
  }

  /** What is standing between this room and a run, if anything. */
  private blockingMessage(): string | null {
    if (session.players.length === 0) return '폰을 연결하세요\n(?fake=1 로 키보드 사용)';

    const present = presentRacers(this.state);
    if (present.length === 0) return '폰 연결 대기 중…\n기록은 그대로입니다';

    if (this.state.phase === 'ready') {
      const missing = present.filter((racer) => racer.grip === null);
      if (missing.length > 0) {
        return `${this.namesOf(missing)} 그립 대기 중\n폰을 편한 자세로 들고 가만히`;
      }
    }
    return null;
  }

  private phaseMessage(): string {
    const { state } = this;
    if (state.phase === 'ready') {
      const counting = state.countdown < state.config.countdownSeconds;
      return counting ? `${Math.ceil(state.countdown)}` : '';
    }
    if (state.phase === 'run') return '';

    const ranked = standings(state);
    const best = ranked[0];
    if (!best) return '';
    if (!state.config.timed) return '연습 종료';
    const seconds = resultSeconds(best);
    if (seconds === null) return '완주자 없음';
    return state.racers.length > 1
      ? `${this.nameOf(best.id)} 1위 ${seconds.toFixed(2)}초`
      : `${seconds.toFixed(2)}초`;
  }

  private nameOf(playerId: number): string {
    return session.players.find((player) => player.id === playerId)?.name ?? `P${playerId}`;
  }

  private namesOf(racers: readonly Racer[]): string {
    return racers.map((racer) => this.nameOf(racer.id)).join(', ');
  }
}
