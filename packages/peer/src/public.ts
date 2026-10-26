import { FanoutSignaling } from './fanout.js';
import { MqttSignaling } from './mqtt.js';
import { PeerJsSignaling } from './peerjs.js';
import { ServerSignaling } from './server.js';
import { isHostAddress, type Signaling } from './signaling.js';

/**
 * The free public brokers the web build also signals through (ARCHITECTURE.md
 * D61), as a fallback for when the PhoneMote server cannot be reached.
 */
export const PUBLIC_MQTT_BROKERS: readonly string[] = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];

export interface SignalingOptions {
  /** The PhoneMote server, first choice (D63). */
  readonly server?: string;
  /** The token the server holds this address with; the relay checks it. */
  readonly token?: string;
}

/** The PhoneMote server and every public channel at once, for rooms and phones alike. */
export function publicSignaling(address: string, options: SignalingOptions = {}): Signaling {
  return new FanoutSignaling(
    address,
    [
      ...(options.server ? [new ServerSignaling(address, options.server, options.token)] : []),
      ...PUBLIC_MQTT_BROKERS.map((url) => new MqttSignaling(address, { url })),
      new PeerJsSignaling(address),
    ],
    // A room waits for the slower channels so a taken code is caught before it
    // is shown; a phone goes ahead on the first one (see FanoutOptions).
    isHostAddress(address) ? {} : { stragglerGraceMs: 0 },
  );
}
