import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
// Relative import on purpose: vite.config.ts is loaded by Node before any TS
// transform is available, so the port constants must be inlined by esbuild
// rather than resolved through the workspace package entry point.
import { PORTS } from '../../packages/protocol/src/constants.ts';

const certDir = resolve(import.meta.dirname, '../../certs');

function devCertificate(): { cert: Buffer; key: Buffer } {
  const cert = resolve(certDir, 'dev-cert.pem');
  const key = resolve(certDir, 'dev-key.pem');
  if (!existsSync(cert) || !existsSync(key)) {
    throw new Error(`No dev certificate in ${certDir}. Run \`pnpm setup:certs\` first.`);
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

/**
 * The game page is HTTPS too: it opens a wss:// socket, and a plain http page
 * mixed with wss (or an https page with ws) is blocked (ARCHITECTURE.md 2).
 *
 * Only serving needs the certificate. A build reads none, so it works on a
 * machine that has never run `pnpm setup:certs`, such as CI.
 */
export default defineConfig(({ command }) => ({
  server: {
    host: '0.0.0.0',
    port: PORTS.game,
    strictPort: true,
    ...(command === 'serve' ? { https: devCertificate() } : {}),
  },
}));
