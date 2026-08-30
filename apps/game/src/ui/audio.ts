/**
 * Tiny Web Audio synth. No asset files, no licences, no loading screen — the
 * few sounds this game needs are cheaper to generate than to fetch.
 */

let context: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  context ??= new AudioContext();
  // Browsers start the context suspended until a gesture; resume is a no-op
  // once it is already running.
  void context.resume();
  return context;
}

interface ToneOptions {
  readonly frequency: number;
  readonly durationMs: number;
  readonly type?: OscillatorType;
  readonly gain?: number;
  /** Ends at this frequency if given, for a rising or falling blip. */
  readonly slideTo?: number;
}

export function tone({ frequency, durationMs, type = 'square', gain = 0.06, slideTo }: ToneOptions): void {
  const audio = ensureContext();
  if (!audio) return;

  const oscillator = audio.createOscillator();
  const envelope = audio.createGain();
  const now = audio.currentTime;
  const duration = durationMs / 1000;

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  if (slideTo !== undefined) oscillator.frequency.linearRampToValueAtTime(slideTo, now + duration);

  envelope.gain.setValueAtTime(gain, now);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  oscillator.connect(envelope).connect(audio.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

export const sfx = {
  hit(strength: number): void {
    tone({ frequency: 420 + strength * 260, durationMs: 70, gain: 0.05 + strength * 0.04 });
  },
  whiff(): void {
    tone({ frequency: 180, durationMs: 90, type: 'sine', gain: 0.03, slideTo: 120 });
  },
  wall(): void {
    tone({ frequency: 260, durationMs: 60, type: 'triangle' });
  },
  point(): void {
    tone({ frequency: 220, durationMs: 260, type: 'sawtooth', slideTo: 110, gain: 0.05 });
  },
  win(): void {
    tone({ frequency: 440, durationMs: 400, type: 'triangle', slideTo: 880, gain: 0.06 });
  },
};
