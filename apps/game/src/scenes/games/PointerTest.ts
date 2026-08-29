import Phaser from 'phaser';
import { session } from '../../session.js';

/**
 * Phase 1 sanity check: tilt moves a dot, A changes its colour.
 *
 * Deliberately trivial. Its job is to make a wrong axis obvious at a glance,
 * next to the numbers in the debug overlay.
 */

const COLORS = [0xff4757, 0x3742fa, 0x2ed573, 0xffa502, 0xf1f3f8];

export class PointerTest extends Phaser.Scene {
  private readonly dots = new Map<number, Phaser.GameObjects.Arc>();
  private readonly colorIndex = new Map<number, number>();
  private cleanup: (() => void) | null = null;

  constructor() {
    super('pointer-test');
  }

  create(): void {
    const { width, height } = this.scale;
    session.configureInput({ tilt: {}, pointer: {}, swing: true });

    this.add
      .text(width / 2, 32, '기울이면 원이 움직입니다 · A 색 변경 · HOME 중앙 · ESC 로비', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#98a0b3',
      })
      .setOrigin(0.5, 0);

    this.add.line(0, 0, 0, height / 2, width, height / 2, 0x232838).setOrigin(0);
    this.add.line(0, 0, width / 2, 0, width / 2, height, 0x232838).setOrigin(0);

    this.cleanup = session.onAction((action) => {
      switch (action.kind) {
        case 'tilt': {
          const dot = this.dotFor(action.playerId);
          // Tilt y is positive upwards; the screen grows downwards.
          dot.setPosition(width / 2 + action.x * (width * 0.45), height / 2 - action.y * (height * 0.45));
          break;
        }
        case 'button_down': {
          if (action.button === 'A') this.cycleColor(action.playerId);
          if (action.button === 'HOME') this.dotFor(action.playerId).setPosition(width / 2, height / 2);
          break;
        }
        case 'swing': {
          // Flash so a swing is visible even while tilt is the main input.
          this.cameras.main.flash(120, 60, 70, 90);
          session.vibrate(action.playerId, [Math.round(30 + action.strength * 70)]);
          break;
        }
        default:
          break;
      }
    });

    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('lobby'));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.cleanup?.();
      this.cleanup = null;
      this.dots.clear();
      this.colorIndex.clear();
    });
  }

  private dotFor(playerId: number): Phaser.GameObjects.Arc {
    const existing = this.dots.get(playerId);
    if (existing) return existing;

    const player = session.players.find((candidate) => candidate.id === playerId);
    const color = player ? Number(`0x${player.color.slice(1)}`) : 0xffffff;
    const dot = this.add.circle(this.scale.width / 2, this.scale.height / 2, 26, color);
    this.dots.set(playerId, dot);
    return dot;
  }

  private cycleColor(playerId: number): void {
    const next = ((this.colorIndex.get(playerId) ?? -1) + 1) % COLORS.length;
    this.colorIndex.set(playerId, next);
    this.dotFor(playerId).setFillStyle(COLORS[next] ?? 0xffffff);
  }
}
