import { describe, it, expect } from "vitest";
import {
  Dir,
  Explored,
  PATH,
  WALL,
  applyMove,
  deserializeGrid,
  emptyExplored,
  isCharismaGap,
  nextMove,
  parsePosition,
  parseRadar,
  parseView,
  serializeGrid,
  shortestPath,
} from "/lib/darknet/lab";

// --- generateMaze, ported verbatim (it's pure) from the game checkout's ---
// --- src/DarkNet/effects/labyrinth.ts (tag v3.0.1), so the end-to-end   ---
// --- test below runs against a real maze layout, not a hand-built one. ---

const NORTH = [0, -1];
const EAST = [1, 0];
const SOUTH = [0, 1];
const WEST = [-1, 0];

const MULTI_MAZE_THRESHOLD = 5;

function mazeMaker(setWidth: number, setHeight: number): string[][] {
  const width = setWidth % 2 === 0 ? setWidth + 1 : setWidth;
  const height = setHeight % 2 === 0 ? setHeight + 1 : setHeight;
  const maze: string[][] = Array.from({ length: height }, () => Array<string>(width).fill(WALL));
  const stack: [number, number][] = [];
  stack.push([1, 1]);
  const directions = [NORTH, EAST, SOUTH, WEST];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node?.[0] || !node[1]) throw new Error("Invalid stack pop");
    const [x, y] = node;

    const neighbors = directions
      .map(([dx, dy]) => [x + dx * 2, y + dy * 2])
      .filter(([nx, ny]) => nx > 0 && nx < width && ny > 0 && ny < height && maze[ny][nx] === WALL);

    if (neighbors.length > 0) {
      stack.push([x, y]);
      const [nx, ny] = neighbors[Math.floor(Math.random() * neighbors.length)];
      maze[(y + ny) / 2][(x + nx) / 2] = PATH;
      maze[ny][nx] = PATH;
      stack.push([nx, ny]);
    }
  }

  return maze;
}

function generateMaze(width = 41, height = 29): string[] {
  if (width < MULTI_MAZE_THRESHOLD) {
    return mazeMaker(width, height).map((row) => row.join(""));
  }

  const halfWidth = Math.ceil(width / 2);
  const halfHeight = Math.ceil(height / 2);

  const maze1 = mazeMaker(halfWidth, halfHeight);
  const maze2 = mazeMaker(halfWidth, halfHeight);
  const maze3 = mazeMaker(halfWidth, halfHeight);
  const maze4 = mazeMaker(halfWidth, halfHeight);

  const resultingMazeTopHalf = maze1.map((row, y) => row.slice(0, -1).concat(maze2[y]));
  const resultingMazeBottomHalf = maze3.map((row, y) => row.slice(0, -1).concat(maze4[y]));
  const resultingMaze = resultingMazeTopHalf.slice(0, -1).concat(resultingMazeBottomHalf);

  const subWidth = maze1[0].length - 1;
  const subHeight = maze1.length - 1;

  const randomTopGap = Math.floor((Math.random() * halfWidth) / 4) * 2 + 1;
  resultingMaze[randomTopGap][subWidth] = PATH;

  const randomLeftGap = Math.floor((Math.random() * halfHeight) / 4) * 2 + 1;
  resultingMaze[subHeight][randomLeftGap] = PATH;

  const randomBottomGap = (Math.floor((Math.random() * halfWidth) / 4) + 1) * 2;
  resultingMaze[height - randomBottomGap - 1][subWidth] = PATH;

  const randomRightGap = (Math.floor((Math.random() * halfHeight) / 4) + 1) * 2;
  resultingMaze[subHeight][width - randomRightGap - 1] = PATH;

  return resultingMaze.map((row) => row.join(""));
}

