import {
  decodePackets,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePublish,
  encodeSubscribe,
} from './mqttCodec.js';
import {
  AddressTakenError,
  isHostAddress,
  parseSignal,
  signalPayload,
  type SignalMessage,
  type Signaling,
} from './signaling.js';

/**
 * Signaling over a public MQTT broker (ARCHITECTURE.md D61).
 *
 * Every address has an inbox topic; sending is publishing to the other side's
 * inbox. A room additionally owns a retained topic naming it, which is how a
 * code collision is noticed and how a phone learns, in a second rather than a
 * timeout, that no room has that code. The broker clears the claim itself if
 * the page vanishes, through the connection's will.
 */

const ROOT = 'phonemote/v1';
const KEEP_ALIVE_SECONDS = 30;
/**
 * A broker sends a topic's retained message with, or just after, its SUBACK.
 * This long after the SUBACK with nothing retained, the topic is empty.
 */
const RETAINED_GRACE_MS = 700;

export interface MqttSocket {
  send(data: Uint8Array): void;
  close(): void;
}

export type MqttSocketFactory = (
  url: string,
  events: { open(): void; message(data: Uint8Array): void; close(): void },
) => MqttSocket;

const browserSocket: MqttSocketFactory = (url, events) => {
  const socket = new WebSocket(url, 'mqtt');
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => events.open());
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) events.message(new Uint8Array(event.data));
  });
  socket.addEventListener('close', () => events.close());
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: () => socket.close(),
  };
};

export interface MqttOptions {
  readonly url: string;
  readonly createSocket?: MqttSocketFactory;
  /** How long a claim waits for a retained owner to show itself. */
  readonly claimWaitMs?: number;
  /** How long `exists` waits for the same. */
  readonly lookupWaitMs?: number;
  readonly connectTimeoutMs?: number;
}

function inboxTopic(address: string): string {
  return `${ROOT}/inbox/${address}`;
}

