/**
 * JSON control messages (ARCHITECTURE.md 6.1).
 *
 * Sensor traffic is binary; everything about joining a room, measuring latency
 * and sending haptics is text.
 */

export type Role = 'game' | 'controller';

export type ClientHello =
  | { type: 'hello'; role: 'game' }
  | {
      type: 'hello';
      role: 'controller';
      roomCode: string;
      name?: string;
      /**
       * Stable per-phone id kept in localStorage. Lets a controller that drops
       * off Wi-Fi come back as the same player instead of taking a new slot.
       */
      clientId?: string;
    };

export type ErrorCode = 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'GAME_LEFT' | 'BAD_MESSAGE';

export type ServerMsg =
  /** To the game: the room it just opened, plus the URL to put in the QR code. */
  | { type: 'room'; roomCode: string; wsUrl: string; controllerUrl: string }
  /** To a controller: which player it became. */
  | { type: 'joined'; playerId: number; color: string; resumed?: boolean }
  | { type: 'player_join'; playerId: number; name: string; color: string; resumed?: boolean }
  | { type: 'player_leave'; playerId: number }
  | { type: 'error'; code: ErrorCode; message: string };

/** game → server → controller; the controller echoes it straight back. */
export interface Ping {
  type: 'ping';
  id: number;
  playerId: number;
}

export interface Pong {
  type: 'pong';
  id: number;
  playerId: number;
}

/** game → server → controller */
export interface Feedback {
  type: 'vibrate';
  playerId: number;
  pattern: number[];
}

export type ClientMsg = ClientHello | Pong | Ping | Feedback;
export type AnyMessage = ClientMsg | ServerMsg;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseMessage(raw: string): AnyMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed['type'] !== 'string') return null;
  return parsed as AnyMessage;
}

export function isClientHello(message: AnyMessage): message is ClientHello {
  if (message.type !== 'hello') return false;
  const role: unknown = (message as { role?: unknown }).role;
  if (role === 'game') return true;
  if (role !== 'controller') return false;
  return typeof (message as { roomCode?: unknown }).roomCode === 'string';
}

export function isPing(message: AnyMessage): message is Ping {
  return (
    message.type === 'ping' &&
    typeof (message as Ping).id === 'number' &&
    typeof (message as Ping).playerId === 'number'
  );
}

export function isPong(message: AnyMessage): message is Pong {
  return (
    message.type === 'pong' &&
    typeof (message as Pong).id === 'number' &&
    typeof (message as Pong).playerId === 'number'
  );
}

export function isFeedback(message: AnyMessage): message is Feedback {
  return (
    message.type === 'vibrate' &&
    typeof (message as Feedback).playerId === 'number' &&
    Array.isArray((message as Feedback).pattern)
  );
}
