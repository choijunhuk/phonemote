import { describe, expect, it } from 'vitest';
import { MAX_TUNNELS_PER_ROOM, RelayHub, SignalHub, type Peer } from '../cloud/hub.js';

class FakePeer implements Peer {
  readonly texts: string[] = [];
  readonly binaries: Uint8Array[] = [];
  closed: number | null = null;

  sendText(text: string): void {
    this.texts.push(text);
  }

  sendBinary(data: Uint8Array): void {
    this.binaries.push(data);
  }

  close(code = 1000): void {
    this.closed = code;
  }

  json(): unknown[] {
    return this.texts.map((text) => JSON.parse(text) as unknown);
  }
}

describe('SignalHub', () => {
  it('lets one token hold an address, and the same token reclaim it', () => {
    const hub = new SignalHub();
    const first = new FakePeer();
    expect(hub.register(first, 'phonemote-v1-ABCD', 'one')).toBe(true);
    expect(hub.register(new FakePeer(), 'phonemote-v1-ABCD', 'two')).toBe(false);

    const again = new FakePeer();
    expect(hub.register(again, 'phonemote-v1-ABCD', 'one')).toBe(true);
    expect(first.closed).toBe(4000);
  });

  it('refuses addresses and tokens that are not plain short words', () => {
    const hub = new SignalHub();
    expect(hub.register(new FakePeer(), 'has space', 't')).toBe(false);
    expect(hub.register(new FakePeer(), 'x'.repeat(200), 't')).toBe(false);
    expect(hub.register(new FakePeer(), 'ok', null)).toBe(false);
  });

  it('carries a message to another address, and says "gone" when nobody holds it', () => {
    const hub = new SignalHub();
    const room = new FakePeer();
    const phone = new FakePeer();
    hub.register(room, 'room', 'r');
    hub.register(phone, 'phone', 'p');

    hub.receive(phone, JSON.stringify({ type: 'send', to: 'room', kind: 'offer', payload: { sdp: 'v=0' } }));
    expect(room.json()).toEqual([{ type: 'signal', from: 'phone', kind: 'offer', payload: { sdp: 'v=0' } }]);

    hub.receive(phone, JSON.stringify({ type: 'send', to: 'nobody', kind: 'offer', payload: {} }));
    expect(phone.json().at(-1)).toEqual({ type: 'signal', from: 'nobody', kind: 'gone' });
  });

  it('answers whether a room exists, and forgets an address when its socket goes', () => {
    const hub = new SignalHub();
    const room = new FakePeer();
    const phone = new FakePeer();
    hub.register(room, 'room', 'r');
    hub.register(phone, 'phone', 'p');
    hub.receive(phone, JSON.stringify({ type: 'exists', address: 'room', ref: 1 }));
    hub.unregister(room);
    hub.receive(phone, JSON.stringify({ type: 'exists', address: 'room', ref: 2 }));
    expect(phone.json()).toEqual([
      { type: 'exists', ref: 1, present: true },
      { type: 'exists', ref: 2, present: false },
    ]);
  });
});

describe('RelayHub', () => {
  function setUp(): { hub: RelayHub; host: FakePeer } {
    const signals = new SignalHub();
    signals.register(new FakePeer(), 'room', 'secret');
    const hub = new RelayHub(signals);
    const host = new FakePeer();
    expect(hub.attachHost(host, 'room', 'secret')).toBe(true);
    return { hub, host };
  }

  it("only seats as host the page that holds the room's address", () => {
    const signals = new SignalHub();
    signals.register(new FakePeer(), 'room', 'secret');
    const hub = new RelayHub(signals);
    expect(hub.attachHost(new FakePeer(), 'room', 'guess')).toBe(false);
    expect(hub.attachHost(new FakePeer(), 'other', 'secret')).toBe(false);
  });

  it('turns away a phone when the room is not relaying', () => {
    const hub = new RelayHub(new SignalHub());
    expect(hub.attachPhone(new FakePeer(), 'room')).toBe(false);
  });

  it('tunnels text and frames between a phone and the room both ways', () => {
    const { hub, host } = setUp();
    const phone = new FakePeer();
    expect(hub.attachPhone(phone, 'room')).toBe(true);
    expect(host.json()).toEqual([{ t: 1, open: true }]);

    hub.receiveText(phone, '{"type":"hello"}');
    expect(host.json().at(-1)).toEqual({ t: 1, d: '{"type":"hello"}' });

    hub.receiveBinary(phone, new Uint8Array([7, 8, 9]));
    expect(Array.from(host.binaries[0] ?? [])).toEqual([0, 0, 0, 1, 7, 8, 9]);

    hub.receiveText(host, JSON.stringify({ t: 1, d: '{"type":"joined"}' }));
    expect(phone.texts).toEqual(['{"type":"joined"}']);
  });

  it('tells the room when a phone leaves, and closes the phones when the room does', () => {
    const { hub, host } = setUp();
    const first = new FakePeer();
    const second = new FakePeer();
    hub.attachPhone(first, 'room');
    hub.attachPhone(second, 'room');
    hub.detach(first);
    expect(host.json().at(-1)).toEqual({ t: 1, close: true });

    hub.detach(host);
    expect(second.closed).toBe(1001);
  });

  it('caps the phones one room can tunnel', () => {
    const { hub } = setUp();
    for (let i = 0; i < MAX_TUNNELS_PER_ROOM; i++) expect(hub.attachPhone(new FakePeer(), 'room')).toBe(true);
    expect(hub.attachPhone(new FakePeer(), 'room')).toBe(false);
  });
});
