import { SOURCE_URL } from '../demo.js';

/**
 * The demo's frame: what this page is, which keys stand in for the phone, and
 * the way to the source.
 *
 * Plain DOM above the canvas rather than text inside a scene, so it reads the
 * same in every game and no scene has to know the demo exists. It is in English
 * because the people who arrive here from the README mostly read English; the
 * game itself is in Korean.
 */

const PLAYER_KEYS: readonly string[] = [
  '<kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd> tilt &amp; aim · <kbd>Space</kbd> swing ' +
    '(hold an arrow to aim it) · <kbd>Z</kbd> A · <kbd>X</kbd> B · <kbd>C</kbd> trigger / level · ' +
    '<kbd>H</kbd> home',
  '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> tilt · <kbd>Q</kbd> swing · <kbd>E</kbd> A · ' +
    '<kbd>R</kbd> B · <kbd>F</kbd> trigger · <kbd>G</kbd> home',
];

export function showDemoBanner(params: URLSearchParams): void {
  const players = Number(params.get('fake')) === 2 ? 2 : 1;

  const banner = document.createElement('header');
  banner.className = 'demo-banner';
  banner.innerHTML = `
    <p class="demo-what">
      <strong>PhoneMote</strong> keyboard demo. The real controller is an Android phone you swing
      and tilt; here the keyboard synthesizes the same raw sensor frames, and they go through the
      real input pipeline.
    </p>
    <p class="demo-keys">
      ${PLAYER_KEYS.slice(0, players)
        .map((keys, index) => `<span><b>P${index + 1}</b> ${keys}</span>`)
        .join('')}
      <span><kbd>Esc</kbd> lobby · <kbd>Alt</kbd>+<kbd>D</kbd> raw vs. interpreted sensor values</span>
    </p>
    <nav class="demo-links">
      <a href="?fake=1"${players === 1 ? ' aria-current="page"' : ''}>1 player</a>
      <a href="?fake=2"${players === 2 ? ' aria-current="page"' : ''}>2 players</a>
      <a href="${SOURCE_URL}">Source on GitHub</a>
    </nav>`;

  document.body.classList.add('demo');
  document.body.prepend(banner);

  // The banner wraps to more lines on a narrow window, and the sensor readout
  // (Alt+D) sits just under it rather than over its links.
  const publishHeight = (): void => {
    document.body.style.setProperty('--demo-banner-height', `${banner.offsetHeight}px`);
  };
  new ResizeObserver(publishHeight).observe(banner);
  publishHeight();
}
