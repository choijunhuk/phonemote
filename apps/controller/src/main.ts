/**
 * Controller entry point.
 *
 * Phase 0 scope: prove the phone can load this page over HTTPS with a trusted
 * certificate, and show whether the secure context the sensor APIs require is
 * actually in place. Sensor streaming, the room form and the button layout
 * arrive in Phase 1 and 2.
 */

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

app.append(heading, subtitle, list);

// This file is loaded as an ES module; the empty export keeps TypeScript from
// treating it as a global script.
export {};
