import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'vitest';
import { decodeSensor, parseTrace } from '@phonemote/protocol';
import { normalize } from '../SensorNormalizer.js';
import type { CanonicalSensorFrame } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(here, '../../../../../traces/corpus');
const OUT = 'C:/Users/choij/AppData/Local/Temp/claude/C--Users-choij-Desktop-wii-project/335c8481-8b39-4036-b1a7-756058c0a538/scratchpad/stats.txt';

const LOG: string[] = [];
function log(...parts: unknown[]): void {
  LOG.push(parts.map((p) => String(p)).join(' '));
}

function load(name: string): CanonicalSensorFrame[] {
  const trace = parseTrace(readFileSync(join(CORPUS, name), 'utf8'));
  let prev: number | null = null;
  const out: CanonicalSensorFrame[] = [];
  for (const encoded of trace.frames) {
    const f = decodeSensor(encoded);
    const c = normalize(f, prev);
    prev = f.timestamp;
    out.push(c);
  }
  return out;
}

describe('scratch', () => {
  it('dumps stats', () => {
    for (const name of ['real-rest.pmtrace', 'real-swing.pmtrace']) {
      const frames = load(name);
      const mag = frames.map((f) =>
        Math.hypot(f.angularVelocity.yaw, f.angularVelocity.pitch, f.angularVelocity.roll),
      );
      const sorted = [...mag].sort((a, b) => a - b);
      const dts = frames
        .slice(1)
        .map((f, i) => f.timestamp - (frames[i]?.timestamp ?? 0))
        .sort((a, b) => a - b);
      const maxAxis = (k: 'yaw' | 'pitch' | 'roll'): string =>
        Math.max(...frames.map((f) => Math.abs(f.angularVelocity[k]))).toFixed(2);
      log(
        name,
        'n=' + frames.length,
        'medianDt=' + String(dts[Math.floor(dts.length / 2)]),
        'mean=' + (mag.reduce((a, b) => a + b, 0) / mag.length).toFixed(3),
        'median=' + String(sorted[Math.floor(sorted.length / 2)]?.toFixed(3)),
        'p95=' + String(sorted[Math.floor(sorted.length * 0.95)]?.toFixed(3)),
        'max=' + String(sorted.at(-1)?.toFixed(3)),
        'maxYaw=' + maxAxis('yaw'),
        'maxPitch=' + maxAxis('pitch'),
        'maxRoll=' + maxAxis('roll'),
      );
      for (const gate of [20, 25, 30, 35, 40]) {
        log('  over ' + String(gate) + ': ' + String(mag.filter((m) => m > gate).length));
      }
      // longest run of consecutive frames above each gate
      for (const gate of [30, 35, 40]) {
        let run = 0;
        let best = 0;
        for (const m of mag) {
          run = m > gate ? run + 1 : 0;
          if (run > best) best = run;
        }
        log('  longest run over ' + String(gate) + ': ' + String(best));
      }
    }
    writeFileSync(OUT, LOG.join('\n'), 'utf8');
  });
});