function ownerTopic(address: string): string {
  return `${ROOT}/owner/${address}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36)).join('');
}

export class MqttSignaling implements Signaling {
  private socket: MqttSocket | null = null;
  private opened = false;
  private closedByUs = false;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private nextPacketId = 1;
  private readonly token = randomToken();
  private readonly messageListeners = new Set<(from: string, message: SignalMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  /** Retained owner topics this end is watching, and who answered. */
  private readonly owners = new Map<string, (owner: string) => void>();
  /** SUBACKs being waited for, by packet id. */
  private readonly subacks = new Map<number, () => void>();

  constructor(
    readonly id: string,
    private readonly options: MqttOptions,
  ) {}

  open(): Promise<void> {
    this.closedByUs = false;
    this.opened = false;
    const claim = isHostAddress(this.id);
    const create = this.options.createSocket ?? browserSocket;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.close();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error('The MQTT broker did not answer in time.')),
        this.options.connectTimeoutMs ?? 12_000,
      );
      let pending: Uint8Array = new Uint8Array(0);

      const socket = create(this.options.url, {
        open: () => {
          socket.send(
            encodeConnect(
              `pm-${this.token}`,
              KEEP_ALIVE_SECONDS,
              // If this page vanishes, the broker clears the room's claim for it.
              claim ? { topic: ownerTopic(this.id), payload: '', retain: true } : undefined,
            ),
          );
        },
        message: (data) => {
          const joined = new Uint8Array(pending.length + data.length);
          joined.set(pending);
          joined.set(data, pending.length);
          const { packets, rest } = decodePackets(joined);
          pending = rest;
          for (const packet of packets) {
            if (packet.type === 'connack') {
              if (packet.returnCode !== 0) {
                fail(new Error(`The MQTT broker refused the connection (${packet.returnCode}).`));
                return;
              }
              socket.send(encodeSubscribe(this.packetId(), inboxTopic(this.id)));
              this.startKeepAlive();
              const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.opened = true;
                resolve();
              };
              if (!claim) {
                finish();
                continue;
              }
              void this.lookup(this.id, this.options.claimWaitMs ?? 3000).then(({ owner }) => {
                // An unanswered lookup is treated as free: a room that cannot
                // open is worse than the rare collision it would have caught.
                if (owner !== null && owner !== this.token) {
                  fail(new AddressTakenError(this.id));
                  return;
                }
                socket.send(encodePublish(ownerTopic(this.id), this.token, true));
                finish();
              });
            } else if (packet.type === 'publish') {
              this.onPublish(packet.topic, packet.payload);
            } else if (packet.type === 'suback') {
              this.subacks.get(packet.packetId)?.();
            }
          }
        },
        close: () => {
          this.stopKeepAlive();
          this.socket = null;
          if (!settled) {
            fail(new Error('The MQTT broker could not be reached.'));
            return;
          }
          const wasOpen = this.opened;
          this.opened = false;
          if (wasOpen && !this.closedByUs) for (const listener of this.closeListeners) listener();
        },
      });
      this.socket = socket;
    });
  }

  /**
   * Whether a room holds this address. True when its retained claim arrives;
   * false only when the broker confirmed the subscription and nothing came;
   * null when the broker did not answer in time. Measured: a fixed two-second
   * wait said "no room" for a room that existed, which locked the phone out.
   */
  async exists(address: string): Promise<boolean | null> {
    if (!this.socket || !this.opened) return null;
    const { owner, confirmed } = await this.lookup(address, this.options.lookupWaitMs ?? 5000);
    if (owner !== null) return true;
    return confirmed ? false : null;
  }

  send(to: string, message: SignalMessage): void {
    if (!this.socket || !this.opened || message.kind === 'gone') return;
    this.socket.send(
      encodePublish(
        inboxTopic(to),
        JSON.stringify({ from: this.id, kind: message.kind, payload: signalPayload(message) }),
      ),
    );
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
    this.stopKeepAlive();
    if (this.socket && this.opened && isHostAddress(this.id)) {
      // Give the code back now rather than when the broker notices.
      this.socket.send(encodePublish(ownerTopic(this.id), '', true));
    }
    this.socket?.send(encodeDisconnect());
    this.socket?.close();
    this.socket = null;
    this.opened = false;
  }

  /**
   * Subscribe to an address's claim. `owner` is whoever holds it; `confirmed`
   * says an empty answer is a real "nobody" rather than a broker too slow to say.
   */
  private lookup(
    address: string,
    waitMs: number,
  ): Promise<{ owner: string | null; confirmed: boolean }> {
    const socket = this.socket;
    if (!socket) return Promise.resolve({ owner: null, confirmed: false });
    return new Promise((resolve) => {
      const topic = ownerTopic(address);
      const packetId = this.packetId();
      let grace: ReturnType<typeof setTimeout> | null = null;
      const done = (owner: string | null, confirmed: boolean): void => {
        clearTimeout(timer);
        if (grace !== null) clearTimeout(grace);
        this.owners.delete(topic);
        this.subacks.delete(packetId);
        resolve({ owner, confirmed });
      };
      const timer = setTimeout(() => done(null, false), waitMs);
      this.owners.set(topic, (owner) => done(owner, true));
      this.subacks.set(packetId, () => {
        grace = setTimeout(() => done(null, true), RETAINED_GRACE_MS);
      });
      socket.send(encodeSubscribe(packetId, topic));
    });
  }

  private onPublish(topic: string, payload: string): void {
    const owner = this.owners.get(topic);
    if (owner) {
      // An empty retained message is a cleared claim: nobody owns it.
      if (payload !== '') owner(payload);
      return;
    }
    if (topic !== inboxTopic(this.id)) return;
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    const from = record['from'];
    const kind = record['kind'];
    if (typeof from !== 'string' || typeof kind !== 'string') return;
    const signal = parseSignal(kind, record['payload']);
    if (!signal) return;
    for (const listener of this.messageListeners) listener(from, signal);
  }

  private packetId(): number {
    const id = this.nextPacketId;
    this.nextPacketId = (this.nextPacketId % 0xffff) + 1;
    return id;
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAlive = setInterval(
      () => this.socket?.send(encodePingreq()),
      (KEEP_ALIVE_SECONDS * 1000) / 2,
    );
  }

  private stopKeepAlive(): void {
    if (this.keepAlive !== null) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }
}
