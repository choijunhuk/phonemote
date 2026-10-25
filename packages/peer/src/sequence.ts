/**
 * Sensor frames over an unordered channel can overtake each other. A frame
 * from before the one already applied would step every integrator backwards in
 * time, so it is dropped: for a live stream, late is the same as lost.
 *
 * The controller counts frames modulo 2^24 (apps/controller/src/main.ts).
 */
const SEQ_SPACE = 1 << 24;
const HALF = SEQ_SPACE / 2;

/** Whether `next` comes after `last` in a sequence that wraps. */
export function isNewerSequence(next: number, last: number): boolean {
  const ahead = (((next - last) % SEQ_SPACE) + SEQ_SPACE) % SEQ_SPACE;
  return ahead !== 0 && ahead < HALF;
}

/** Keeps the newest frame per sender and turns away stragglers. */
export class LatestOnly {
  private readonly last = new Map<number, number>();

  accept(sender: number, seq: number): boolean {
    const last = this.last.get(sender);
    if (last !== undefined && !isNewerSequence(seq, last)) return false;
    this.last.set(sender, seq);
    return true;
  }

  /**
   * A sender starting over — a reloaded page counts from 0 again — must not be
   * judged against the count it had before, or every frame would look old
   * until it caught up.
   */
  forget(sender: number): void {
    this.last.delete(sender);
  }
}
