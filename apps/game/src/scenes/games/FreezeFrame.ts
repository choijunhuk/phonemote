import Phaser from 'phaser';
import { session } from '../../session.js';
import type { CanonicalVector } from '../../input/types.js';
import { sfx } from '../../ui/audio.js';
import {
  alivePlayers,
  calibrate,
  createFreeze,
  everyoneReady,
  holdProgress,
  leader,
  readPose,
  startRound,
  stepFreeze,
  syncPlayers,
  type FreezeEvent,
  type FreezeState,
} from './freezeState.js';

/**
 * Freeze Frame: the screen calls a pose, everyone has to hold it.
 *
 * Chosen as the second game because it is immune to every weakness this
 * platform actually has. It never asks when a swing happened, so detection
 * latency and recall do not matter. It never integrates anything, so drift does
 * not exist. It never needs to know which way the player is facing, which is
 * the one thing Chrome cannot tell us. All it reads is which way gravity
 * points, which is the most trustworthy number in the whole system.
 *
 * It is also the first thing here that four phones play at once.
 *
 * The rules live in freezeState.ts; this draws them (ARCHITECTURE.md 8).
 */

/** Where a grip is kept between scenes, so it is set once per session. */
const GRIP_KEY = 'freezeFrameGrip';

interface Card {
  readonly container: Phaser.GameObjects.Container;
  readonly nameText: Phaser.GameObjects.Text;
  readonly scoreText: Phaser.GameObjects.Text;
  readonly heartText: Phaser.GameObjects.Text;
  readonly meter: Phaser.GameObjects.Rectangle;
  readonly color: string;
}

export class FreezeFrame extends Phaser.Scene {
  private state: FreezeState = createFreeze();
  private readonly cards = new Map<number, Card>();
  private poseText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private timerBar!: Phaser.GameObjects.Rectangle;
  private freezeBar!: Phaser.GameObjects.Rectangle;
  private cleanup: Array<() => void> = [];

  constructor() {
    super('freeze-frame');
  }

  create(): void {
    const { width, height } = this.scale;
    session.configureInput({ pose: true });

    // A restarted scene is the same object with the same fields. Without a
    // fresh state the second game began at the last one's round number and
    // tolerance, with its calibration prompt already timed out — which looks
    // exactly like a game that starts already over.
    this.state = createFreeze();
    this.cards.clear();

    this.add
      .text(width / 2, 24, 'FREEZE FRAME', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        color: '#f1f3f8',
      })
      .setOrigin(0.5, 0);

