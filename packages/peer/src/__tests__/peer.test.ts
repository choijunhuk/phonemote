import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AddressTakenError,
  BroadcastSignaling,
  LatestOnly,
  PeerJsSignaling,
  callerAddress,
  hostAddress,
  isNewerSequence,
  parseSignal,
  type SignalMessage,
  type SocketFactory,
} from '../index.js';

describe('addresses', () => {
  it('derives the room address from its code, case-insensitively', () => {
    expect(hostAddress('abcd')).toBe('phonemote-v1-ABCD');
  });

  it('gives callers a distinct, prefixed address', () => {
    const address = callerAddress(() => 0.5);
    expect(address).toMatch(/^phonemote-v1-c-[0-9a-z]{12}$/);
    expect(callerAddress()).not.toBe(callerAddress());
  });
});

describe('parseSignal', () => {
  it('accepts well-formed offers, answers and candidates', () => {
    expect(parseSignal('offer', { sdp: 'v=0' })).toEqual({ kind: 'offer', sdp: 'v=0' });
    expect(parseSignal('candidate', { candidate: { candidate: 'c', sdpMid: '0' } })).toEqual({
      kind: 'candidate',
      candidate: { candidate: 'c', sdpMid: '0' },
    });
  });

  it('drops anything shaped wrong instead of handing it to the browser', () => {
    expect(parseSignal('offer', { sdp: 42 })).toBeNull();
    expect(parseSignal('offer', { sdp: '' })).toBeNull();
    expect(parseSignal('answer', null)).toBeNull();
    expect(parseSignal('candidate', { candidate: { sdpMid: '0' } })).toBeNull();
    expect(parseSignal('reboot', {})).toBeNull();
  });
});

describe('sequence ordering', () => {
  it('treats the next numbers, across the wrap, as newer', () => {
    expect(isNewerSequence(11, 10)).toBe(true);
    expect(isNewerSequence(0, (1 << 24) - 1)).toBe(true);
    expect(isNewerSequence(10, 10)).toBe(false);
    expect(isNewerSequence(9, 10)).toBe(false);
  });

  it('turns away a straggler but takes a sender that started over once told', () => {
    const latest = new LatestOnly();
    expect(latest.accept(1, 100)).toBe(true);
    expect(latest.accept(1, 99)).toBe(false);
    expect(latest.accept(2, 5)).toBe(true);
    expect(latest.accept(1, 0)).toBe(false);
    latest.forget(1);
    expect(latest.accept(1, 0)).toBe(true);
  });
});

/** A stand-in for the PeerJS server, at the level of the JSON it exchanges. */
function fakeServer(): {
  factory: SocketFactory;
  urls: string[];
  sent: unknown[];
  push(message: unknown): void;
  drop(): void;
} {
  const urls: string[] = [];
  const sent: unknown[] = [];
  let events: { message(data: string): void; close(): void } | null = null;
  return {
    urls,
    sent,
    factory: (url, handlers) => {
      urls.push(url);
      events = handlers;
      return {
        send: (data) => sent.push(JSON.parse(data)),
        close: () => undefined,
      };
    },
    push: (message) => events?.message(JSON.stringify(message)),
    drop: () => events?.close(),
  };
}

describe('PeerJsSignaling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims its id with its token and opens on OPEN', async () => {
    const server = fakeServer();
    const signaling = new PeerJsSignaling('phonemote-v1-ABCD', {
      createSocket: server.factory,
      token: 't0k',
    });
    const opening = signaling.open();
    server.push({ type: 'OPEN' });
    await expect(opening).resolves.toBeUndefined();
    expect(server.urls[0]).toBe(
      'wss://0.peerjs.com:443/peerjs?key=peerjs&id=phonemote-v1-ABCD&token=t0k',
    );
  });

  it('reports a taken id, which is how a room code collision shows', async () => {
    const server = fakeServer();
    const signaling = new PeerJsSignaling('phonemote-v1-ABCD', { createSocket: server.factory });
    const opening = signaling.open();
    server.push({ type: 'ID-TAKEN', payload: { msg: 'taken' } });
    await expect(opening).rejects.toBeInstanceOf(AddressTakenError);
  });

  it('sends in the server format and receives with the sender filled in', async () => {
    const server = fakeServer();
    const signaling = new PeerJsSignaling('a', { createSocket: server.factory });
    const received: Array<[string, SignalMessage]> = [];
    signaling.onMessage((from, message) => received.push([from, message]));
    const opening = signaling.open();
    server.push({ type: 'OPEN' });
    await opening;

    signaling.send('b', { kind: 'offer', sdp: 'v=0' });
    // Laid out as the PeerJS client lays it out: the cloud passes that shape.
    expect(server.sent).toContainEqual({
      type: 'OFFER',
      dst: 'b',
      payload: {
        type: 'data',
        connectionId: 'dc_phonemote',
        serialization: 'binary',
        reliable: true,
        sdp: { type: 'offer', sdp: 'v=0' },
      },
    });

    server.push({ type: 'ANSWER', src: 'b', payload: { sdp: { type: 'answer', sdp: 'v=1' } } });
    server.push({ type: 'ANSWER', src: 'b', payload: { sdp: 7 } });
    server.push({ type: 'EXPIRE', src: 'c' });
    expect(received).toEqual([
      ['b', { kind: 'answer', sdp: 'v=1' }],
      ['c', { kind: 'gone' }],
    ]);
  });

  it('keeps the server from timing it out, and says when it drops', async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const signaling = new PeerJsSignaling('a', { createSocket: server.factory });
    const dropped = vi.fn();
    signaling.onClose(dropped);
    const opening = signaling.open();
    server.push({ type: 'OPEN' });
    await opening;

    vi.advanceTimersByTime(60_000);
    expect(
      server.sent.filter((message) => (message as { type: string }).type === 'HEARTBEAT'),
    ).toHaveLength(3);

    server.drop();
    expect(dropped).toHaveBeenCalledOnce();
  });

  it('fails to open when the server cannot be reached', async () => {
    const server = fakeServer();
    const signaling = new PeerJsSignaling('a', { createSocket: server.factory });
    const opening = signaling.open();
    server.drop();
    await expect(opening).rejects.toThrow('could not be reached');
  });
});

describe('BroadcastSignaling', () => {
  const open: BroadcastSignaling[] = [];
  afterEach(() => {
    for (const signaling of open.splice(0)) signaling.close();
  });

  it('carries a message from one address to another', async () => {
    const host = new BroadcastSignaling('host', 20);
    const phone = new BroadcastSignaling('phone', 20);
    open.push(host, phone);
    await Promise.all([host.open(), phone.open()]);

    const arrived = new Promise<[string, SignalMessage]>((resolve) => {
      host.onMessage((from, message) => resolve([from, message]));
    });
    phone.send('host', { kind: 'offer', sdp: 'v=0' });
    await expect(arrived).resolves.toEqual(['phone', { kind: 'offer', sdp: 'v=0' }]);
  });

  it('refuses an address somebody already holds', async () => {
    const first = new BroadcastSignaling('room', 20);
    open.push(first);
    await first.open();
    const second = new BroadcastSignaling('room', 50);
    open.push(second);
    await expect(second.open()).rejects.toBeInstanceOf(AddressTakenError);
  });
});
