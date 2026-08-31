import { describe, expect, it } from 'vitest';
import { assignSeats, playerAt, seatOf } from '../seats.js';

/**
 * The roster a scene hands in comes from session.players, which is rebuilt
 * id-sorted on every roster change. These tests sort the same way, so the
 * mid-match join below is the one that actually happens in a room.
 */
function roster(...playerIds: number[]): readonly number[] {
  return [...playerIds].sort((a, b) => a - b);
}

describe('assigning seats', () => {
  it('seats the roster in the order the match started with', () => {
    const seats = assignSeats(roster(9, 4));

    expect(seatOf(seats, 4)).toBe(1);
    expect(seatOf(seats, 9)).toBe(2);
    expect(playerAt(seats, 1)).toBe(4);
    expect(playerAt(seats, 2)).toBe(9);
  });

  it('takes the caller at their word instead of sorting behind their back', () => {
    const seats = assignSeats([9, 4]);

    expect(seatOf(seats, 9)).toBe(1);
    expect(seatOf(seats, 4)).toBe(2);
  });

  it('gives a player who appears twice a single seat', () => {
    const seats = assignSeats([4, 9, 4]);

    expect(seats).toEqual([4, 9]);
    expect(seatOf(seats, 4)).toBe(1);
  });

  it('cannot be rewritten once the match is under way', () => {
    expect(Object.isFrozen(assignSeats([4, 9]))).toBe(true);
  });
});

describe('a phone that joins mid-match', () => {
  it('does not push the players who were already here out of their seats', () => {
    const seats = assignSeats(roster(4, 9));
    expect(seatOf(seats, 4)).toBe(1);
    expect(seatOf(seats, 9)).toBe(2);

    // A third phone connects during the match and the relay hands it the lowest
    // free slot, so it sorts in front of both players who are already playing.
    const joined = roster(2, 4, 9);

    // What Tennis answered: player 4 slides from the left of the court to the
    // right, and player 9 falls off the end and becomes a spectator mid-rally.
    expect(joined.findIndex((playerId) => playerId === 4)).toBe(1);
    expect(joined.findIndex((playerId) => playerId === 9)).toBe(2);

    expect(seatOf(seats, 4)).toBe(1);
    expect(seatOf(seats, 9)).toBe(2);
    expect(playerAt(seats, 1)).toBe(4);
    expect(playerAt(seats, 2)).toBe(9);
  });

  it('is a spectator rather than the new player 1', () => {
    const seats = assignSeats(roster(4, 9));

    expect(seatOf(seats, 2)).toBe(null);
    expect(playerAt(seats, 3)).toBe(null);
  });
});

describe('reading a seating', () => {
  it('has nobody in seat 0, which is the index, not a seat', () => {
    const seats = assignSeats([4, 9]);

    expect(playerAt(seats, 0)).toBe(null);
    expect(playerAt(seats, -1)).toBe(null);
  });

  it('answers null for every question about an empty match', () => {
    const seats = assignSeats([]);

    expect(seatOf(seats, 4)).toBe(null);
    expect(playerAt(seats, 1)).toBe(null);
  });
});
