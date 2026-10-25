/**
 * The handful of MQTT 3.1.1 packets signaling needs, encoded and decoded by
 * hand (ARCHITECTURE.md D61).
 *
 * Four outbound packets (CONNECT, SUBSCRIBE, PUBLISH at QoS 0, PINGREQ) and
 * four inbound ones (CONNACK, SUBACK, PUBLISH, PINGRESP) are the whole of it.
 * A full client library would be most of the controller's download for a few
 * kilobytes of handshake, and this way every byte on the wire is in this file.
 *
 * Reference: MQTT Version 3.1.1, OASIS Standard, sections 2 and 3.
 */

const TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A UTF-8 string with its two-byte length in front (section 1.5.3). */
function utf8(text: string): number[] {
  const bytes = encoder.encode(text);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

/** The variable-length "remaining length" (section 2.2.3). */
export function encodeLength(length: number): number[] {
  const out: number[] = [];
  let rest = length;
  do {
    let digit = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) digit |= 0x80;
    out.push(digit);
  } while (rest > 0);
  return out;
}

function packet(firstByte: number, body: readonly number[]): Uint8Array {
  return new Uint8Array([firstByte, ...encodeLength(body.length), ...body]);
}

export interface Will {
  readonly topic: string;
  readonly payload: string;
  readonly retain: boolean;
}

export function encodeConnect(clientId: string, keepAliveSeconds: number, will?: Will): Uint8Array {
  // Clean session, and the will flags when there is one (section 3.1.2.3).
  const flags = 0x02 | (will ? 0x04 | (will.retain ? 0x20 : 0) : 0);
  return packet(TYPE.CONNECT << 4, [
    ...utf8('MQTT'),
    4, // protocol level 3.1.1
    flags,
    keepAliveSeconds >> 8,
    keepAliveSeconds & 0xff,
    ...utf8(clientId),
    ...(will ? [...utf8(will.topic), ...utf8(will.payload)] : []),
  ]);
}

/** One topic at QoS 0. The first byte's low nibble is fixed at 0b0010 (section 3.8.1). */
export function encodeSubscribe(packetId: number, topic: string): Uint8Array {
  return packet((TYPE.SUBSCRIBE << 4) | 0x02, [packetId >> 8, packetId & 0xff, ...utf8(topic), 0]);
}

/** QoS 0, so no packet id (section 3.3.2.2). */
export function encodePublish(topic: string, payload: string, retain = false): Uint8Array {
  return packet((TYPE.PUBLISH << 4) | (retain ? 1 : 0), [...utf8(topic), ...encoder.encode(payload)]);
}

export function encodePingreq(): Uint8Array {
  return packet(TYPE.PINGREQ << 4, []);
}

export function encodeDisconnect(): Uint8Array {
  return packet(TYPE.DISCONNECT << 4, []);
}

export type InboundPacket =
  | { readonly type: 'connack'; readonly returnCode: number }
  | { readonly type: 'suback'; readonly packetId: number; readonly granted: number }
  | { readonly type: 'publish'; readonly topic: string; readonly payload: string; readonly retained: boolean }
  | { readonly type: 'pingresp' }
  | { readonly type: 'other'; readonly code: number };

/**
 * Split a buffer into whole packets.
 *
 * A WebSocket message normally carries exactly one, but nothing in the spec
 * promises it, so packets are read off until the bytes run out. A truncated
 * tail is returned rather than guessed at.
 */
export function decodePackets(bytes: Uint8Array): { packets: InboundPacket[]; rest: Uint8Array } {
  const packets: InboundPacket[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const start = offset;
    const first = bytes[offset++];
    if (first === undefined) break;

    let length = 0;
    let multiplier = 1;
    let digit: number | undefined;
    let complete = false;
    for (let i = 0; i < 4; i++) {
      digit = bytes[offset++];
      if (digit === undefined) break;
      length += (digit & 0x7f) * multiplier;
      multiplier *= 128;
      if ((digit & 0x80) === 0) {
        complete = true;
        break;
      }
    }
    if (!complete || offset + length > bytes.length) {
      return { packets, rest: bytes.slice(start) };
    }

    const body = bytes.subarray(offset, offset + length);
    offset += length;
    packets.push(decodeOne(first, body));
  }

  return { packets, rest: new Uint8Array(0) };
}

function decodeOne(first: number, body: Uint8Array): InboundPacket {
  const code = first >> 4;
  switch (code) {
    case TYPE.CONNACK:
      return { type: 'connack', returnCode: body[1] ?? 0xff };
    case TYPE.SUBACK:
      return {
        type: 'suback',
        packetId: ((body[0] ?? 0) << 8) | (body[1] ?? 0),
        granted: body[2] ?? 0x80,
      };
    case TYPE.PUBLISH: {
      const topicLength = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
      const qos = (first >> 1) & 0x03;
      const topicEnd = 2 + topicLength;
      // QoS 1 and 2 carry a packet id after the topic; nothing here asks for them.
      const payloadStart = topicEnd + (qos > 0 ? 2 : 0);
      return {
        type: 'publish',
        topic: decoder.decode(body.subarray(2, topicEnd)),
        payload: decoder.decode(body.subarray(payloadStart)),
        retained: (first & 0x01) === 1,
      };
    }
    case TYPE.PINGRESP:
      return { type: 'pingresp' };
    default:
      return { type: 'other', code };
  }
}