// Also ported verbatim: the game's own view renderer, so the parseRadar
// cross-check below pins lab.ts's coordinate convention against the real
// function instead of against its own assumption. `labEndpoint` stands in
// for `DarknetState.labEndpoint`, which the game stores as `[x_end, y_end]`;
// note the destructure below swaps the names (`endpointY` <- element 0,
// `endpointX` <- element 1) exactly as the game does — a double swap
// against the `i`/`j` (row/col) loop indices that cancels out, so this is
// not a bug to "fix" when porting.
function getSurroundingsVisualized(
  maze: string[],
  x: number,
  y: number,
  range: number,
  showPlayer: boolean,
  showEnd: boolean,
  labEndpoint: [number, number],
): string {
  const result: string[] = [];
  const [endpointY, endpointX] = labEndpoint;
  for (let i = y - range; i <= y + range; i++) {
    let row = "";
    for (let j = x - range; j <= x + range; j++) {
      if (i === y && j === x && showPlayer) {
        row += "@";
        continue;
      }
      if (i === endpointX && j === endpointY && showEnd) {
        row += "X";
        continue;
      }
      row += maze[i]?.[j] ?? PATH;
    }
    result.push(row);
  }
  return result.join("\n");
}

// --- parseView -----------------------------------------------------------

describe("parseView", () => {
  it("reads north/south from the top/bottom-middle char and east/west from the middle row", () => {
    const data = [`${WALL}${PATH}${WALL}`, `${PATH}@${WALL}`, `${WALL}${WALL}${WALL}`].join("\n");
    expect(parseView(data)).toEqual({ north: true, east: false, south: false, west: true });
  });

  it("reads all four open around the player", () => {
    const data = [`${WALL}${PATH}${WALL}`, `${PATH}@${PATH}`, `${WALL}${PATH}${WALL}`].join("\n");
    expect(parseView(data)).toEqual({ north: true, east: true, south: true, west: true });
  });

  it("reads all four walled", () => {
    const data = [`${WALL}${WALL}${WALL}`, `${WALL}@${WALL}`, `${WALL}${WALL}${WALL}`].join("\n");
    expect(parseView(data)).toEqual({ north: false, east: false, south: false, west: false });
  });

  it("treats missing/short lines as walls rather than throwing", () => {
    expect(parseView("")).toEqual({ north: false, east: false, south: false, west: false });
    expect(parseView(`${PATH}\n@`)).toEqual({ north: false, east: false, south: false, west: false });
  });
});

// --- parsePosition ---------------------------------------------------------

describe("parsePosition", () => {
  it("parses a successful move message", () => {
    expect(parsePosition("You have moved to 5,7.")).toEqual([5, 7]);
  });

  it("parses a blocked move message", () => {
    expect(parsePosition("You cannot go that way. You are still at 3,9.")).toEqual([3, 9]);
  });

  it("returns null for a message matching neither form", () => {
    expect(parsePosition("You have discovered the end of the labyrinth.")).toBeNull();
  });
});

// --- parseRadar --------------------------------------------------------------

describe("parseRadar", () => {
  const blankRow = PATH.repeat(7);

  function radarLines(playerCol: number, playerRow: number, exit?: [number, number]): string {
    const rows = Array.from({ length: 7 }, () => blankRow.split(""));
    rows[playerRow][playerCol] = "@";
    if (exit) rows[exit[1]][exit[0]] = "X";
    return rows.map((r) => r.join("")).join("\n");
  }

  it("locates @ and X", () => {
    const message = radarLines(3, 3, [5, 1]);
    expect(parseRadar(message)).toEqual({ player: [3, 3], exit: [5, 1] });
  });

  it("returns exit: null when there is no X (out of radar range)", () => {
    const message = radarLines(3, 3);
    expect(parseRadar(message)).toEqual({ player: [3, 3], exit: null });
  });

  it("reconstructs the true exit position from the game's own renderer (not just its own assumption)", () => {
    // Cross-check against the ported getSurroundingsVisualized, not against
    // hand-built strings that already assume the convention under test.
    const maze = generateMaze(12, 8);
    const trueExit: [number, number] = [maze[0].length - 2, maze.length - 2];
    // Within 3 cells of the exit in both axes, so X renders.
    const player: [number, number] = [trueExit[0] - 2, trueExit[1] - 1];

    const message = getSurroundingsVisualized(maze, player[0], player[1], 3, true, true, trueExit);
    const parsed = parseRadar(message);

    expect(parsed.player).toEqual([3, 3]); // always the window's center
    expect(parsed.exit).not.toBeNull();
    const reconstructed: [number, number] = [
      player[0] - parsed.player[0] + parsed.exit![0],
      player[1] - parsed.player[1] + parsed.exit![1],
    ];
    expect(reconstructed).toEqual(trueExit);
  });
});

