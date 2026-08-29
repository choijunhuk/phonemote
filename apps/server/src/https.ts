import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Certificate loading. Every process in PhoneMote speaks HTTPS/WSS because the
 * sensor APIs only fire in a secure context (ARCHITECTURE.md 2).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const CERT_DIR = resolve(here, '../../../certs');
export const CERT_FILE = resolve(CERT_DIR, 'dev-cert.pem');
export const KEY_FILE = resolve(CERT_DIR, 'dev-key.pem');

export interface TlsMaterial {
  readonly cert: Buffer;
  readonly key: Buffer;
}

export class MissingCertificateError extends Error {
  constructor(cause: unknown) {
    super(
      `Could not read the dev certificate.\n` +
        `  expected: ${CERT_FILE}\n` +
        `            ${KEY_FILE}\n\n` +
        `Run this first:\n` +
        `  pnpm setup:certs\n\n` +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'MissingCertificateError';
  }
}

export function loadTlsMaterial(): TlsMaterial {
  try {
    return { cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) };
  } catch (cause) {
    throw new MissingCertificateError(cause);
  }
}
