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
}

export class CalibrationScene extends Phaser.Scene {
  private next = 'pointer-test';
  private readyText!: Phaser.GameObjects.Text;
  private readonly calibrated = new Set<number>();
  private cleanup: (() => void) | null = null;

  constructor() {
    super('calibration');
  }

  init(data: Partial<CalibrationData>): void {
    this.next = data.next ?? 'pointer-test';
    this.calibrated.clear();
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
      if (this.calibrated.size >= session.players.length) {
        this.time.delayedCall(250, () => this.scene.start(this.next));
      }
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.cleanup?.();
      this.cleanup = null;
    });

    this.updateReady();
  }

  private updateReady(): void {
    const total = session.players.length;
    this.readyText.setText(total === 0 ? '연결된 컨트롤러가 없습니다' : `${this.calibrated.size} / ${total} 준비됨`);
  }
}
