import Phaser from 'phaser';
import {
  POSES,
  poseCloseness,
  poseMatches,
  rotateFromReference,
  type NamedPose,
} from '../../input/pose.js';
import { session } from '../../session.js';
import type { CanonicalVector } from '../../input/types.js';
import { sfx } from '../../ui/audio.js';

/**
 * Freeze Frame: the screen calls a pose, everyone has two seconds to hold it.
 *
 * Chosen as the next game because it is immune to every weakness this platform
 * actually has. It never asks when a swing happened, so detection latency and
 * recall do not matter. It never integrates anything, so drift does not exist.
 * It never needs to know which way the player is facing, which is the one thing
 * Chrome cannot tell us. All it reads is which way gravity points, which is the
 * most trustworthy number in the whole system.
 *
 * It is also the first thing here that four phones play at once.
 */

const ROUND_SECONDS = 2.2;
const REVEAL_SECONDS = 1.4;
const TOLERANCE_START = 35;
const TOLERANCE_FLOOR = 16;
/** Rounds survived before the tolerance stops tightening. */
const TIGHTEN_OVER = 8;

type Phase = 'ready' | 'holding' | 'reveal' | 'over';

interface Contestant {
  readonly playerId: number;
  readonly name: string;
  readonly color: string;
  readonly card: Phaser.GameObjects.Container;
  readonly nameText: Phaser.GameObjects.Text;
  readonly scoreText: Phaser.GameObjects.Text;
  readonly meter: Phaser.GameObjects.Rectangle;
  score: number;
  out: boolean;
  closeness: number;
  held: boolean;
  /**
   * The hold this player calibrated as their own "level". Poses are written
   * against the canonical landscape grip, but nobody holds a phone to a
   * specification, and a pose game that silently demands one fails every round
   * for a reason nobody in the room can see.
   */
  reference: CanonicalVector | null;
  /** Most recent reading, so A can adopt it as the reference. */
  lastUp: CanonicalVector | null;
}

export class FreezeFrame extends Phaser.Scene {
  private phase: Phase = 'ready';
  private timer = 0;
  private round = 0;
  private pose: NamedPose = POSES[0] ?? { key: 'level', label: '똑바로', up: { x: 0, y: 1, z: 0 } };
  private tolerance = TOLERANCE_START;

  private readonly contestants = new Map<number, Contestant>();
  private poseText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private timerBar!: Phaser.GameObjects.Rectangle;
  private cleanup: Array<() => void> = [];

  constructor() {
    super('freeze-frame');
  }

  create(): void {
    const { width, height } = this.scale;
    session.configureInput({ pose: true });

    this.add
      .text(width / 2, 28, 'FREEZE FRAME', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        color: '#f1f3f8',
      })
      .setOrigin(0.5, 0);

