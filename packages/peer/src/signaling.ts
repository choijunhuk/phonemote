/**
 * What two browsers say to each other before they have a connection of their
 * own (ARCHITECTURE.md D60).
 *
 * WebRTC can connect a phone straight to the game page, but the two have to
 * swap an offer, an answer and some network candidates first, through
 * something they can both already reach. That something is a signaling
 * channel. It carries a few kilobytes per join and nothing after that: every
 * sensor frame goes over the peer connection itself.
 */

export type SignalMessage =
  | { readonly kind: 'offer'; readonly sdp: string }
  | { readonly kind: 'answer'; readonly sdp: string }
  | { readonly kind: 'candidate'; readonly candidate: RTCIceCandidateInit }
  /** The other side is not there: never registered, or gone. */
  | { readonly kind: 'gone' };

export interface Signaling {
  /** This end's address on the channel. */
  readonly id: string;
  /**
   * Claim the address. Rejects with AddressTakenError when somebody else
   * already holds it, which is how a room code collision is noticed.
   */
  open(): Promise<void>;
  send(to: string, message: SignalMessage): void;
  onMessage(listener: (from: string, message: SignalMessage) => void): () => void;
  /** The channel dropped after it had opened. */
  onClose(listener: () => void): () => void;
  close(): void;
  /**
   * Whether a room currently holds this address, for channels that can tell
   * (true or false), so a mistyped code fails in a second rather than after a
   * call times out. Null, or absent, when the channel cannot say.
   */
  exists?(address: string): Promise<boolean | null>;
}

export class AddressTakenError extends Error {
  constructor(id: string) {
    super(`The address ${id} is already taken.`);
    this.name = 'AddressTakenError';
  }
}

/** Rooms and phones share one namespace on a public server, so both are prefixed. */
const NAMESPACE = 'phonemote-v1';

export function hostAddress(roomCode: string): string {
  return `${NAMESPACE}-${roomCode.toUpperCase()}`;
}

/** Rooms have addresses of their own; phones get random caller addresses. */
export function isHostAddress(address: string): boolean {
  return address.startsWith(`${NAMESPACE}-`) && !address.startsWith(`${NAMESPACE}-c-`);
}

export function callerAddress(random: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < 12; i++) suffix += Math.floor(random() * 36).toString(36);
  return `${NAMESPACE}-c-${suffix}`;
}

/**
 * Read a message that arrived from the network.
 *
 * Whatever is on the other end of a public server is untrusted, so nothing is
 * passed on until its shape has been checked: an `sdp` that is not a string or
 * a candidate without one is dropped rather than handed to RTCPeerConnection.
 */
export function parseSignal(kind: string, payload: unknown): SignalMessage | null {
  if (kind === 'gone') return { kind: 'gone' };
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;

  if (kind === 'offer' || kind === 'answer') {
    const sdp = record['sdp'];
    return typeof sdp === 'string' && sdp.length > 0 ? { kind, sdp } : null;
  }
  if (kind === 'candidate') {
    const candidate = record['candidate'];
    if (typeof candidate !== 'object' || candidate === null) return null;
    const init = candidate as Record<string, unknown>;
    if (typeof init['candidate'] !== 'string') return null;
    const sdpMid = init['sdpMid'];
    const sdpMLineIndex = init['sdpMLineIndex'];
    return {
      kind,
      candidate: {
        candidate: init['candidate'],
        ...(typeof sdpMid === 'string' ? { sdpMid } : {}),
        ...(typeof sdpMLineIndex === 'number' ? { sdpMLineIndex } : {}),
      },
    };
  }
  return null;
}

/** The payload half of a message, the inverse of parseSignal. */
export function signalPayload(message: SignalMessage): Record<string, unknown> {
  switch (message.kind) {
    case 'offer':
    case 'answer':
      return { sdp: message.sdp };
    case 'candidate':
      return { candidate: message.candidate };
    case 'gone':
      return {};
  }
}
