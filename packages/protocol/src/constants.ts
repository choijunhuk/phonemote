/**
 * Shared constants for every PhoneMote process.
 * See ARCHITECTURE.md sections 2, 6 and 7.1.
 */

/** Ports are fixed (ARCHITECTURE.md 2). */
export const PORTS = {
  game: 5173,
  controller: 5174,
  relay: 8443,
} as const;

/**
 * Room code alphabet: no I, O, 0 or 1, so a code read off a screen and typed
 * into a phone cannot be misread.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

/** One game socket and at most this many controllers per room. */
export const MAX_PLAYERS = 4;

/** Slot order is fixed: player 1 gets the first colour (ARCHITECTURE.md 6.1). */
export const PLAYER_COLORS = ['#FF4757', '#3742FA', '#2ED573', '#FFA502'] as const;

/** Button bitmask sent in sensor frame field 12. */
export const BUTTON = {
  A: 1,
  B: 2,
  TRIGGER: 4,
  MINUS: 8,
  PLUS: 16,
  HOME: 32,
} as const;

export type ButtonName = keyof typeof BUTTON;

/**
 * Screen orientation enum carried in sensor frame field 13.
 * The value is derived from `screen.orientation.type`; the normaliser turns it
 * back into a rotation angle (ARCHITECTURE.md 5.5).
 */
export const SCREEN_ORIENTATION = {
  'portrait-primary': 0,
  'landscape-primary': 1,
  'portrait-secondary': 2,
  'landscape-secondary': 3,
} as const;

/** Rotation angle in degrees for each screen orientation enum value. */
export const SCREEN_ORIENTATION_ANGLE = [0, 90, 180, 270] as const;

/** Sensor frame layout: 14 float32 values, little-endian (ARCHITECTURE.md 6.2). */
export const SENSOR_FRAME_FIELDS = 14;
export const SENSOR_FRAME_BYTES = SENSOR_FRAME_FIELDS * 4;

export const SENSOR_FIELD = {
  playerId: 0,
  seq: 1,
  timestamp: 2,
  orientationAlpha: 3,
  orientationBeta: 4,
  orientationGamma: 5,
  rotationRateAlpha: 6,
  rotationRateBeta: 7,
  rotationRateGamma: 8,
  accelerationX: 9,
  accelerationY: 10,
  accelerationZ: 11,
  buttons: 12,
  screenOrientation: 13,
} as const;

/** Phones send at most this often (ARCHITECTURE.md 7.2). */
export const SENSOR_SEND_HZ = 60;
