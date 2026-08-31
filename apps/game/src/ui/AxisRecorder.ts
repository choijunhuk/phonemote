import { PORTS } from '@phonemote/protocol';
import { session } from '../session.js';

/**
 * A guided measurement run, written down for someone to read afterwards.
 *
 * The phone is the only place the truth about an axis lives. "It feels wrong"
 * cannot be debugged and neither can a memory of what the numbers looked like,
 * so this asks for one named movement at a time, records what the pipeline
 * reported while it happened, and posts the lot to the relay.
 *
 * Nothing here judges anything. It gathers evidence; the mapping table in
 * ARCHITECTURE.md 5.6 is what gets changed if the evidence disagrees with it.
 *
 * Press r in the lobby to start.
 */

/** Recorded either side of the moment the player says "now". */
const BEFORE_MS = 1000;
const AFTER_MS = 1000;
const SAMPLE_EVERY_MS = 50;

interface Step {
  readonly key: string;
  readonly prompt: string;
  /** What the mapping table says should happen, for the report. */
  readonly expectation: string;
  /**
   * Only changes the wording. Both kinds record a second either side of the
   * button press: for a hold both halves are the pose, for a movement the
   * first half already contains it.
   *
   * Detecting the moment automatically was tried and was worse. Waiting for
   * stillness or for a rate threshold gave the player nothing to see and no way
   * to intervene, and a step that never met its condition simply sat there.
   */
  readonly mode: 'hold' | 'motion';
}

const STEPS: readonly Step[] = [
  {
    key: 'rest',
    prompt: '폰을 세로로 들고 위쪽 끝이 화면을 향하게, 가만히',
    expectation: 'up ≈ (0, 1, 0), 각속도 ≈ 0',
    mode: 'hold',
  },
  { key: 'tilt-right', prompt: '오른쪽으로 90도 기울이기 (오른쪽 변이 아래로)', expectation: 'roll +, up ≈ (-1, 0, 0)', mode: 'hold' },
  { key: 'tilt-left', prompt: '왼쪽으로 90도 기울이기', expectation: 'roll -, up ≈ (1, 0, 0)', mode: 'hold' },
  {
    key: 'aim-up',
    prompt: '화면이 바닥을 보게 눕히기 (뒷면이 천장)',
    expectation: 'up ≈ (0, 0, -1)',
    mode: 'hold',
  },
  {
    key: 'aim-down',
    prompt: '화면이 하늘을 보게 눕히기',
    expectation: 'up ≈ (0, 0, 1)',
    mode: 'hold',
  },
  {
    key: 'turn-right',
    prompt: '정면으로 돌아와서, 오른쪽으로 한 번 돌리기',
    expectation: 'yaw rate +',
    mode: 'motion',
  },
  {
    key: 'turn-left',
    prompt: '왼쪽으로 한 번 돌리기',
    expectation: 'yaw rate -',
    mode: 'motion',
  },
  {
    key: 'swing',
    prompt: '테니스 치듯 한 번 세게 휘두르기',
    expectation: '각속도 피크 큼, tip 이동 방향',
    mode: 'motion',
  },
  {
    key: 'upside-down',
    prompt: '세로 그대로 위아래만 거꾸로 뒤집어 들기',
    expectation: 'up ≈ (0, -1, 0)',
    mode: 'hold',
  },
];

interface Sample {
  readonly t: number;
  readonly raw: {
    readonly alpha: number;
    readonly beta: number;
    readonly gamma: number;
    readonly rateAlpha: number;
    readonly rateBeta: number;
    readonly rateGamma: number;
    readonly accelX: number;
    readonly accelY: number;
    readonly accelZ: number;
    readonly screenOrientation: number;
    readonly flags: number;
  };
  readonly canonical: {
    readonly yaw: number;
    readonly pitch: number;
    readonly roll: number;
    readonly yawRate: number;
    readonly pitchRate: number;
    readonly rollRate: number;
    readonly accelX: number;
    readonly accelY: number;
    readonly accelZ: number;
    readonly upX: number;
    readonly upY: number;
    readonly upZ: number;
  };
}

export class AxisRecorder {
  private readonly element = document.createElement('div');
  private running = false;

  constructor(parent: HTMLElement = document.body) {
    this.element.className = 'axis-recorder';
    this.element.style.display = 'none';
    parent.append(this.element);

    window.addEventListener('keydown', (event) => {
      if (event.key === 'r' && !this.running) void this.run();
    });
  }

  private show(html: string): void {
    this.element.style.display = 'block';
    this.element.innerHTML = html;
  }

