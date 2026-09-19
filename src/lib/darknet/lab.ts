/**
 * Darknet Labyrinth Walker (pure maze logic)
 *
 * `src/DarkNet/effects/labyrinth.ts` (game source, tag v3.0.1) generates the
 * maze as `string[]` rows, indexed `maze[y][x]`, where `"█"` is a wall and
 * `" "` (a single space) is an open corridor cell — confirmed from the
 * `WALL`/`PATH` constants there. Corridors sit on odd `(x, y)`; a move jumps
 * two cells, and the single cell between origin and destination (the
 * "connector") is the wall check `handleLabyrinthPassword` performs.
 *
 * `getSurroundingsVisualized(maze, x, y, range, showPlayer, showEnd)` builds
 * the ASCII views this module parses: rows run top-to-bottom as `y` grows
 * (north = lower `y` = earlier row), columns run left-to-right as `x` grows.
 * `ns.dnet.authenticate` returns a 3x3 view (`range = 1`) centered on
 * wherever the player ends up — the *new* position on a successful move, the
 * *unchanged* position on a blocked one — with `@` always at the center.
 * `ns.dnet.labradar` returns a 7x7 view (`range = 3`) in `message` (not
 * `data`), also centered on the player, with `X` marking the exit when it is
 * within range.
 *
 * Zero `ns` imports — safe to import from anything, including scripts that
 * replicate across the darknet (see `DNET_BUNDLE` in `/lib/darknet/protocol`).
 *
 * Import with: import { ... } from "/lib/darknet/lab";
 */

/** The four cardinal move directions `ns.dnet.authenticate` accepts (full words). */
export type Dir = "north" | "east" | "south" | "west";

/** Open-corridor character in the game's maze rows (`PATH` in `labyrinth.ts`). */
export const PATH = " ";
/** Wall character in the game's maze rows (`WALL` in `labyrinth.ts`). */
export const WALL = "█";

const ALL_DIRS: Dir[] = ["east", "south", "west", "north"];

const DELTA: Record<Dir, [number, number]> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
};

function key(pos: [number, number]): string {
  return `${pos[0]},${pos[1]}`;
}

function unkey(k: string): [number, number] {
  const [x, y] = k.split(",").map(Number);
  return [x, y];
}

/** Step one or two cells from `pos` in `dir` ("dir" moves are always two cells; one cell reaches the connector between them). */
function step(pos: [number, number], dir: Dir, n: 1 | 2): [number, number] {
  const [dx, dy] = DELTA[dir];
  return [pos[0] + dx * n, pos[1] + dy * n];
}

/** Parsed openness of the four cells immediately adjacent to the view's center. */
export interface ViewResult {
  north: boolean;
  east: boolean;
  south: boolean;
  west: boolean;
}

/**
 * Parse a 3x3 `getSurroundingsVisualized` view (the `data` field of an
 * `authenticate` result). Ragged or short lines are treated defensively: a
 * missing character reads as a wall, never as open.
 */
export function parseView(data: string): ViewResult {
  const lines = data.split("\n");
  const charAt = (row: number, col: number): string | undefined => lines[row]?.[col];
  return {
    north: charAt(0, 1) === PATH,
    east: charAt(1, 2) === PATH,
    south: charAt(2, 1) === PATH,
    west: charAt(1, 0) === PATH,
  };
}

/**
 * Extract the `X,Y` position from an `authenticate` result message — either
 * `"You have moved to X,Y."` (success) or `"You cannot go that way. You are
 * still at X,Y."` (blocked). Returns null when the message matches neither
 * form.
 */
