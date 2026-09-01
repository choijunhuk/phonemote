import type Phaser from 'phaser';
import { session } from '../../session.js';
import { BaseGameScene } from './BaseGameScene.js';
import type { GameAction } from '../../input/types.js';
import { sfx } from '../../ui/audio.js';
import {
  HIT_ZONE,
  createTennis,
  isMatchPoint,
  step,
  swing,
  swingPower,
  type Side,
  type TennisState,
} from './tennisState.js';

/**
 * Tennis (ARCHITECTURE.md 11, Phase 3).
 *
 * All rules live in tennisState.ts; this scene draws them and translates
 * GameActions into swings. It never sees a sensor frame (P4).
 */

const COURT_MARGIN = 0.08;

const MISS_TEXT = {
  early: '너무 빨랐음',
  late: '너무 늦었음',
  'not-your-turn': '상대 서브',
} as const;

export class Tennis extends BaseGameScene {
  private state: TennisState = createTennis();
  private lastPlayerCount = 0;
  private ball!: Phaser.GameObjects.Arc;
  private readonly rackets = new Map<Side, Phaser.GameObjects.Rectangle>();
  private readonly bands = new Map<Side, Phaser.GameObjects.Rectangle>();
  private scoreText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private rallyText!: Phaser.GameObjects.Text;
  private lastPhase: TennisState['phase'] = 'serve';
  private lastShakeAt = 0;
  private waiting = false;
  private swingFeedback!: Phaser.GameObjects.Text;
  private modeText!: Phaser.GameObjects.Text;
  private readingText!: Phaser.GameObjects.Text;

  constructor() {
    super('tennis');
  }

  protected build(): void {
    // The mode comes from the lobby now. Guessing it from the number of
    // connected phones meant two phones could never practise and one phone
    // could never play a match (ARCHITECTURE.md 7.4).
    this.state = createTennis({ players: this.mode === 'versus' ? 2 : 1 });
    this.lastPlayerCount = session.presentPlayers.length;
    this.lastPhase = this.state.phase;
    this.waiting = false;
    this.lastShakeAt = 0;
    this.drawCourt();
  }

  protected override onGameAction(action: GameAction): void {
    {
      if (action.kind === 'swing') {
        // Resolved per swing: a phone that joined after this scene started, or
        // rejoined with a new id, would otherwise have every swing silently
        // thrown away — which looks exactly like the swing never being seen.
        const side = this.sideFor(action.playerId);
        if (!side) {
          session.log(`스윙 무시 P${action.playerId} (자리 없음)`);
          return;
        }
        // Practice is one player against a wall. A second phone in the room is
        // a spectator, not the wall's arm.
        if (this.state.config.players === 1 && side !== 1) {
          session.log(`스윙 무시 P${action.playerId} (연습은 P1만)`);
          return;
        }
        const result = swing(
          this.state,
          side,
          action.peakRate,
          action.direction8,
          action.direction,
        );
        // Power comes from the peak rate, not from strength: strength saturates
        // where a real swing begins, so it was 1.0 every time and every hit
        // sounded, buzzed and shook identically.
        const power = swingPower(action.peakRate);
        if (this.mode === 'practice') {
          this.readingText.setText(
            `속도 ${Math.round(action.peakRate)}°/s   파워 ${power.toFixed(2)}   ` +
              `방향 ${action.direction8}   회전 y${action.rotation.yaw.toFixed(0)} ` +
              `p${action.rotation.pitch.toFixed(0)} r${action.rotation.roll.toFixed(0)}`,
          );
        }
        if (result.hit) {
          sfx.hit(power);
          session.vibrate(action.playerId, [Math.round(25 + power * 55)]);
          // Only a genuinely hard shot is worth shaking the screen for, and
          // never twice inside 200 ms: two shakes on top of each other read as
          // the picture breaking rather than as the ball being hit hard.
          if (power > 0.7 && this.time.now - this.lastShakeAt > 200) {
            this.lastShakeAt = this.time.now;
            this.cameras.main.shake(90, 0.004 + power * 0.006);
          }
          this.showSwingFeedback('맞음', '#2ed573', side);
          session.log(
            `타격 P${side} ${Math.round(action.peakRate)}°/s (파워 ${power.toFixed(2)}) ` +
              `${action.direction8} → 속도 ${this.state.ball.vx.toFixed(2)}`,
          );
        } else if (result.miss !== null) {
          // Only when a live ball was genuinely missed. The state machine
          // reports no miss during a point or after the match, and printing
          // "too late" while the player is celebrating a point is a lie.
          sfx.whiff();
          // 15 ms is below what an Android motor can even spin up to, so a
          // whiff and a dead phone felt identical in the hand.
          session.vibrate(action.playerId, [25, 45, 25]);
          this.showSwingFeedback(MISS_TEXT[result.miss], '#ffa502', side);
          session.log(
            `빗나감 P${side} ${result.miss ?? '?'} 공x ${this.state.ball.x.toFixed(2)} ` +
              `속도 ${this.state.ball.vx.toFixed(2)}`,
          );
        }
        return;
      }
      if (action.kind === 'button_down' && action.button === 'A' && this.state.phase === 'gameover') {
        this.scene.start('lobby');
      }
    }
  }

