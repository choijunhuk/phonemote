import { PORTS, encodeSensor, type SensorFrame } from '@phonemote/protocol';
import { formatSnapshot } from './debug.js';
import { clientId } from './identity.js';
import { SensorSource, checkSupport } from './sensors.js';
import { Transport } from './transport.js';
import { ControllerUi } from './ui.js';
import { requestWakeLock, watchVisibility } from './wakelock.js';

/**
 * Controller entry point: capture raw sensors, send them, echo pings, buzz.
 * It knows nothing about the game (ARCHITECTURE.md P2).
 */

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
  sensors.start();
  ui.onHoldModeChange((mode) => sensors.setHoldMode(mode));

  const url = `wss://${window.location.hostname}:${PORTS.relay}`;
  let seq = 0;
  let sent = 0;
  let lastSecond = performance.now();
  let framesThisSecond = 0;
  let hz = 0;

  const transport = new Transport(
    url,
    roomCode,
    {
      onState: (state, detail) => ui.setStatus(state, detail),
      onJoined: (playerId, color) => ui.showPad(color, playerId),
      onServerMessage: (message) => {
        if (message.type === 'vibrate') ui.vibrate(message.pattern);
        if (message.type === 'error') ui.setStatus('failed', message.message);
      },
    },
    name || undefined,
    clientId(),
  );
  transport.connect();

  const tick = (): void => {
    requestAnimationFrame(tick);

    const playerId = transport.currentPlayerId;
    const snapshot = sensors.read();

    // A hidden page still gets the occasional frame; sending it would only
    // feed the game stale poses from a phone in someone's pocket.
    if (playerId !== null && document.visibilityState === 'visible') {
      const frame: SensorFrame = {
        playerId,
        seq,
        // Phone clock: only ever compared with itself (ARCHITECTURE.md 6.2).
        timestamp: performance.now(),
        orientation: snapshot.orientation,
        rotationRate: snapshot.rotationRate,
        acceleration: snapshot.acceleration,
        buttons: ui.buttonMask,
        screenOrientation: snapshot.screenOrientation,
      };
      if (transport.sendFrame(encodeSensor(frame))) {
        seq = (seq + 1) % (1 << 24);
        sent++;
        framesThisSecond++;
      }
    }

    const now = performance.now();
    if (now - lastSecond >= 1000) {
      hz = (framesThisSecond * 1000) / (now - lastSecond);
      framesThisSecond = 0;
      lastSecond = now;
      ui.setDebugText(
        sensors.isReceiving
          ? formatSnapshot(snapshot, sent, hz)
          : '센서 이벤트를 아직 받지 못했습니다. 폰을 조금 움직여 보세요.',
      );
    }
  };

  requestAnimationFrame(tick);
}
