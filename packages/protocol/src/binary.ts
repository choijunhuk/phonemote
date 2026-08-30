import {
  SENSOR_FIELD,
  SENSOR_FRAME_BYTES,
  SENSOR_FRAME_BYTES_V1,
  SENSOR_FRAME_FIELDS,
  SENSOR_FRAME_VERSION,
} from './constants.js';
import { isScreenOrientationValue, type SensorFrame } from './frame.js';

/**
 * Sensor frames go over the wire as little-endian float32 values
 * (ARCHITECTURE.md 6.2).
 *
 * Endianness is written out explicitly with DataView: the byte order of a
 * Float32Array follows the platform, which is not something a phone and a PC
 * may disagree about.
 */

const LITTLE_ENDIAN = true;

/** seq stays exactly representable in a float32 below 2^24. */
export const SEQ_MODULO = 1 << 24;

export function encodeSensor(frame: SensorFrame): ArrayBuffer {
  const buffer = new ArrayBuffer(SENSOR_FRAME_BYTES);
  const view = new DataView(buffer);
  const put = (field: number, value: number): void => {
    view.setFloat32(field * 4, value, LITTLE_ENDIAN);
  };

  put(SENSOR_FIELD.playerId, frame.playerId);
  put(SENSOR_FIELD.seq, frame.seq);
  put(SENSOR_FIELD.timestamp, frame.timestamp);
  put(SENSOR_FIELD.orientationAlpha, frame.orientation.alpha);
  put(SENSOR_FIELD.orientationBeta, frame.orientation.beta);
  put(SENSOR_FIELD.orientationGamma, frame.orientation.gamma);
  put(SENSOR_FIELD.rotationRateAlpha, frame.rotationRate.alpha);
  put(SENSOR_FIELD.rotationRateBeta, frame.rotationRate.beta);
  put(SENSOR_FIELD.rotationRateGamma, frame.rotationRate.gamma);
  put(SENSOR_FIELD.accelerationX, frame.acceleration.x);
  put(SENSOR_FIELD.accelerationY, frame.acceleration.y);
  put(SENSOR_FIELD.accelerationZ, frame.acceleration.z);
  put(SENSOR_FIELD.buttons, frame.buttons);
  put(SENSOR_FIELD.screenOrientation, frame.screenOrientation);
  put(SENSOR_FIELD.version, SENSOR_FRAME_VERSION);
  put(SENSOR_FIELD.motionSeq, frame.motionSeq);
  put(SENSOR_FIELD.flags, frame.flags);

  return buffer;
}

export class MalformedSensorFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedSensorFrameError';
  }
}

/**
 * Accepts v2 (68 byte) and v1 (56 byte) frames. v1 exists so traces recorded
 * before the format grew stay readable; its missing fields take defaults that
 * say "this frame cannot tell you".
 */
export function decodeSensor(buffer: ArrayBuffer): SensorFrame {
  const isV1 = buffer.byteLength === SENSOR_FRAME_BYTES_V1;
  if (!isV1 && buffer.byteLength !== SENSOR_FRAME_BYTES) {
    throw new MalformedSensorFrameError(
      `Sensor frame must be ${SENSOR_FRAME_BYTES} bytes (${SENSOR_FRAME_FIELDS} float32) ` +
        `or ${SENSOR_FRAME_BYTES_V1} for v1, got ${buffer.byteLength}`,
    );
  }

  const view = new DataView(buffer);
  const get = (field: number): number => view.getFloat32(field * 4, LITTLE_ENDIAN);

  const screenOrientation = Math.round(get(SENSOR_FIELD.screenOrientation));
  if (!isScreenOrientationValue(screenOrientation)) {
    throw new MalformedSensorFrameError(`Unknown screen orientation value: ${screenOrientation}`);
  }

  const seq = Math.round(get(SENSOR_FIELD.seq));

  return {
    // Integer-valued fields travel as floats; round them back so downstream
    // code can compare and bit-test them safely.
    playerId: Math.round(get(SENSOR_FIELD.playerId)),
    seq,
    timestamp: get(SENSOR_FIELD.timestamp),
    orientation: {
      alpha: get(SENSOR_FIELD.orientationAlpha),
      beta: get(SENSOR_FIELD.orientationBeta),
      gamma: get(SENSOR_FIELD.orientationGamma),
    },
    rotationRate: {
      alpha: get(SENSOR_FIELD.rotationRateAlpha),
      beta: get(SENSOR_FIELD.rotationRateBeta),
      gamma: get(SENSOR_FIELD.rotationRateGamma),
    },
    acceleration: {
      x: get(SENSOR_FIELD.accelerationX),
      y: get(SENSOR_FIELD.accelerationY),
      z: get(SENSOR_FIELD.accelerationZ),
    },
    buttons: Math.round(get(SENSOR_FIELD.buttons)),
    screenOrientation,
    version: isV1 ? 1 : Math.round(get(SENSOR_FIELD.version)),
    // A v1 frame has no event counter. Falling back to seq keeps stall
    // detection monotonic, at the cost of never detecting a stall in old
    // recordings — which is honest: v1 could not see one either.
    motionSeq: isV1 ? seq : Math.round(get(SENSOR_FIELD.motionSeq)),
    flags: isV1 ? 0 : Math.round(get(SENSOR_FIELD.flags)),
  };
}

/** Frames arriving from `ws` may be a Buffer or a view; normalise to ArrayBuffer. */
export function toArrayBuffer(data: ArrayBufferView | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
