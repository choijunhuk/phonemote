/**
 * The browser demo (ARCHITECTURE.md D56).
 *
 * The same game, built for a static host: no relay, no certificates, and
 * keyboard stand-ins pushing raw sensor frames through the real input pipeline
 * where the phones would be. It exists so PhoneMote can be played from a link,
 * without an Android phone, a shared Wi-Fi network or a root CA install.
 *
 * Fixed at build time (`vite build --mode demo`). A query string cannot switch
 * it on, so the real game never starts without its relay by accident.
 */
export const DEMO = import.meta.env.MODE === 'demo';

export const SOURCE_URL = 'https://github.com/choijunhuk/phonemote';
