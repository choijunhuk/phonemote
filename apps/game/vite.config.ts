import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
// Relative import on purpose: vite.config.ts is loaded by Node before any TS
// transform is available, so the port constants must be inlined by esbuild
// rather than resolved through the workspace package entry point.
import { PORTS } from '../../packages/protocol/src/constants.ts';

const certDir = resolve(import.meta.dirname, '../../certs');

/**
 * The game page is HTTPS too: it opens a wss:// socket, and a plain http page
 * mixed with wss (or an https page with ws) is blocked (ARCHITECTURE.md 2).
 */
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: PORTS.game,
    strictPort: true,
    https: {
      cert: readFileSync(resolve(certDir, 'dev-cert.pem')),
      key: readFileSync(resolve(certDir, 'dev-key.pem')),
    },
  },
});
