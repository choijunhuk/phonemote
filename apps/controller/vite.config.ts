import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
// Relative import on purpose: vite.config.ts is loaded by Node before any TS
// transform is available, so the port constants must be inlined by esbuild
// rather than resolved through the workspace package entry point.
import { PORTS } from '../../packages/protocol/src/constants.ts';

const certDir = resolve(import.meta.dirname, '../../certs');

/**
 * Hands the phone the mkcert root CA as a download rather than a page of text.
 * scripts/setup-certs.sh puts the file in public/; this only fixes the headers,
 * which is what decides whether Chrome saves it to Downloads.
 */
function serveRootCa(): Plugin {
  return {
    name: 'phonemote-serve-root-ca',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/rootCA')) return next();
        res.setHeader('content-type', 'application/x-x509-ca-cert');
        res.setHeader('content-disposition', 'attachment; filename="rootCA.crt"');
        next();
      });
    },
  };
}

/**
 * The controller must be served over HTTPS: DeviceMotionEvent and
 * DeviceOrientationEvent only fire in a secure context (ARCHITECTURE.md 2).
 */
export default defineConfig({
  plugins: [serveRootCa()],
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
