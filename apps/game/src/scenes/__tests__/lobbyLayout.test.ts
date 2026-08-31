import { describe, expect, it } from 'vitest';
import { type Tile, columnsFor, layoutTiles, moveFocus } from '../lobbyLayout.js';

/**
 * The lobby is heading for nine or more games, and the single column it used to
 * draw put the sixth tile's centre at y = 728 on a 720-high canvas. These check
 * the two things a player would notice about that: a game that is not on the
 * screen, and a d-pad press that goes nowhere.
 *
 * 1280x720 throughout, the resolution the game is designed at.
 */

const SCREEN = { width: 1280, height: 720 } as const;
/** A band unlike the defaults, to prove the margins are honoured and not baked in. */
const MARGINS = { left: 40, top: 120, right: 40, bottom: 60 } as const;
const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/** Floats, so a tile that lands exactly on the margin must not read as outside it. */
const EPSILON = 1e-6;

function at(tiles: readonly Tile[], index: number): Tile {
  const tile = tiles[index];
  if (tile === undefined) throw new Error(`expected a tile at ${index}`);
  return tile;
}

function overlaps(a: Tile, b: Tile): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width - EPSILON &&
    Math.abs(a.y - b.y) * 2 < a.height + b.height - EPSILON
  );
}

describe('lobby tile layout', () => {
  it('keeps every tile inside the margins it was given, for one game through twelve', () => {
    for (const count of COUNTS) {
      for (const tile of layoutTiles({ ...SCREEN, ...MARGINS, count })) {
        expect(tile.x - tile.width / 2).toBeGreaterThanOrEqual(MARGINS.left - EPSILON);
        expect(tile.x + tile.width / 2).toBeLessThanOrEqual(SCREEN.width - MARGINS.right + EPSILON);
        expect(tile.y - tile.height / 2).toBeGreaterThanOrEqual(MARGINS.top - EPSILON);
        expect(tile.y + tile.height / 2).toBeLessThanOrEqual(
          SCREEN.height - MARGINS.bottom + EPSILON,
        );
      }
    }
  });

  it('keeps every tile on a 720-high screen, where the old single column did not', () => {
    // The formula this replaces put tile six at y = 728 and tile nine at 1070.
    for (const count of COUNTS) {
      for (const tile of layoutTiles({ ...SCREEN, count })) {
        expect(tile.y + tile.height / 2).toBeLessThanOrEqual(SCREEN.height + EPSILON);
        expect(tile.y - tile.height / 2).toBeGreaterThanOrEqual(-EPSILON);
        expect(tile.x + tile.width / 2).toBeLessThanOrEqual(SCREEN.width + EPSILON);
        expect(tile.x - tile.width / 2).toBeGreaterThanOrEqual(-EPSILON);
      }
    }
  });

  it('never lets two tiles overlap', () => {
    for (const count of COUNTS) {
      const tiles = layoutTiles({ ...SCREEN, ...MARGINS, count });
      for (const [i, a] of tiles.entries()) {
        for (const [j, b] of tiles.entries()) {
          if (i >= j) continue;
          expect(overlaps(a, b), `tiles ${i} and ${j} of ${count} overlap`).toBe(false);
        }
      }
    }
  });

  it('keeps every tile big enough to read from across the room', () => {
    for (const count of COUNTS) {
      for (const options of [{ ...SCREEN, count }, { ...SCREEN, ...MARGINS, count }]) {
        for (const tile of layoutTiles(options)) {
          expect(tile.width).toBeGreaterThanOrEqual(150);
          expect(tile.height).toBeGreaterThanOrEqual(70);
        }
      }
    }
  });

  it('gives every game the same size box', () => {
    for (const count of COUNTS) {
      const tiles = layoutTiles({ ...SCREEN, count });
      const first = at(tiles, 0);
      for (const tile of tiles) {
        expect(tile.width).toBeCloseTo(first.width, 6);
        expect(tile.height).toBeCloseTo(first.height, 6);
      }
    }
  });

  it('fills left to right, then top to bottom', () => {
    const columns = columnsFor(12);
    const tiles = layoutTiles({ ...SCREEN, count: 12 });
    for (let index = 1; index < tiles.length; index++) {
      const previous = at(tiles, index - 1);
      const tile = at(tiles, index);
      if (index % columns === 0) {
        expect(tile.y).toBeGreaterThan(previous.y);
        expect(tile.x).toBeLessThan(previous.x);
      } else {
        expect(tile.y).toBeCloseTo(previous.y, 6);
        expect(tile.x).toBeGreaterThan(previous.x);
      }
    }
  });

  it('centres a last row that came up short', () => {
    // Ten games in a grid of three leaves one on its own; it belongs under the
    // middle of the band, not hanging off the left edge.
    const tiles = layoutTiles({ ...SCREEN, ...MARGINS, count: 10 });
    const bandCentre = (MARGINS.left + (SCREEN.width - MARGINS.right)) / 2;
    expect(at(tiles, 9).x).toBeCloseTo(bandCentre, 6);
    // And the middle tile of a full row is still where it always was.
    expect(at(tiles, 7).x).toBeCloseTo(bandCentre, 6);
  });

  it('has nothing to place when there are no games', () => {
    expect(layoutTiles({ ...SCREEN, count: 0 })).toEqual([]);
  });
});

