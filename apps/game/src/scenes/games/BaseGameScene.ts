import Phaser from 'phaser';
import { session } from '../../session.js';
import { gameByKey, modeByKey, type GameModeKey } from '../../games.js';
import type { GameAction } from '../../input/types.js';

/**
 * What every game scene has to get right, written once.
 *
 * Four scenes had already copied this boilerplate four different ways, and they
 * had already drifted: HOME meant "back to the lobby" in two of them and
 * "re-centre the pointer" in a third; cleanup was a nullable function here and
 * an array there; only one scene ever returned to the lobby by itself. With six
 * more games arriving, the copies would have become ten.
 *
 * The bugs it prevents are not hypothetical. Phaser restarts a scene by calling
 * create() again on the SAME instance, so every class field survives — which is
 * why the lobby stopped showing its QR code after the first game (`qrShown`
 * was never reset) and why a second tennis match showed its winner screen for a
 * single frame (`overSince` was already past its limit). Anything a run owns
 * gets reset in init(), which Phaser calls before every create().
 *
 * P4 still holds: this touches session and GameAction, never the input layer.
 */

export interface GameSceneData {
  /** Chosen in the lobby. Practice is the safe default for a direct start. */
  readonly mode?: string;
}

const MODE_KEYS: readonly GameModeKey[] = ['practice', 'solo', 'versus', 'coop', 'party'];

function asMode(value: string | undefined): GameModeKey {
  return MODE_KEYS.find((mode) => mode === value) ?? 'practice';
}

export abstract class BaseGameScene extends Phaser.Scene {
  /** Which mode the lobby started. Read it in build(); it is set before that. */
  protected mode: GameModeKey = 'practice';
  /** Seconds in the last frame, clamped. Use it for anything frame-rate bound. */
  protected lastDelta = 1 / 60;

  private cleanups: Array<() => void> = [];
  private lobbyIn = 0;
  private waitingText: Phaser.GameObjects.Text | null = null;

  init(data: GameSceneData = {}): void {
    this.mode = asMode(data.mode);
    this.cleanups = [];
    this.lobbyIn = 0;
    this.waitingText = null;
    this.lastDelta = 1 / 60;
  }

  create(): void {
    // One source of truth for what a game reads. The registry and each scene's
    // create() both used to declare it, with nothing checking that they agreed,
    // and a mode-specific config (a putting drill wants different detectors
    // from a full round) made two copies untenable.
    const game = gameByKey(this.scene.key);
    const mode = game ? (modeByKey(game, this.mode) ?? game.modes[0]) : undefined;
    if (mode) session.configureInput(mode.input);

    this.build();

    this.cleanups.push(
      session.onAction((action) => {
        // HOME is the way out, in every game, always. A player holding a phone
        // across the room cannot be expected to remember which game made it
        // mean something else.
        if (action.kind === 'button_down' && action.button === 'HOME') {
          this.scene.start('lobby');
          return;
        }
        this.onGameAction(action);
      }),
    );
    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('lobby'));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const off of this.cleanups) off();
      this.cleanups = [];
      this.teardown();
    });
  }

  override update(_time: number, delta: number): void {
    // A stutter or a backgrounded tab hands us a huge delta; integrating it
    // whole would jump a ball across the court and score a point nobody played.
    const dt = Math.min(delta / 1000, 1 / 30);
    this.lastDelta = dt;

    if (this.lobbyIn > 0) {
      this.lobbyIn -= dt;
      if (this.lobbyIn <= 0) {
        this.scene.start('lobby');
        return;
      }
    }

    this.step(dt);
  }

  /** Build the scene. Called once per run, after init() has cleared state. */
  protected abstract build(): void;

  /** One frame. */
  protected abstract step(dt: number): void;

  /** Everything except HOME, which is handled for you. */
  protected onGameAction(action: GameAction): void {
    void action;
  }

  /** Anything to release beyond the action listener. */
  protected teardown(): void {}

  /** Register something to release on shutdown. */
  protected onCleanup(off: () => void): void {
    this.cleanups.push(off);
  }

  /**
   * Leave for the lobby after a while.
   *
   * A finished game must never be a dead screen: a match that ended while
   * everyone had put their phone down would otherwise sit there until somebody
   * found the keyboard. Calling it repeatedly does not restart the countdown.
   */
  protected returnToLobbyAfter(seconds: number): void {
    if (this.lobbyIn <= 0) this.lobbyIn = seconds;
  }

  /**
   * Say who the game is waiting for, without tearing anything down.
   *
   * A phone inside its rejoin window is still on the roster with its score
   * (ARCHITECTURE.md D48), so waiting is the correct behaviour and saying so is
   * the difference between that and a frozen game.
   */
  protected showWaiting(message: string | null): void {
    if (message === null) {
      this.waitingText?.setVisible(false);
      return;
    }
    this.waitingText ??= this.add
      .text(this.scale.width / 2, this.scale.height * 0.5, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        color: '#ffa502',
        align: 'center',
        backgroundColor: '#0f1116',
        padding: { x: 18, y: 12 },
      })
      .setOrigin(0.5)
      .setDepth(1000);
    this.waitingText.setText(message).setVisible(true);
  }

  /** For the dev harness, so one browser script can drive every game. */
  debugState(): unknown {
    return { scene: this.scene.key, mode: this.mode };
  }
}
