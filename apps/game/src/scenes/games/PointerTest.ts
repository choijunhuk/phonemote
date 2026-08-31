import Phaser from 'phaser';
import { session } from '../../session.js';
import { BaseGameScene } from './BaseGameScene.js';
import type { GameAction } from '../../input/types.js';

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

export class PointerTest extends BaseGameScene {
  private readonly dots = new Map<number, Phaser.GameObjects.Arc>();
  private readonly pointers = new Map<number, PointerTrack>();
  private readonly colorIndex = new Map<number, number>();
  private readout!: Phaser.GameObjects.Text;
  private stillnessText!: Phaser.GameObjects.Text;
  private lastStillness = '';

  constructor() {
    super('pointer-test');
  }

  protected build(): void {
    const { width, height } = this.scale;
    this.lastStillness = '';

    this.add
      .text(width / 2, 24, '● 기울기   ✛ 자이로 포인터   ·   A 색 변경   B 재중심   HOME/ESC 로비', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: '#98a0b3',
      })
      .setOrigin(0.5, 0);

    this.add.line(0, 0, 0, height / 2, width, height / 2, 0x232838).setOrigin(0);
    this.add.line(0, 0, width / 2, 0, width / 2, height, 0x232838).setOrigin(0);

    this.readout = this.add
      .text(width / 2, height - 20, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '22px',
        color: '#98a0b3',
        align: 'center',
      })
      .setOrigin(0.5, 1);

    this.stillnessText = this.add
      .text(width / 2, 96, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '22px',
        color: '#98a0b3',
      })
      .setOrigin(0.5, 0);
  }

  protected override onGameAction(action: GameAction): void {
    const { width, height } = this.scale;
    {
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
          // HOME leaves for the lobby in every game, so re-centring moved to B.
          // Two meanings for the same button across nine games is not something
          // a player holding a phone across the room can be asked to remember.
          if (action.button === 'B') this.resetDrift(action.playerId);
          break;
        }
        case 'stillness': {
          // The number behind "hold it steady": what the phone actually reads
          // while the player believes they are holding still.
          this.lastStillness =
            `P${action.playerId}  흔들림 ${action.rate.toFixed(1)}°/s   ` +
            `${action.still ? `정지 ${(action.steadyMs / 1000).toFixed(1)}초` : '움직임'}` +
            `${action.stalled ? '   센서 정지' : ''}`;
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
    }
  }

  protected override teardown(): void {
    this.dots.clear();
    this.pointers.clear();
    this.colorIndex.clear();
  }

  protected step(): void {
    this.stillnessText.setText(this.lastStillness);
    const lines: string[] = [];
    for (const [playerId, track] of this.pointers) {
      const seconds = (performance.now() - track.restedAt) / 1000;
      const displaced = Math.hypot(track.x - track.restedFrom.x, track.y - track.restedFrom.y);
      lines.push(
        `P${playerId}  포인터 ${track.x.toFixed(3)}, ${track.y.toFixed(3)}   ` +
          `B 이후 ${seconds.toFixed(0)}초에 ${displaced.toFixed(3)} 이동 ` +
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
