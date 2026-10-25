import type { Signaling } from './signaling.js';

/**
 * A phone and the game page, connected directly (ARCHITECTURE.md D60).
 *
 * Two data channels, because the two kinds of traffic want opposite things.
 * Control messages — hello, joined, ping, vibrate — must arrive, in order. A
 * sensor frame that arrives late is worse than one that never arrives: the
 * next one is already 16 ms behind it, and a reliable channel would hold every
 * later frame back until the lost one was resent. So sensor frames go unordered
 * with no retransmission, and the receiver drops anything older than what it
 * has already seen.
 */

/**
 * Where to look for a route between phone and PC.
 *
 * On one Wi-Fi network the devices' own addresses are enough. STUN finds each
 * side's public address for when they are not; TURN relays the traffic when
 * no direct route exists at all, such as a guest network that isolates its
 * clients. These are the public servers the PeerJS client itself defaults to.
 */
export const PUBLIC_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs',
    credential: 'peerjsp',
  },
];

export const CONTROL_CHANNEL = 'control';
export const SENSOR_CHANNEL = 'sensor';

export interface PeerLink {
  readonly connection: RTCPeerConnection;
  /** JSON control messages: in order, never lost. */
  readonly control: RTCDataChannel;
  /** Binary sensor frames: unordered, never retransmitted. */
  readonly sensor: RTCDataChannel;
}

export class RoomNotFoundError extends Error {
  constructor() {
    super('No room answered at that code.');
    this.name = 'RoomNotFoundError';
  }
}

export class LinkTimeoutError extends Error {
  constructor() {
    super('The connection did not open in time.');
    this.name = 'LinkTimeoutError';
  }
}

export interface LinkOptions {
  readonly iceServers: readonly RTCIceServer[];
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Candidates can arrive before the description they belong to has been set,
 * and adding them then throws. Hold them until it is.
 */
class CandidateQueue {
  private pending: RTCIceCandidateInit[] = [];
  private ready = false;

  constructor(private readonly connection: RTCPeerConnection) {}

  add(candidate: RTCIceCandidateInit): void {
    if (this.ready) this.apply(candidate);
    else this.pending.push(candidate);
  }

  flush(): void {
    this.ready = true;
    for (const candidate of this.pending) this.apply(candidate);
    this.pending = [];
  }

  private apply(candidate: RTCIceCandidateInit): void {
    // One unusable candidate is not a failed connection; the others carry on.
    void this.connection.addIceCandidate(candidate).catch(() => undefined);
  }
}

/** The phone calls the room, and resolves once both channels are open. */
export function dial(signaling: Signaling, hostId: string, options: LinkOptions): Promise<PeerLink> {
  const connection = new RTCPeerConnection({ iceServers: [...options.iceServers] });
  const control = connection.createDataChannel(CONTROL_CHANNEL, { ordered: true });
  const sensor = connection.createDataChannel(SENSOR_CHANNEL, {
    ordered: false,
    maxRetransmits: 0,
  });
  control.binaryType = 'arraybuffer';
  sensor.binaryType = 'arraybuffer';
  const candidates = new CandidateQueue(connection);

  return new Promise((resolve, reject) => {
    let done = false;
    let stopListening: () => void = () => undefined;
    const timer = setTimeout(
      () => finish(new LinkTimeoutError()),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    function finish(error?: Error): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopListening();
      if (error) {
        connection.close();
        reject(error);
      } else {
        resolve({ connection, control, sensor });
      }
    }

    stopListening = signaling.onMessage((from, message) => {
      if (from !== hostId) return;
      if (message.kind === 'answer') {
        connection
          .setRemoteDescription({ type: 'answer', sdp: message.sdp })
          .then(() => candidates.flush())
          .catch((error: unknown) => finish(asError(error)));
      } else if (message.kind === 'candidate') {
        candidates.add(message.candidate);
      } else if (message.kind === 'gone') {
        finish(new RoomNotFoundError());
      }
    });

    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        signaling.send(hostId, { kind: 'candidate', candidate: event.candidate.toJSON() });
      }
    });
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') finish(new Error('The peer connection failed.'));
    });

    let open = 0;
    const opened = (): void => {
      open++;
      if (open === 2) finish();
    };
    control.addEventListener('open', opened, { once: true });
    sensor.addEventListener('open', opened, { once: true });

    connection
      .createOffer()
      .then(async (offer) => {
        await connection.setLocalDescription(offer);
        signaling.send(hostId, { kind: 'offer', sdp: offer.sdp ?? '' });
      })
      .catch((error: unknown) => finish(asError(error)));
  });
}

export interface IncomingCall {
  /** Resolves once the caller's two channels are open. */
  readonly link: Promise<PeerLink>;
  /** A candidate from the caller, which may arrive before the answer is ready. */
  addCandidate(candidate: RTCIceCandidateInit): void;
  close(): void;
}

/** The room answers one caller's offer. */
export function answer(
  signaling: Signaling,
  callerId: string,
  offerSdp: string,
  options: LinkOptions,
): IncomingCall {
  const connection = new RTCPeerConnection({ iceServers: [...options.iceServers] });
  const candidates = new CandidateQueue(connection);

  const link = new Promise<PeerLink>((resolve, reject) => {
    let done = false;
    let control: RTCDataChannel | null = null;
    let sensor: RTCDataChannel | null = null;
    const timer = setTimeout(
      () => fail(new LinkTimeoutError()),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    function fail(error: Error): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connection.close();
      reject(error);
    }

    const check = (): void => {
      const c = control;
      const s = sensor;
      if (done || !c || !s || c.readyState !== 'open' || s.readyState !== 'open') return;
      done = true;
      clearTimeout(timer);
      resolve({ connection, control: c, sensor: s });
    };

    connection.addEventListener('datachannel', (event) => {
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';
      if (channel.label === CONTROL_CHANNEL) control = channel;
      else if (channel.label === SENSOR_CHANNEL) sensor = channel;
      else return;
      if (channel.readyState === 'open') check();
      else channel.addEventListener('open', check, { once: true });
    });
    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        signaling.send(callerId, { kind: 'candidate', candidate: event.candidate.toJSON() });
      }
    });
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') fail(new Error('The peer connection failed.'));
    });

    connection
      .setRemoteDescription({ type: 'offer', sdp: offerSdp })
      .then(async () => {
        candidates.flush();
        const reply = await connection.createAnswer();
        await connection.setLocalDescription(reply);
        signaling.send(callerId, { kind: 'answer', sdp: reply.sdp ?? '' });
      })
      .catch((error: unknown) => fail(asError(error)));
  });

  return {
    link,
    addCandidate: (candidate) => candidates.add(candidate),
    close: () => connection.close(),
  };
}
