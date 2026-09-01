import type Phaser from 'phaser';
import { session } from '../../session.js';
import { BaseGameScene } from './BaseGameScene.js';
import type { GameAction } from '../../input/types.js';
import { sfx } from '../../ui/audio.js';
import {
  bestStops,
  createStatue,
  findRacer,
  ghostProgress,
  readStillness,
  setGhost,
  standings,
  statueConfigFor,
  stepStatue,
  syncRacers,
  type StatueEvent,
  type StatueLight,
  type StatueRacer,
  type StatueState,
} from './statueState.js';

/**
 * Statue Race: shake to run, and be completely still when the light turns red.
 *
 * Every decision is statueState.ts's. This scene feeds it stillness readings,
 * draws what came back and turns its events into sound and vibration
 * (ARCHITECTURE.md 8). It never sees a sensor frame (P4).
 */

/** Where a solo record is kept, so the ghost survives the trip via the lobby. */
const GHOST_KEY = 'statueRaceBestSeconds';

/**
 * The board solo always races on.
 *
 * Any fixed number would do; what matters is that it does not change, because
 * a ghost is only a fair opponent on the pattern its time was set against.
 */
const SOLO_SEED = 20260901;

/**
 * The go pulse, ms.
 *
 * Below 25 ms an Android motor never finishes spinning up and the player feels
 * nothing at all, which is indistinguishable from a phone that has stopped
 * talking to the game.
 */
const GO_PULSE_MS = 45;

/**
 * Why nothing buzzes under a red light.
 *
 * The motor is bolted to the same body the gyroscope sits in, so every pulse is
 * rotation the phone then reports. Under red that reading is the thing being
 * judged, and the 15 deg/s line is far below what a vibrating phone measures:
 * the game would be convicting players of its own buzzing, and in practice it
 * would draw its own buzz into the curve the player is trying to read. Pulses
 * therefore only go out under green, or to a racer who is already frozen and
 * cannot be judged again for 1.2 s.
 */
const CAUGHT_PULSE = [200];
const FINISH_PULSE = [40, 60, 40];

const LIGHT_COLOR: Readonly<Record<StatueLight, number>> = {
  green: 0x2ed573,
  amber: 0xffa502,
  red: 0xff4757,
};

/** The light, said in words as well as colour: a TV across a room is not a lamp. */
const LIGHT_WORD: Readonly<Record<StatueLight, string>> = {
  green: '달려',
  amber: '준비',
  red: '멈춰',
};

const DIM = '#98a0b3';
const RACE_ROW = 92;
const PRACTICE_ROW = 104;

interface Lane {
  readonly container: Phaser.GameObjects.Container;
  /** Race: distance and rate. Practice: the live reading and the line it faces. */
  readonly detail: Phaser.GameObjects.Text;
  /** Practice only: the last attempt and the best three. */
  readonly result: Phaser.GameObjects.Text | null;
  readonly fill: Phaser.GameObjects.Rectangle | null;
  readonly marker: Phaser.GameObjects.Arc | null;
  readonly graph: Phaser.GameObjects.Graphics | null;
  readonly color: number;
}

export class StatueRace extends BaseGameScene {
  private state: StatueState = createStatue();
  private readonly lanes = new Map<number, Lane>();
  private readonly lamps = new Map<StatueLight, Phaser.GameObjects.Arc>();
  /** Player ids this phone has ever sent a reading for. */
  private readonly heard = new Map<number, boolean>();
  private ghostMarker: Phaser.GameObjects.Rectangle | null = null;
  private modeText!: Phaser.GameObjects.Text;
  private headline!: Phaser.GameObjects.Text;
  private waitLine!: Phaser.GameObjects.Text;

  constructor() {
    super('statue-race');
  }

  protected build(): void {
    const { width, height } = this.scale;

    // Phaser restarts a scene by calling create() on the same instance, so a
    // second race would otherwise start on the first one's pattern, with its
    // finished racers and its winner already on screen.
    this.state = createStatue(statueConfigFor(this.mode), this.seedFor());
    this.lanes.clear();
    this.lamps.clear();
    this.heard.clear();
    this.ghostMarker = null;

    this.add
      .text(width / 2, 16, 'STATUE RACE', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        color: '#f1f3f8',
      })
      .setOrigin(0.5, 0);