    this.poseText = this.add
      .text(width / 2, height * 0.28, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '76px',
        color: '#2ed573',
        align: 'center',
      })
      .setOrigin(0.5);

    this.phaseText = this.add
      .text(width / 2, height * 0.42, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#c3c9d6',
        align: 'center',
      })
      .setOrigin(0.5);

    // Two bars: how long is left, and how much of the hold is done. The second
    // is the whole point of the game, so it cannot be invisible.
    this.add.rectangle(width / 2, height * 0.52, width * 0.6, 8, 0x232838);
    this.timerBar = this.add
      .rectangle(width * 0.2, height * 0.52, width * 0.6, 8, 0x3742fa)
      .setOrigin(0, 0.5);
    this.freezeBar = this.add
      .rectangle(width * 0.2, height * 0.52 + 14, width * 0.6, 6, 0x2ed573)
      .setOrigin(0, 0.5)
      .setScale(0, 1);

    this.add
      .text(width / 2, height - 20, 'HOME 또는 ESC: 로비', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: '#98a0b3',
      })
      .setOrigin(0.5, 1);

    this.rebuildCards();

    this.cleanup.push(
      session.onPlayersChanged(() => this.rebuildCards()),
      session.onAction((action) => {
        // Gravity rather than angles: the poses this game asks for include flat
        // and straight up, exactly where pitch and roll stop meaning anything
        // (ARCHITECTURE.md 5.8).
        if (action.kind === 'pose') {
          readPose(this.state, action.playerId, action.up, this.time.now);
          return;
        }
        if (action.kind !== 'button_down') return;
        if (action.button === 'HOME') this.scene.start('lobby');
        if (action.button === 'A') this.pressA(action.playerId);
      }),
    );

    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('lobby'));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const off of this.cleanup) off();
      this.cleanup = [];
      this.cards.clear();
    });
  }

  override update(_time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 1 / 30);
    this.play(stepFreeze(this.state, dt, this.time.now));
    this.syncGrips();
    this.render();
  }

  /**
   * Grips outlive the scene.
   *
   * Being asked to calibrate again on every visit — after a lobby, after a
   * restart, after somebody else's phone reconnected — is a setup screen
   * standing between the player and the game they already set up once.
   */
  private syncGrips(): void {
    for (const player of this.state.players) {
      const key = `${GRIP_KEY}:${player.id}`;
      if (player.reference) {
        this.registry.set(key, player.reference);
        continue;
      }
      const stored = this.registry.get(key) as CanonicalVector | undefined;
      if (stored) {
        player.reference = stored;
        session.log(`기준 자세 P${player.id} (이전 설정 사용)`);
      }
    }
  }

  /** Sound and vibration, which are the only things the rules cannot do. */
  private play(events: readonly FreezeEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'lock':
          session.vibrate(event.playerId, [40]);
          sfx.tick();
          session.log(`고정 P${event.playerId} +${event.points}`);
          break;
        case 'miss':
          // Two short pulses for a miss, one long one for being knocked out:
          // the phone is where the player is looking, not the screen.
          session.vibrate(event.playerId, event.out ? [200] : [25, 60, 25]);
          break;
        case 'reveal':
          if (event.locked > 0) sfx.point();
          else sfx.whiff();
          break;
        case 'round':
          sfx.tick();
          session.log(
            `${event.round}라운드 ${this.state.pose.key} ` +
              `허용 ${this.state.tolerance.toFixed(0)}°`,
          );
          break;
        default:
          sfx.win();
          break;
      }
    }
  }

  /** A does double duty: set your grip before the game, restart it after. */
  private pressA(playerId: number): void {
    if (this.state.phase === 'over') {
      this.scene.restart();
      return;
    }
    if (!calibrate(this.state, playerId, true)) {
      if (this.state.flatWarning === playerId) session.vibrate(playerId, [25, 60, 25]);
      return;
    }
    session.vibrate(playerId, [30]);
    session.log(`기준 자세 P${playerId}`);
    if (this.state.phase === 'ready' && everyoneReady(this.state)) {
      this.play(startRound(this.state));
    }
  }

  private rebuildCards(): void {
    const { width, height } = this.scale;
    for (const card of this.cards.values()) card.container.destroy();
    this.cards.clear();

    const players = session.players;
    // Scores, grips and lives live in the state, which keeps every player it
    // already knows: somebody joining must not cost the rest of the room its
    // game, which is what rebuilding the roster from scratch used to do.
    syncPlayers(
      this.state,
      players.map((player) => ({ id: player.id, present: player.present })),
    );

    players.forEach((player, index) => {
      const color = Number(`0x${player.color.slice(1)}`);
      const cardWidth = Math.min(260, (width * 0.9) / Math.max(1, players.length));
      const x = width / 2 + (index - (players.length - 1) / 2) * (cardWidth + 16);

      const panel = this.add.rectangle(0, 0, cardWidth, 132, 0x171b24).setStrokeStyle(2, color);
      const nameText = this.add
        .text(0, -44, player.name, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '24px',
          color: player.color,
        })
        .setOrigin(0.5);
      const scoreText = this.add
        .text(0, -8, '0', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '28px',
          color: '#f1f3f8',
        })
        .setOrigin(0.5);
      const heartText = this.add
        .text(0, 24, '', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '24px',
          color: '#ff4757',
        })
        .setOrigin(0.5);
      const meterTrack = this.add.rectangle(0, 52, cardWidth - 40, 10, 0x232838);
      const meter = this.add
        .rectangle(-(cardWidth - 40) / 2, 52, cardWidth - 40, 10, color)
        .setOrigin(0, 0.5);

      const container = this.add.container(x, height * 0.76, [
        panel,
        nameText,
        scoreText,
        heartText,
        meterTrack,
        meter,
      ]);
      this.cards.set(player.id, {
        container,
        nameText,
        scoreText,
        heartText,
        meter,
        color: player.color,
      });
    });
  }

  private render(): void {
    const { phase } = this.state;
    this.poseText.setText(phase === 'over' ? '끝!' : phase === 'ready' ? '준비' : this.state.pose.label);

    const locked = this.state.players.filter((player) => player.locked).length;
    this.phaseText.setText(this.phaseMessage(locked));

    // The hold in progress, shown while it happens rather than announced after.
    this.freezeBar.setScale(phase === 'holding' ? holdProgress(this.state) : 0, 1);
    this.timerBar
      .setVisible(phase === 'holding')
      .setScale(Math.max(0, this.state.timer / this.state.config.roundSeconds), 1);

    for (const player of this.state.players) {
      const card = this.cards.get(player.id);
      if (!card) continue;
      const detail = !player.reference
        ? 'A를 누르세요'
        : player.out
          ? '탈락'
          : player.locked
            ? `성공 +${player.lockPoints}`
            : `${player.offBy.toFixed(0)}°`;
      card.scoreText.setText(`${player.score}   ${detail}`);
      card.heartText.setText('♥'.repeat(Math.max(0, player.hearts)));
      card.meter.setFillStyle(player.locked ? 0x2ed573 : Number(`0x${card.color.slice(1)}`));
      card.meter.setScale(player.locked ? 1 : player.closeness, 1);
      card.container.setAlpha(player.out ? 0.4 : 1);
      card.nameText.setColor(player.locked ? '#2ed573' : card.color);
    }

    const angles = this.state.players
      .map((player) => `P${player.id} ${player.offBy.toFixed(0)}°`)
      .join(' ');
    session.status =
      `freeze-frame ${phase}  라운드 ${this.state.round}  자세 ${this.state.pose.key}  ` +
      `허용 ${this.state.tolerance.toFixed(0)}°  ` +
      `유지 ${(this.state.freezeMs / 1000).toFixed(1)}s  ${angles}`;
  }

  private phaseMessage(locked: number): string {
    if (this.state.players.length === 0) return '폰을 연결하세요 (?fake=1 로 키보드 사용)';
    const waiting = this.state.players.filter((player) => !player.reference).length;
    switch (this.state.phase) {
      case 'ready':
        return this.state.flatWarning === null
          ? `편한 자세로 폰을 들고 A — ${waiting}명 남음 (그 자세가 기준이 됩니다)`
          : `P${this.state.flatWarning}: 폰을 세워서 들고 다시 A (눕히면 기울이기 자세가 안 나옵니다)`;
      case 'holding':
        return (
          `${(this.state.freezeMs / 1000).toFixed(1)}초 동안 유지 — ` +
          `${locked}/${alivePlayers(this.state).length} 성공   ` +
          `(허용 ${this.state.tolerance.toFixed(0)}°)`
        );
      case 'reveal':
        return `${this.state.round}라운드 결과 — ${locked}명 성공`;
      default:
        return `${this.winnerLine()}   ·   A: 다시`;
    }
  }

  private winnerLine(): string {
    const best = leader(this.state);
    if (!best) return '';
    const card = this.cards.get(best.id);
    const name = card?.nameText.text ?? `P${best.id}`;
    return this.state.players.length === 1
      ? `${this.state.round - 1}라운드 버팀 — ${best.score}점`
      : `${name} 승리 — ${best.score}점`;
  }
}
