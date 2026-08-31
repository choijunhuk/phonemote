import Phaser from 'phaser';
import { CalibrationScene } from './scenes/CalibrationScene.js';
import { LobbyScene } from './scenes/LobbyScene.js';
import { GAMES } from './games.js';
import { session } from './session.js';
import { AxisRecorder } from './ui/AxisRecorder.js';
import { unlockAudio } from './ui/audio.js';
import { DebugOverlay } from './ui/DebugOverlay.js';

/**
 * Game entry point. The session owns the socket and the input pipeline; scenes
 * only ever see GameActions (ARCHITECTURE.md P4).
 */

// Anything that throws anywhere on the page lands in the overlay. Without
// this, a crash inside a scene looks exactly like the game quietly freezing.
window.addEventListener('error', (event) => session.reportError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => session.reportError(event.reason));

session.start();
// The first sound this game makes is a ball being hit by a phone, over a
// socket, with nobody having touched this machine. Chrome will not start an
// audio context outside a gesture, so one is armed here rather than hoping.
unlockAudio();

const overlay = new DebugOverlay();
overlay.start();

// Press r to walk through the axis measurements and post them to the relay.
new AxisRecorder();

// Development stand-ins. Both push frames through the real pipeline rather
// than faking GameActions, so the game can be played, and a change felt,
// without a phone in the room.
const params = new URLSearchParams(window.location.search);
const fake = params.get('fake');
if (fake !== null) {
  void import('./dev/FakeController.js').then((module) => {
    module.startFakeControllers(Number(fake) || 1);
  });
}
const replayName = params.get('replay');
if (replayName !== null) {
  void import('./dev/replay.js')
    .then((module) => module.startReplay(replayName))
    .catch((error: unknown) => session.reportError(error));
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 1280,
  height: 720,
  backgroundColor: '#0f1116',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  // Games come from the registry, so adding one is a single edit there.
  scene: [LobbyScene, CalibrationScene, ...GAMES.map((entry) => entry.scene)],
});

/**
 * Dev-only handle on the running game.
 *
 * Two things need it. Driving the game from the console — starting a scene,
 * reading its state — is how a rule change gets checked without a phone. And an
 * automated browser can be missing requestAnimationFrame entirely, which stops
 * Phaser's loop dead; `game.step` lets something else drive it instead.
 */
if (import.meta.env.DEV) {
  Object.assign(window, { phonemote: { game, session } });
}
