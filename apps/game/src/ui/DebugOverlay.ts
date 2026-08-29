import { session } from '../session.js';

/**
 * Raw next to canonical, for one player at a time (ARCHITECTURE.md 7.4).
 *
 * This is the instrument the Phase 1 axis check is read off: hold the phone,
 * move it one way, and see whether the canonical sign matches the table in
 * ARCHITECTURE.md 5.6. Lives in the DOM, above the Phaser canvas, so it can be
 * read while a scene is running.
 */

const REFRESH_MS = 100;

function pad(value: number, digits = 1): string {
  return value.toFixed(digits).padStart(8);
}

export class DebugOverlay {
  private readonly element = document.createElement('pre');
  private selected = 1;
  private visible = true;
  private timer: number | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.element.className = 'debug-overlay';
    parent.append(this.element);

    window.addEventListener('keydown', (event) => {
      if (event.key === 'd') this.toggle();
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 4) this.selected = digit;
    });
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.render(), REFRESH_MS);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.element.style.display = this.visible ? 'block' : 'none';
  }

  private render(): void {
    if (!this.visible) return;

    const info = session.debugInfo(this.selected);
    const header = `player ${this.selected}  (1-4 to switch, d to hide)`;

    if (!info.raw || !info.canonical) {
      this.element.textContent = `${header}\n\n연결된 프레임 없음`;
      return;
    }

    const { raw, canonical, latency } = info;
    const rtt = latency.reportable
      ? `median ${latency.medianMs.toFixed(1)} ms   p95 ${latency.p95Ms.toFixed(1)} ms`
      : `표본 ${latency.samples}/100 수집 중`;

    this.element.textContent = [
      header,
      '',
      '                 raw (device)          canonical',
      `orient   a${pad(raw.orientation.alpha)}  b${pad(raw.orientation.beta)}   ` +
        `yaw${pad(canonical.orientation.yaw)} pitch${pad(canonical.orientation.pitch)}`,
      `         g${pad(raw.orientation.gamma)}                 ` +
        `roll${pad(canonical.orientation.roll)}`,
      `rate     a${pad(raw.rotationRate.alpha)}  b${pad(raw.rotationRate.beta)}   ` +
        `yaw${pad(canonical.angularVelocity.yaw)} pitch${pad(canonical.angularVelocity.pitch)}`,
      `         g${pad(raw.rotationRate.gamma)}                 ` +
        `roll${pad(canonical.angularVelocity.roll)}`,
      `accel    x${pad(raw.acceleration.x, 2)}  y${pad(raw.acceleration.y, 2)}   ` +
        `x${pad(canonical.acceleration.x, 2)} y${pad(canonical.acceleration.y, 2)}`,
      `         z${pad(raw.acceleration.z, 2)}                 ` +
        `z${pad(canonical.acceleration.z, 2)}`,
      '',
      info.fused
        ? `fused    yaw${pad(info.fused.orientation.yaw)} pitch${pad(info.fused.orientation.pitch)}` +
          ` roll${pad(info.fused.orientation.roll)}`
        : 'fused    (off)',
      '',
      `screen   ${raw.screenOrientation}   buttons ${raw.buttons}   seq ${raw.seq}`,
      `stream   ${info.hz.toFixed(1)} Hz   loss ${info.lossPercent.toFixed(2)}%`,
      `rtt      ${rtt}`,
    ].join('\n');
  }
}
