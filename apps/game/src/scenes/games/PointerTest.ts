import Phaser from 'phaser';
import { session } from '../../session.js';

/**
 * Phase 1 sanity check: a tilt dot, a gyro pointer, and the numbers that say
 * whether either of them is behaving.
 *
 * The pointer crosshair matters more than it looks. Until it existed the gyro
 * pointer had never been drawn on screen at all — PointerMode ran, emitted, and
 * nothing consumed it — so every claim about pointer drift was a guess. The
 * drift readout turns it into a measurement: hold the phone still, watch the
 * number.
 */

const COLORS = [0xff4757, 0x3742fa, 0x2ed573, 0xffa502, 0xf1f3f8];

interface PointerTrack {
  readonly crosshair: Phaser.GameObjects.Container;
  x: number;
  y: number;
  /** Total path length since the last reset: drift accumulates, position hides it. */
  travelled: number;
  restedAt: number;
  restedFrom: { x: number; y: number };
}

export class PointerTest extends Phaser.Scene {
  private readonly dots = new Map<number, Phaser.GameObjects.Arc>();
  private readonly pointers = new Map<number, PointerTrack>();
  private readonly colorIndex = new Map<number, number>();
  private readout!: Phaser.GameObjects.Text;
  private cleanup: (() => void) | null = null;

  constructor() {
    super('pointer-test');
  }

  create(): void {
    const { width, height } = this.scale;
    session.configureInput({ tilt: {}, pointer: {}, swing: true });

    this.add
      .text(width / 2, 24, '● 기울기   ✛ 자이로 포인터   ·   A 색 변경   HOME 재중심   ESC 로비', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#98a0b3',
      })
      .setOrigin(0.5, 0);

    this.add.line(0, 0, 0, height / 2, width, height / 2, 0x232838).setOrigin(0);
    this.add.line(0, 0, width / 2, 0, width / 2, height, 0x232838).setOrigin(0);

    this.readout = this.add
      .text(width / 2, height - 20, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#98a0b3',
        align: 'center',
      })
      .setOrigin(0.5, 1);

    this.cleanup = session.onAction((action) => {
      switch (action.kind) {
        case 'tilt': {
          const dot = this.dotFor(action.playerId);
          // Tilt y is positive upwards; the screen grows downwards.
          dot.setPosition(
            width / 2 + action.x * (width * 0.45),
            height / 2 - action.y * (height * 0.45),
          );
          break;
        }
        case 'pointer_move': {
          this.movePointer(action.playerId, action.x, action.y);
          break;
        }
        case 'button_down': {
          if (action.button === 'A') this.cycleColor(action.playerId);
          if (action.button === 'HOME') this.resetDrift(action.playerId);
          break;
        }
        case 'swing': {
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
      this.pointers.clear();
      this.colorIndex.clear();
    });
  }

  override update(): void {
    const lines: string[] = [];
    for (const [playerId, track] of this.pointers) {
      const seconds = (performance.now() - track.restedAt) / 1000;
      const displaced = Math.hypot(track.x - track.restedFrom.x, track.y - track.restedFrom.y);
      lines.push(
        `P${playerId}  포인터 ${track.x.toFixed(3)}, ${track.y.toFixed(3)}   ` +
          `HOME 이후 ${seconds.toFixed(0)}초에 ${displaced.toFixed(3)} 이동 ` +
          `(경로 ${track.travelled.toFixed(2)})`,
      );
    }
    this.readout.setText(
      lines.length > 0 ? lines.join('\n') : '연결된 컨트롤러가 없습니다 (?fake=1 로 키보드 사용)',
    );
  }

  private movePointer(playerId: number, x: number, y: number): void {
    const track = this.pointerFor(playerId);
    track.travelled += Math.hypot(x - track.x, y - track.y);
    track.x = x;
    track.y = y;
    track.crosshair.setPosition(x * this.scale.width, y * this.scale.height);
  }

  private resetDrift(playerId: number): void {
    const track = this.pointerFor(playerId);
    track.travelled = 0;
    track.restedAt = performance.now();
    track.restedFrom = { x: track.x, y: track.y };
    this.dotFor(playerId).setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  private pointerFor(playerId: number): PointerTrack {
    const existing = this.pointers.get(playerId);
    if (existing) return existing;

    const color = this.colorOf(playerId);
    const horizontal = this.add.rectangle(0, 0, 34, 2, color);
    const vertical = this.add.rectangle(0, 0, 2, 34, color);
    const ring = this.add.circle(0, 0, 16).setStrokeStyle(2, color, 0.7);
    const crosshair = this.add.container(this.scale.width / 2, this.scale.height / 2, [
      horizontal,
      vertical,
      ring,
    ]);

    const track: PointerTrack = {
      crosshair,
      x: 0.5,
      y: 0.5,
      travelled: 0,
      restedAt: performance.now(),
      restedFrom: { x: 0.5, y: 0.5 },
    };
    this.pointers.set(playerId, track);
    return track;
  }

  private colorOf(playerId: number): number {
    const player = session.players.find((candidate) => candidate.id === playerId);
    return player ? Number(`0x${player.color.slice(1)}`) : 0xffffff;
  }

  private dotFor(playerId: number): Phaser.GameObjects.Arc {
    const existing = this.dots.get(playerId);
    if (existing) return existing;

    const dot = this.add.circle(
      this.scale.width / 2,
      this.scale.height / 2,
      26,
      this.colorOf(playerId),
    );
    this.dots.set(playerId, dot);
    return dot;
  }

  private cycleColor(playerId: number): void {
    const next = ((this.colorIndex.get(playerId) ?? -1) + 1) % COLORS.length;
    this.colorIndex.set(playerId, next);
    this.dotFor(playerId).setFillStyle(COLORS[next] ?? 0xffffff);
  }
}
