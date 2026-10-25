import { FanoutSignaling } from './fanout.js';
import { MqttSignaling } from './mqtt.js';
import { PeerJsSignaling } from './peerjs.js';
import type { Signaling } from './signaling.js';

/**
 * The free public brokers the web build signals through (ARCHITECTURE.md D61).
 * Order is preference only; all are used at once.
 */
export const PUBLIC_MQTT_BROKERS: readonly string[] = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];

/** Every public channel at once, for the room and for the phones alike. */
export function publicSignaling(address: string): Signaling {
  return new FanoutSignaling(address, [
    ...PUBLIC_MQTT_BROKERS.map((url) => new MqttSignaling(address, { url })),
    new PeerJsSignaling(address),
  ]);
}