    this.poseText = this.add
      .text(width / 2, height * 0.3, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '76px',
        color: '#2ed573',
        align: 'center',
      })
      .setOrigin(0.5);

    this.phaseText = this.add
      .text(width / 2, height * 0.44, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#98a0b3',
      })
      .setOrigin(0.5);

    this.add.rectangle(width / 2, height * 0.52, width * 0.6, 8, 0x232838);
    this.timerBar = this.add
      .rectangle(width * 0.2, height * 0.52, width * 0.6, 8, 0x3742fa)
      .setOrigin(0, 0.5);

    this.add
      .text(width / 2, height - 22, 'HOME: 로비   ·   ESC: 로비', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#6b7488',
      })
      .setOrigin(0.5, 1);

    this.rebuildContestants();

    this.cleanup.push(
      session.onPlayersChanged(() => this.rebuildContestants()),
      session.onAction((action) => {
        // Gravity rather than angles: the poses this game asks for include flat
        // and straight up, exactly where pitch and roll stop meaning anything
        // (ARCHITECTURE.md 5.8).
        if (action.kind === 'pose') {
          const contestant = this.contestants.get(action.playerId);
          if (!contestant) return;
          contestant.lastUp = action.up;
          if (!contestant.reference) return;

          // Judged in the player's own frame, so the grip they chose is level.
          const aligned = rotateFromReference(action.up, contestant.reference);
          contestant.closeness = poseCloseness(this.pose.up, aligned, this.tolerance);
          contestant.held = poseMatches(this.pose.up, aligned, this.tolerance);
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
      this.contestants.clear();
    });

    this.phase = 'ready';
  }

  override update(_time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 1 / 30);

    switch (this.phase) {
      case 'holding': {
        this.timer -= dt;
        this.timerBar.setScale(Math.max(0, this.timer / ROUND_SECONDS), 1);
        if (this.timer <= 0) this.judge();
        break;
      }
      case 'reveal': {
        this.timer -= dt;
        if (this.timer <= 0) this.startRound();
        break;
      }
      default:
        break;
    }

    this.render();
  }

  /**
   * A does double duty: set your grip before the game, restart it after.
   */
  private pressA(playerId: number): void {
    if (this.phase === 'over') {
      this.scene.restart();
      return;
    }
    const contestant = this.contestants.get(playerId);
    if (!contestant?.lastUp) return;

    contestant.reference = contestant.lastUp;
    contestant.closeness = 1;
    contestant.held = true;
    session.vibrate(playerId, [30]);
    session.log(`기준 자세 설정 P${playerId}`);

    if (this.phase === 'ready' && this.everyoneReady()) this.startRound();
  }

  private everyoneReady(): boolean {
    const contestants = [...this.contestants.values()];
    return contestants.length > 0 && contestants.every((contestant) => contestant.reference);
  }

  private startRound(): void {
    const alive = [...this.contestants.values()].filter((contestant) => !contestant.out);
    if (this.round > 0 && alive.length === 0) {
      this.phase = 'over';
      return;
    }

    this.round++;
    // Tighten as the round number climbs, then hold: a game that gets harder
    // forever just ends in frustration rather than in a winner.
    const progress = Math.min(1, (this.round - 1) / TIGHTEN_OVER);
    this.tolerance = TOLERANCE_START - (TOLERANCE_START - TOLERANCE_FLOOR) * progress;

    const choices = POSES.filter((pose) => pose.key !== this.pose.key);
    this.pose = choices[Math.floor(Math.random() * choices.length)] ?? this.pose;

    this.phase = 'holding';
    this.timer = ROUND_SECONDS;
    sfx.tick();
  }

  private judge(): void {
    this.phase = 'reveal';
    this.timer = REVEAL_SECONDS;

    let anyHeld = false;
    for (const contestant of this.contestants.values()) {
      if (contestant.out) continue;
      if (contestant.held) {
        contestant.score++;
        anyHeld = true;
        session.vibrate(contestant.playerId, [40]);
      } else {
        // Missing a pose costs the round, not the game: a player knocked out in
        // the first ten seconds spends the rest of it watching.
        session.vibrate(contestant.playerId, [15, 60, 15]);
      }
    }
    if (anyHeld) sfx.point();
  }

  private rebuildContestants(): void {
    const { width, height } = this.scale;
    // Somebody joining must not cost everyone else their grip and their score.
    const carried = new Map(
      [...this.contestants.values()].map((contestant) => [
        contestant.playerId,
        {
          score: contestant.score,
          reference: contestant.reference,
          lastUp: contestant.lastUp,
        },
      ]),
    );
    for (const contestant of this.contestants.values()) contestant.card.destroy();
    this.contestants.clear();

    const players = session.players;
    players.forEach((player, index) => {
      const color = Number(`0x${player.color.slice(1)}`);
      const cardWidth = Math.min(260, (width * 0.9) / Math.max(1, players.length));
      const x = width / 2 + (index - (players.length - 1) / 2) * (cardWidth + 16);
      const y = height * 0.75;

      const panel = this.add.rectangle(0, 0, cardWidth, 120, 0x171b24).setStrokeStyle(2, color);
      const nameText = this.add
        .text(0, -36, player.name, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '22px',
          color: player.color,
        })
        .setOrigin(0.5);
      const scoreText = this.add
        .text(0, 2, '0', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '34px',
          color: '#f1f3f8',
        })
        .setOrigin(0.5);
      const meterTrack = this.add.rectangle(0, 40, cardWidth - 40, 10, 0x232838);
      const meter = this.add
        .rectangle(-(cardWidth - 40) / 2, 40, cardWidth - 40, 10, color)
        .setOrigin(0, 0.5);

      const card = this.add.container(x, y, [panel, nameText, scoreText, meterTrack, meter]);
      this.contestants.set(player.id, {
        playerId: player.id,
        name: player.name,
        color: player.color,
        card,
        nameText,
        scoreText,
        meter,
        score: carried.get(player.id)?.score ?? 0,
        out: false,
        closeness: 0,
        held: false,
        reference: carried.get(player.id)?.reference ?? null,
        lastUp: carried.get(player.id)?.lastUp ?? null,
      });
    });
  }

  private render(): void {
    this.poseText.setText(
      this.phase === 'over' ? '끝!' : this.phase === 'ready' ? '준비' : this.pose.label,
    );

    const held = [...this.contestants.values()].filter((contestant) => contestant.held).length;
    const waiting = [...this.contestants.values()].filter(
      (contestant) => !contestant.reference,
    ).length;
    this.phaseText.setText(
      this.contestants.size === 0
        ? '폰을 연결하세요 (?fake=1 로 키보드 사용)'
        : this.phase === 'ready'
          ? `편한 자세로 폰을 들고 A — ${waiting}명 남음 (그 자세가 기준이 됩니다)`
          : this.phase === 'holding'
            ? `자세를 유지하세요 — ${held}/${this.contestants.size} 성공 중   (허용 ${this.tolerance.toFixed(0)}°)`
            : this.phase === 'reveal'
              ? `${this.round}라운드 결과`
              : 'A: 다시',
    );

    for (const contestant of this.contestants.values()) {
      contestant.scoreText.setText(String(contestant.score));
      contestant.meter.setScale(contestant.closeness, 1);
      contestant.nameText.setColor(contestant.held ? '#2ed573' : contestant.color);
    }

    session.status =
      `freeze-frame ${this.phase}  라운드 ${this.round}  자세 ${this.pose.key}  ` +
      `허용 ${this.tolerance.toFixed(0)}°`;
  }
}
