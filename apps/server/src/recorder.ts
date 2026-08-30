import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  TRACE_EXTENSION,
  TRACE_VERSION,
  bytesToHex,
  encodeTraceHeader,
  type TraceHeader,
} from '@phonemote/protocol';

/**
 * Records the sensor stream to disk, so a motion can be played back exactly
 * (ARCHITECTURE.md 8).
 *
 * The relay is the right place for this: it already sees every frame, it does
 * not have to understand any of them to write them down, and the phone needs
 * no changes at all. Frames are stored exactly as they arrived, so a replay
 * exercises the codec as well as everything downstream of it.
 *
 * Off unless --record is passed.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const TRACE_DIR = resolve(here, '../../../traces');

/** Filenames come from room and player, so they cannot collide mid-session. */
function traceName(roomCode: string, playerId: number): string {
  return `${roomCode}-p${playerId}${TRACE_EXTENSION}`;
}

export class TraceRecorder {
  private readonly started = new Set<string>();
  private frameCount = 0;

  constructor(private readonly note: string) {
    mkdirSync(TRACE_DIR, { recursive: true });
  }

  record(roomCode: string, playerId: number, frame: ArrayBuffer): void {
    const file = join(TRACE_DIR, traceName(roomCode, playerId));

    if (!this.started.has(file)) {
      this.started.add(file);
      const header: TraceHeader = {
        trace: TRACE_VERSION,
        roomCode,
        playerId,
        startedAt: new Date().toISOString(),
        note: this.note,
      };
      appendFileSync(file, `${encodeTraceHeader(header)}\n`, 'utf8');
      console.log(`[record] ${file}`);
    }

    appendFileSync(file, `${bytesToHex(frame)}\n`, 'utf8');
    this.frameCount++;
  }

  get stats(): { files: number; frames: number } {
    return { files: this.started.size, frames: this.frameCount };
  }
}

export interface TraceListing {
  readonly name: string;
  readonly bytes: number;
}

function listIn(directory: string, prefix: string): TraceListing[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(TRACE_EXTENSION))
      .map((entry) => ({
        name: `${prefix}${entry.name}`,
        bytes: readFileSync(join(directory, entry.name)).byteLength,
      }));
  } catch {
    return [];
  }
}

/** Session recordings sit at the top; the committed corpus is one level down. */
export function listTraces(): TraceListing[] {
  return [...listIn(TRACE_DIR, ''), ...listIn(join(TRACE_DIR, 'corpus'), 'corpus/')];
}

/**
 * Reads one trace for the replay endpoint. The name is checked rather than
 * joined blindly: this server is on a LAN with other people's devices on it.
 */
export function readTrace(name: string): string | null {
  // Only a bare filename, optionally inside corpus/. This server is on a LAN
  // with other people's devices on it, so the path is checked rather than
  // joined and hoped for.
  if (!/^(corpus\/)?[A-Za-z0-9._-]+$/.test(name) || !name.endsWith(TRACE_EXTENSION)) return null;
  if (name.includes('..')) return null;
  try {
    return readFileSync(join(TRACE_DIR, name), 'utf8');
  } catch {
    return null;
  }
}