export function parsePosition(message: string): [number, number] | null {
  const m = message.match(/(?:moved to|still at)\s+(-?\d+)\s*,\s*(-?\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** `labradar`'s parsed 7x7 view: `@` and `X` located in view-local (col, row) coordinates. */
export interface RadarResult {
  player: [number, number];
  exit: [number, number] | null;
}

/**
 * Parse a `labradar` result's `message` (a 7x7 `getSurroundingsVisualized`
 * view, not `data`). Coordinates are view-local — column (x-ish) then row
 * (y-ish), matching `getSurroundingsVisualized`'s row-per-`y`, char-per-`x`
 * layout — not absolute maze coordinates; the caller combines them with its
 * own known absolute position. `exit` is null when no `X` appears (exit out
 * of range).
 */
export function parseRadar(message: string): RadarResult {
  const lines = message.split("\n");
  let player: [number, number] = [3, 3];
  let exit: [number, number] | null = null;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    for (let col = 0; col < line.length; col++) {
      const c = line[col];
      if (c === "@") player = [col, row];
      else if (c === "X") exit = [col, row];
    }
  }
  return { player, exit };
}

/**
 * The four flavour messages `handleLabyrinthPassword` returns when the
 * player's charisma is below the lab's requirement (game source, tag v3.0.1).
 * Every move fails while this holds, with no `data` field.
 */
const CHARISMA_GAP_MESSAGES = [
  "You find yourself lost and confused. You need to be more charismatic to navigate the labyrinth.",
  "You stumble in the dark. You need more moxie to find your way.",
  "You feel the walls closing in. You need to be more charming to escape.",
  "You are unable to make any progress. You need more charisma to find the secret.",
];

/**
 * True when an `authenticate` result is the charisma-gate failure.
 *
 * NOT detectable via `code`: `handleLabyrinthPassword` sets `code:
 * NotEnoughCharisma` (451) on its own response, but `getAuthResult`
 * (`src/DarkNet/effects/authentication.ts`) collapses that into its own
 * `result.code`, which is only ever 200 or 401 (`response.code ===
 * ResponseCodeEnum.Success ? 200 : 401`) — and `ns.dnet.authenticate`'s
 * labyrinth branch (`src/NetscriptFunctions/Darknet.ts`) returns that
 * collapsed `result.code`, not the original 451. The message is the only
 * surviving signal.
 */
export function isCharismaGap(res: { success: boolean; message: string }): boolean {
  return !res.success && CHARISMA_GAP_MESSAGES.includes(res.message);
}

/**
 * Sparse, unbounded knowledge of the maze, keyed `"x,y"`. Both corridor
 * cells (odd, odd — places the player can stand) and connector cells (one
 * even coordinate — the single-cell gap a move steps through) share this key
 * space; a cell absent from both sets is unknown.
 */
export interface Explored {
  open: Set<string>;
  walls: Set<string>;
}

/** A fresh, empty explored grid. */
export function emptyExplored(): Explored {
  return { open: new Set(), walls: new Set() };
}

function markOpen(explored: Explored, pos: [number, number]): void {
  const k = key(pos);
  explored.open.add(k);
  explored.walls.delete(k);
}

function markWall(explored: Explored, pos: [number, number]): void {
  const k = key(pos);
  explored.walls.add(k);
  explored.open.delete(k);
}

/**
 * Serialize the explored grid to rows of `"#"` (wall) / `"."` (open) /
 * `"?"` (unknown), suitable for a `lab` report's `grid` field. The bounding
 * box defaults to the smallest rectangle covering every known cell
 * (0-indexed); pass `cols`/`rows` to pad or crop to a fixed size.
 */
export function serializeGrid(explored: Explored, cols?: number, rows?: number): string[] {
  let maxX = 0;
  let maxY = 0;
  for (const k of explored.open) {
    const [x, y] = unkey(k);
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  for (const k of explored.walls) {
    const [x, y] = unkey(k);
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const width = cols ?? maxX + 1;
  const height = rows ?? maxY + 1;
  const out: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const k = `${x},${y}`;
      if (explored.open.has(k)) row += ".";
      else if (explored.walls.has(k)) row += "#";
      else row += "?";
    }
    out.push(row);
  }
  return out;
}

/** Inverse of `serializeGrid`; `"?"` (or any other/missing character) stays unknown. */
export function deserializeGrid(rows: string[]): Explored {
  const explored = emptyExplored();
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === ".") explored.open.add(`${x},${y}`);
      else if (c === "#") explored.walls.add(`${x},${y}`);
    }
  }
  return explored;
}

/**
 * Record one direction's openness from `from` into `explored`, and return
 * where that leaves the walker: `from` moved two cells in `dir` when
 * `view[dir]` is open, or `from` unchanged (with the connector cell marked a
 * wall) when it isn't.
 *
 * `view` must describe the surroundings *at* `from` (i.e. a view centered on
 * `from`, as `getSurroundingsVisualized`/`parseView` produce it before the
 * move). A blocked `authenticate` response is centered on the unchanged
 * position, so its view already satisfies this directly. A successful
 * response's view is centered on the *new* position instead — reusable here
 * by calling `applyMove` once per direction with `from` set to that new,
 * ground-truth position (from `parsePosition`) and that same view, which
 * ingests all four of its neighbouring walls in one shot (see
 * `docs/design/2026-09-19-darknet.md` Section 7: "each step ... reveals the
 * four neighbouring walls").
 */
export function applyMove(explored: Explored, from: [number, number], dir: Dir, view: ViewResult): [number, number] {
  markOpen(explored, from);
  const connector = step(from, dir, 1);
  if (!view[dir]) {
    markWall(explored, connector);
    return from;
  }
  markOpen(explored, connector);
  const to = step(from, dir, 2);
  markOpen(explored, to);
  return to;
}

/** True when the connector one cell from `pos` in `dir` is neither a known wall nor already known open. */
function isUnknown(explored: Explored, pos: [number, number], dir: Dir): boolean {
  const k = key(step(pos, dir, 1));
  return !explored.walls.has(k) && !explored.open.has(k);
}

/** True when the connector one cell from `pos` in `dir`, and the corridor two cells away, are both known open. */
function isKnownEdge(explored: Explored, pos: [number, number], dir: Dir): boolean {
  return explored.open.has(key(step(pos, dir, 1))) && explored.open.has(key(step(pos, dir, 2)));
}

