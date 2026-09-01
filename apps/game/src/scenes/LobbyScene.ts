import Phaser from 'phaser';
import QRCode from 'qrcode';
import { session } from '../session.js';
import {
  GAMES,
  defaultMode,
  playersLabel,
  type GameDefinition,
  type GameMode,
} from '../games.js';
import { columnsFor, layoutTiles, moveFocus } from './lobbyLayout.js';

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
  readonly modeText: Phaser.GameObjects.Text;
  readonly centre: { x: number; y: number };
  /** Which of this game's modes is chosen. Left and right move through them. */
  mode: number;
}

export class LobbyScene extends Phaser.Scene {
  private codeText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private slotTexts: Phaser.GameObjects.Text[] = [];
  private cursor!: Phaser.GameObjects.Arc;
  private tiles: Tile[] = [];
  private selected = 0;
  private columns = 1;
  private qrShown = false;
  private cleanups: Array<() => void> = [];

  constructor() {
    super('lobby');
  }

  create(): void {
    const { width, height } = this.scale;
    // Phaser reuses the scene instance, so these outlive a restart unless they
    // are cleared here. qrShown surviving is why the lobby lost its QR code and
    // its controller URL for the rest of the session after the first game.
    this.qrShown = false;
    this.selected = 0;
    this.tiles = [];
    this.slotTexts = [];
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
      .text(width * 0.26, height * 0.29, '폰 Chrome에서 QR 스캔 또는 룸 코드 입력', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: '#98a0b3',
      })
      .setOrigin(0.5);

    this.buildSlots();
    this.buildMenu();

