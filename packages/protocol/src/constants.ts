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

/** Sensor frame layout: little-endian float32 (ARCHITECTURE.md 6.2). */
export const SENSOR_FRAME_VERSION = 2;
export const SENSOR_FRAME_FIELDS = 17;
export const SENSOR_FRAME_BYTES = SENSOR_FRAME_FIELDS * 4;

/** v1 frames still exist in recorded traces and decode with defaults. */
export const SENSOR_FRAME_FIELDS_V1 = 14;
export const SENSOR_FRAME_BYTES_V1 = SENSOR_FRAME_FIELDS_V1 * 4;

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
  version: 14,
  motionSeq: 15,
  flags: 16,
} as const;

/**
 * What the phone can actually supply. A device with no gravity-excluded
 * acceleration can never trigger a swing, and that has to be visible rather
 * than looking like a detector that simply never fires.
 */
export const SENSOR_FLAG = {
  LINEAR_ACCEL: 1,
  ROTATION_RATE: 2,
  ORIENTATION: 4,
  /** The player declared the hold direction instead of trusting the OS. */
  HOLD_OVERRIDE: 8,
} as const;

/**
 * Frames are sent from the devicemotion event, so the phone's sensor decides
 * the rate. This cap only exists to stop a 120 Hz device from doubling the
 * traffic for nothing.
 */
export const SENSOR_MAX_SEND_HZ = 100;

/** A sensor that has not ticked in this long is treated as stalled. */
export const SENSOR_STALL_MS = 150;

/**
 * A controller that disappears keeps its slot this long, so a Wi-Fi blip or a
 * screen lock does not turn the player into a new one (ARCHITECTURE.md 11).
 */
export const REJOIN_GRACE_MS = 10_000;

/** Socket-level heartbeat: no reply within two beats and the socket is dead. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
