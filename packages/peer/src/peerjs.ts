import {
  AddressTakenError,
  parseSignal,
  signalPayload,
  type SignalMessage,
  type Signaling,
} from './signaling.js';

/**
 * Signaling over the public PeerJS server (ARCHITECTURE.md D60).
 *
 * It is free, needs no account, and speaks a small JSON protocol over a
 * WebSocket, so it is implemented here directly rather than pulling in the
 * PeerJS client library. The protocol, from peerjs-server's source:
 *
 * - connect to `<url>?key=peerjs&id=<id>&token=<token>`;
 * - the server answers OPEN, or ID-TAKEN when another token holds the id
 *   (the same token may reclaim its own id after a drop);
 * - OFFER, ANSWER and CANDIDATE carry an opaque payload to `dst`, and arrive
 *   with `src` filled in by the server;
 * - a message to an id nobody holds comes back as EXPIRE after about 5 s;
 * - a client silent for 90 s is dropped, hence the heartbeat.
 */

export const PEERJS_CLOUD_URL = 'wss://0.peerjs.com:443/peerjs';
const KEY = 'peerjs';
const HEARTBEAT_MS = 20_000;

/** The slice of a WebSocket this uses, so a test can stand in for the server. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (
  url: string,
  events: { message(data: string): void; close(): void },
) => SocketLike;

const browserSocket: SocketFactory = (url, events) => {
  const socket = new WebSocket(url);
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string') events.message(event.data);
  });
  socket.addEventListener('close', () => events.close());
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: () => socket.close(),
  };
};

const TO_WIRE = { offer: 'OFFER', answer: 'ANSWER', candidate: 'CANDIDATE' } as const;

function kindFromWire(type: string): string | null {
  switch (type) {
    case 'OFFER':
      return 'offer';
    case 'ANSWER':
      return 'answer';
    case 'CANDIDATE':
      return 'candidate';
    case 'EXPIRE':
    case 'LEAVE':
      return 'gone';
    default:
      return null;
  }
}

interface ServerMessage {
  readonly type: string;
  readonly src?: string;
  readonly payload?: unknown;
}

function parseServerMessage(text: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string') return null;
  const src = record['src'];
  return {
    type,
    ...(typeof src === 'string' ? { src } : {}),
    payload: record['payload'],
  };
}

/**
 * The payload as the PeerJS client lays it out. The cloud server was seen
 * passing that shape and not a bare `{ sdp }`, so it is matched field for field.
 */
function wirePayload(message: SignalMessage): Record<string, unknown> {
  const common = { type: 'data', connectionId: 'dc_phonemote', serialization: 'binary', reliable: true };
  if (message.kind === 'offer' || message.kind === 'answer') {
    return { ...common, sdp: { type: message.kind, sdp: message.sdp } };
  }
  return { ...common, ...signalPayload(message) };
}

/** `{ sdp: { sdp } }` back to the `{ sdp }` that parseSignal reads. */
function fromWirePayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const sdp = (payload as Record<string, unknown>)['sdp'];
  if (typeof sdp === 'object' && sdp !== null) {
    return { ...payload, sdp: (sdp as Record<string, unknown>)['sdp'] };
  }
  return payload;
}

function randomToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface PeerJsOptions {
  readonly url?: string;
  /** Keep it to reclaim the same id after a drop. */
  readonly token?: string;
  readonly createSocket?: SocketFactory;
}

export class PeerJsSignaling implements Signaling {
  readonly token: string;
  private socket: SocketLike | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private opened = false;
  private closedByUs = false;
  private readonly messageListeners = new Set<(from: string, message: SignalMessage) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(
    readonly id: string,
    private readonly options: PeerJsOptions = {},
  ) {
    this.token = options.token ?? randomToken();
  }

  open(): Promise<void> {
    this.closedByUs = false;
    this.opened = false;
    const base = this.options.url ?? PEERJS_CLOUD_URL;
    const url =
      `${base}?key=${KEY}&id=${encodeURIComponent(this.id)}` +
      `&token=${encodeURIComponent(this.token)}`;
    const create = this.options.createSocket ?? browserSocket;

    return new Promise((resolve, reject) => {
      this.socket = create(url, {
        message: (text) => {
          const message = parseServerMessage(text);
          if (!message) return;
          if (message.type === 'OPEN') {
            this.opened = true;
            this.startHeartbeat();
            resolve();
            return;
          }
          if (message.type === 'ID-TAKEN') {
            reject(new AddressTakenError(this.id));
            this.close();
            return;
          }
          if (message.type === 'ERROR') {
            if (!this.opened) reject(new Error('The signaling server refused the connection.'));
            return;
          }
          const kind = kindFromWire(message.type);
          if (kind === null || message.src === undefined) return;
          const signal = parseSignal(kind, fromWirePayload(message.payload));
          if (!signal) return;
          for (const listener of this.messageListeners) listener(message.src, signal);
        },
        close: () => {
          this.stopHeartbeat();
          this.socket = null;
          if (!this.opened) {
            reject(new Error('The signaling server could not be reached.'));
            return;
          }
          this.opened = false;
          if (!this.closedByUs) for (const listener of this.closeListeners) listener();
        },
      });
    });
  }

  send(to: string, message: SignalMessage): void {
    if (!this.socket || !this.opened || message.kind === 'gone') return;
    this.socket.send(
      JSON.stringify({ type: TO_WIRE[message.kind], payload: wirePayload(message), dst: to }),
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
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.opened = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.socket?.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