    this.hintText = this.add
      .text(width / 2, height - 24, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
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
    // Only as many number keys as there are names for. The old fallback of
    // 'ONE' meant every game past the fourth registered another handler on the
    // same key, so pressing 1 fired all of them and the last one won.
    const NUMBER_KEYS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
    NUMBER_KEYS.forEach((name, index) => {
      if (index >= GAMES.length) return;
      this.input.keyboard?.on(`keydown-${name}`, () => {
        this.selected = index;
        this.launch();
      });
    });
    this.input.keyboard?.on('keydown-LEFT', () => this.cycleMode(-1));
    this.input.keyboard?.on('keydown-RIGHT', () => this.cycleMode(1));

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
        // An empty slot still has to be visible from the sofa; #3a4152 on
        // #0f1116 is not a colour at that distance, it is a smudge.
        .text(width * 0.06, height * (0.45 + index * 0.07), '', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '24px',
          color: '#6f7994',
        })
        .setOrigin(0, 0.5),
    );
  }

  private buildMenu(): void {
    const { width, height } = this.scale;
    // A grid, because a column runs off the bottom: at nine games the fifth
    // tile landed at y=728 on a 720-high canvas and the ninth at y=1070, where
    // no pointer could ever reach them.
    this.columns = columnsFor(GAMES.length);
    const placed = layoutTiles({
      width,
      height,
      count: GAMES.length,
      // The left half belongs to the room code, the QR and the player slots.
      left: width * 0.46,
      right: 24,
      top: height * 0.16,
      // Room for two lines of hint: the focused game's mode and its
      // description sit on the first, the controls on the second.
      bottom: 112,
    });

    this.tiles = GAMES.map((game, index) => {
      const box = placed[index];
      const centre = { x: box?.x ?? width / 2, y: box?.y ?? height / 2 };
      const tileWidth = box?.width ?? 300;
      const tileHeight = box?.height ?? 96;

      const panel = this.add
        .rectangle(0, 0, tileWidth, tileHeight, 0x171b24)
        .setStrokeStyle(2, 0x2c3242);
      // No number prefix on the tile. At three columns the title, the number
      // and the player count did not fit on one line, and the number keys are
      // still there — the hint line says so.
      const title = this.add
        .text(-tileWidth / 2 + 18, -tileHeight / 2 + 10, game.title, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '24px',
          color: '#f1f3f8',
        })
        .setOrigin(0, 0);
      const blurb = this.add
        .text(-tileWidth / 2 + 18, -tileHeight / 2 + 40, game.blurb, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '19px',
          color: '#98a0b3',
          wordWrap: { width: tileWidth - 36 },
          // Three lines of a wrapped Korean sentence is as much as a 210px
          // tile can hold before it runs into the mode chip.
          maxLines: 3,
        })
        .setOrigin(0, 0);
      // The mode line is the whole point of the redesign: it is where a player
      // sees that practice exists at all.
      const modeText = this.add
        .text(-tileWidth / 2 + 18, tileHeight / 2 - 30, '', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '20px',
          color: '#2ed573',
          // The whole tile width: the player count moved up to the title line,
          // so a mode name like "드라이빙 레인지" has room to be itself.
          wordWrap: { width: tileWidth - 36 },
          maxLines: 1,
        })
        .setOrigin(0, 0);

      return {
        game,
        panel,
        modeText,
        centre,
        // Whatever suits the room right now, so the common case needs no
        // fiddling: one phone lands on something one person can play.
        mode: Math.max(
          0,
          game.modes.indexOf(defaultMode(game, session.presentPlayers.length)),
        ),
        container: this.add.container(centre.x, centre.y, [panel, title, blurb, modeText]),
      };
    });
  }

  private move(step: number): void {
    this.selected = moveFocus(
      this.selected,
      this.tiles.length,
      this.columns,
      step > 0 ? 'down' : 'up',
    );
  }

  /**
   * Move through this game's modes.
   *
   * Modes that the room cannot fill are still shown, greyed, with the reason.
   * A menu entry that silently disappears when a phone drops reads as the app
   * breaking, not as a rule.
   */
  private cycleMode(step: number): void {
    const tile = this.tiles[this.selected];
    if (!tile) return;
    const count = tile.game.modes.length;
    tile.mode = (tile.mode + step + count) % count;
  }

  private modeOf(tile: Tile): GameMode | undefined {
    return tile.game.modes[tile.mode];
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
    const mode = tile ? this.modeOf(tile) : undefined;
    if (!tile || !mode) return;

    const present = session.presentPlayers.length;
    if (present > mode.maxPlayers) {
      session.log(`${tile.game.key}/${mode.key}: 최대 ${mode.maxPlayers}명`);
      return;
    }
    // Below the minimum is allowed from the keyboard, because the keyboard
    // stand-ins are how this is played with no phone in the room at all.

    // Input is configured before the scene starts, so its very first frame is
    // already the right shape.
    session.configureInput(mode.input);
    session.log(`게임 시작 ${tile.game.key} (${mode.key})`);
    this.scene.start(tile.game.calibration ? 'calibration' : tile.game.key, {
      mode: mode.key,
      next: tile.game.key,
    });
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
        text.setColor('#6f7994');
      }
    });

    const present = session.presentPlayers.length;
    this.tiles.forEach((tile, index) => {
      const chosen = index === this.selected;
      tile.panel.setStrokeStyle(chosen ? 3 : 2, chosen ? 0x2ed573 : 0x2c3242);
      tile.panel.setFillStyle(chosen ? 0x1d2430 : 0x171b24);

      const mode = this.modeOf(tile);
      if (!mode) return;
      // Said out loud rather than hidden: a mode that vanishes when a phone
      // drops reads as the app breaking.
      const short = present < mode.minPlayers;
      const many = present > mode.maxPlayers;
      const label = tile.game.modes.length > 1 ? `◀ ${mode.title} ▶` : mode.title;
      // The chip carries the name only. At nine games a tile is 210px wide and
      // a mode's description does not fit beside it; the description goes to
      // the full-width line at the bottom, for whichever tile has focus.
      tile.modeText
        .setText(label)
        .setColor(short || many ? '#6f7994' : chosen ? '#2ed573' : '#98a0b3');
    });

    this.cursor.setVisible(players.length > 0);
    this.hintText.setText(this.hint(present));
  }

  /** What the focused game's chosen mode is, then how to drive the menu. */
  private hint(present: number): string {
    const tile = this.tiles[this.selected];
    const mode = tile ? this.modeOf(tile) : undefined;
    const controls =
      session.players.length === 0
        ? '폰을 연결하거나, 키보드 ↑↓←→ + Enter   ·   숫자키 1~9로 바로 시작'
        : '고르고 A로 시작   ·   ←→ 모드   ·   B 다음   ·   숫자키 1~9';
    if (!tile || !mode) return controls;

    const why =
      present < mode.minPlayers
        ? `${mode.minPlayers}명 필요, 지금 ${present}명`
        : present > mode.maxPlayers
          ? `최대 ${mode.maxPlayers}명`
          : mode.detail;
    // The player range lives here rather than on the tile: at three columns a
    // title like "Together Table" already fills the line, and a count printed
    // over the last letters of a name is worse than a count one line away.
    return `${tile.game.title} · ${mode.title} (${playersLabel(tile.game)}) — ${why}
${controls}`;
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
          fontSize: '20px',
          color: '#98a0b3',
        })
        .setOrigin(0.5);
    });
    this.textures.addBase64('qr', dataUrl);
  }
}
