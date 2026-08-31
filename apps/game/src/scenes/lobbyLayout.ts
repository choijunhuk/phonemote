/**
 * Where the lobby's game tiles go.
 *
 * Pure arithmetic, no Phaser: the bug this replaces was arithmetic, and finding
 * it needed nothing but numbers.
 *
 * The lobby used to stack tiles in one column at a fixed stride of 96 + 18, so
 * the screen decided nothing and the list simply ran off it: at 720 high, tile
 * six landed at y = 728 and tile nine at y = 1070. Those games could not be
 * selected by pointer or by d-pad, and nothing on screen said they existed. So
 * the shape here follows the number of games and the space available, and every
 * tile is placed inside the band it was given or not at all.
 *
 * Coordinates are tile CENTRES, because that is what a Phaser container and a
 * Phaser rectangle both take.
 */

export interface Tile {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutOptions {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  /** Margins in pixels. Omitted ones leave room for what the lobby already draws. */
  readonly left?: number;
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
}

/** Between tiles, in pixels. The spacing the single-column lobby already used. */
const GAP = 18;

/**
 * How many rows the height can carry.
 *
 * With the default margins at 1280x720 the band is 504 high. Four rows leave
 * 112 per tile; five leave 86. The tile draws a 28px title over a 22px blurb and
 * the lobby sizes it 96 tall, so a fifth row would make the box shorter than the
 * text already inside it.
 */
const MAX_ROWS = 4;

/**
 * How many columns the width can carry.
 *
 * The band is 1126 wide at 1280. Six columns give a 173-wide tile, seven give
 * 146 — under the 150 a game title needs to stay legible from a sofa, which is
 * the distance this screen is read from.
 */
const MAX_COLUMNS = 6;

/**
 * A ceiling on tile height, so few games do not become billboards.
 *
 * One game in a 504-high band would otherwise get a 504-high tile holding two
 * lines of text. Height beyond about this is empty box; the slack becomes margin
 * instead, and the block is centred in the band.
 */
const MAX_TILE_HEIGHT = 160;

/** Default side margin, as a fraction of the canvas width. */
const SIDE_MARGIN = 0.06;
/** Default top margin: the title, the room code and the join line sit above it. */
const TOP_MARGIN = 0.22;
/** Default bottom margin: the hint line sits at the foot of the screen. */
const BOTTOM_MARGIN = 0.08;

/**
 * How wide to make the grid for this many games.
 *
 * The fewest columns that keep the row count inside what the height can carry: a
 * column is read down at a glance, a grid has to be scanned, so the list only
 * widens when it has run out of vertical room. Deliberately independent of the
 * canvas — the tile sizes above are quoted at 1280x720, the resolution the game
 * is designed at, and a lobby whose shape changed with the window would move
 * every target under the player's cursor.
 *
 * Past MAX_ROWS * MAX_COLUMNS = 24 games this can no longer honour both limits
 * and rows start getting thinner. Twenty-five games want a second page, not a
 * smaller tile.
 */
export function columnsFor(count: number): number {
  if (!Number.isFinite(count) || count <= 1) return 1;
  return Math.min(MAX_COLUMNS, Math.ceil(count / MAX_ROWS));
}

export function layoutTiles(options: LayoutOptions): readonly Tile[] {
  const count = Number.isFinite(options.count) ? Math.max(0, Math.floor(options.count)) : 0;
  if (count === 0) return [];

  const left = options.left ?? options.width * SIDE_MARGIN;
  const right = options.right ?? options.width * SIDE_MARGIN;
  const top = options.top ?? options.height * TOP_MARGIN;
  const bottom = options.bottom ?? options.height * BOTTOM_MARGIN;

  const bandWidth = Math.max(0, options.width - left - right);
  const bandHeight = Math.max(0, options.height - top - bottom);

  const columns = columnsFor(count);
  const rows = Math.ceil(count / columns);

  const tileWidth = Math.max(0, (bandWidth - (columns - 1) * GAP) / columns);
  const tileHeight = Math.min(
    MAX_TILE_HEIGHT,
    Math.max(0, (bandHeight - (rows - 1) * GAP) / rows),
  );

  const blockHeight = rows * tileHeight + (rows - 1) * GAP;
  const firstRowTop = top + (bandHeight - blockHeight) / 2;

  const tiles: Tile[] = [];
  for (let index = 0; index < count; index++) {
    const row = Math.floor(index / columns);
    const column = index % columns;

    // The last row is usually short. Centring it keeps the block symmetric, so
    // the odd game out does not read as a mistake, and it costs nothing for the
    // full rows: their width is the whole band, so this puts them at the margin.
    const inRow = Math.min(columns, count - row * columns);
    const rowWidth = inRow * tileWidth + (inRow - 1) * GAP;
    const rowLeft = left + (bandWidth - rowWidth) / 2;

    tiles.push({
      x: rowLeft + column * (tileWidth + GAP) + tileWidth / 2,
      y: firstRowTop + row * (tileHeight + GAP) + tileHeight / 2,
      width: tileWidth,
      height: tileHeight,
    });
  }
  return tiles;
}

/**
 * Where the d-pad sends the focus next.
 *
 * Both axes wrap, for the same reason: the last row is short, so the bottom
 * right of the grid is a corner with two or three directions that would do
 * nothing, and a d-pad that stops silently is indistinguishable from one that is
 * not connected. Wrapping also means every game is reachable by holding one
 * direction, which is how a player who cannot see the layout will find them.
 *
 * Left and right walk the list in reading order rather than staying inside the
 * row: a row of one — count 10 in a grid of three — would otherwise be a dead
 * end in both directions. Up and down move inside the column, skipping to the
 * lowest tile that column actually has, so down and then up is always where you
 * started even when the column is short.
 *
 * `columns` is the caller's, not columnsFor's, so a scene that lays out its own
 * grid still moves through it correctly.
 */
export function moveFocus(
  current: number,
  count: number,
  columns: number,
  direction: 'up' | 'down' | 'left' | 'right',
): number {
  if (!Number.isFinite(count) || count < 1) return 0;
  const total = Math.floor(count);
  const perRow = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
  const index = Number.isFinite(current)
    ? Math.min(total - 1, Math.max(0, Math.floor(current)))
    : 0;

  if (direction === 'right') return (index + 1) % total;
  if (direction === 'left') return (index - 1 + total) % total;

  const column = index % perRow;
  if (direction === 'down') {
    const below = index + perRow;
    // Off the bottom, so back to the top of this column, which always exists:
    // the column index is never past the tile the focus is already on.
    return below < total ? below : column;
  }

  const above = index - perRow;
  if (above >= 0) return above;
  let lowest = column;
  while (lowest + perRow < total) lowest += perRow;
  return lowest;
}
