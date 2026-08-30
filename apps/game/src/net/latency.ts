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

/**
 * At one ping a second, a hundred samples means no RTT figure for the first
 * hundred seconds — longer than most playtests. Twenty is enough for a median
 * to mean something, and the sample count is shown alongside it.
 */
export const MIN_REPORTABLE_SAMPLES = 20;

/** A pong later than this is not a measurement, it is a straggler. */
const PING_TIMEOUT_MS = 2000;
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
    // Drop the ones that are never coming back, so a late reply cannot land
    // years later and drag the median with it.
    for (const [pendingId, sentAt] of this.pending) {
      if (now - sentAt > PING_TIMEOUT_MS) this.pending.delete(pendingId);
    }
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
  private lastArrivalAt: number | null = null;
  private lost = 0;
  private received = 0;
  private intervalMs = 0;
  /** Gaps between arrivals, on the PC clock: the phone's own timing hides these. */
  private readonly arrivals: number[] = [];

  record(seq: number, timestamp: number, arrivedAt = 0): void {
    if (arrivedAt > 0) {
      if (this.lastArrivalAt !== null) {
        this.arrivals.push(arrivedAt - this.lastArrivalAt);
        if (this.arrivals.length > 240) this.arrivals.shift();
      }
      this.lastArrivalAt = arrivedAt;
    }

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

  /**
   * The worst arrival gaps. Frames leaving the phone evenly can still arrive in
   * bursts, and the phone's own timestamps cannot show that.
   */
  get arrivalGaps(): { p95: number; max: number } {
    if (this.arrivals.length === 0) return { p95: 0, max: 0 };
    const sorted = [...this.arrivals].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
    return { p95: sorted[index] ?? 0, max: sorted.at(-1) ?? 0 };
  }

  get lossPercent(): number {
    const total = this.received + this.lost;
    return total === 0 ? 0 : (this.lost / total) * 100;
  }
}
