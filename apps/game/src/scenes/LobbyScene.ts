import Phaser from 'phaser';
import QRCode from 'qrcode';
import { session } from '../session.js';

/**
 * Lobby: shows how to join, who has joined, and what to press.
 *
 * The QR encodes the controllerUrl exactly as the server sent it; this scene
 * never builds that URL itself (ARCHITECTURE.md 6.1).
 */

export class LobbyScene extends Phaser.Scene {
  private codeText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private slotTexts: Phaser.GameObjects.Text[] = [];
  private qrShown = false;
  private cleanups: Array<() => void> = [];

  constructor() {
    super('lobby');
  }

  create(): void {
    const { width, height } = this.scale;
    session.configureInput({});

    this.add
      .text(width / 2, height * 0.12, 'PhoneMote', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '56px',
        color: '#f1f3f8',
      })
      .setOrigin(0.5);

    this.codeText = this.add
      .text(width * 0.3, height * 0.34, '연결 중…', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '96px',
        color: '#2ed573',
      })
      .setOrigin(0.5);

    this.add
      .text(width * 0.3, height * 0.46, '폰 Chrome으로 QR을 찍거나 룸 코드를 입력하세요', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '20px',
        color: '#98a0b3',
      })
      .setOrigin(0.5);

    this.buildSlots();

    this.hintText = this.add
      .text(width / 2, height * 0.88, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: '#f1f3f8',
        align: 'center',
      })
      .setOrigin(0.5);

    this.cleanups.push(
      session.onPlayersChanged(() => this.refresh()),
      session.onAction((action) => {
        if (action.kind !== 'button_down' || session.players.length === 0) return;
        if (action.button === 'A') this.scene.start('calibration', { next: 'tennis' });
        if (action.button === 'B') this.scene.start('calibration', { next: 'pointer-test' });
      }),
    );

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const cleanup of this.cleanups) cleanup();
      this.cleanups = [];
    });

    this.time.addEvent({ delay: 250, loop: true, callback: () => this.refresh() });
    this.refresh();
  }

  private buildSlots(): void {
    const { width, height } = this.scale;
    this.slotTexts = [0, 1, 2, 3].map((index) =>
      this.add
        .text(width * 0.68, height * (0.3 + index * 0.09), '', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '28px',
          color: '#3a4152',
        })
        .setOrigin(0, 0.5),
    );
  }

  private refresh(): void {
    const room = session.room;
    this.codeText.setText(room ? room.roomCode : '연결 중…');
    this.codeText.setColor(room ? '#2ed573' : '#ff4757');

    if (room && !this.qrShown) {
      this.qrShown = true;
      void this.showQr(room.controllerUrl);
    }

    const players = session.players;
    this.slotTexts.forEach((text, index) => {
      const player = players[index];
      if (player) {
        text.setText(`P${player.id}  ${player.name}`);
        text.setColor(player.color);
      } else {
        text.setText(`P${index + 1}  ―`);
        text.setColor('#3a4152');
      }
    });

    this.hintText.setText(
      players.length === 0
        ? '폰을 연결하면 시작할 수 있습니다'
        : 'A: 테니스     B: 포인터 테스트',
    );
  }

  private async showQr(controllerUrl: string): Promise<void> {
    const dataUrl = await QRCode.toDataURL(controllerUrl, {
      margin: 1,
      width: 320,
      color: { dark: '#0f1116', light: '#ffffff' },
    });

    this.textures.once('addtexture-qr', () => {
      const { width, height } = this.scale;
      this.add.image(width * 0.3, height * 0.66, 'qr').setDisplaySize(240, 240);
      this.add
        .text(width * 0.3, height * 0.82, controllerUrl, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '16px',
          color: '#98a0b3',
        })
        .setOrigin(0.5);
    });
    this.textures.addBase64('qr', dataUrl);
  }
}
