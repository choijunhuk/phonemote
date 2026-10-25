import { AddressTakenError, type SignalMessage, type Signaling } from './signaling.js';

/**
 * Several signaling channels used as one (ARCHITECTURE.md D61).
 *
 * No free public server is dependable on its own. Measured from one network:
 * the PeerJS cloud sits behind Cloudflare and splits clients across origins
 * that do not share state, so a phone and a room often never meet; one public
 * MQTT broker was unreachable and another dropped one message in three. So the
 * room listens on all of them and a phone calls on all of them, and the first
 * channel that carries the handshake wins.
 *
 * The same message arriving twice — over two brokers — is passed on once: a
 * second offer would make the room answer again and tear down the first call.
 */

const DEDUPE_WINDOW_MS = 60_000;
/**
 * How long a sent message is kept for a channel that opens late. Measured: a
 * phone's first offer went out on the one channel already open, which lost
 * it, while the broker that would have carried it was still connecting; the
 * call waited out its 15 s timeout and only the retry got through.
 */
const BACKLOG_MS = 15_000;
/** After the first channel opens, how long to wait for the rest before going ahead. */
const STRAGGLER_GRACE_MS = 2500;
const REOPEN_MS = 5000;

function messageKey(from: string, message: SignalMessage): string {
  switch (message.kind) {
    case 'offer':
    case 'answer':
      return `${from}|${message.kind}|${message.sdp}`;
    case 'candidate':
      return `${from}|candidate|${message.candidate.candidate ?? ''}`;
    case 'gone':
      return `${from}|gone`;
  }
}

export class FanoutSignaling implements Signaling {
  private readonly open_ = new Set<Signaling>();
  private readonly seen = new Map<string, number>();
  private backlog: Array<{ readonly at: number; readonly to: string; readonly message: SignalMessage }> =
    [];
  private readonly messageListeners = new Set<(from: string, message: SignalMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closedByUs = false;

  constructor(
    readonly id: string,
    private readonly channels: readonly Signaling[],
  ) {
    for (const channel of channels) {
      channel.onMessage((from, message) => this.deliver(from, message));
      channel.onClose(() => this.lost(channel));
    }
  }

  open(): Promise<void> {
    this.closedByUs = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      let pending = this.channels.length;
      let grace: ReturnType<typeof setTimeout> | null = null;
      const errors: Error[] = [];

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (grace !== null) clearTimeout(grace);
        if (this.open_.size > 0) {
          resolve();
          return;
        }
        reject(errors[0] ?? new Error('No signaling channel could be reached.'));
      };

      for (const channel of this.channels) {
        if (this.open_.has(channel)) {
          pending--;
          continue;
        }
        channel
          .open()
          .then(() => {
            if (this.closedByUs) {
              channel.close();
              return;
            }
            this.adopt(channel);
            grace ??= setTimeout(finish, STRAGGLER_GRACE_MS);
          })
          .catch((error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            if (failure instanceof AddressTakenError && !settled) {
              // A collision on any channel is a collision: somebody holds this code.
              settled = true;
              this.close();
              reject(failure);
              return;
            }
            errors.push(failure);
          })
          .finally(() => {
            pending--;
            if (pending === 0) finish();
          });
      }
      if (pending === 0) finish();
    });
  }

  /**
   * Whether a room holds this address, by whichever channels can say.
   * One yes is enough; it takes every channel that can answer to say no.
   */
  async exists(address: string): Promise<boolean | null> {
    const answers = await Promise.all(
      [...this.open_].map((channel) => channel.exists?.(address) ?? Promise.resolve(null)),
    );
    if (answers.includes(true)) return true;
    return answers.includes(false) ? false : null;
  }

  send(to: string, message: SignalMessage): void {
    const now = Date.now();
    this.backlog = this.backlog.filter((entry) => now - entry.at < BACKLOG_MS);
    this.backlog.push({ at: now, to, message });
    for (const channel of this.open_) channel.send(to, message);
  }

  onMessage(listener: (from: string, message: SignalMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.closedByUs = true;
    for (const channel of this.channels) channel.close();
    this.open_.clear();
  }

  private deliver(from: string, message: SignalMessage): void {
    // One channel saying "not here" says nothing about the others: the PeerJS
    // cloud reports a room as gone from a server the room is not on.
    if (message.kind === 'gone') return;
    const now = Date.now();
    for (const [key, at] of this.seen) if (now - at > DEDUPE_WINDOW_MS) this.seen.delete(key);
    const key = messageKey(from, message);
    if (this.seen.has(key)) return;
    this.seen.set(key, now);
    for (const listener of this.messageListeners) listener(from, message);
  }

  private lost(channel: Signaling): void {
    if (!this.open_.delete(channel) || this.closedByUs) return;
    if (this.open_.size === 0) {
      for (const listener of this.closeListeners) listener();
      return;
    }
    // The others carry on; this one tries again on its own.
    setTimeout(() => {
      if (this.closedByUs || this.open_.has(channel)) return;
      channel
        .open()
        .then(() => this.adopt(channel))
        .catch(() => undefined);
    }, REOPEN_MS);
  }

  /** A channel that opened, possibly late: catch it up on what was just sent. */
  private adopt(channel: Signaling): void {
    this.open_.add(channel);
    const now = Date.now();
    for (const entry of this.backlog) {
      if (now - entry.at < BACKLOG_MS) channel.send(entry.to, entry.message);
    }
  }
}