describe('lobby grid shape', () => {
  it('keeps a short list in a single column', () => {
    for (const count of [1, 2, 3, 4]) {
      expect(columnsFor(count)).toBe(1);
    }
  });

  it('adds a column rather than a fifth row', () => {
    expect(columnsFor(5)).toBe(2);
    expect(columnsFor(8)).toBe(2);
    expect(columnsFor(9)).toBe(3);
    expect(columnsFor(12)).toBe(3);
    expect(columnsFor(13)).toBe(4);
  });

  it('stops widening before a tile gets too narrow to read', () => {
    for (const count of [24, 40, 200]) {
      expect(columnsFor(count)).toBe(6);
    }
  });

  it('asks for one column when there is nothing to lay out', () => {
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(-3)).toBe(1);
    expect(columnsFor(Number.NaN)).toBe(1);
  });
});

describe('lobby d-pad focus', () => {
  const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
  /** columnsFor's answer plus grids it would never pick, since callers may pass their own. */
  const COLUMN_COUNTS = [1, 2, 3, 4, 5, 7];

  it('always lands on a real game, from every game, in every direction', () => {
    for (const count of COUNTS) {
      for (const columns of [...COLUMN_COUNTS, columnsFor(count)]) {
        for (let index = 0; index < count; index++) {
          for (const direction of DIRECTIONS) {
            const next = moveFocus(index, count, columns, direction);
            expect(Number.isInteger(next)).toBe(true);
            expect(next).toBeGreaterThanOrEqual(0);
            expect(next).toBeLessThan(count);
          }
        }
      }
    }
  });

  it('comes back where you started when you press right then left', () => {
    for (const count of COUNTS) {
      for (const columns of [...COLUMN_COUNTS, columnsFor(count)]) {
        for (let index = 0; index < count; index++) {
          const right = moveFocus(index, count, columns, 'right');
          expect(moveFocus(right, count, columns, 'left')).toBe(index);
        }
      }
    }
  });

  it('comes back where you started when you press down then up', () => {
    for (const count of COUNTS) {
      for (const columns of [...COLUMN_COUNTS, columnsFor(count)]) {
        for (let index = 0; index < count; index++) {
          const down = moveFocus(index, count, columns, 'down');
          expect(moveFocus(down, count, columns, 'up')).toBe(index);
        }
      }
    }
  });

  it('reaches every game by holding one direction', () => {
    for (const count of COUNTS) {
      const columns = columnsFor(count);
      const seen = new Set<number>();
      let index = 0;
      for (let press = 0; press < count; press++) {
        seen.add(index);
        index = moveFocus(index, count, columns, 'right');
      }
      expect(seen.size).toBe(count);
      expect(index).toBe(0);
    }
  });

  it('moves a whole row at a time when the grid is wide', () => {
    // Twelve games in three columns: down from the top left is the tile below it.
    expect(moveFocus(0, 12, 3, 'down')).toBe(3);
    expect(moveFocus(3, 12, 3, 'up')).toBe(0);
    expect(moveFocus(0, 12, 3, 'right')).toBe(1);
  });

  it('drops to the lowest game a short column actually has', () => {
    // Ten games in three columns: the last row holds index 9 alone, so up from
    // the top of the middle column is 7, not the 10 that is not there.
    expect(moveFocus(1, 10, 3, 'up')).toBe(7);
    expect(moveFocus(7, 10, 3, 'down')).toBe(1);
    expect(moveFocus(0, 10, 3, 'up')).toBe(9);
  });

  it('stays on the only game there is', () => {
    for (const direction of DIRECTIONS) {
      expect(moveFocus(0, 1, 1, direction)).toBe(0);
    }
  });

  it('recovers from a focus that is already off the end', () => {
    // A game removed from the list while its tile was selected.
    for (const direction of DIRECTIONS) {
      expect(moveFocus(99, 3, 1, direction)).toBeLessThan(3);
      expect(moveFocus(-4, 3, 1, direction)).toBeGreaterThanOrEqual(0);
      expect(moveFocus(0, 0, 1, direction)).toBe(0);
    }
  });
});
