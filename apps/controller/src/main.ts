/**
 * Controller entry point.
 *
 * Phase 0 scope: prove the phone can load this page over HTTPS with a trusted
 * certificate, and show whether the secure context the sensor APIs require is
 * actually in place. Sensor streaming, the room form and the button layout
 * arrive in Phase 1 and 2.
 */

import { PORTS } from '@phonemote/protocol';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('#app is missing from index.html');

const rows: ReadonlyArray<readonly [string, string, boolean]> = [
  ['origin', window.location.origin, true],
  ['secure context', String(window.isSecureContext), window.isSecureContext],
  ['screen orientation', screen.orientation.type, true],
];

const heading = document.createElement('h1');
heading.textContent = 'PhoneMote Controller';

const subtitle = document.createElement('p');
subtitle.textContent = 'Phase 0 — connection check only.';
subtitle.style.color = 'var(--muted)';
subtitle.style.margin = '0';

const list = document.createElement('dl');
for (const [label, value, good] of rows) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dd.className = good ? 'ok' : 'bad';
  list.append(dt, dd);
}

// Phone-side setup aid: the same server hands out mkcert's root CA, so the
// certificate warning can be fixed without moving files off the PC by hand.
const caLink = document.createElement('a');
caLink.href = '/rootCA.crt';
caLink.textContent = '루트 CA 내려받기 (rootCA.crt)';
caLink.style.color = 'var(--ok)';

const caHint = document.createElement('p');
caHint.style.color = 'var(--muted)';
caHint.style.margin = '0';
caHint.style.fontSize = '0.85rem';
caHint.textContent =
  '인증서 경고가 뜬다면: 위 파일을 받은 뒤 설정 앱에서 설치하세요. ' +
  '설정 검색창에 "CA 인증서" > 인증서 설치 > CA 인증서 > 다운로드 폴더에서 선택. ' +
  '다운로드한 파일을 직접 탭하면 Android가 설치를 거부합니다.';

app.append(heading, subtitle, list, caLink, caHint);

/**
 * The certificate check that actually matters.
 *
 * A page warning can be clicked through; a TLS failure on a fetch or a
 * WebSocket cannot. If this probe succeeds, the relay's certificate is trusted
 * for real and Phase 1 sensor streaming will connect.
 */
const relayUrl = `https://${window.location.hostname}:${PORTS.relay}/health`;
const relayRow = document.createElement('dd');
const relayLabel = document.createElement('dt');
relayLabel.textContent = 'relay TLS';
relayRow.textContent = '확인 중…';
list.append(relayLabel, relayRow);

try {
  await fetch(relayUrl, { mode: 'no-cors', signal: AbortSignal.timeout(4000) });
  relayRow.textContent = 'ok — 인증서 신뢰됨';
  relayRow.className = 'ok';
} catch {
  relayRow.textContent = '실패 — 릴레이 인증서가 신뢰되지 않음';
  relayRow.className = 'bad';
}

// This file is loaded as an ES module; the empty export keeps TypeScript from
// treating it as a global script.
export {};
