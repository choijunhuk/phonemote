import Phaser from 'phaser';
import QRCode from 'qrcode';
import { session } from '../session.js';
import { GAMES, type GameDefinition } from '../games.js';

/**
 * Lobby: how to join, who has joined, and what to play.
 *
 * The QR encodes the controllerUrl exactly as the server sent it; this scene
 * never builds that URL itself (ARCHITECTURE.md 6.1).
 *
 * The menu is built for a pointer that drifts, because ours does: big targets,
 * selection snapping to whichever is nearest, and A to confirm rather than
 * dwelling on a target. It is also fully playable from the PC keyboard, so a
 * game can be reached with no phone connected at all.
 */

interface Tile {
  readonly game: GameDefinition;
  readonly container: Phaser.GameObjects.Container;
  readonly panel: Phaser.GameObjects.Rectangle;
  readonly centre: { x: number; y: number };
}

export class LobbyScene extends Phaser.Scene {
  private codeText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private slotTexts: Phaser.GameObjects.Text[] = [];
  private cursor!: Phaser.GameObjects.Arc;
  private tiles: Tile[] = [];
  private selected = 0;
  private qrShown = false;
  private cleanups: Array<() => void> = [];

  constructor() {
    super('lobby');
  }

  create(): void {
    const { width, height } = this.scale;
    // The pointer drives the menu, so it has to be on before a game is chosen.
    session.configureInput({ pointer: {} });

    this.add
      .text(width * 0.26, height * 0.08, 'PhoneMote', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '48px',
        color: '#f1f3f8',
      })
      .setOrigin(0.5, 0);

    this.codeText = this.add
      .text(width * 0.26, height * 0.2, '연결 중…', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '84px',
        color: '#2ed573',
      })
      .setOrigin(0.5);

    this.add
      .text(width * 0.26, height * 0.29, '폰 Chrome으로 QR을 찍거나 룸 코드를 입력하세요', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#98a0b3',
      })
      .setOrigin(0.5);

    this.buildSlots();
    this.buildMenu();

    this.hintText = this.add
      .text(width / 2, height - 24, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#98a0b3',
        align: 'center',
      })
      .setOrigin(0.5, 1);

    this.cursor = this.add.circle(width * 0.7, height / 2, 10, 0xf1f3f8).setAlpha(0.85);

    this.cleanups.push(
      session.onPlayersChanged(() => this.refresh()),
      session.onAction((action) => {
        if (action.kind === 'pointer_move') {
          this.cursor.setPosition(action.x * this.scale.width, action.y * this.scale.height);
          this.selectNearest(this.cursor.x, this.cursor.y);
          return;
        }
        if (action.kind !== 'button_down') return;
        if (action.button === 'A') this.launch();
        if (action.button === 'B') this.move(1);
      }),
    );

    // Keyboard is a first-class path, not a fallback: without it the lobby is a
    // dead screen whenever no phone is connected.
    this.input.keyboard?.on('keydown-DOWN', () => this.move(1));
    this.input.keyboard?.on('keydown-UP', () => this.move(-1));
    this.input.keyboard?.on('keydown-ENTER', () => this.launch());
    this.input.keyboard?.on('keydown-SPACE', () => this.launch());
    for (const [index] of GAMES.entries()) {
      this.input.keyboard?.on(`keydown-${['ONE', 'TWO', 'THREE', 'FOUR'][index] ?? 'ONE'}`, () => {
        this.selected = index;
        this.launch();
      });
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const cleanup of this.cleanups) cleanup();
      this.cleanups = [];
      this.tiles = [];
    });

    this.time.addEvent({ delay: 250, loop: true, callback: () => this.refresh() });
    this.refresh();
  }

  private buildSlots(): void {
    const { width, height } = this.scale;
    this.slotTexts = [0, 1, 2, 3].map((index) =>
      this.add
        .text(width * 0.06, height * (0.45 + index * 0.07), '', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '24px',
          color: '#3a4152',
        })
        .setOrigin(0, 0.5),
    );
  }

  private buildMenu(): void {
    const { width, height } = this.scale;
    const tileWidth = width * 0.42;
    const tileHeight = 96;

    this.tiles = GAMES.map((game, index) => {
      const centre = { x: width * 0.7, y: height * 0.22 + index * (tileHeight + 18) };
      const panel = this.add
        .rectangle(0, 0, tileWidth, tileHeight, 0x171b24)
        .setStrokeStyle(2, 0x2c3242);
      const title = this.add
        .text(-tileWidth / 2 + 24, -22, `${index + 1}. ${game.title}`, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '28px',
          color: '#f1f3f8',
        })
        .setOrigin(0, 0);
      const blurb = this.add
        .text(-tileWidth / 2 + 24, 14, game.blurb, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '16px',
          color: '#98a0b3',
        })
        .setOrigin(0, 0);
      const players = this.add
        .text(tileWidth / 2 - 24, 14, game.players, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '16px',
          color: '#6b7488',
        })
        .setOrigin(1, 0);

      return {
        game,
        panel,
        centre,
        container: this.add.container(centre.x, centre.y, [panel, title, blurb, players]),
      };
    });
  }

  private move(step: number): void {
    this.selected = (this.selected + step + this.tiles.length) % this.tiles.length;
  }

  /** Snap to the nearest tile rather than requiring the cursor to sit inside one. */
  private selectNearest(x: number, y: number): void {
    let best = this.selected;
    let bestDistance = Number.POSITIVE_INFINITY;
    this.tiles.forEach((tile, index) => {
      const distance = Math.hypot(tile.centre.x - x, tile.centre.y - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    this.selected = best;
  }

  private launch(): void {
    const tile = this.tiles[this.selected];
    if (!tile) return;

    // Input is configured before the scene starts, so its very first frame is
    // already the right shape.
    session.configureInput(tile.game.input);
    session.log(`게임 시작 ${tile.game.key}`);
    this.scene.start(
      tile.game.calibration ? 'calibration' : tile.game.key,
      tile.game.calibration ? { next: tile.game.key } : undefined,
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

    this.tiles.forEach((tile, index) => {
      const chosen = index === this.selected;
      tile.panel.setStrokeStyle(chosen ? 3 : 2, chosen ? 0x2ed573 : 0x2c3242);
      tile.panel.setFillStyle(chosen ? 0x1d2430 : 0x171b24);
    });

    this.cursor.setVisible(players.length > 0);
    this.hintText.setText(
      players.length === 0
        ? '폰을 연결하거나, 키보드 ↑↓ + Enter 로 바로 시작할 수 있습니다'
        : '폰을 겨눠 고르고 A로 시작   ·   B 다음 항목   ·   키보드 ↑↓ Enter   ·   r 축 측정',
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
      this.add.image(width * 0.26, height * 0.72, 'qr').setDisplaySize(200, 200);
      this.add
        .text(width * 0.26, height * 0.88, controllerUrl, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '14px',
          color: '#98a0b3',
        })
        .setOrigin(0.5);
    });
    this.textures.addBase64('qr', dataUrl);
  }
}
