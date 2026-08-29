import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
// Relative import on purpose: vite.config.ts is loaded by Node before any TS
// transform is available, so the port constants must be inlined by esbuild
// rather than resolved through the workspace package entry point.
import { PORTS } from '../../packages/protocol/src/constants.ts';

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
