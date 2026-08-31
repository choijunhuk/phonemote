/**
 * Which player is player 1, and the answer that stops changing.
 *
 * Tennis asked `session.players.findIndex((p) => p.id === playerId)`. That list
 * is rebuilt id-sorted on every roster change and the relay hands a rejoining
 * phone the lowest free slot, so a phone that joins mid-match with an id below
 * everyone else's sorts to the front: it takes seat 1, the player who was in
 * seat 1 slides to seat 2, and whoever was in seat 2 becomes a spectator without
 * anything on screen saying so. freezeState sidestepped the whole question by
 * keying every record by player id, which is right but says nothing about which
 * end of the court somebody is standing at.
 *
 * So a seat is assigned once, from the roster as it stood at match start, and is
 * never derived from the live roster again. An id names a player; a seat is a
 * position in this match; this module is the only place the two meet.
 */

/**
 * 1-based: seat 1 is shown to the room as P1, and an off-by-one between the
 * label and the array index is exactly the kind of quiet mistake this module is
 * meant to remove.
 */
export type Seat = number;

/**
 * Freeze the seating for a match.
 *
 * The order handed in is the seating — the caller decides whether that is join
 * order or anything else, and this makes no attempt to sort it. Sorting here
 * would only invite the caller to call it again later and get a different
 * answer, which is the bug above.
 *
 * A repeated id is seated once. Two seats for one phone means one of them can
 * never be played and the other's score is written twice.
 */
export function assignSeats(playerIds: readonly number[]): readonly number[] {
  const seated: number[] = [];
  for (const playerId of playerIds) {
    if (!seated.includes(playerId)) seated.push(playerId);
  }
  // Frozen because a mid-match roster change must not be able to reach in and
  // reshuffle a match that is already being played.
  return Object.freeze(seated);
}

/**
 * The seat this player holds, or null if they hold none.
 *
 * null is a real answer, not a failure: a phone that connected after the match
 * started is a spectator until the next one. Returning -1 or 0 instead would be
 * silently usable as an index.
 */
export function seatOf(seats: readonly number[], playerId: number): Seat | null {
  const index = seats.indexOf(playerId);
  return index === -1 ? null : index + 1;
}

/** Who is sitting there, or null if that seat does not exist in this match. */
export function playerAt(seats: readonly number[], seat: Seat): number | null {
  const playerId = seats[seat - 1];
  return playerId === undefined ? null : playerId;
}
