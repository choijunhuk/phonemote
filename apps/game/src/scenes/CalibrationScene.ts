import Phaser from 'phaser';
import { session } from '../session.js';

/**
 * Centres every connected controller before play (ARCHITECTURE.md 7.4).
 *
 * Tilt is measured against gravity, so "level" depends on how the player holds
 * the phone. Whatever pose they are in when they press A becomes zero.
 */

interface CalibrationData {
  readonly next: string;
  readonly mode?: string;
}

/**
 * Nobody waits here forever.
 *
 * One player who has put their phone down blocks the whole room, and a player
 * with no phone at all — the keyboard stand-ins are how this is played with
 * none in the room — had no way through this screen whatsoever. Freeze Frame
 * learned the same lesson and gave its grip prompt a timeout (D32's neighbour
 * in freezeState); this is that, here.
 */
const AUTO_START_SECONDS = 8;

export class CalibrationScene extends Phaser.Scene {
  private next = 'pointer-test';
  private mode: string | undefined;
  private waited = 0;
  /** One transition per visit; the timeout and a button press can both fire. */
  private started = false;
  private readyText!: Phaser.GameObjects.Text;
  private readonly calibrated = new Set<number>();
  private cleanup: (() => void) | null = null;

  constructor() {
    super('calibration');
  }

  init(data: Partial<CalibrationData>): void {
    this.next = data.next ?? 'pointer-test';
    this.mode = data.mode;
    this.calibrated.clear();
    this.started = false;
    // Phaser reuses the instance, so a run-scoped counter left over from the
    // last visit would send the next one straight through.
    this.waited = 0;
  }

  create(): void {
    const { width, height } = this.scale;
    session.configureInput({ tilt: {} });

    this.add
      .text(width / 2, height * 0.35, '화면 중앙을 겨눈 자세로', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        color: '#f1f3f8',
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height * 0.47, 'A 버튼을 누르세요', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '64px',
        color: '#2ed573',
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height * 0.58, '폰을 세로로 들고, 위쪽 끝이 화면을 향하게 잡습니다', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '20px',
        color: '#98a0b3',
      })
      .setOrigin(0.5);

    this.readyText = this.add
      .text(width / 2, height * 0.72, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: '#98a0b3',
      })
      .setOrigin(0.5);

    this.cleanup = session.onAction((action) => {
      if (action.kind !== 'button_down' || action.button !== 'A') return;
      session.requestCalibration(action.playerId);
      session.vibrate(action.playerId, [40]);
      this.calibrated.add(action.playerId);
      this.updateReady();

      // Everyone in: go. A single player can also start on their own.
      if (this.calibrated.size >= session.presentPlayers.length) this.go();
    });

    // A keyboard has no A button and no phone behind it, and the stand-ins are
    // how this is played with no phone in the room at all. Without this there
    // was no way off this screen for them.
    this.input.keyboard?.on('keydown-ENTER', () => this.go());
    this.input.keyboard?.on('keydown-SPACE', () => this.go());
    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('lobby'));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.cleanup?.();
      this.cleanup = null;
    });

    this.updateReady();
  }

  override update(_time: number, delta: number): void {
    this.waited += Math.min(delta / 1000, 1 / 30);
    if (this.waited >= AUTO_START_SECONDS) this.go();
    this.updateReady();
  }

  /**
   * Into the game, carrying the mode the lobby chose.
   *
   * Without the mode, a match sent through calibration arrived at the scene as
   * whatever the default is — so the practice screen a player picked in the
   * lobby quietly became the real game, or the other way round.
   */
  private go(): void {
    if (this.started) return;
    this.started = true;
    this.time.delayedCall(250, () => this.scene.start(this.next, { mode: this.mode }));
  }

  private updateReady(): void {
    const total = session.presentPlayers.length;
    const left = Math.max(0, AUTO_START_SECONDS - this.waited);
    this.readyText.setText(
      total === 0
        ? `연결된 컨트롤러가 없습니다 — Enter로 진행 (${left.toFixed(0)}초 뒤 자동)`
        : `${this.calibrated.size} / ${total} 준비됨 — ${left.toFixed(0)}초 뒤 자동 시작`,
    );
  }
}
