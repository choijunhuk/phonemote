import { describe, expect, it } from 'vitest';
import {
  AddressTakenError,
  FanoutSignaling,
  MqttSignaling,
  decodePackets,
  encodeConnect,
  encodeLength,
  encodePublish,
  hostAddress,
  isHostAddress,
  type MqttSocketFactory,
  type SignalMessage,
  type Signaling,
} from '../index.js';

describe('MQTT codec', () => {
  it('encodes the remaining length at each size boundary', () => {
    expect(encodeLength(0)).toEqual([0]);
    expect(encodeLength(127)).toEqual([127]);
    expect(encodeLength(128)).toEqual([0x80, 0x01]);
    expect(encodeLength(16_383)).toEqual([0xff, 0x7f]);
    expect(encodeLength(16_384)).toEqual([0x80, 0x80, 0x01]);
  });

  it('writes a 3.1.1 CONNECT with the will when there is one', () => {
    const bytes = Array.from(encodeConnect('id', 30, { topic: 't', payload: '', retain: true }));
    expect(bytes[0]).toBe(0x10);
    // "MQTT", level 4, flags: clean session + will + will retain.
    expect(bytes.slice(2, 10)).toEqual([0, 4, 77, 81, 84, 84, 4, 0x26]);
  });

  it('splits several packets out of one buffer and keeps a truncated tail', () => {
    const one = encodePublish('a/b', 'hello', true);
    const two = encodePublish('c', 'x');
    const joined = new Uint8Array([...one, ...two, ...two.slice(0, 3)]);
    const { packets, rest } = decodePackets(joined);
    expect(packets).toEqual([
      { type: 'publish', topic: 'a/b', payload: 'hello', retained: true },
      { type: 'publish', topic: 'c', payload: 'x', retained: false },
    ]);
    expect(Array.from(rest)).toEqual(Array.from(two.slice(0, 3)));
  });
});

/**
 * Just enough broker for the client: CONNECT with a will, SUBSCRIBE at QoS 0,
 * PUBLISH with retain, and the will published when a socket drops unannounced.
 */
class FakeBroker {
  private readonly retained = new Map<string, string>();
  private readonly clients = new Set<FakeClient>();

  readonly factory: MqttSocketFactory = (_url, events) => {
    const client = new FakeClient(this, events);
    this.clients.add(client);
    setTimeout(() => events.open(), 0);
    return client;
  };

  /** Drop every connection without a DISCONNECT, as a closed tab does. */
  dropAll(): void {
    for (const client of [...this.clients]) client.drop();
  }

  receive(client: FakeClient, bytes: Uint8Array): void {
    const type = (bytes[0] ?? 0) >> 4;
    let offset = 1;
    while (((bytes[offset++] ?? 0) & 0x80) !== 0);
    const body = bytes.subarray(offset);
    const readString = (at: number): [string, number] => {
      const length = ((body[at] ?? 0) << 8) | (body[at + 1] ?? 0);
      return [new TextDecoder().decode(body.subarray(at + 2, at + 2 + length)), at + 2 + length];
    };

    if (type === 1) {
      const flags = body[7] ?? 0;
      // Past the protocol name, level, flags, keep-alive and client id.
      const [, afterClientId] = readString(10);
      if ((flags & 0x04) !== 0) {
        const [topic, next] = readString(afterClientId);
        const [payload] = readString(next);
        client.will = { topic, payload, retain: (flags & 0x20) !== 0 };
      }
      client.deliver(new Uint8Array([0x20, 2, 0, 0]));
    } else if (type === 8) {
      const [topic] = readString(2);
      client.topics.add(topic);
      client.deliver(new Uint8Array([0x90, 3, body[0] ?? 0, body[1] ?? 0, 0]));
      const kept = this.retained.get(topic);
      if (kept !== undefined) client.deliver(encodePublish(topic, kept, true));
    } else if (type === 3) {
      const [topic, at] = readString(0);
      const payload = new TextDecoder().decode(body.subarray(at));
      this.publish(topic, payload, ((bytes[0] ?? 0) & 1) === 1);
    } else if (type === 14) {
      client.will = null;
      this.clients.delete(client);
    }
  }

  publish(topic: string, payload: string, retain: boolean): void {
    if (retain) {
      if (payload === '') this.retained.delete(topic);
      else this.retained.set(topic, payload);
    }
    for (const client of this.clients) {
      if (client.topics.has(topic)) client.deliver(encodePublish(topic, payload));
    }
  }

  forget(client: FakeClient): void {
    this.clients.delete(client);
    if (client.will) this.publish(client.will.topic, client.will.payload, client.will.retain);
  }
}

class FakeClient {
  readonly topics = new Set<string>();
  will: { topic: string; payload: string; retain: boolean } | null = null;
  private live = true;

  constructor(
    private readonly broker: FakeBroker,
    private readonly events: { open(): void; message(data: Uint8Array): void; close(): void },
  ) {}

  send(data: Uint8Array): void {
    if (this.live) this.broker.receive(this, data);
  }

  close(): void {
    if (!this.live) return;
    this.live = false;
    this.broker.forget(this);
    setTimeout(() => this.events.close(), 0);
  }

  drop(): void {
    this.close();
  }

  deliver(data: Uint8Array): void {
    if (this.live) setTimeout(() => this.events.message(data), 0);
  }
}

function mqtt(broker: FakeBroker, address: string): MqttSignaling {
  return new MqttSignaling(address, {
    url: 'wss://broker.test/mqtt',
    createSocket: broker.factory,
    // Past the 700 ms the client waits after a SUBACK for a retained claim.
    claimWaitMs: 2000,
    lookupWaitMs: 2000,
  });
}

