/**
 * One-euro filter: smooth when slow, responsive when fast.
 *
 * The gyro on this phone sits at about 3.1 deg/s of noise while the phone is
 * perfectly still, against a pointer deadzone of 2. So the noise clears the
 * deadzone regularly, and every excursion is integrated — the cursor does a
 * random walk even when nobody is moving. Widening the deadzone would fix that
 * and take slow, careful aiming with it, which is the one thing a pointer has
 * to be good at.
 *
 * This cuts the cut-off frequency when the signal is slow, so a still hand gets
 * heavy smoothing, and raises it when the signal moves, so a real sweep passes
 * through almost untouched. Lag is only spent where it is not noticed.
 *
 * Casiez, Roussel and Vogel, CHI 2012.
 */

export interface OneEuroOptions {
  /** Cut-off in Hz at zero speed. Lower is smoother and laggier when still. */
  readonly minCutoff?: number;
  /** How much speed raises the cut-off. Higher follows fast motion more closely. */
  readonly beta?: number;
  /** Cut-off for the speed estimate itself. */
  readonly derivativeCutoff?: number;
}

const DEFAULTS = { minCutoff: 1.2, beta: 0.03, derivativeCutoff: 1 } as const;

function alphaFor(cutoffHz: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly derivativeCutoff: number;

  private value: number | null = null;
  private derivative = 0;

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? DEFAULTS.minCutoff;
    this.beta = options.beta ?? DEFAULTS.beta;
    this.derivativeCutoff = options.derivativeCutoff ?? DEFAULTS.derivativeCutoff;
  }

  reset(): void {
    this.value = null;
    this.derivative = 0;
  }

  filter(sample: number, dt: number): number {
    if (dt <= 0) return this.value ?? sample;
    if (this.value === null) {
      this.value = sample;
      return sample;
    }

    const rate = (sample - this.value) / dt;
    const dAlpha = alphaFor(this.derivativeCutoff, dt);
    this.derivative += dAlpha * (rate - this.derivative);

    // The faster it is genuinely moving, the less it gets smoothed.
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    const alpha = alphaFor(cutoff, dt);
    this.value += alpha * (sample - this.value);
    return this.value;
  }
}
