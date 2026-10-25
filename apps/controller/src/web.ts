/**
 * The web build of the controller (ARCHITECTURE.md D60): served from the same
 * public HTTPS origin as the game, so the page is a secure context without any
 * certificate on the phone, and it reaches the game over WebRTC instead of the
 * relay. Fixed at build time (`vite build --mode web`).
 */
export const WEB_BUILD = import.meta.env.MODE === 'web';
