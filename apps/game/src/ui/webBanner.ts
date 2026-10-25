import { SOURCE_URL } from '../web.js';

/**
 * The web build's frame: what this page is, how a phone joins, and the keys
 * that stand in for one.
 *
 * Plain DOM above the canvas rather than text inside a scene, so it reads the
 * same in every game and no scene has to know which build it is in. English,
 * because the people who arrive here from the README mostly read English; the
 * game itself is in Korean.
 */

const KEYS =
  '<kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd> tilt &amp; aim · <kbd>Space</kbd> swing ' +
  '(hold an arrow to aim it) · <kbd>Z</kbd> A · <kbd>X</kbd> B · <kbd>C</kbd> trigger / level · ' +
  '<kbd>H</kbd> home · <kbd>Esc</kbd> lobby · <kbd>Alt</kbd>+<kbd>D</kbd> raw vs. interpreted sensor values';

export function showWebBanner(): void {
  const banner = document.createElement('header');
  banner.className = 'web-banner';
  banner.innerHTML = `
    <p class="web-what">
      <strong>PhoneMote</strong> — scan the QR code with Chrome on an Android phone and it becomes
      the motion controller. No app, no install. No phone at hand? Press <kbd>N</kbd> in the lobby
      for a keyboard player.
    </p>
    <p class="web-keys"><b>Keyboard</b> ${KEYS}</p>
    <nav class="web-links"><a href="${SOURCE_URL}">Source on GitHub</a></nav>`;

  document.body.classList.add('web');
  document.body.prepend(banner);

  // The banner wraps to more lines on a narrow window, and the sensor readout
  // (Alt+D) sits just under it rather than over it.
  const publishHeight = (): void => {
    document.body.style.setProperty('--web-banner-height', `${banner.offsetHeight}px`);
  };
  new ResizeObserver(publishHeight).observe(banner);
  publishHeight();
}
