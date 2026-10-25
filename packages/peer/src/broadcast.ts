import {
  AddressTakenError,
  parseSignal,
  signalPayload,
  type SignalMessage,
  type Signaling,
} from './signaling.js';

/**
 * Signaling between tabs of one browser, over a BroadcastChannel.
 *
 * For the end-to-end test, which opens the game and a controller side by side
 * and must not depend on a public server being up. Everything above the
 * channel — the offer, the answer, the candidates, the peer connection — is the
 * real thing.
 *
 * A claim waits a moment for anyone already holding the address to object,
 * which is the same collision rule the public server enforces.
 */

const CHANNEL = 'phonemote-signal';

type Envelope =
  | { readonly op: 'claim'; readonly id: string }
  | { readonly op: 'taken'; readonly id: string }
  | {
      readonly op: 'signal';
      readonly from: string;
      readonly to: string;
      readonly kind: string;
      readonly payload: unknown;
    };

function parseEnvelope(value: unknown): Envelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const op = record['op'];
  const id = record['id'];
  if (op === 'claim' && typeof id === 'string') return { op, id };
  if (op === 'taken' && typeof id === 'string') return { op, id };
  if (
    op === 'signal' &&
    typeof record['from'] === 'string' &&
    typeof record['to'] === 'string' &&
    typeof record['kind'] === 'string'
  ) {
    return {
      op,
      from: record['from'],
      to: record['to'],
      kind: record['kind'],
      payload: record['payload'],
    };
  }
  return null;
}

export class BroadcastSignaling implements Signaling {
  private channel: BroadcastChannel | null = null;
  private readonly messageListeners = new Set<(from: string, message: SignalMessage) => void>();

  constructor(
    readonly id: string,
    private readonly claimWaitMs = 150,
  ) {}

  open(): Promise<void> {
    const channel = new BroadcastChannel(CHANNEL);
    this.channel = channel;

    return new Promise((resolve, reject) => {
      let settled = false;
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const envelope = parseEnvelope(event.data);
        if (!envelope) return;
        if (envelope.op === 'claim') {
          if (settled && envelope.id === this.id) channel.postMessage({ op: 'taken', id: this.id });
          return;
        }
        if (envelope.op === 'taken') {
          if (!settled && envelope.id === this.id) {
            settled = true;
            reject(new AddressTakenError(this.id));
            this.close();
          }
          return;
        }
        if (envelope.to !== this.id) return;
        const signal = parseSignal(envelope.kind, envelope.payload);
        if (!signal) return;
        for (const listener of this.messageListeners) listener(envelope.from, signal);
      };

      channel.postMessage({ op: 'claim', id: this.id });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, this.claimWaitMs);
    });
  }

  send(to: string, message: SignalMessage): void {
    this.channel?.postMessage({
      op: 'signal',
      from: this.id,
      to,
      kind: message.kind,
      payload: signalPayload(message),
    });
  }

  onMessage(listener: (from: string, message: SignalMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** A BroadcastChannel does not drop, so there is nothing to report. */
  onClose(listener: () => void): () => void {
    void listener;
    return () => undefined;
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
  }
}
