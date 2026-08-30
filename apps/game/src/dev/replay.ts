import { PLAYER_COLORS, PORTS, decodeSensor, parseTrace } from '@phonemote/protocol';
import { session } from '../session.js';

/**
 * Plays a recorded trace into the live game (ARCHITECTURE.md 8).
 *
 * The frames go through decode, normalise, fuse and map exactly as they did
 * when they arrived from a phone, so what is being watched is the real
 * pipeline replaying a real motion. Useful for the part a unit test cannot
 * answer: whether a change that looks right in numbers also looks right on
 * screen.
 *
 *   ?replay=swing-forward.pmtrace
 *
 * The relay serves the traces because the browser cannot read the directory.
 */

const FAKE_ID = 99;

export async function startReplay(name: string): Promise<void> {
  const url = `https://${window.location.hostname}:${PORTS.relay}/traces/${encodeURIComponent(name)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Trace ${name} not found (${response.status})`);

  const trace = parseTrace(await response.text());
  const frames = trace.frames.map(decodeSensor);
  const first = frames[0];
  if (!first) throw new Error(`Trace ${name} has no frames`);

  session.addLocalPlayer({
    id: FAKE_ID,
    name: name.replace('.pmtrace', ''),
    color: PLAYER_COLORS[0] ?? '#ffffff',
  });

  console.log(`[replay] ${name}: ${frames.length} frames — ${trace.header.note}`);

  const startedAt = performance.now();
  const originT = first.timestamp;
  let index = 0;

  // Paced by the timestamps the phone recorded, so a stall in the trace is a
  // stall on screen rather than a burst that arrives all at once.
  const tick = (): void => {
    const elapsed = performance.now() - startedAt;
    while (index < frames.length) {
      const frame = frames[index];
      if (!frame || frame.timestamp - originT > elapsed) break;
      session.injectFrame({ ...frame, playerId: FAKE_ID });
      index++;
    }
    if (index < frames.length) requestAnimationFrame(tick);
    else console.log(`[replay] ${name}: finished`);
  };

  requestAnimationFrame(tick);
}
