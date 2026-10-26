import { BroadcastSignaling } from './broadcast.js';
import { publicSignaling } from './public.js';
import { PUBLIC_ICE_SERVERS } from './rtc.js';
import { DEFAULT_SERVER_URL, ServerSignaling, randomToken } from './server.js';
import type { Signaling } from './signaling.js';

/**
 * How the web build's pages connect, read off the page's query string
 * (ARCHITECTURE.md D63). The game and the controller share it, and the game
 * hands its choices on to the controller through the QR code's URL, so the two
 * always signal the same way.
 *
 *   (default)          the PhoneMote server, plus the public channels
 *   ?signal=server     the PhoneMote server only (the relay end-to-end test)
 *   ?signal=local      inside one browser, no server (the other e2e tests)
 *   ?server=ws://…     a server on this machine instead of the deployed one
 */
export interface WebSetup {
  readonly signaling: (address: string) => Signaling;
  readonly iceServers: readonly RTCIceServer[];
  /** The relay, and the token this page's server signaling uses. Absent when local. */
  readonly relay?: { readonly url: string; readonly token: string };
  /** Query parameters to hand on to the controller page. */
  readonly carry: string;
}

/**
 * Only a server on this machine may be swapped in by a link. Anything else
 * would let a crafted URL point a room, and its players' streams, at a relay
 * the room's owner never chose.
 */
const LOCAL_SERVER = /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function webSetup(params: URLSearchParams, configuredServer?: string): WebSetup {
  const mode = params.get('signal');
  const override = params.get('server');
  const server =
    override !== null && LOCAL_SERVER.test(override)
      ? override
      : configuredServer || DEFAULT_SERVER_URL;
  const carry = new URLSearchParams();
  if (mode === 'local' || mode === 'server') carry.set('signal', mode);
  if (server === override) carry.set('server', server);

  if (mode === 'local') {
    return { signaling: (address) => new BroadcastSignaling(address), iceServers: [], carry: carry.toString() };
  }
  const token = randomToken();
  return {
    signaling: (address) =>
      mode === 'server'
        ? new ServerSignaling(address, server, token)
        : publicSignaling(address, { server, token }),
    // A test on one machine needs no STUN; everyone else does.
    iceServers: mode === 'server' ? [] : PUBLIC_ICE_SERVERS,
    relay: { url: server, token },
    carry: carry.toString(),
  };
}
