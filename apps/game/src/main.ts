import Phaser from 'phaser';
import { BroadcastSignaling, PUBLIC_ICE_SERVERS, publicSignaling } from '@phonemote/peer';
import { GAMES } from './games.js';
import { PeerHost } from './net/peerHost.js';
import { CalibrationScene } from './scenes/CalibrationScene.js';
import { LobbyScene } from './scenes/LobbyScene.js';
import { gameScenes } from './sceneTable.js';
import { session } from './session.js';
import { AxisRecorder } from './ui/AxisRecorder.js';
import { unlockAudio } from './ui/audio.js';
import { DebugOverlay } from './ui/DebugOverlay.js';
import { showWebBanner } from './ui/webBanner.js';
import { WEB_BUILD } from './web.js';

/**
 * Game entry point. The session owns the link to the phones and the input
 * pipeline; scenes only ever see GameActions (ARCHITECTURE.md P4).
 */

// Anything that throws anywhere on the page lands in the overlay. Without
// this, a crash inside a scene looks exactly like the game quietly freezing.
window.addEventListener('error', (event) => session.reportError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => session.reportError(event.reason));

const params = new URLSearchParams(window.location.search);

if (WEB_BUILD) {
  // The page is the host (D60). `?signal=local` keeps the handshake inside one
  // browser, for the end-to-end test; everyone else signals through every
  // public channel at once (D61).
  const local = params.get('signal') === 'local';
  session.start(
    (handlers) =>
      new PeerHost(handlers, {
        signaling: (address) =>
          local ? new BroadcastSignaling(address) : publicSignaling(address),
        iceServers: local ? [] : PUBLIC_ICE_SERVERS,
        controllerUrl: (code) =>
          new URL(`controller/?room=${code}${local ? '&signal=local' : ''}`, window.location.href)
            .href,
      }),
  );
  showWebBanner();
} else {
  session.start();
}

// The first sound this game makes is a ball being hit by a phone, over a
// socket, with nobody having touched this machine. Chrome will not start an
// audio context outside a gesture, so one is armed here rather than hoping.
unlockAudio();

// Hidden in the web build: a wall of numbers is not the first thing somebody
// arriving from a link should see. Alt+D shows it.
const overlay = new DebugOverlay(document.body, { hidden: WEB_BUILD });
overlay.start();

// Alt+R walks through the axis measurements and posts them to the relay,
// which the web build does not have.
if (!WEB_BUILD) new AxisRecorder();

// Keyboard stand-ins and recorded traces. Both push frames through the real
// pipeline rather than faking GameActions, so the game can be played, and a
// change felt, without a phone in the room.
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
  scene: [LobbyScene, CalibrationScene, ...gameScenes()],
});

// N in the lobby seats one more keyboard player, up to four. N is on none of
// the four keyboard layouts, so it can never be a button press in disguise.
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'n' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!game.scene.isActive('lobby')) return;
  void import('./dev/FakeController.js').then((module) => module.addKeyboardPlayer());
});

/**
 * Handle on the running game, for development and for the web build.
 *
 * Two things need it. Driving the game from the console — starting a scene,
 * reading its state — is how a rule change gets checked without a phone. And an
 * automated browser can be missing requestAnimationFrame entirely, which stops
 * Phaser's loop dead; `game.step` lets something else drive it instead. The
 * end-to-end tests (apps/game/e2e) play every game through this handle, against
 * the web build, so what they check is what gets deployed.
 */
if (import.meta.env.DEV || WEB_BUILD) {
  Object.assign(window, { phonemote: { game, session, games: GAMES } });
}
