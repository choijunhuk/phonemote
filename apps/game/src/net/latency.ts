/**
 * Round-trip latency (ARCHITECTURE.md 6.3).
 *
 * The phone's performance.now() and the PC's do not share an origin, so a
 * one-way time computed from the frame timestamp would be meaningless. Only
 * the round trip, measured entirely on this clock, is real.
 */

export interface LatencyStats {
  readonly samples: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  /** Statistics are only worth reporting once there are enough samples. */
  readonly reportable: boolean;
}

export const MIN_REPORTABLE_SAMPLES = 100;
const MAX_SAMPLES = 600;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? Number.NaN;
}

export class LatencyTracker {
  private readonly pending = new Map<number, number>();
  private readonly samples: number[] = [];

  recordSent(id: number, now: number): void {
    this.pending.set(id, now);
  }

  recordPong(id: number, now: number): number | null {
    const sentAt = this.pending.get(id);
    if (sentAt === undefined) return null;
    this.pending.delete(id);

    const rtt = now - sentAt;
    this.samples.push(rtt);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    return rtt;
  }

  stats(): LatencyStats {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      samples: sorted.length,
      medianMs: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      reportable: sorted.length >= MIN_REPORTABLE_SAMPLES,
    };
  }
}

/**
 * Frames arrive with a sequence number and the phone's own clock, which is
 * enough to tell how much was lost and how fast the phone is really sending.
 */
export class StreamQuality {
  private lastSeq: number | null = null;
  private lastTimestamp: number | null = null;
  private lost = 0;
  private received = 0;
  private intervalMs = 0;

  record(seq: number, timestamp: number): void {
    if (this.lastSeq !== null && seq > this.lastSeq) {
      this.lost += seq - this.lastSeq - 1;
    }
    this.lastSeq = seq;
    this.received++;

    if (this.lastTimestamp !== null && timestamp > this.lastTimestamp) {
      const delta = timestamp - this.lastTimestamp;
      // Exponential average: a single hiccup should not dominate the readout.
      this.intervalMs = this.intervalMs === 0 ? delta : this.intervalMs * 0.9 + delta * 0.1;
    }
    this.lastTimestamp = timestamp;
  }

  get hz(): number {
    return this.intervalMs > 0 ? 1000 / this.intervalMs : 0;
  }

  get lossPercent(): number {
    const total = this.received + this.lost;
    return total === 0 ? 0 : (this.lost / total) * 100;
  }
}
