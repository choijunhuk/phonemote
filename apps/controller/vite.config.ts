import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { PORTS } from '@phonemote/protocol';

const certDir = resolve(import.meta.dirname, '../../certs');

/**
 * The controller must be served over HTTPS: DeviceMotionEvent and
 * DeviceOrientationEvent only fire in a secure context (ARCHITECTURE.md 2).
 */
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: PORTS.controller,
    strictPort: true,
    https: {
      cert: readFileSync(resolve(certDir, 'dev-cert.pem')),
      key: readFileSync(resolve(certDir, 'dev-key.pem')),
    },
  },
});
