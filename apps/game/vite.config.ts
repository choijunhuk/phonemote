import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
// Relative import on purpose: vite.config.ts is loaded by Node before any TS
// transform is available, so the port constants must be inlined by esbuild
// rather than resolved through the workspace package entry point.
import { PORTS } from '../../packages/protocol/src/constants.ts';

const certDir = resolve(import.meta.dirname, '../../certs');
const corpusDir = resolve(import.meta.dirname, '../../traces/corpus');

function devCertificate(): { cert: Buffer; key: Buffer } {
  const cert = resolve(certDir, 'dev-cert.pem');
  const key = resolve(certDir, 'dev-key.pem');
  if (!existsSync(cert) || !existsSync(key)) {
    throw new Error(`No dev certificate in ${certDir}. Run \`pnpm setup:certs\` first.`);
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

/**
 * Ships the committed trace corpus beside the web build's page, so `?replay=` works on
 * a static host. In the real game the relay serves these instead.
 */
function webTraces(): Plugin {
  return {
    name: 'phonemote-web-traces',
    apply: (_config, env) => env.command === 'build' && env.mode === 'web',
    generateBundle() {
      for (const name of readdirSync(corpusDir)) {
        if (!name.endsWith('.pmtrace')) continue;
        this.emitFile({
          type: 'asset',
          fileName: `traces/${name}`,
          source: readFileSync(resolve(corpusDir, name)),
        });
      }
    },
  };
}

/**
 * The game page is HTTPS too: it opens a wss:// socket, and a plain http page
 * mixed with wss (or an https page with ws) is blocked (ARCHITECTURE.md 2).
 *
 * Only serving needs the certificate. A build reads none, so it works on a
 * machine that has never run `pnpm setup:certs`, such as CI (D54). The web
 * build (`--mode web`, D60) talks to phones over WebRTC from a public origin,
 * so it needs none even to serve.
 */
export default defineConfig(({ command, mode }) => {
  const web = mode === 'web';
  return {
    // Relative, so the web build works wherever it is hosted: GitHub Pages
    // serves it under /phonemote/, a local preview at the root.
    base: web ? './' : '/',
    plugins: [webTraces()],
    build: {
      // Phaser alone is about 1.2 MB minified and cannot be split further, so
      // the default 500 kB warning fired on every build and said nothing.
      chunkSizeWarningLimit: 1600,
      // Not dist/ itself: emptying it took the web build in dist/web with it,
      // and the e2e tests with nothing to serve. `build:web` passes its own.
      outDir: 'dist/lan',
    },
    server: {
      host: '0.0.0.0',
      port: PORTS.game,
      strictPort: true,
      ...(command === 'serve' && !web ? { https: devCertificate() } : {}),
    },
  };
});
