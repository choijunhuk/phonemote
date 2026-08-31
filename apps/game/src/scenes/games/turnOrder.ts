/**
 * Whose turn it is.
 *
 * Bowling is ten frames and golf is nine holes, and nothing in the repo
 * supported turns at all, so tennisState grew its own: a `server: Side`, a
 * 'not-your-turn' miss reason, and a three second auto-serve so that a serve
 * nobody took could not freeze the match. Six more games would have meant six
 * more private versions of that. The two lessons worth keeping are here — a
 * player who is not there is skipped rather than waited for, and a turn nobody
 * takes ends by itself.
 *
 * The playing order is seeded from the seating (seats.ts) but is a copy of it.
 * Golf re-sorts who plays next after every stroke, and sorting the seating array
 * itself would move players between seats, which is exactly what seats.ts exists
 * to prevent: seat numbers and score cards stay put while the order of play
 * changes underneath them.
 */

export interface TurnOrder {
  /**
   * Player ids in playing order, which starts as the seating and is re-permuted
   * by `reorder`. Not the seating itself — ask seats.ts for seat numbers.
   */
  seats: readonly number[];
  /** Position in `seats` that is on turn. */
  index: number;
  /** Seconds the current turn has gone untaken. */
  elapsed: number;
  readonly timeoutSeconds: number;
  /**
   * Players whose phone dropped out. They keep their position and their score;
   * the order steps over them until they come back.
   */
  absent: readonly number[];
}

export type TurnEvent =
  | { readonly kind: 'turn_changed'; readonly playerId: number }
  | { readonly kind: 'turn_timed_out'; readonly playerId: number }
  | { readonly kind: 'order_empty' };

/**
 * How long a turn may go untaken before it is given up on.
 *
 * The same failure AUTO_SERVE_SECONDS answers in tennis: a phone put down, or
 * one whose disconnect nobody reported, leaves the room in front of a game that
 * will never move again. Three seconds is right for a serve and wrong for a
 * turn — a bowling frame includes picking the phone up, standing up and aiming,
 * and a turn that expires under a player who is still getting ready is worse
 * than one that hangs. A minute never fires on somebody who is actually playing.
 *
 * Counted in seconds off `dtSeconds`, never in frames: the traces are a 20 Hz
 * poll, the phone's own rate is unknown, and a frame count would mean a
 * different timeout on every device.
 */
export const DEFAULT_TURN_SECONDS = 60;

export function createTurnOrder(
  seats: readonly number[],
  timeoutSeconds = DEFAULT_TURN_SECONDS,
): TurnOrder {
  return {
    seats: Object.freeze([...seats]),
    index: 0,
    elapsed: 0,
    timeoutSeconds,
    absent: [],
  };
}

/**
 * Who may play right now, or null if nobody can.
 *
 * An order parked on an absent player is how "everybody dropped out" is
 * recorded, so that reads as no current player rather than as a turn belonging
 * to a phone that is not there.
 */
export function currentPlayer(order: TurnOrder): number | null {
  const playerId = order.seats[order.index];
  if (playerId === undefined) return null;
  return order.absent.includes(playerId) ? null : playerId;
}

interface Position {
  readonly index: number;
  readonly playerId: number;
}

/** The next position holding a player who is here, wrapping, or null if none is. */
function nextPresent(order: TurnOrder, from: number): Position | null {
  const count = order.seats.length;
  for (let step = 0; step < count; step++) {
    const index = (from + step) % count;
    const playerId = order.seats[index];
    if (playerId !== undefined && !order.absent.includes(playerId)) return { index, playerId };
  }
  return null;
}

/**
 * End the current turn and hand play to the next player who is here.
 *
 * The event is emitted even when it lands on the same player, because with one
 * player left every turn is theirs and a caller that redraws on turn_changed
 * would otherwise never redraw again.
 */
export function advance(order: TurnOrder): TurnEvent[] {
  const next = nextPresent(order, order.index + 1);
  // Nobody to hand it to. The order said so when it emptied, and repeating it on
  // every call is the spinning this is meant to avoid.
  if (next === null) return [];

  order.index = next.index;
  order.elapsed = 0;
  return [{ kind: 'turn_changed', playerId: next.playerId }];
}

/**
 * Re-sort the playing order. Lowest rank plays first — golf ranks by minus the
 * distance to the hole, so the ball furthest out plays next.
 *
 * Whose turn it is survives the sort. This is called between strokes, and the
 * player it is called during is still holding the phone.
 */
export function reorder(order: TurnOrder, rank: (playerId: number) => number): void {
  const onTurn = order.seats[order.index];
  // Ranked once per player: a comparator that called `rank` itself would call it
  // O(n log n) times, and sort by an answer that may have moved in between.
  const ranked = order.seats.map((playerId, index) => ({ playerId, index, rank: rank(playerId) }));
  // Ties keep the order they already had. Ties are the normal case at the start
  // of a hole, and a room whose play order reshuffles for no visible reason
  // looks broken.
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);

  order.seats = Object.freeze(ranked.map((entry) => entry.playerId));
  // Following the player rather than the position also keeps an emptied order
  // parked on the same absent player, so its emptiness is not reported twice.
  order.index = onTurn === undefined ? 0 : order.seats.indexOf(onTurn);
}

/**
 * Mark a player's phone as gone, or back.
 *
 * Going absent mid-turn passes the turn on at once: waiting out the timeout for
 * a phone that has already said it is leaving is a minute of nothing. Going
 * absent at any other time changes nothing visible — the order steps over them
 * when it reaches them, and their position and score are untouched.
 *
 * order_empty is emitted the moment the last player leaves and not again, which
 * is what the parked index records: that it has already been said.
 */
export function setAbsent(order: TurnOrder, playerId: number, absent: boolean): TurnEvent[] {
  if (!order.seats.includes(playerId)) return [];
  if (order.absent.includes(playerId) === absent) return [];

  const before = currentPlayer(order);
  order.absent = absent
    ? [...order.absent, playerId]
    : order.absent.filter((id) => id !== playerId);

  if (absent) {
    if (before !== playerId) return [];
    const next = nextPresent(order, order.index + 1);
    if (next === null) return [{ kind: 'order_empty' }];
    order.index = next.index;
    order.elapsed = 0;
    return [{ kind: 'turn_changed', playerId: next.playerId }];
  }

  // Somebody else is mid-turn, so the returning player waits their place.
  if (before !== null) return [];

  // The order was parked with nobody in it. Whoever reconnects first plays, and
  // a player who dropped during their own turn gets that turn back rather than
  // losing it to the reconnect.
  order.index = order.seats.indexOf(playerId);
  order.elapsed = 0;
  return [{ kind: 'turn_changed', playerId }];
}

/**
 * One frame of the shot clock.
 *
 * A parked order has nobody to time out and has already reported itself empty,
 * so it ticks in silence.
 */
export function tickTurn(order: TurnOrder, dtSeconds: number): TurnEvent[] {
  const playerId = currentPlayer(order);
  if (playerId === null) return [];

  order.elapsed += dtSeconds;
  if (order.elapsed < order.timeoutSeconds) return [];

  // advance resets elapsed, which is what keeps this from firing again on the
  // very next tick.
  return [{ kind: 'turn_timed_out', playerId }, ...advance(order)];
}