  protected override teardown(): void {
    this.rackets.clear();
    // The bands were left holding destroyed objects, which the next run then
    // wrote to.
    this.bands.clear();
  }

  protected step(dt: number): void {
    if (session.presentPlayers.length !== this.lastPlayerCount) {
      session.log(`플레이어 ${this.lastPlayerCount} → ${session.presentPlayers.length}`);
      this.lastPlayerCount = session.presentPlayers.length;
    }

    // A phone that drops out for a moment used to restart the scene, wiping a
    // 4-3 game because of one bad second of wifi. Pause instead: the score is
    // still there when they come back.
    // Present, not known: a phone inside its rejoin window is still on the
    // roster with its score, and the game should wait rather than play on
    // without it (ARCHITECTURE.md D48).
    this.waiting = session.presentPlayers.length < this.state.config.players;
    if (this.waiting) {
      this.render();
      return;
    }

    const before = this.state.ball.vx;
    step(this.state, dt);

    // The wall in practice mode reverses the ball without anyone swinging.
    if (this.state.config.players === 1 && before > 0 && this.state.ball.vx < 0) sfx.wall();

    // Never a dead screen: a match that ended while everyone had put their
    // phone down would otherwise sit there until somebody found a keyboard.
    if (this.state.phase === 'gameover') this.returnToLobbyAfter(8);

    if (this.state.phase !== this.lastPhase) {
      if (this.state.phase === 'point') {
        sfx.point();
        session.log(
          this.state.config.players === 1
            ? `놓침 ${this.state.misses}/${this.state.config.missesAllowed} (랠리 ${this.state.rally})`
            : `득점 P${this.state.lastPointTo ?? '?'} → ${this.state.score[0]}:${this.state.score[1]}`,
        );
      }
      if (this.state.phase === 'gameover') sfx.win();
      if (this.state.phase === 'rally' && this.lastPhase === 'serve') {
        session.log(`서브 P${this.state.server} 속도 ${this.state.ball.vx.toFixed(2)}`);
      }
      this.lastPhase = this.state.phase;
    }

    this.render();
    session.status =
      `tennis ${this.state.phase}  공 ${this.state.ball.x.toFixed(2)},` +
      `${this.state.ball.y.toFixed(2)}  속도 ${this.state.ball.vx.toFixed(2)}` +
      `  서브 P${this.state.server}`;
  }

  private drawCourt(): void {
    const { width, height } = this.scale;
    const top = height * COURT_MARGIN;
    const bottom = height * (1 - COURT_MARGIN);

    this.add.rectangle(width / 2, (top + bottom) / 2, width * 0.94, bottom - top, 0x16351f);
    this.add
      .line(0, 0, width / 2, top, width / 2, bottom, 0xffffff, 0.35)
      .setOrigin(0)
      .setLineWidth(2);

    // The hit zone is the racket. A 14 px bat in the middle of a band a third
    // of the court wide told the player the window was shut while it was still
    // open, so returns kept happening in what looked like empty space.
    const solo = this.state.config.players === 1;
    for (const side of [1, 2] as Side[]) {
      if (solo && side === 2) {
        // A wall, because a wall is what actually returns the ball in practice.
        // Drawing an opponent there is why it read as one who never swung.
        this.add
          .rectangle(this.courtX(1) + 10, (top + bottom) / 2, 20, bottom - top, 0x555f70)
          .setAlpha(0.85);
        continue;
      }
      const centre = side === 1 ? this.courtX(HIT_ZONE / 2) : this.courtX(1 - HIT_ZONE / 2);
      const bandWidth = this.courtX(HIT_ZONE) - this.courtX(0);
      const color = this.colorOf(side);

      this.bands.set(
        side,
        this.add.rectangle(centre, (top + bottom) / 2, bandWidth, bottom - top, color).setAlpha(0.1),
      );
      this.rackets.set(
        side,
        this.add.rectangle(
          side === 1 ? this.courtX(HIT_ZONE) : this.courtX(1 - HIT_ZONE),
          height / 2,
          12,
          110,
          color,
        ),
      );
      this.add
        .text(centre, top + 14, `P${side}`, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '30px',
          color: session.players[side - 1]?.color ?? '#98a0b3',
        })
        .setOrigin(0.5, 0)
        .setAlpha(0.75);
    }

    this.ball = this.add.circle(width / 2, height / 2, 12, 0xf1f3f8);