/**
 * Direction preference order: the default is "increasing x then y" (biased
 * toward the bottom-right corner, where the exit sits unless the lab offsets
 * start/end). When `bias` is given (a spotted-but-not-yet-connected exit),
 * prefer whichever axis closes more distance first.
 */
function biasOrder(pos: [number, number], bias: [number, number] | null): Dir[] {
  if (!bias) return ALL_DIRS;
  const dx = bias[0] - pos[0];
  const dy = bias[1] - pos[1];
  const xDir: Dir = dx >= 0 ? "east" : "west";
  const yDir: Dir = dy >= 0 ? "south" : "north";
  const primary = Math.abs(dx) >= Math.abs(dy) ? [xDir, yDir] : [yDir, xDir];
  const rest = ALL_DIRS.filter((d) => d !== primary[0] && d !== primary[1]);
  return [...primary, ...rest];
}

/**
 * Depth-first exploration driven entirely by `explored` (no separate call
 * stack): step into an unknown neighbour when one exists in bias order;
 * otherwise BFS over the known-open graph to the nearest cell that still has
 * an unknown neighbour ("backtrack"), and take the first step there. Returns
 * null when nothing reachable remains unexplored.
 */
function exploreFrom(explored: Explored, pos: [number, number], bias: [number, number] | null): Dir | null {
  const order = biasOrder(pos, bias);

  for (const dir of order) {
    if (isUnknown(explored, pos, dir)) return dir;
  }

  const startKey = key(pos);
  const visited = new Set<string>([startKey]);
  const queue: { at: [number, number]; first: Dir }[] = [];
  for (const dir of order) {
    if (!isKnownEdge(explored, pos, dir)) continue;
    const next = step(pos, dir, 2);
    const nk = key(next);
    if (visited.has(nk)) continue;
    visited.add(nk);
    queue.push({ at: next, first: dir });
  }

  let i = 0;
  while (i < queue.length) {
    const { at, first } = queue[i++];
    if (order.some((dir) => isUnknown(explored, at, dir))) return first;
    for (const dir of order) {
      if (!isKnownEdge(explored, at, dir)) continue;
      const next = step(at, dir, 2);
      const nk = key(next);
      if (visited.has(nk)) continue;
      visited.add(nk);
      queue.push({ at: next, first });
    }
  }

  return null;
}

/**
 * BFS over the known-open graph (edges = a connector cell in `explored.open`
 * with both endpoints in `explored.open`) from `from` to `to`. Returns the
 * shortest direction sequence, `[]` when already there, or null when `to`
 * isn't reachable through cells the walker has actually confirmed open.
 */
export function shortestPath(explored: Explored, from: [number, number], to: [number, number]): Dir[] | null {
  if (from[0] === to[0] && from[1] === to[1]) return [];
  const targetKey = key(to);
  const visited = new Set<string>([key(from)]);
  const queue: { at: [number, number]; path: Dir[] }[] = [{ at: from, path: [] }];

  let i = 0;
  while (i < queue.length) {
    const { at, path } = queue[i++];
    for (const dir of ALL_DIRS) {
      if (!isKnownEdge(explored, at, dir)) continue;
      const next = step(at, dir, 2);
      const nk = key(next);
      if (visited.has(nk)) continue;
      visited.add(nk);
      const nextPath = [...path, dir];
      if (nk === targetKey) return nextPath;
      queue.push({ at: next, path: nextPath });
    }
  }
  return null;
}

/**
 * Pick the next move. With a `target` (a located exit), take the first step
 * of the shortest known-open path there; if the target isn't connected to
 * `pos` through confirmed-open cells yet, keep exploring but biased toward
 * it instead of the default bottom-right bias. Without a `target`, explore
 * depth-first biased toward increasing x then y. Never steps into a cell
 * whose connector is a known wall. Returns null when there is nowhere left
 * to go (fully explored with no path to `target`, or already there).
 */
export function nextMove(explored: Explored, pos: [number, number], target: [number, number] | null): Dir | null {
  if (target) {
    if (pos[0] === target[0] && pos[1] === target[1]) return null;
    const path = shortestPath(explored, pos, target);
    if (path && path.length > 0) return path[0];
    return exploreFrom(explored, pos, target);
  }
  return exploreFrom(explored, pos, null);
}

/** Largest known `x`/`y` across both sets — used by callers that need a rough sense of how much maze is known so far (e.g. "am I in the explored bottom-right quadrant"). */
export function boundingBox(explored: Explored): { maxX: number; maxY: number } {
  let maxX = 0;
  let maxY = 0;
  for (const k of explored.open) {
    const [x, y] = unkey(k);
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  for (const k of explored.walls) {
    const [x, y] = unkey(k);
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { maxX, maxY };
}

/** All four cardinal directions, in a fixed order (currently east, south, west, north). */
export function allDirs(): Dir[] {
  return [...ALL_DIRS];
}