// --- isCharismaGap ------------------------------------------------------------

describe("isCharismaGap", () => {
  // Exact strings from handleLabyrinthPassword (game source, tag v3.0.1).
  const flavourMessages = [
    "You find yourself lost and confused. You need to be more charismatic to navigate the labyrinth.",
    "You stumble in the dark. You need more moxie to find your way.",
    "You feel the walls closing in. You need to be more charming to escape.",
    "You are unable to make any progress. You need more charisma to find the secret.",
  ];

  it("matches each of the four charisma-gate flavour messages", () => {
    for (const message of flavourMessages) {
      expect(isCharismaGap({ success: false, message })).toBe(true);
    }
  });

  it("does not match a normal move or bump message", () => {
    expect(isCharismaGap({ success: true, message: "You have moved to 5,7." })).toBe(false);
    expect(isCharismaGap({ success: false, message: "You cannot go that way. You are still at 3,9." })).toBe(false);
  });

  it("requires success: false even if the text happens to match", () => {
    expect(isCharismaGap({ success: true, message: flavourMessages[0] })).toBe(false);
  });
});

// --- serializeGrid / deserializeGrid ---------------------------------------

describe("serializeGrid / deserializeGrid", () => {
  it("round-trips an explored grid", () => {
    const explored: Explored = emptyExplored();
    for (const k of ["1,1", "2,1", "3,1", "1,2"]) explored.open.add(k);
    for (const k of ["0,1", "1,0", "4,1"]) explored.walls.add(k);

    const rows = serializeGrid(explored);
    const restored = deserializeGrid(rows);

    expect(restored.open).toEqual(explored.open);
    expect(restored.walls).toEqual(explored.walls);
  });

  it("uses '#'/'.'/'?' and leaves unknown cells out of both sets on deserialize", () => {
    const explored: Explored = emptyExplored();
    explored.open.add("1,1");
    explored.walls.add("2,1");
    const rows = serializeGrid(explored, 4, 2);
    expect(rows[1]).toBe("?.#?");
    const restored = deserializeGrid(rows);
    expect(restored.open.has("1,1")).toBe(true);
    expect(restored.walls.has("2,1")).toBe(true);
    expect(restored.open.has("3,1")).toBe(false);
    expect(restored.walls.has("3,1")).toBe(false);
  });

  it("round-trips an empty grid", () => {
    const explored = emptyExplored();
    const restored = deserializeGrid(serializeGrid(explored));
    expect(restored.open.size).toBe(0);
    expect(restored.walls.size).toBe(0);
  });
});

// --- shortestPath ------------------------------------------------------------

describe("shortestPath", () => {
  it("finds a known path over open corridor cells", () => {
    const explored: Explored = emptyExplored();
    // A straight corridor (1,1) -- (3,1) -- (5,1), all cells and connectors open.
    for (const k of ["1,1", "2,1", "3,1", "4,1", "5,1"]) explored.open.add(k);
    expect(shortestPath(explored, [1, 1], [5, 1])).toEqual(["east", "east"]);
  });

  it("returns [] when already at the target", () => {
    const explored = emptyExplored();
    expect(shortestPath(explored, [1, 1], [1, 1])).toEqual([]);
  });

  it("returns null when the target is not reachable through known-open cells", () => {
    const explored: Explored = emptyExplored();
    // The corridor exists as far as (3,1), but the connector onward is unknown.
    for (const k of ["1,1", "2,1", "3,1"]) explored.open.add(k);
    expect(shortestPath(explored, [1, 1], [5, 1])).toBeNull();
  });

  it("does not cross a known wall even if the far cell is open", () => {
    const explored: Explored = emptyExplored();
    explored.open.add("1,1");
    explored.walls.add("2,1"); // connector marked a wall
    explored.open.add("3,1"); // far cell somehow known open (e.g. from another approach)
    expect(shortestPath(explored, [1, 1], [3, 1])).toBeNull();
  });
});