function nextMessage(signaling: Signaling): Promise<[string, SignalMessage]> {
  return new Promise((resolve) => signaling.onMessage((from, message) => resolve([from, message])));
}

describe('MqttSignaling', () => {
  it('tells room addresses from caller addresses', () => {
    expect(isHostAddress(hostAddress('ABCD'))).toBe(true);
    expect(isHostAddress('phonemote-v1-c-0123456789ab')).toBe(false);
  });

  it("carries a message to the other side's inbox", async () => {
    const broker = new FakeBroker();
    const room = mqtt(broker, hostAddress('ABCD'));
    const phone = mqtt(broker, 'phonemote-v1-c-phone0000000');
    await room.open();
    await phone.open();
    const arrived = nextMessage(room);
    phone.send(room.id, { kind: 'offer', sdp: 'v=0' });
    await expect(arrived).resolves.toEqual([phone.id, { kind: 'offer', sdp: 'v=0' }]);
  });

  it('refuses a room code another page already holds', async () => {
    const broker = new FakeBroker();
    await mqtt(broker, hostAddress('ABCD')).open();
    await expect(mqtt(broker, hostAddress('ABCD')).open()).rejects.toBeInstanceOf(
      AddressTakenError,
    );
  });

  it('answers whether a room exists, and the claim goes when the page does', async () => {
    const broker = new FakeBroker();
    const room = mqtt(broker, hostAddress('ABCD'));
    await room.open();
    const phone = mqtt(broker, 'phonemote-v1-c-phone0000000');
    await phone.open();
    await expect(phone.exists(hostAddress('ABCD'))).resolves.toBe(true);
    await expect(phone.exists(hostAddress('ZZZZ'))).resolves.toBe(false);

    // The tab closes without a word; the broker publishes the room's will.
    broker.dropAll();
    const checker = mqtt(broker, 'phonemote-v1-c-checker0000');
    await checker.open();
    await expect(checker.exists(hostAddress('ABCD'))).resolves.toBe(false);
  });
});

/** A channel with no network: it opens or fails as told and records what it sends. */
class StubChannel implements Signaling {
  readonly sent: Array<[string, SignalMessage]> = [];
  private listener: ((from: string, message: SignalMessage) => void) | null = null;

  constructor(
    readonly id: string,
    private readonly outcome: 'open' | 'unreachable' | 'taken',
    private readonly knows: boolean | null = null,
  ) {}

  open(): Promise<void> {
    if (this.outcome === 'open') return Promise.resolve();
    return Promise.reject(
      this.outcome === 'taken' ? new AddressTakenError(this.id) : new Error('unreachable'),
    );
  }

  send(to: string, message: SignalMessage): void {
    this.sent.push([to, message]);
  }

  onMessage(listener: (from: string, message: SignalMessage) => void): () => void {
    this.listener = listener;
    return () => undefined;
  }

  onClose(): () => void {
    return () => undefined;
  }

  close(): void {}

  exists(): Promise<boolean | null> {
    return Promise.resolve(this.knows);
  }

  hear(from: string, message: SignalMessage): void {
    this.listener?.(from, message);
  }
}

describe('FanoutSignaling', () => {
  it('opens on whichever channels it can reach and sends on all of them', async () => {
    const up = new StubChannel('a', 'open');
    const down = new StubChannel('a', 'unreachable');
    const fanout = new FanoutSignaling('a', [up, down]);
    await fanout.open();
    fanout.send('b', { kind: 'answer', sdp: 'v=0' });
    expect(up.sent).toEqual([['b', { kind: 'answer', sdp: 'v=0' }]]);
    expect(down.sent).toEqual([]);
  });

  it('catches a channel that opens late up on what was just sent', async () => {
    let release: () => void = () => undefined;
    const late = new StubChannel('a', 'open');
    late.open = () => new Promise<void>((resolve) => (release = resolve));
    const fanout = new FanoutSignaling('a', [new StubChannel('a', 'open'), late]);
    await fanout.open();
    fanout.send('room', { kind: 'offer', sdp: 'v=0' });
    expect(late.sent).toEqual([]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(late.sent).toEqual([['room', { kind: 'offer', sdp: 'v=0' }]]);
  });

  it('fails only when every channel does, and a collision on any is a collision', async () => {
    await expect(
      new FanoutSignaling('a', [new StubChannel('a', 'unreachable')]).open(),
    ).rejects.toThrow('unreachable');
    await expect(
      new FanoutSignaling('a', [new StubChannel('a', 'open'), new StubChannel('a', 'taken')]).open(),
    ).rejects.toBeInstanceOf(AddressTakenError);
  });

  it('passes a message heard on two channels on once, and ignores one channel saying gone', async () => {
    const first = new StubChannel('a', 'open');
    const second = new StubChannel('a', 'open');
    const fanout = new FanoutSignaling('a', [first, second]);
    await fanout.open();
    const heard: Array<[string, SignalMessage]> = [];
    fanout.onMessage((from, message) => heard.push([from, message]));

    first.hear('b', { kind: 'offer', sdp: 'v=0' });
    second.hear('b', { kind: 'offer', sdp: 'v=0' });
    second.hear('b', { kind: 'gone' });
    expect(heard).toEqual([['b', { kind: 'offer', sdp: 'v=0' }]]);
  });

  it('believes one channel that has seen the room, and all that have not', async () => {
    const yes = new FanoutSignaling('a', [
      new StubChannel('a', 'open', false),
      new StubChannel('a', 'open', true),
    ]);
    await yes.open();
    await expect(yes.exists('room')).resolves.toBe(true);

    const no = new FanoutSignaling('a', [
      new StubChannel('a', 'open', false),
      new StubChannel('a', 'open', null),
    ]);
    await no.open();
    await expect(no.exists('room')).resolves.toBe(false);
  });
});
