import {
  SENSOR_FRAME_VERSION,
  encodeSensor,
  type SensorFrame,
} from '@phonemote/protocol';
import { formatSnapshot } from './debug.js';
import { clientId } from './identity.js';
import { SensorSource, checkSupport, type SensorSnapshot } from './sensors.js';
import { Transport } from './transport.js';
import { ControllerUi } from './ui.js';
import { requestWakeLock, watchVisibility } from './wakelock.js';

/**
 * Controller entry point: capture raw sensors, send them, echo pings, buzz.
 * It knows nothing about the game (ARCHITECTURE.md P2).
 */

/** Slow enough to be negligible traffic, fast enough that a button still feels instant. */
const KEEPALIVE_INTERVAL_MS = 100;
const SENSOR_RESTART_AFTER_MS = 2000;

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('#app is missing from index.html');

const ui = new ControllerUi(app);
const support = checkSupport();

if (!support.supported) {
  ui.setStatus('failed', `사용할 수 없음: ${support.missing.join(', ')}`);
  ui.setDebugText(
    '이 페이지는 Android Chrome에서 HTTPS로 열어야 합니다.\n' +
      '인증서 경고를 무시하고 들어온 경우에도 센서는 동작하지만,\n' +
      '릴레이 연결은 루트 CA를 설치해야 합니다. README 3장을 보세요.',
  );
} else {
  start();
}

function start(): void {
  const params = new URLSearchParams(window.location.search);
  const prefilled = (params.get('room') ?? '').toUpperCase().slice(0, 4);

  ui.setStatus('idle');
  ui.showJoinForm(prefilled, ({ roomCode, name }) => {
    // Started from a tap, which is also the moment a wake lock may be granted.
    void requestWakeLock();
    watchVisibility();
    run(roomCode, name);
  });
}

function run(roomCode: string, name: string): void {
  const sensors = new SensorSource();
  ui.onHoldModeChange((mode) => sensors.setHoldMode(mode));
  sensors.start();

  let seq = 0;
  let sent = 0;
  let dropped = 0;
  let framesThisSecond = 0;
  let lastSecond = performance.now();
  let hz = 0;

  const transport = new Transport(
    roomCode,
    {
      onState: (state, detail) => ui.setStatus(state, detail),
      onJoined: (playerId, color) => ui.showPad(color, playerId),
      onServerMessage: (message) => {
        if (message.type === 'vibrate') ui.vibrate(message.pattern);
        if (message.type === 'error') ui.setStatus('failed', message.message);
      },
      onGiveUp: (reason) => ui.showJoinAgain(reason),
    },
    name || undefined,
    clientId(),
  );
  transport.connect();

  const send = (snapshot: SensorSnapshot): void => {
    const playerId = transport.currentPlayerId;
    // A hidden page still gets the occasional event; sending it would only feed
    // the game stale poses from a phone in someone's pocket.
    if (playerId === null || document.visibilityState !== 'visible') return;

    const frame: SensorFrame = {
      playerId,
      seq,
      timestamp: snapshot.timestamp,
      orientation: snapshot.orientation,
      rotationRate: snapshot.rotationRate,
      acceleration: snapshot.acceleration,
      buttons: ui.takeButtonMask(),
      screenOrientation: snapshot.screenOrientation,
      version: SENSOR_FRAME_VERSION,
      motionSeq: snapshot.motionSeq,
      flags: snapshot.flags,
    };

    // seq counts frames we meant to send, including the ones we drop, so the
    // game's loss figure covers backpressure drops instead of hiding them.
    seq = (seq + 1) % (1 << 24);
    if (transport.sendFrame(encodeSensor(frame))) {
      sent++;
      framesThisSecond++;
    } else {
      dropped++;
    }

    const now = performance.now();
    if (now - lastSecond >= 1000) {
      hz = (framesThisSecond * 1000) / (now - lastSecond);
      framesThisSecond = 0;
      lastSecond = now;
      ui.setDebugText(formatSnapshot(snapshot, sent, dropped, hz));
    }
  };

  let lastSentAt = performance.now();
  sensors.onFrame((snapshot) => {
    lastSentAt = performance.now();
    send(snapshot);
  });

  /**
   * Sending is driven by the sensor, so a stalled sensor would take the buttons
   * down with it. This keeps a slow trickle going: those frames carry the same
   * motionSeq, which is exactly how the game knows to freeze the motion while
   * still honouring a button press.
   */
  window.setInterval(() => {
    if (transport.currentPlayerId === null) return;
    const now = performance.now();
    if (now - lastSentAt >= KEEPALIVE_INTERVAL_MS) {
      lastSentAt = now;
      send(sensors.read());
    }

    const silent = now - sensors.lastEventAt;
    if (silent < SENSOR_RESTART_AFTER_MS) return;
    ui.setStatus('joined', `센서 멈춤 ${(silent / 1000).toFixed(0)}초`);
    // Android sometimes stops delivering after a spell in the background, and a
    // fresh registration is the only thing that reliably brings it back.
    sensors.restart();
  }, KEEPALIVE_INTERVAL_MS);
}