  private samplePlayer(playerId: number): Sample | null {
    const info = session.debugInfo(playerId);
    if (!info.raw || !info.canonical) return null;
    const { raw, canonical } = info;
    return {
      t: performance.now(),
      raw: {
        alpha: raw.orientation.alpha,
        beta: raw.orientation.beta,
        gamma: raw.orientation.gamma,
        rateAlpha: raw.rotationRate.alpha,
        rateBeta: raw.rotationRate.beta,
        rateGamma: raw.rotationRate.gamma,
        accelX: raw.acceleration.x,
        accelY: raw.acceleration.y,
        accelZ: raw.acceleration.z,
        screenOrientation: raw.screenOrientation,
        flags: raw.flags,
      },
      canonical: {
        yaw: canonical.orientation.yaw,
        pitch: canonical.orientation.pitch,
        roll: canonical.orientation.roll,
        yawRate: canonical.angularVelocity.yaw,
        pitchRate: canonical.angularVelocity.pitch,
        rollRate: canonical.angularVelocity.roll,
        accelX: canonical.acceleration.x,
        accelY: canonical.acceleration.y,
        accelZ: canonical.acceleration.z,
        upX: canonical.up.x,
        upY: canonical.up.y,
        upZ: canonical.up.z,
      },
    };
  }

  private rateOf(sample: Sample): number {
    const { yawRate, pitchRate, rollRate } = sample.canonical;
    return Math.hypot(yawRate, pitchRate, rollRate);
  }

  /**
   * Samples continuously and keeps the last second, so pressing A captures the
   * second before the press as well as the second after it. A pose is in both
   * halves; a swing is in the first, which is the only way to catch something
   * that is over before anyone could react to it.
   */
  private async collect(playerId: number, step: Step, index: number): Promise<Sample[]> {
    const head = `<h2>${index + 1} / ${STEPS.length}</h2><p class="prompt">${step.prompt}</p>`;
    const before: Sample[] = [];
    const keep = Math.ceil(BEFORE_MS / SAMPLE_EVERY_MS);
    let pressed = false;

    const stop = session.onAction((action) => {
      if (action.kind === 'button_down' && action.playerId === playerId) pressed = true;
    });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === ' ' || event.key === 'Enter') pressed = true;
    };
    window.addEventListener('keydown', onKey);

    try {
      while (!pressed) {
        const sample = this.samplePlayer(playerId);
        if (sample) {
          before.push(sample);
          if (before.length > keep) before.shift();
        }
        const rate = sample ? this.rateOf(sample) : 0;
        this.show(
          head +
            `<p class="countdown">${
              step.mode === 'hold' ? '그 자세로' : '동작한 다음'
            } <b>A</b> 를 누르세요 (PC: 스페이스)</p>` +
            `<p class="recording">각속도 ${rate.toFixed(0)}°/s</p>`,
        );
        await wait(SAMPLE_EVERY_MS);
      }

      const samples = [...before];
      for (let waited = 0; waited < AFTER_MS; waited += SAMPLE_EVERY_MS) {
        const sample = this.samplePlayer(playerId);
        if (sample) samples.push(sample);
        this.show(head + `<p class="recording">측정 중… ${samples.length}개</p>`);
        await wait(SAMPLE_EVERY_MS);
      }

      // Let go of the button before the next step, or it fires immediately.
      await wait(400);
      return samples;
    } finally {
      stop();
      window.removeEventListener('keydown', onKey);
    }
  }

  async run(): Promise<void> {
    const player = session.players[0];
    if (!player) {
      this.show('<h2>축 측정</h2><p class="prompt">먼저 폰을 연결하세요.</p>');
      await wait(2500);
      this.element.style.display = 'none';
      return;
    }

    this.running = true;
    const steps: Array<{ step: Step; samples: Sample[] }> = [];

    for (const [index, step] of STEPS.entries()) {
      steps.push({ step, samples: await this.collect(player.id, step, index) });
    }

    const payload = {
      kind: 'axis-check',
      startedAt: new Date().toISOString(),
      player: { id: player.id, name: player.name },
      userAgent: navigator.userAgent,
      steps: steps.map(({ step, samples }) => ({
        key: step.key,
        prompt: step.prompt,
        expectation: step.expectation,
        samples,
      })),
    };

    try {
      const response = await fetch(`https://${window.location.hostname}:${PORTS.relay}/log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const total = steps.reduce((count, entry) => count + entry.samples.length, 0);
      this.show(
        response.ok
          ? `<h2>저장됨</h2><p class="prompt">${STEPS.length}단계 · 표본 ${total}개</p>` +
            '<p class="countdown">logs/sessions.jsonl 에 기록되었습니다</p>'
          : `<h2>저장 실패</h2><p class="prompt">서버 응답 ${response.status}</p>`,
      );
    } catch (error) {
      session.reportError(error);
      this.show('<h2>저장 실패</h2><p class="prompt">릴레이에 연결하지 못했습니다</p>');
    }

    await wait(4000);
    this.element.style.display = 'none';
    this.running = false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