    this.scoreText = this.add
      .text(width / 2, 18, '0 : 0', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '40px',
        color: '#f1f3f8',
      })
      .setOrigin(0.5, 0);

    this.phaseText = this.add
      .text(width / 2, this.scale.height * 0.5, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '44px',
        color: '#ffffff',
        align: 'center',
      })
      .setOrigin(0.5);

    this.rallyText = this.add
      .text(width / 2, this.scale.height - 26, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: '#98a0b3',
      })
      .setOrigin(0.5, 1);

    this.swingFeedback = this.add
      .text(width / 2, this.scale.height * 0.68, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '32px',
        color: '#ffa502',
      })
      .setOrigin(0.5)
      .setAlpha(0);

    this.modeText = this.add
      .text(18, 18, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '22px',
        color: '#98a0b3',
      })
      .setOrigin(0, 0);
    this.modeText.setText(
      this.state.config.players === 1
        ? '연습 (벽치기)'
        : `대전 — P1 vs P2 (폰 ${session.presentPlayers.length}대)`,
    );

    // Practice shows the numbers behind the shot. A player who cannot see what
    // their own swing measured has no way to tell a bad swing from a swing the
    // game never saw, which is the complaint this whole platform keeps hearing.
    this.readingText = this.add
      .text(18, 46, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '22px',
        color: '#98a0b3',
      })
      .setOrigin(0, 0)
      .setVisible(this.mode === 'practice');
  }

  private sideFor(playerId: number): Side | null {
    const index = session.players.findIndex((player) => player.id === playerId);
    if (index === 0) return 1;
    if (index === 1) return 2;
    return null;
  }

  private showSwingFeedback(text: string, color: string, side: Side): void {
    // On the swinger's own half, so four people in a room can tell whose miss
    // it was without guessing.
    this.swingFeedback.setPosition(
      this.courtX(side === 1 ? 0.16 : 0.84),
      this.scale.height * 0.3,
    );
    this.swingFeedback.setText(text).setColor(color).setAlpha(1);
    this.tweens.killTweensOf(this.swingFeedback);
    this.tweens.add({ targets: this.swingFeedback, alpha: 0, duration: 700, delay: 250 });
  }

  private colorOf(side: Side): number {
    const player = session.players[side - 1];
    return player ? Number(`0x${player.color.slice(1)}`) : 0x555f70;
  }

  private courtX(normalised: number): number {
    const { width } = this.scale;
    return width * 0.03 + normalised * width * 0.94;
  }

  private courtY(normalised: number): number {
    const { height } = this.scale;
    const top = height * COURT_MARGIN;
    return top + normalised * (height * (1 - 2 * COURT_MARGIN));
  }

  private render(): void {
    this.ball.setPosition(this.courtX(this.state.ball.x), this.courtY(this.state.ball.y));
    this.ball.setVisible(this.state.phase !== 'gameover');

    // Rackets track the ball vertically: the player swings, the game positions.
    for (const [side, racket] of this.rackets) {
      const approaching = side === 1 ? this.state.ball.vx <= 0 : this.state.ball.vx >= 0;
      const target = approaching ? this.courtY(this.state.ball.y) : this.courtY(0.5);
      // Frame-rate independent, so this does not chase twice as fast on a
      // 120 Hz screen as it does on a 60 Hz one.
      racket.setY(racket.y + (target - racket.y) * (1 - Math.exp(-9 * this.lastDelta)));

      // The only cue in the game that says "now": the band brightens exactly
      // while a swing on that side would connect.
      const inZone =
        this.state.phase === 'rally' &&
        (side === 1
          ? this.state.ball.vx < 0 && this.state.ball.x <= HIT_ZONE
          : this.state.ball.vx > 0 && this.state.ball.x >= 1 - HIT_ZONE);
      this.bands.get(side)?.setAlpha(inZone ? 0.24 : 0.1);
      racket.setFillStyle(inZone ? 0xffffff : this.colorOf(side));
    }

    const [left, right] = this.state.score;
    this.scoreText.setText(
      this.state.config.players === 1
        ? `랠리 ${this.state.rally}   최고 ${this.state.bestRally}   ` +
          `실수 ${this.state.misses}/${this.state.config.missesAllowed}`
        : `${left} : ${right}`,
    );

    this.phaseText.setText(
      this.waiting ? '상대 폰 연결 대기 중…\n점수는 그대로입니다' : this.phaseMessage(),
    );
    this.rallyText.setText(this.hint());
  }

  private hint(): string {
    if (this.state.phase === 'gameover') return 'A 또는 ESC: 로비로 (8초 뒤 자동)';
    // Everyone past the second phone is watching, and being told so beats
    // swinging at a game that will never answer.
    const side = this.mySides();
    if (side === 'spectator') return '관전 중 — 테니스는 P1, P2만 칩니다';
    if (this.state.rally >= 3) return `랠리 ${this.state.rally}`;
    return 'HOME: 로비   ·   밴드가 밝아지면 휘두르기';
  }

  /** Whether anyone in the room is only watching. */
  private mySides(): 'players' | 'spectator' {
    return session.players.length > this.state.config.players ? 'spectator' : 'players';
  }

  private phaseMessage(): string {
    switch (this.state.phase) {
      case 'serve':
        return `P${this.state.server} 서브 — 폰을 휘두르세요${isMatchPoint(this.state) ? '\n매치 포인트' : ''}`;
      case 'point':
        return this.state.config.players === 1 ? '아쉽다' : `P${this.state.lastPointTo ?? 1} 득점`;
      case 'gameover':
        return this.state.winner === null
          ? `연습 종료 — 최고 랠리 ${this.state.bestRally}`
          : `P${this.state.winner} 승리`;
      default:
        return '';
    }
  }
}
