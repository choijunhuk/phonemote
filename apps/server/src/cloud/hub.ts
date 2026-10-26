/**
 * The PhoneMote server's two jobs, as rules with no network in them
 * (ARCHITECTURE.md D63). cloud.ts puts WebSockets behind `Peer`.
 *
 * SignalHub: every page holds an address and can message any other address,
 * which is all a WebRTC handshake needs. A room's address also answers "does
 * this room exist", so a mistyped code fails at once.
 *
 * RelayHub: when phone and PC cannot reach each other directly, the server
 * carries their messages instead. The room's page holds one socket and every
 * relayed phone is a numbered tunnel on it; a phone's socket carries exactly
 * what a data channel would, so neither end changes for it.
 */

export interface Peer {
  sendText(text: string): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

const MAX_ADDRESS = 96;
const MAX_TOKEN = 96;
/** A room seats four; the rest is headroom for phones mid-reconnect. */
export const MAX_TUNNELS_PER_ROOM = 8;

function validId(value: string | null): value is string {
  return value !== null && value.length > 0 && value.length <= MAX_ADDRESS && /^[\w-]+$/.test(value);
}

export class SignalHub {
  private readonly byAddress = new Map<string, { peer: Peer; token: string }>();
  private readonly byPeer = new Map<Peer, string>();

  /** Claim an address. False when another token holds it. */
  register(peer: Peer, address: string | null, token: string | null): boolean {
    if (!validId(address) || token === null || token.length === 0 || token.length > MAX_TOKEN) {
      return false;
    }
    const held = this.byAddress.get(address);
    if (held && held.token !== token) return false;
    // The same token coming back — a page that reconnected — replaces itself.
    if (held) {
      this.byPeer.delete(held.peer);
      held.peer.close(4000, 'replaced');
    }
    this.byAddress.set(address, { peer, token });
    this.byPeer.set(peer, address);
    return true;
  }

  unregister(peer: Peer): void {
    const address = this.byPeer.get(peer);
    if (address === undefined) return;
    this.byPeer.delete(peer);
    if (this.byAddress.get(address)?.peer === peer) this.byAddress.delete(address);
  }

  ownerToken(address: string): string | null {
    return this.byAddress.get(address)?.token ?? null;
  }

  /** One message from a registered peer. Anything malformed is ignored. */
  receive(peer: Peer, text: string): void {
    const from = this.byPeer.get(peer);
    if (from === undefined) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;

    if (record['type'] === 'send' && typeof record['to'] === 'string' && typeof record['kind'] === 'string') {
      const target = this.byAddress.get(record['to']);
      if (!target) {
        peer.sendText(JSON.stringify({ type: 'signal', from: record['to'], kind: 'gone' }));
        return;
      }
      target.peer.sendText(
        JSON.stringify({ type: 'signal', from, kind: record['kind'], payload: record['payload'] }),
      );
      return;
    }
    if (record['type'] === 'exists' && typeof record['address'] === 'string') {
      peer.sendText(
        JSON.stringify({
          type: 'exists',
          ref: record['ref'],
          present: this.byAddress.has(record['address']),
        }),
      );
    }
  }
}

interface RelayRoom {
  readonly host: Peer;
  readonly phones: Map<number, Peer>;
  nextTunnel: number;
}

export class RelayHub {
  private readonly rooms = new Map<string, RelayRoom>();
  private readonly hostOf = new Map<Peer, string>();
  private readonly phoneOf = new Map<Peer, { room: string; tunnel: number }>();

  constructor(private readonly signals: SignalHub) {}

  /** The room's page offers to carry relayed phones. It must own the room's address. */
  attachHost(peer: Peer, address: string | null, token: string | null): boolean {
    if (!validId(address) || token === null || this.signals.ownerToken(address) !== token) {
      return false;
    }
    const previous = this.rooms.get(address);
    if (previous) this.detach(previous.host);
    this.rooms.set(address, { host: peer, phones: new Map(), nextTunnel: 1 });
    this.hostOf.set(peer, address);
    return true;
  }

  /** A phone that could not reach the room directly. False when the room has no relay. */
  attachPhone(peer: Peer, address: string | null): boolean {
    const room = validId(address) ? this.rooms.get(address) : undefined;
    if (!room || !validId(address) || room.phones.size >= MAX_TUNNELS_PER_ROOM) return false;
    const tunnel = room.nextTunnel++;
    room.phones.set(tunnel, peer);
    this.phoneOf.set(peer, { room: address, tunnel });
    room.host.sendText(JSON.stringify({ t: tunnel, open: true }));
    return true;
  }

  /** Whatever a socket says, routed by which side it is. */
  receiveText(peer: Peer, text: string): void {
    const phone = this.phoneOf.get(peer);
    if (phone) {
      this.rooms.get(phone.room)?.host.sendText(JSON.stringify({ t: phone.tunnel, d: text }));
      return;
    }
    const room = this.roomHostedBy(peer);
    if (!room) return;
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof envelope !== 'object' || envelope === null) return;
    const record = envelope as Record<string, unknown>;
    const tunnel = record['t'];
    if (typeof tunnel !== 'number') return;
    const target = room.phones.get(tunnel);
    if (!target) return;
    if (record['close'] === true) {
      target.close(1000, 'closed by the room');
      return;
    }
    if (typeof record['d'] === 'string') target.sendText(record['d']);
  }

  /** Binary to the host is prefixed with the 4-byte tunnel number; to a phone it is bare. */
  receiveBinary(peer: Peer, data: Uint8Array): void {
    const phone = this.phoneOf.get(peer);
    if (phone) {
      const framed = new Uint8Array(4 + data.length);
      new DataView(framed.buffer).setUint32(0, phone.tunnel);
      framed.set(data, 4);
      this.rooms.get(phone.room)?.host.sendBinary(framed);
      return;
    }
    const room = this.roomHostedBy(peer);
    if (!room || data.length < 4) return;
    const tunnel = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    room.phones.get(tunnel)?.sendBinary(data.subarray(4));
  }

  detach(peer: Peer): void {
    const phone = this.phoneOf.get(peer);
    if (phone) {
      this.phoneOf.delete(peer);
      const room = this.rooms.get(phone.room);
      if (room?.phones.get(phone.tunnel) === peer) {
        room.phones.delete(phone.tunnel);
        room.host.sendText(JSON.stringify({ t: phone.tunnel, close: true }));
      }
      return;
    }
    const address = this.hostOf.get(peer);
    if (address === undefined) return;
    this.hostOf.delete(peer);
    const room = this.rooms.get(address);
    if (room?.host !== peer) return;
    this.rooms.delete(address);
    // No room to carry them to: the phones fall back to calling again.
    for (const phonePeer of room.phones.values()) {
      this.phoneOf.delete(phonePeer);
      phonePeer.close(1001, 'the room left the relay');
    }
  }

  private roomHostedBy(peer: Peer): RelayRoom | undefined {
    const address = this.hostOf.get(peer);
    return address === undefined ? undefined : this.rooms.get(address);
  }
}