    this.modeText = this.add.text(18, 18, '', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '22px',
      color: DIM,
    });

    const lights: StatueLight[] = ['green', 'amber', 'red'];
    lights.forEach((light, index) => {
      this.lamps.set(
        light,
        this.add.circle(width / 2 + (index - 1) * 84, 120, 26, LIGHT_COLOR[light]),
      );
    });

    this.headline = this.add
      .text(width / 2, 178, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '56px',
        color: '#f1f3f8',
        align: 'center',
      })
      .setOrigin(0.5, 0);

    this.waitLine = this.add
      .text(width / 2, height - 56, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#c3c9d6',
        align: 'center',
      })
      .setOrigin(0.5, 0);

    this.add
      .text(width / 2, height - 20, 'HOME 또는 ESC: 로비', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '22px',
        color: DIM,
      })
      .setOrigin(0.5, 0);

    // Fires immediately with the roster it already has, which is what builds
    // the lanes the first time.
    this.onCleanup(session.onPlayersChanged(() => this.rebuildLanes()));
  }

  protected override onGameAction(action: GameAction): void {
    if (action.kind === 'stillness') {
      this.heard.set(action.playerId, true);
      // Straight through. Which readings count, and what they mean, is the
      // rules module's business — re-deciding any of it here is how the screen
      // and the score start disagreeing.
      readStillness(this.state, action.playerId, action.rate, action.stalled);
      return;
    }
    if (action.kind === 'button_down' && action.button === 'A' && this.state.phase === 'finish') {
      // restart() re-runs init(), which reads the mode out of the data it is
      // handed. Without passing it, a party rematch would silently become the
      // practice drill.
      this.scene.restart({ mode: this.mode });
    }
  }

  protected override teardown(): void {
    this.lanes.clear();
    this.lamps.clear();
  }

  protected step(dt: number): void {
    const waiting = this.waitingMessage();
    this.showWaiting(waiting);
    // Held rather than run on: the pattern is the same for everyone in the
    // room, so a light that changed while a phone was away is a red the player
    // never saw. Progress, attempts and records are all still in the state
    // when they come back (ARCHITECTURE.md D48).
    if (waiting === null) this.play(stepStatue(this.state, dt));

    if (this.state.phase === 'finish') this.returnToLobbyAfter(10);
    this.render();
  }

  /**
   * Solo alone gets a fixed board.
   *
   * The ghost is only an opponent on the pattern it was recorded against. Party
   * and practice get a new one every time: a room that has heard the same
   * pattern twice starts slowing down before the light, and in practice that
   * anticipation is exactly what the stop time is meant to measure.
   */
  private seedFor(): number {
    return this.mode === 'solo' ? SOLO_SEED : Date.now() % 1_000_000;
  }

  /** Sound and vibration, which are the only things the rules cannot do. */
  private play(events: readonly StatueEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'light':
          this.onLight(event.light);
          break;
        case 'caught':
          sfx.whiff();
          session.vibrate(event.playerId, CAUGHT_PULSE);
          session.log(`잡힘 P${event.playerId} → ${Math.round(event.progress)}`);
          break;
        case 'freed':
          sfx.tick();
          break;
        case 'stopped':
          // Only a personal best is worth a sound: a party of four stopping at
          // every red would otherwise be four blips a light, and the number the
          // practice screen draws is already the answer.
          if (event.best) sfx.tick();
          // The log holds six lines. A four-phone race stops four times a red,
          // which would push everything else in the room off it.
          if (!this.state.config.raced || event.best) {
            session.log(
              `정지 P${event.playerId} ${event.ms} ms (직전 최고 ${Math.round(event.peakRate)}°/s)`,
            );
          }
          break;
        case 'finish':
          if (event.rank === 1) sfx.win();
          else sfx.point();
          session.vibrate(event.playerId, FINISH_PULSE);
          session.log(`완주 P${event.playerId} ${event.rank}위 ${event.seconds.toFixed(1)}초`);
          break;
        case 'record':
          this.storeGhost(event.playerId, event.seconds);
          break;
        default:
          sfx.win();
          break;
      }
    }
  }

  private onLight(light: StatueLight): void {
    if (light === 'green') {
      sfx.hit(1);
      // The go cue is felt, not read: at the moment green comes up the player
      // is holding the phone, not staring at a lamp across the room.
      for (const racer of this.state.racers) {
        if (racer.present) session.vibrate(racer.id, [GO_PULSE_MS]);
      }
      return;
    }
    if (light === 'amber') {
      sfx.tick();
      return;
    }
    sfx.point();
  }

  private storeGhost(playerId: number, seconds: number): void {
    this.registry.set(`${GHOST_KEY}:${playerId}`, seconds);
    sfx.win();
    session.log(`기록 P${playerId} ${seconds.toFixed(1)}초`);
  }

  /**
   * Load the record the ghost runs on, once, before the race starts.
   *
   * Applying one mid-race would move the marker the player is currently
   * chasing, and the finish line would compare the run against a time it was
   * not run against.
   */
  private loadGhost(): void {
    if (!this.state.config.ghost) return;
    if (this.state.ghostSeconds !== null || this.state.phase !== 'countdown') return;
    const first = this.state.racers[0];
    if (!first) return;
    const stored = this.registry.get(`${GHOST_KEY}:${first.id}`) as number | undefined;
    if (stored !== undefined) setGhost(this.state, stored);
  }

  /** Party needs somebody to race; everything else runs with one phone. */
  private requiredPlayers(): number {
    return this.mode === 'party' ? 2 : 1;
  }

  /**
   * What the game cannot proceed without, or null.
   *
   * The second case is this game's version of a grip: a phone that has never
   * sent a reading is one the red light cannot judge, and starting the
   * countdown for it would hand it a caught-or-not verdict from no data at all.
   * It is only checked before the start — a phone going quiet in the middle of
   * a race must not freeze the other three.
   */
  private waitingMessage(): string | null {
    if (session.players.length === 0) return '폰을 연결하세요 (?fake=1 로 키보드 사용)';

    const present = session.presentPlayers.length;
    const needed = this.requiredPlayers();
    if (present < needed) {
      return `폰 ${present}/${needed}대 — 연결을 기다립니다\n진행 상황은 그대로 있습니다`;
    }

    if (this.state.phase === 'countdown') {
      const silent = session.presentPlayers.filter((player) => this.heard.get(player.id) !== true);
      if (silent.length > 0) {
        return (
          `${silent.map((player) => player.name).join(', ')} 폰에서 아직 움직임이 오지 않습니다\n` +
          '폰을 손에 들고 한 번 흔들어 주세요'
        );
      }
    }
    return null;
  }

  private rebuildLanes(): void {
    const players = session.players;
    // Progress, attempts and ranks belong to the state, which keeps everyone it
    // already knows: one phone reconnecting must not restart the room's race.
    syncRacers(
      this.state,
      players.map((player) => ({ id: player.id, present: player.present })),
    );
    this.loadGhost();

    for (const lane of this.lanes.values()) lane.container.destroy();
    this.lanes.clear();
    this.ghostMarker = null;

    const raced = this.state.config.raced;
    const top = this.scale.height * (raced ? 0.34 : 0.3);
    players.forEach((player, index) => {
      const y = top + index * (raced ? RACE_ROW : PRACTICE_ROW) + (raced ? RACE_ROW / 2 : 0);
      this.lanes.set(
        player.id,
        raced
          ? this.buildRaceLane(player.name, player.color, y, index === 0)
          : this.buildPracticeLane(player.name, player.color, y),
      );
    });
  }

  private buildRaceLane(playerName: string, colorHex: string, y: number, first: boolean): Lane {
    const color = Number(`0x${colorHex.slice(1)}`);
    const left = this.trackLeft();
    const width = this.trackWidth();

    const name = this.add.text(18, -22, playerName, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '26px',
      color: colorHex,
    });
    const detail = this.add.text(18, 10, '', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '22px',
      color: DIM,
    });
    const track = this.add.rectangle(left, 0, width, 14, 0x232838).setOrigin(0, 0.5);
    const fill = this.add.rectangle(left, 0, width, 14, color).setOrigin(0, 0.5).setScale(0, 1);
    const line = this.add.rectangle(left + width, 0, 4, 44, 0xf1f3f8);
    const marker = this.add.circle(left, 0, 15, color);

    const parts: Phaser.GameObjects.GameObject[] = [name, detail, track, fill, line, marker];
    if (this.state.config.ghost && first) {
      // A bar rather than a second circle: it is a time, not a player, and two
      // circles on one lane read as two racers.
      this.ghostMarker = this.add.rectangle(left, 0, 7, 38, 0xf1f3f8).setAlpha(0.55);
      parts.push(this.ghostMarker);
    }

    return {
      container: this.add.container(0, y, parts),
      detail,
      result: null,
      fill,
      marker,
      graph: null,
      color,
    };
  }

  /**
   * The practice row: what this player's own arm measured, while it measures it.
   *
   * A player who cannot see the number has no way to tell a late stop from a
   * stop the game never received, and the curve on the right is the reason the
   * number is what it is — a big shake takes longer to fall under the line than
   * a small one, which is the whole lesson the race is built on.
   */
  private buildPracticeLane(playerName: string, colorHex: string, y: number): Lane {
    const color = Number(`0x${colorHex.slice(1)}`);
    const name = this.add.text(18, 0, playerName, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '26px',
      color: colorHex,
    });
    // Placed past the name it was measured for, because names are whatever the
    // player typed on their phone and a fixed column overlaps the long ones.
    const detail = this.add.text(18 + name.width + 24, 2, '', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '22px',
      color: DIM,
    });
    const result = this.add.text(18, 34, '', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '22px',
      color: '#c3c9d6',
    });
    const graph = this.add.graphics();

    return {
      container: this.add.container(0, y, [name, detail, result, graph]),
      detail,
      result,
      fill: null,
      marker: null,
      graph,
      color,
    };
  }

  private trackLeft(): number {
    return this.scale.width * 0.3;
  }

  private trackWidth(): number {
    return this.scale.width * 0.65;
  }

  private trackX(progress: number): number {
    return this.trackLeft() + (progress / this.state.config.trackLength) * this.trackWidth();
  }

  private traceBox(): { readonly x: number; readonly w: number; readonly h: number } {
    return { x: this.scale.width * 0.55, w: this.scale.width * 0.4, h: 78 };
  }

  private render(): void {
    const state = this.state;
    const config = state.config;

    for (const [light, lamp] of this.lamps) {
      const on = state.phase === light;
      lamp.setAlpha(on ? 1 : 0.14).setScale(on ? 1 : 0.78);
    }
    this.headline.setText(this.headlineText()).setColor(this.headlineColor());
    this.modeText.setText(this.modeLines());
    this.waitLine.setText(this.waitText());

    if (this.ghostMarker) {
      const progress = ghostProgress(state);
      this.ghostMarker.setVisible(progress !== null).setX(this.trackX(progress ?? 0));
    }

    for (const [playerId, lane] of this.lanes) {
      const racer = findRacer(state, playerId);
      if (!racer) continue;
      lane.container.setAlpha(racer.present ? 1 : 0.45);
      if (config.raced) this.renderRaceLane(lane, racer);
      else this.renderPracticeLane(lane, racer);
    }

    const rates = state.racers
      .map((racer) => `P${racer.id} ${racer.rate.toFixed(0)}°/s ${Math.round(racer.progress)}`)
      .join(' ');
    session.status =
      `statue-race ${state.phase} ${this.mode}  ${state.clock.toFixed(1)}s  ` +
      `구간 ${state.segment}  ${rates}`;
  }

  private renderRaceLane(lane: Lane, racer: StatueRacer): void {
    const config = this.state.config;
    const progress = racer.progress / config.trackLength;
    lane.fill?.setScale(progress, 1);
    lane.marker?.setX(this.trackX(racer.progress));
    // White while frozen: a marker that only changed colour would be the one
    // thing on the lane a colour-blind player could not read.
    lane.marker?.setFillStyle(racer.frozenFor > 0 ? 0xf1f3f8 : lane.color);

    const bits = [`${Math.round(racer.progress)}/${config.trackLength}`];
    if (!racer.present) bits.push('연결 끊김');
    else if (racer.finishedAt !== null) bits.push(`${racer.rank ?? '?'}위 ${racer.finishedAt.toFixed(1)}초`);
    else if (racer.frozenFor > 0) bits.push(`얼음 ${racer.frozenFor.toFixed(1)}초`);
    else if (racer.stalled) bits.push('신호 없음');
    else bits.push(`${Math.round(racer.rate)}°/s`);
    if (racer.caught > 0) bits.push(`잡힘 ${racer.caught}회`);
    lane.detail.setText(bits.join('  ·  '));
  }

  private renderPracticeLane(lane: Lane, racer: StatueRacer): void {
    const config = this.state.config;
    const line = config.catchRateDegPerSec;
    // One decimal: a hand trying to hold still reads about 3.3 deg/s, and
    // rounded to whole degrees that becomes a 3 that never moves.
    const live = `현재 ${racer.rate.toFixed(1)}°/s   기준선 ${line}°/s`;
    const verdict = !racer.present
      ? '연결 끊김'
      : racer.stalled
        ? '신호 없음'
        : this.state.phase === 'red'
          ? racer.rate > line
            ? '아직 움직임'
            : '멈춤'
          : '';
    lane.detail.setText(verdict === '' ? live : `${live}   ${verdict}`);

    const last = racer.attempts[racer.attempts.length - 1];
    const lastLine =
      last === undefined
        ? '직전 —'
        : last.stopped
          ? `직전 ${last.ms} ms   그때 최고 ${Math.round(last.peakRate)}°/s`
          : `직전 못 멈춤 (${last.ms} ms 동안 계속 움직임)`;
    const best = bestStops(racer, 3);
    const bestLine =
      `최고 ${best.length === 0 ? '—' : best.map((ms) => `${ms} ms`).join(' / ')}` +
      `   시도 ${racer.attempts.length}/${config.attempts}`;
    lane.result?.setText(`${lastLine}\n${bestLine}`);

    if (lane.graph) this.drawTrace(lane.graph, racer, lane.color);
  }

  private drawTrace(
    graph: Phaser.GameObjects.Graphics,
    racer: StatueRacer,
    color: number,
  ): void {
    const state = this.state;
    const config = state.config;
    const box = this.traceBox();
    graph.clear();
    graph.fillStyle(0x171b24, 1).fillRect(box.x, 0, box.w, box.h);

    // Anchored at zero until there is a full window of history, so the first
    // few seconds do not scroll past at a different speed from the rest.
    const newest = Math.max(state.clock, config.traceSeconds);
    const oldest = newest - config.traceSeconds;
    const xFor = (t: number): number => box.x + ((t - oldest) / config.traceSeconds) * box.w;
    // Square root, not linear: on a 0-900 deg/s linear axis the 15 deg/s line
    // sits 1.7% off the floor, where nobody can see which side of it they are
    // on — and which side of it they are on is the entire game.
    const yFor = (rate: number): number => {
      const clamped = Math.min(Math.max(rate, 0), config.maxRateDegPerSec);
      return box.h - Math.sqrt(clamped / config.maxRateDegPerSec) * box.h;
    };

    if (state.phase === 'red') {
      const from = Math.max(box.x, xFor(state.clock - state.redElapsed));
      graph.fillStyle(LIGHT_COLOR.red, 0.16).fillRect(from, 0, box.x + box.w - from, box.h);
    }

    const threshold = yFor(config.catchRateDegPerSec);
    graph.lineStyle(2, LIGHT_COLOR.red, 0.9);
    graph.lineBetween(box.x, threshold, box.x + box.w, threshold);

    const samples = racer.trace.filter((sample) => sample.t >= oldest);
    if (samples.length < 2) return;
    graph.lineStyle(3, color, 1);
    graph.beginPath();
    samples.forEach((sample, index) => {
      const x = xFor(sample.t);
      const y = yFor(sample.rate);
      if (index === 0) graph.moveTo(x, y);
      else graph.lineTo(x, y);
    });
    graph.strokePath();
  }

  private headlineText(): string {
    const state = this.state;
    switch (state.phase) {
      case 'countdown':
        return `${Math.max(1, Math.ceil(state.timer))}`;
      case 'finish':
        return this.finishText();
      default:
        return LIGHT_WORD[state.phase];
    }
  }

  private headlineColor(): string {
    switch (this.state.phase) {
      case 'green':
        return '#2ed573';
      case 'amber':
        return '#ffa502';
      case 'red':
        return '#ff4757';
      default:
        return '#f1f3f8';
    }
  }

  private finishText(): string {
    const state = this.state;
    if (!state.config.raced) return '연습 끝';

    const winner = standings(state).find((racer) => racer.rank !== null);
    if (!winner) return '완주자 없음';
    const seconds = winner.finishedAt ?? state.clock;
    if (this.mode !== 'solo') return `${this.nameOf(winner.id)} 승리`;
    // ghostSeconds is still the record this run was raced against: the new one
    // is only written to the registry, never applied mid-race.
    return state.ghostSeconds === null || seconds <= state.ghostSeconds
      ? `${seconds.toFixed(1)}초 — 최고 기록`
      : `${seconds.toFixed(1)}초 (최고 ${state.ghostSeconds.toFixed(1)}초)`;
  }

  private modeLines(): string {
    const config = this.state.config;
    if (!config.raced) {
      return (
        `멈추기 연습 — 빨간불에 ${config.catchRateDegPerSec}°/s 아래로 내려가기까지 걸린 시간\n` +
        `그래프: 최근 ${config.traceSeconds}초의 회전 속도, 빨간 가로선이 기준선`
      );
    }
    if (this.mode !== 'solo') return `다 같이 — ${session.presentPlayers.length}대`;
    return this.state.ghostSeconds === null
      ? '혼자 — 이번 기록이 다음 판의 고스트가 됩니다'
      : `혼자 — 고스트 ${this.state.ghostSeconds.toFixed(1)}초`;
  }

  /**
   * The one line that always says what the game is waiting for.
   *
   * Being told "waiting for P3" beats a screen that has simply stopped, and
   * under red it is the only place the number the player has to beat is
   * written out.
   */
  private waitText(): string {
    const waiting = this.waitingMessage();
    if (waiting !== null) return waiting.replace('\n', ' — ');

    const config = this.state.config;
    const absent = session.players.filter((player) => !player.present);
    const note =
      absent.length === 0
        ? ''
        : `   ·   ${absent.map((player) => player.name).join(', ')} 연결 끊김 (기록 유지)`;

    switch (this.state.phase) {
      case 'countdown':
        return `초록불이 켜지면 폰을 흔드세요${note}`;
      case 'green':
        return config.raced
          ? `초록불 — 세게 흔들수록 빨리 갑니다${note}`
          : `초록불 — 마음껏 흔드세요${note}`;
      case 'amber':
        return `노란불 — 곧 빨간불입니다, 지금 팔을 줄이세요${note}`;
      case 'red':
        return `빨간불 — ${config.catchRateDegPerSec}°/s 아래로 멈추세요${note}`;
      default:
        return `A: 다시   ·   10초 뒤 로비로 돌아갑니다${note}`;
    }
  }

  private nameOf(playerId: number): string {
    return session.players.find((player) => player.id === playerId)?.name ?? `P${playerId}`;
  }
}
