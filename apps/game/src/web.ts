/**
 * The web build (ARCHITECTURE.md D56, D60).
 *
 * The same game, built for a static host such as GitHub Pages: no relay, no
 * certificates, no server of its own. The page itself hosts the room, phones
 * join over WebRTC by scanning its QR code, and keyboard stand-ins can take
 * their place. Open the page on a PC, scan the code with an Android phone,
 * play.
 *
 * Fixed at build time (`vite build --mode web`). A query string cannot switch
 * it on, so the LAN game never loses its relay by accident.
 */
export const WEB_BUILD = import.meta.env.MODE === 'web';

export const SOURCE_URL = 'https://github.com/choijunhuk/phonemote';
