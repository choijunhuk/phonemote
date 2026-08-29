import { listLanIpCandidates, resolveLanIp } from './lanIp.js';

/**
 * Prints every host name the dev certificate must cover, one per line.
 *
 * scripts/setup-certs.sh feeds this straight into mkcert, so the certificate
 * and the server agree on the address by construction (ARCHITECTURE.md 2.1).
 */

const hosts = new Set<string>(['localhost', '127.0.0.1', '::1']);

try {
  hosts.add(resolveLanIp().host);
} catch {
  // No LAN address right now: still emit a certificate that works on localhost.
}
for (const candidate of listLanIpCandidates()) {
  hosts.add(candidate.address);
}

console.log([...hosts].join('\n'));
