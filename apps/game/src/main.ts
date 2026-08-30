import Phaser from 'phaser';
import { CalibrationScene } from './scenes/CalibrationScene.js';
import { LobbyScene } from './scenes/LobbyScene.js';
import { PointerTest } from './scenes/games/PointerTest.js';
import { Tennis } from './scenes/games/Tennis.js';
import { session } from './session.js';
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

const overlay = new DebugOverlay();
overlay.start();

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

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 1280,
  height: 720,
  backgroundColor: '#0f1116',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [LobbyScene, CalibrationScene, PointerTest, Tennis],
});
