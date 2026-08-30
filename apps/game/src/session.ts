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
}

type ActionListener = (action: GameAction) => void;
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

  private mapper = new InputMapper();
  private client: GameClient | null = null;
  private pingId = 0;

  room: RoomInfo | null = null;
  connected = false;

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
      onPlayerJoin: (player) => {
        this.playerMap.set(player.id, player);
        this.latency.set(player.id, new LatencyTracker());
        this.quality.set(player.id, new StreamQuality());
        this.emitPlayers();
      },
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

  /** Each scene declares the input modes it wants; state does not leak across. */
  configureInput(config: InputMapperConfig): void {
    this.mapper = new InputMapper(config);
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
    };
  }

  private handleFrame(frame: SensorFrame): void {
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
      for (const listener of this.actionListeners) listener(action);
    }
  }

  private emitPlayers(): void {
    const snapshot = this.players;
    for (const listener of this.playersListeners) listener(snapshot);
  }
}

/** One session per page; scenes import this rather than passing it around. */
export const session = new GameSession();
