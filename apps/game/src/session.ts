import type { SensorFrame } from '@phonemote/protocol';
import { GameClient, type PlayerInfo, type RoomInfo } from './net/client.js';
import { LatencyTracker, StreamQuality, type LatencyStats } from './net/latency.js';
import { InputMapper, type InputMapperConfig } from './input/InputMapper.js';
import type { CanonicalSensorFrame, GameAction } from './input/types.js';

/**
 * The seam between the network and the game.
 *
 * Scenes talk to this and receive GameActions; they never touch a SensorFrame
 * (ARCHITECTURE.md P4). Everything upstream — sockets, decoding, normalising —
 * stops here.
 */

const PING_INTERVAL_MS = 1000;

export interface SwingRecord {
  readonly strength: number;
  readonly direction8: string;
  /** PC clock, so "how long ago" can be shown without touching phone time. */
  readonly at: number;
}

export interface PlayerDebugInfo {
  readonly raw: SensorFrame | null;
  readonly canonical: CanonicalSensorFrame | null;
  readonly fused: CanonicalSensorFrame | null;
  readonly latency: LatencyStats;
  readonly hz: number;
  readonly lossPercent: number;
  /** Counted so the player can compare swings felt against swings detected. */
  readonly swingCount: number;
  readonly lastSwing: SwingRecord | null;
  readonly tilt: { x: number; y: number } | null;
  /**
   * Milliseconds since the phone's sensor values last changed. The phone sends
   * its cached reading 60 times a second whether or not the sensors are still
   * firing, so a healthy stream says nothing about a stalled sensor. This does.
   */
  readonly sensorStaleMs: number;
  /** Strongest |a| seen in the last two seconds, for reading swing strength. */
  readonly accelPeak: number;
}

type ActionListener = (action: GameAction) => void;

export interface SessionError {
  readonly message: string;
  readonly at: number;
}
type PlayersListener = (players: readonly PlayerInfo[]) => void;

export class GameSession {
  private readonly actionListeners = new Set<ActionListener>();
  private readonly playersListeners = new Set<PlayersListener>();
  private readonly playerMap = new Map<number, PlayerInfo>();
  private readonly latency = new Map<number, LatencyTracker>();
  private readonly quality = new Map<number, StreamQuality>();
  private readonly rawFrames = new Map<number, SensorFrame>();
  private readonly swingCounts = new Map<number, number>();
  private readonly lastSwings = new Map<number, SwingRecord>();
  private readonly lastTilt = new Map<number, { x: number; y: number }>();
  private readonly sensorChangedAt = new Map<number, number>();
  private readonly stalledSince = new Map<number, number>();
  private readonly accelHistory = new Map<number, Array<{ at: number; magnitude: number }>>();

  /**
   * One mapper for the life of the session. Rebuilding it per scene threw away
   * the calibration the previous scene had just taken.
   */
  private readonly mapper = new InputMapper();
  private client: GameClient | null = null;
  private pingId = 0;

  room: RoomInfo | null = null;
  connected = false;
  /** Whatever a scene is doing right now, for the debug overlay. */
  status = '';
  lastError: SessionError | null = null;
  /** Newest first. Scenes append; the overlay prints. */
  readonly events: string[] = [];

  get players(): readonly PlayerInfo[] {
    return [...this.playerMap.values()].sort((a, b) => a.id - b.id);
  }

  start(): void {
    if (this.client) return;

    this.client = new GameClient({
      onRoom: (room) => {
        this.room = room;
        this.connected = true;
        this.emitPlayers();
      },
      onPlayerJoin: (player) => this.registerPlayer(player),
      onPlayerLeave: (playerId) => {
        this.playerMap.delete(playerId);
        this.latency.delete(playerId);
        this.quality.delete(playerId);
        this.rawFrames.delete(playerId);
        this.mapper.removePlayer(playerId);
        this.emitPlayers();
      },
      onFrame: (frame) => this.handleFrame(frame),
      onPong: (playerId, id) => {
        this.latency.get(playerId)?.recordPong(id, performance.now());
      },
      onDisconnect: () => {
        this.connected = false;
        this.room = null;
        this.playerMap.clear();
        this.emitPlayers();
      },
    });

    this.client.connect();

    window.setInterval(() => {
      for (const player of this.playerMap.keys()) {
        const id = this.pingId++;
        this.latency.get(player)?.recordSent(id, performance.now());
        this.client?.ping(player, id);
      }
    }, PING_INTERVAL_MS);
  }