// --- nextMove ------------------------------------------------------------------

describe("nextMove", () => {
  it("explores toward the bottom-right (east) first from a blank grid", () => {
    const explored = emptyExplored();
    expect(nextMove(explored, [1, 1], null)).toBe("east");
  });

  it("skips a known wall and prefers the next bias direction", () => {
    const explored: Explored = emptyExplored();
    explored.walls.add("2,1"); // east connector from (1,1) is a wall
    expect(nextMove(explored, [1, 1], null)).toBe("south");
  });

  it("never returns a direction whose connector is a known wall", () => {
    const explored: Explored = emptyExplored();
    explored.walls.add("2,1"); // east
    explored.walls.add("1,2"); // south
    explored.walls.add("0,1"); // west
    expect(nextMove(explored, [1, 1], null)).toBe("north");
  });

  it("backtracks along known-open cells to the nearest frontier", () => {
    const explored: Explored = emptyExplored();
    // From (1,1): north/east/west are known walls, south leads to a known-open (1,3).
    explored.walls.add("1,0");
    explored.walls.add("2,1");
    explored.walls.add("0,1");
    explored.open.add("1,1");
    explored.open.add("1,2"); // south connector
    explored.open.add("1,3"); // far cell, itself has an unknown east neighbour
    expect(nextMove(explored, [1, 1], null)).toBe("south");
  });

  it("returns null when fully boxed in with no known-open escape", () => {
    const explored: Explored = emptyExplored();
    explored.walls.add("1,0");
    explored.walls.add("2,1");
    explored.walls.add("1,2");
    explored.walls.add("0,1");
    expect(nextMove(explored, [1, 1], null)).toBeNull();
  });

  it("with a target, takes the first step of the shortest known-open path", () => {
    const explored: Explored = emptyExplored();
    for (const k of ["1,1", "2,1", "3,1"]) explored.open.add(k);
    expect(nextMove(explored, [1, 1], [3, 1])).toBe("east");
  });

  it("with an unreachable target, keeps exploring biased toward it instead of stopping", () => {
    const explored: Explored = emptyExplored();
    // Nothing known yet; target is south-east of (1,1) but far off (not a known-open path).
    const dir = nextMove(explored, [1, 1], [9, 9]);
    expect(["east", "south"]).toContain(dir);
  });
});

// --- applyMove -----------------------------------------------------------------

describe("applyMove", () => {
  it("moves two cells and marks the connector + far cell open when the view says open", () => {
    const explored = emptyExplored();
    const view = { north: false, east: true, south: false, west: false };
    const to = applyMove(explored, [1, 1], "east", view);
    expect(to).toEqual([3, 1]);
    expect(explored.open.has("1,1")).toBe(true);
    expect(explored.open.has("2,1")).toBe(true);
    expect(explored.open.has("3,1")).toBe(true);
  });

  it("stays put and marks the connector a wall when the view says blocked", () => {
    const explored = emptyExplored();
    const view = { north: false, east: false, south: false, west: false };
    const to = applyMove(explored, [1, 1], "east", view);
    expect(to).toEqual([1, 1]);
    expect(explored.walls.has("2,1")).toBe(true);
    expect(explored.open.has("3,1")).toBe(false);
  });
});

// --- end-to-end: drive nextMove + applyMove against a maze oracle --------------

