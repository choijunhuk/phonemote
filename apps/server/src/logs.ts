import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Somewhere for the game to write down what happened, so it can be read later
 * by someone who was not in the room.
 *
 * The phone is the only place the truth about an axis lives, and "it feels
 * wrong" cannot be debugged. A recorded session can: the game posts what it
 * measured while the player did a named movement, and the numbers settle the
 * question instead of another round of guessing.
 *
 * Line-delimited JSON, one session per line, newest appended.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const LOG_DIR = resolve(here, '../../../logs');
const LOG_FILE = 'sessions.jsonl';
/** A session of samples is a few hundred kB at most; anything bigger is a bug. */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

export function appendLog(body: string): { ok: true; bytes: number } | { ok: false; why: string } {
  if (body.length > MAX_LOG_BYTES) return { ok: false, why: 'too large' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, why: 'not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, why: 'not an object' };

  const stamped = JSON.stringify({ receivedAt: new Date().toISOString(), ...parsed });
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(join(LOG_DIR, LOG_FILE), `${stamped}\n`, 'utf8');
  return { ok: true, bytes: stamped.length };
}

export function listLogs(): Array<{ name: string; bytes: number; lines: number }> {
  try {
    return readdirSync(LOG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => {
        const text = readFileSync(join(LOG_DIR, entry.name), 'utf8');
        return {
          name: entry.name,
          bytes: text.length,
          lines: text.split('\n').filter((line) => line.trim().length > 0).length,
        };
      });
  } catch {
    return [];
  }
}
