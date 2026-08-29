import { createServer } from 'node:https';
import { PORTS } from '@phonemote/protocol';
import { loadTlsMaterial, MissingCertificateError } from './https.js';
import { resolveLanIp } from './lanIp.js';

/**
 * Relay server.
 *
 * Phase 0 scope: terminate HTTPS on the fixed port, resolve the LAN IP and
 * report it. Room routing and the WebSocket layer arrive in Phase 1 — this
 * process never interprets sensor packets (ARCHITECTURE.md P1).
 */

function main(): void {
  const lan = resolveLanIp();

  if (lan.candidates.length > 1 && lan.source === 'auto') {
    console.warn('[relay] several LAN IP candidates found:');
    for (const candidate of lan.candidates) {
      const mark = candidate.address === lan.host ? '*' : ' ';
      console.warn(`  ${mark} ${candidate.address}  (${candidate.name})`);
    }
    console.warn(`[relay] using ${lan.host}. Pin it with PHONEMOTE_HOST=<ip> if that is wrong.`);
  }

  const tls = loadTlsMaterial();

  const server = createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: lan.host }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('PhoneMote relay: WebSocket only\n');
  });

  server.listen(PORTS.relay, '0.0.0.0', () => {
    console.log(`[relay]      wss://${lan.host}:${PORTS.relay}  (host source: ${lan.source})`);
    console.log(`[game]      https://${lan.host}:${PORTS.game}`);
    console.log(`[controller] https://${lan.host}:${PORTS.controller}`);
  });
}

try {
  main();
} catch (error) {
  if (error instanceof MissingCertificateError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