describe("walker end-to-end against a generated maze", () => {
  it("reaches the exit within a reasonable move bound", () => {
    // Even width/height, matching every real `labData` entry
    // (20x14, 30x20, 40x26, 60x40): generateMaze's 4-way stitch places its
    // bottom/right inter-quadrant gap at an odd row+column offset from an
    // even width/height, landing it on a real (single-odd-coordinate)
    // connector cell. An odd width/height instead lands that gap on a
    // both-even intersection cell no move can ever reach, occasionally
    // stranding the bottom-right quadrant (and the exit inside it) — a
    // property of the game's generator, not of the walker under test here.
    const width = 12;
    const height = 8;
    const maze = generateMaze(width, height);
    const start: [number, number] = [1, 1];
    const exit: [number, number] = [maze[0].length - 2, maze.length - 2];

    const DELTA: Record<Dir, [number, number]> = {
      north: [0, -1],
      east: [1, 0],
      south: [0, 1],
      west: [-1, 0],
    };

    /** Oracle: is the connector one cell from `pos` in `dir` open, per the real maze? Mirrors the game's own check (only the connector cell is ever tested, never the corridor endpoint's own char). */
    function oracleView(pos: [number, number]): { north: boolean; east: boolean; south: boolean; west: boolean } {
      const at = (dir: Dir) => {
        const [dx, dy] = DELTA[dir];
        return maze[pos[1] + dy]?.[pos[0] + dx] === PATH;
      };
      return { north: at("north"), east: at("east"), south: at("south"), west: at("west") };
    }

    const explored = emptyExplored();
    let pos = start;
    const bound = width * height * 8;
    let moves = 0;
    let reached = pos[0] === exit[0] && pos[1] === exit[1];

    while (!reached && moves < bound) {
      const dir = nextMove(explored, pos, null);
      if (!dir) break; // fully explored reachable area without finding the exit
      const view = oracleView(pos);
      pos = applyMove(explored, pos, dir, view);
      moves++;
      reached = pos[0] === exit[0] && pos[1] === exit[1];
    }

    expect(reached).toBe(true);
    expect(moves).toBeLessThan(bound);
  });
});

// --- end-to-end: the worker's own pattern (parsePosition + parseView + applyMove x4) ---

describe("walker end-to-end using the worker's actual ingest pattern", () => {
  // dnet-lab.ts itself has no unit test (it touches ns); this drives the same
  // sequence it does — parse the ground-truth position from the message,
  // then ingest all four neighbouring walls of the *resulting* position via
  // applyMove, exactly as the worker calls it — against real message/data
  // strings from the ported getSurroundingsVisualized, so a mismatch between
  // lab.ts's helpers and the real response shapes would show up here.
  it("reaches the exit driving nextMove from real authenticate-shaped responses", () => {
    const width = 12;
    const height = 8;
    const maze = generateMaze(width, height);
    const start: [number, number] = [1, 1];
    const exit: [number, number] = [maze[0].length - 2, maze.length - 2];

    const DELTA: Record<Dir, [number, number]> = {
      north: [0, -1],
      east: [1, 0],
      south: [0, 1],
      west: [-1, 0],
    };
    const DIRS: Dir[] = ["north", "east", "south", "west"];

    /** Mirrors handleLabyrinthPassword's message/data shape for one authenticate call. */
    function attemptMove(pos: [number, number], dir: Dir): { message: string; data: string } {
      const [dx, dy] = DELTA[dir];
      const connectorOpen = maze[pos[1] + dy]?.[pos[0] + dx] === PATH;
      if (connectorOpen) {
        const to: [number, number] = [pos[0] + 2 * dx, pos[1] + 2 * dy];
        return {
          message: `You have moved to ${to[0]},${to[1]}.`,
          data: getSurroundingsVisualized(maze, to[0], to[1], 1, true, false, exit),
        };
      }
      return {
        message: `You cannot go that way. You are still at ${pos[0]},${pos[1]}.`,
        data: getSurroundingsVisualized(maze, pos[0], pos[1], 1, true, false, exit),
      };
    }

    const explored = emptyExplored();
    let pos = start;
    const bound = width * height * 8;
    let moves = 0;

    while (moves < bound && !(pos[0] === exit[0] && pos[1] === exit[1])) {
      const dir = nextMove(explored, pos, null);
      if (!dir) break;

      const { message, data } = attemptMove(pos, dir);
      const newPos = parsePosition(message);
      expect(newPos).not.toBeNull();

      const view = parseView(data);
      for (const d of DIRS) applyMove(explored, newPos as [number, number], d, view);
      pos = newPos as [number, number];
      moves++;
    }

    expect(pos).toEqual(exit);
    expect(moves).toBeLessThan(bound);
  });
});
