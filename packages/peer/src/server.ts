import type { Link } from './link.js';
import {
  AddressTakenError,
  parseSignal,
  signalPayload,
  type SignalMessage,
  type Signaling,
} from './signaling.js';

/**
 * The PhoneMote server's side of things, from a browser (ARCHITECTURE.md D63):
 * signaling through it, and the relay when a phone cannot reach the room
 * directly. Its wire protocol is apps/server/src/cloud/hub.ts.
 */

/** The deployment this repository runs. A fork points VITE_PHONEMOTE_SERVER elsewhere. */
export const DEFAULT_SERVER_URL = 'wss://coms.kw.ac.kr/phonemote';

export function randomToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class ServerSignaling implements Signaling {
  private socket: WebSocket | null = null;
  private opened = false;
  private closedByUs = false;
  private nextRef = 1;
  private readonly lookups = new Map<number, (present: boolean) => void>();
  private readonly messageListeners = new Set<(from: string, message: SignalMessage) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(
    readonly id: string,
    private readonly url: string,
    /** Shared with the relay, which only seats a room's host for this token. */
    readonly token: string = randomToken(),
  ) {}

  open(): Promise<void> {
    this.closedByUs = false;
    this.opened = false;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${this.url}/signal?id=${encodeURIComponent(this.id)}&token=${encodeURIComponent(this.token)}`,
      );
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error('The PhoneMote server did not answer in time.'));
      }, 8000);

      socket.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (typeof event.data !== 'string') return;
        const message = parse(event.data);
        if (!message) return;
        if (message['type'] === 'open' && !settled) {
          settled = true;
          clearTimeout(timer);
          this.opened = true;
          resolve();
        } else if (message['type'] === 'taken' && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(new AddressTakenError(this.id));
        } else if (message['type'] === 'exists' && typeof message['ref'] === 'number') {
          this.lookups.get(message['ref'])?.(message['present'] === true);
        } else if (
          message['type'] === 'signal' &&
          typeof message['from'] === 'string' &&
          typeof message['kind'] === 'string'
        ) {
          const signal = parseSignal(message['kind'], message['payload']);
          if (signal) for (const listener of this.messageListeners) listener(message['from'], signal);
        }
      });
      socket.addEventListener('close', () => {
        this.socket = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('The PhoneMote server could not be reached.'));
          return;
        }
        const wasOpen = this.opened;
        this.opened = false;
        if (wasOpen && !this.closedByUs) for (const listener of this.closeListeners) listener();
      });
    });
  }

  /** The server knows exactly who is registered, so this is a straight answer. */
  exists(address: string): Promise<boolean | null> {
    const socket = this.socket;
    if (!socket || !this.opened) return Promise.resolve(null);
    const ref = this.nextRef++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.lookups.delete(ref);
        resolve(null);
      }, 4000);
      this.lookups.set(ref, (present) => {
        clearTimeout(timer);
        this.lookups.delete(ref);
        resolve(present);
      });
      socket.send(JSON.stringify({ type: 'exists', address, ref }));
    });
  }

  send(to: string, message: SignalMessage): void {
    if (!this.socket || !this.opened || message.kind === 'gone') return;
    this.socket.send(
      JSON.stringify({ type: 'send', to, kind: message.kind, payload: signalPayload(message) }),
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
    this.socket?.close();
    this.socket = null;
    this.opened = false;
  }
}

/** A Link over one WebSocket, or a tunnel on the host's, with an end that fires once. */
function makeLink(
  sendControl: (text: string) => void,
  sendSensor: (frame: ArrayBuffer) => boolean,
  buffered: () => number,
  close: () => void,
): Link & { control(text: string): void; sensor(frame: ArrayBuffer): void; end(): void } {
  const controls = new Set<(text: string) => void>();
  const sensors = new Set<(frame: ArrayBuffer) => void>();
  const ends = new Set<() => void>();
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const listener of ends) listener();
  };
  return {
    kind: 'relay',
    sendControl,
    sendSensor,
    get bufferedAmount() {
      return buffered();
    },
    onControl: (listener) => controls.add(listener),
    onSensor: (listener) => sensors.add(listener),
    onEnd: (listener) => {
      if (ended) listener();
      else ends.add(listener);
    },
    close: () => {
      close();
      end();
    },
    control: (text) => controls.forEach((listener) => listener(text)),
    sensor: (frame) => sensors.forEach((listener) => listener(frame)),
    end,
  };
}

/**
 * A phone reaching the room through the server. Resolves once the server has
 * seated it on the room's relay; rejects when the room is not relaying.
 */
export function relayLink(url: string, roomAddress: string, maxBufferedBytes: number): Promise<Link> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${url}/relay?role=phone&id=${encodeURIComponent(roomAddress)}`,
    );
    socket.binaryType = 'arraybuffer';
    const link = makeLink(
      (text) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
      (frame) => {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > maxBufferedBytes) return false;
        socket.send(frame);
        return true;
      },
      () => socket.bufferedAmount,
      () => socket.close(),
    );
    let opened = false;
    socket.addEventListener('open', () => {
      opened = true;
      resolve(link);
    });
    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data === 'string') link.control(event.data);
      else if (event.data instanceof ArrayBuffer) link.sensor(event.data);
    });
    socket.addEventListener('close', () => {
      if (!opened) reject(new Error('The PhoneMote relay could not be reached.'));
      link.end();
    });
  });
}

/**
 * The room's page on the relay: one socket, a numbered tunnel per relayed
 * phone, each handed over as a Link. It rejoins after a drop for as long as
 * the room holds its address with the same token.
 */
export class RelayHost {
  private socket: WebSocket | null = null;
  private stopped = false;
  private readonly tunnels = new Map<number, ReturnType<typeof makeLink>>();

  constructor(
    private readonly url: string,
    private readonly roomAddress: string,
    private readonly token: string,
    private readonly onPhone: (link: Link) => void,
  ) {}

  start(): void {
    this.stopped = false;
    const socket = new WebSocket(
      `${this.url}/relay?role=host&id=${encodeURIComponent(this.roomAddress)}` +
        `&token=${encodeURIComponent(this.token)}`,
    );
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.data instanceof ArrayBuffer) {
        if (event.data.byteLength < 4) return;
        const tunnel = new DataView(event.data).getUint32(0);
        this.tunnels.get(tunnel)?.sensor(event.data.slice(4));
        return;
      }
      if (typeof event.data !== 'string') return;
      const envelope = parse(event.data);
      const tunnel = envelope?.['t'];
      if (!envelope || typeof tunnel !== 'number') return;
      if (envelope['open'] === true) this.openTunnel(socket, tunnel);
      else if (envelope['close'] === true) this.endTunnel(tunnel);
      else if (typeof envelope['d'] === 'string') this.tunnels.get(tunnel)?.control(envelope['d']);
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      for (const tunnel of [...this.tunnels.keys()]) this.endTunnel(tunnel);
      if (!this.stopped) setTimeout(() => !this.stopped && this.start(), 3000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  private openTunnel(socket: WebSocket, tunnel: number): void {
    const link = makeLink(
      (text) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: tunnel, d: text }));
      },
      () => false,
      () => socket.bufferedAmount,
      () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: tunnel, close: true }));
        this.tunnels.delete(tunnel);
      },
    );
    this.tunnels.set(tunnel, link);
    this.onPhone(link);
  }

  private endTunnel(tunnel: number): void {
    const link = this.tunnels.get(tunnel);
    this.tunnels.delete(tunnel);
    link?.end();
  }
}
