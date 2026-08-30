import Phaser from 'phaser';
import { session } from '../../session.js';
import { sfx } from '../../ui/audio.js';
import {
  HIT_ZONE,
  createTennis,
  isMatchPoint,
  step,
  swing,
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

export class Tennis extends Phaser.Scene {
  private state: TennisState = createTennis();
  private lastPlayerCount = 0;
  private ball!: Phaser.GameObjects.Arc;
  private readonly rackets = new Map<Side, Phaser.GameObjects.Rectangle>();
  private scoreText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private rallyText!: Phaser.GameObjects.Text;
  private lastPhase: TennisState['phase'] = 'serve';
  private swingFeedback!: Phaser.GameObjects.Text;
  private modeText!: Phaser.GameObjects.Text;
  private cleanup: (() => void) | null = null;

  constructor() {
    super('tennis');
  }

  create(): void {
    session.configureInput({ swing: true });

    const players = session.players;
    this.lastPlayerCount = players.length;
    this.state = createTennis({ players: players.length >= 2 ? 2 : 1 });
    this.lastPhase = this.state.phase;

    this.drawCourt();

    this.cleanup = session.onAction((action) => {
      if (action.kind === 'swing') {
        // Resolved per swing: a phone that joined after this scene started, or
        // rejoined with a new id, would otherwise have every swing silently
        // thrown away — which looks exactly like the swing never being seen.
        const side = this.sideFor(action.playerId);
        if (!side) {
          session.log(`스윙 무시 P${action.playerId} (자리 없음)`);
          return;
        }
        const result = swing(
          this.state,
          side,
          action.strength,
          action.direction8,
          action.direction,
        );
        if (result.hit) {
          sfx.hit(action.strength);
          session.vibrate(action.playerId, [Math.round(25 + action.strength * 65)]);
          this.cameras.main.shake(90, 0.002 + action.strength * 0.004);
          this.showSwingFeedback('맞음', '#2ed573');
          session.log(
            `타격 P${side} 강도 ${action.strength.toFixed(2)} ${action.direction8} ` +
              `→ 속도 ${this.state.ball.vx.toFixed(2)}`,
          );
        } else {
          // The swing was seen; it just did not connect. Saying so is the
          // difference between bad timing and a controller that looks dead.
          sfx.whiff();
          session.vibrate(action.playerId, [15]);
          this.showSwingFeedback(MISS_TEXT[result.miss ?? 'late'], '#ffa502');
          session.log(
            `빗나감 P${side} ${result.miss ?? '?'} 공x ${this.state.ball.x.toFixed(2)} ` +
              `속도 ${this.state.ball.vx.toFixed(2)}`,
          );
        }
        return;
      }
      if (action.kind === 'button_down' && action.button === 'HOME') this.scene.start('lobby');
      if (action.kind === 'button_down' && action.button === 'A' && this.state.phase === 'gameover') {
        this.scene.start('lobby');
      }
    });

    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('lobby'));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.cleanup?.();
      this.cleanup = null;
      this.rackets.clear();
    });
  }

  override update(_time: number, delta: number): void {
    // A stutter or a backgrounded tab hands us a huge delta; integrating it
    // whole would jump the ball across a side of the court and score a point
    // nobody played.
    const dt = Math.min(delta / 1000, 1 / 30);

    // One phone cannot play two-player tennis: every ball that crosses would
    // be an instant point, which reads as the game resetting itself.
    if (session.players.length !== this.lastPlayerCount) {
      session.log(`플레이어 ${this.lastPlayerCount} → ${session.players.length}, 재시작`);
      this.scene.restart();
      return;
    }

    const before = this.state.ball.vx;
    step(this.state, dt);

    // The wall in practice mode reverses the ball without anyone swinging.
    if (this.state.config.players === 1 && before > 0 && this.state.ball.vx < 0) sfx.wall();

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

    for (const side of [1, 2] as Side[]) {
      const x = side === 1 ? this.courtX(HIT_ZONE / 2) : this.courtX(1 - HIT_ZONE / 2);
      const player = session.players[side - 1];
      const color = player ? Number(`0x${player.color.slice(1)}`) : 0x555f70;
      this.rackets.set(side, this.add.rectangle(x, height / 2, 14, 90, color).setAlpha(0.9));
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
        fontSize: '18px',
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
        fontSize: '18px',
        color: '#98a0b3',
      })
      .setOrigin(0, 0);
    this.modeText.setText(
      this.state.config.players === 1
        ? '연습 (벽치기) — 폰 1대'
        : `대전 — P1 vs P2 (폰 ${session.players.length}대)`,
    );
  }

  private sideFor(playerId: number): Side | null {
    const index = session.players.findIndex((player) => player.id === playerId);
    if (index === 0) return 1;
    if (index === 1) return 2;
    return null;
  }

  private showSwingFeedback(text: string, color: string): void {
    this.swingFeedback.setText(text).setColor(color).setAlpha(1);
    this.tweens.killTweensOf(this.swingFeedback);
    this.tweens.add({ targets: this.swingFeedback, alpha: 0, duration: 700, delay: 250 });
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
      const approaching =
        side === 1 ? this.state.ball.vx <= 0 : this.state.ball.vx >= 0;
      const target = approaching ? this.courtY(this.state.ball.y) : this.courtY(0.5);
      racket.setY(Phaser.Math.Linear(racket.y, target, 0.15));
    }

    const [left, right] = this.state.score;
    this.scoreText.setText(
      this.state.config.players === 1
        ? `랠리 ${this.state.rally}   실수 ${this.state.misses}/${this.state.config.missesAllowed}`
        : `${left} : ${right}`,
    );

    this.phaseText.setText(this.phaseMessage());
    this.rallyText.setText(
      this.state.phase === 'gameover'
        ? 'A 또는 ESC: 로비로'
        : 'HOME: 로비   ·   공이 라켓 근처에 왔을 때 스윙',
    );
  }

  private phaseMessage(): string {
    switch (this.state.phase) {
      case 'serve':
        return `P${this.state.server} 서브 — 폰을 휘두르세요${isMatchPoint(this.state) ? '\n매치 포인트' : ''}`;
      case 'point':
        return this.state.config.players === 1 ? '아쉽다' : `P${this.state.lastPointTo ?? 1} 득점`;
      case 'gameover':
        return this.state.winner === null
          ? `연습 종료 — 최고 랠리 ${this.state.rally}`
          : `P${this.state.winner} 승리`;
      default:
        return '';
    }
  }
}
