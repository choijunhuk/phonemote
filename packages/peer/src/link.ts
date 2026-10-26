import type { PeerLink } from './rtc.js';

/**
 * One phone's connection to the room, whatever carries it (ARCHITECTURE.md D63).
 *
 * Two things can: a WebRTC peer connection straight between phone and PC, or
 * the PhoneMote server relaying the same messages over WebSockets when no
 * direct route exists. The room and the phone speak to either through this,
 * so seating, pings, haptics and sensor frames do not care which it is.
 */
export interface Link {
  readonly kind: 'direct' | 'relay';
  /** JSON control messages, in order. */
  sendControl(text: string): void;
  /** A binary sensor frame. False when dropped because the link is behind. */
  sendSensor(frame: ArrayBuffer): boolean;
  /** Bytes of control traffic queued and not yet sent. */
  readonly bufferedAmount: number;
  onControl(listener: (text: string) => void): void;
  onSensor(listener: (frame: ArrayBuffer) => void): void;
  /** Called once, when the link is gone for any reason. */
  onEnd(listener: () => void): void;
  close(): void;
}

/** A WebRTC peer connection's two data channels, as a Link. */
export function directLink(peer: PeerLink, maxBufferedBytes: number): Link {
  const { connection, control, sensor } = peer;
  const ends = new Set<() => void>();
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    connection.close();
    for (const listener of ends) listener();
  };
  control.addEventListener('close', end);
  connection.addEventListener('connectionstatechange', () => {
    const state = connection.connectionState;
    if (state === 'disconnected' || state === 'failed' || state === 'closed') end();
  });

  return {
    kind: 'direct',
    sendControl: (text) => {
      if (control.readyState === 'open') control.send(text);
    },
    sendSensor: (frame) => {
      if (sensor.readyState !== 'open' || sensor.bufferedAmount > maxBufferedBytes) return false;
      sensor.send(frame);
      return true;
    },
    get bufferedAmount() {
      return control.bufferedAmount;
    },
    onControl: (listener) =>
      control.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (typeof event.data === 'string') listener(event.data);
      }),
    onSensor: (listener) =>
      sensor.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (event.data instanceof ArrayBuffer) listener(event.data);
      }),
    onEnd: (listener) => {
      if (ended) listener();
      else ends.add(listener);
    },
    close: end,
  };
}
