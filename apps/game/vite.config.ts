import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { PORTS } from '@phonemote/protocol';

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