  private registerPlayer(player: PlayerInfo): void {
    this.playerMap.set(player.id, player);
    this.latency.set(player.id, new LatencyTracker());
    this.quality.set(player.id, new StreamQuality());
    this.emitPlayers();
  }

  /**
   * Development entry points: a keyboard stand-in and a recorded trace both
   * push frames through the very same pipeline the network uses, so what they
   * exercise is the real thing rather than a parallel implementation.
   */
  addLocalPlayer(player: PlayerInfo): void {
    this.registerPlayer(player);
  }

  injectFrame(frame: SensorFrame): void {
    this.handleFrame(frame);
  }

  /** Each scene declares the input modes it wants. */
  configureInput(config: InputMapperConfig): void {
    this.mapper.setConfig(config);
  }

  requestCalibration(playerId: number): void {
    this.mapper.requestCalibration(playerId);
  }

  vibrate(playerId: number, pattern: number[]): void {
    this.client?.vibrate(playerId, pattern);
  }

  onAction(listener: ActionListener): () => void {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }

  onPlayersChanged(listener: PlayersListener): () => void {
    this.playersListeners.add(listener);
    listener(this.players);
    return () => this.playersListeners.delete(listener);
  }

  debugInfo(playerId: number): PlayerDebugInfo {
    const quality = this.quality.get(playerId);
    return {
      raw: this.rawFrames.get(playerId) ?? null,
      canonical: this.mapper.lastCanonical(playerId),
      fused: this.mapper.lastFused(playerId),
      latency:
        this.latency.get(playerId)?.stats() ??
        ({ samples: 0, medianMs: Number.NaN, p95Ms: Number.NaN, reportable: false } as LatencyStats),
      hz: quality?.hz ?? 0,
      lossPercent: quality?.lossPercent ?? 0,
      swingCount: this.swingCounts.get(playerId) ?? 0,
      lastSwing: this.lastSwings.get(playerId) ?? null,
      tilt: this.lastTilt.get(playerId) ?? null,
      sensorStaleMs: performance.now() - (this.sensorChangedAt.get(playerId) ?? performance.now()),
      accelPeak: (this.accelHistory.get(playerId) ?? []).reduce(
        (peak, sample) => Math.max(peak, sample.magnitude),
        0,
      ),
    };
  }

  private handleFrame(frame: SensorFrame): void {
    const now = performance.now();
    const previous = this.rawFrames.get(frame.playerId);
    // motionSeq is the phone's own event counter, so this is a fact rather than
    // the guess that comparing values for equality used to make.
    if (!previous || previous.motionSeq !== frame.motionSeq) {
      this.sensorChangedAt.set(frame.playerId, now);
      this.stalledSince.delete(frame.playerId);
    } else if (!this.stalledSince.has(frame.playerId)) {
      this.stalledSince.set(frame.playerId, now);
    }

    const magnitude = Math.hypot(
      frame.acceleration.x,
      frame.acceleration.y,
      frame.acceleration.z,
    );
    const history = this.accelHistory.get(frame.playerId) ?? [];
    history.push({ at: now, magnitude });
    while (history.length > 0 && now - (history[0]?.at ?? now) > 2000) history.shift();
    this.accelHistory.set(frame.playerId, history);

    this.rawFrames.set(frame.playerId, frame);
    this.quality.get(frame.playerId)?.record(frame.seq, frame.timestamp);

    for (const action of this.mapper.update(frame)) {
      if (action.kind === 'swing') {
        this.swingCounts.set(action.playerId, (this.swingCounts.get(action.playerId) ?? 0) + 1);
        this.lastSwings.set(action.playerId, {
          strength: action.strength,
          direction8: action.direction8,
          at: performance.now(),
        });
      }
      if (action.kind === 'tilt') this.lastTilt.set(action.playerId, { x: action.x, y: action.y });
      for (const listener of this.actionListeners) {
        // A scene that throws here would otherwise take down the socket
        // handler, and every later frame with it: the stream would still read
        // 60 Hz and 0% loss while nothing on screen ever moved again.
        try {
          listener(action);
        } catch (error) {
          this.reportError(error);
        }
      }
    }
  }

  log(message: string): void {
    this.events.unshift(message);
    if (this.events.length > 6) this.events.pop();
  }

  reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = { message, at: performance.now() };
    console.error('[session]', error);
  }

  private emitPlayers(): void {
    const snapshot = this.players;
    for (const listener of this.playersListeners) listener(snapshot);
  }
}

/** One session per page; scenes import this rather than passing it around. */
export const session = new GameSession();
