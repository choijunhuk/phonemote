/**
 * Game entry point.
 *
 * Phase 0 scope: a placeholder page that proves the HTTPS dev server is up on
 * the fixed port. Phaser, the lobby and the input pipeline arrive in Phase 1.
 */

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('#app is missing from index.html');

const heading = document.createElement('h1');
heading.textContent = 'PhoneMote';

const subtitle = document.createElement('p');
subtitle.textContent = 'Phase 0 — scaffolding. Lobby and games arrive in Phase 1.';

app.append(heading, subtitle);

// This file is loaded as an ES module; the empty export keeps TypeScript from
// treating it as a global script.
export {};
