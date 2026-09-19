/**
 * Minesweeper Solver
 *
 * Phase 1 (2s): "Remember all the mines!" — mines shown as <Report/> SVG icons.
 * Phase 2: "Mark all the mines!" — navigate with arrows, press Space to flag.
 *
 * DOM structure (from MinesweeperGame.tsx):
 *   Paper > h4 "Remember all the mines!" / "Mark all the mines!"
 *         > Box (div, CSS grid, repeat(W, 1fr))
 *             > p (cell, 32x32, border) — contains <svg> (ReportIcon) if mine, empty otherwise
 *             > p (cell) ...
 *             > ... (W * H total cells, row-major order)
 *
 * Grid dimensions scale with difficulty: 3x3 to 6x6.
 * Mines: 4 to 15 depending on difficulty.
 * Memory phase is exactly 2000ms. Marking phase is ~13000ms.
 *
 * Marking a non-mine cell = instant failure.
 * Cursor starts at (0, 0). Navigation wraps around.
 */
import { MiniGameSolver } from "/lib/infiltration/types";
import { DomUtils } from "/lib/dom";

const win = globalThis["window"] as Window;

/** Find the grid container using getComputedStyle. */
function findGrid(container: Element): { el: Element; width: number; height: number } | null {
  const divs = container.querySelectorAll("div");
  for (const div of divs) {
    const computed = win.getComputedStyle(div);
    const cols = computed.gridTemplateColumns;
    const rows = computed.gridTemplateRows;
    if (!cols || cols === "none") continue;
    const colCount = cols.split(/\s+/).filter(s => s.length > 0).length;
    const rowCount = rows && rows !== "none"
      ? rows.split(/\s+/).filter(s => s.length > 0).length
      : 0;
    // Minesweeper grids are 3x3 to 6x6
    if (colCount >= 3 && colCount <= 6 && rowCount >= 3) {
      return { el: div, width: colCount, height: rowCount };
    }
  }
  return null;
}

/** Read mine positions from the grid during memory phase. Mines have SVG children. */
function readMines(grid: Element): number[] {
  const mines: number[] = [];
  const cells = Array.from(grid.children);
  for (let i = 0; i < cells.length; i++) {
    // Mine cells contain an SVG (MUI <Report/> icon, data-testid="ReportIcon").
    // Must match the testid specifically, not just "any svg": in the marking phase
    // the cursor cell renders a <Close/> icon and a correctly-flagged cell renders
    // a <Flag/> icon, both also SVGs, which a bare "svg" selector would misidentify
    // as mines (see MinesweeperGame.tsx / MinesweeperModel.ts in the game source).
    if (cells[i].querySelector('svg[data-testid="ReportIcon"]')) {
      mines.push(i);
    }
  }
  return mines;
}

export const minesweeperSolver: MiniGameSolver = {
  id: "minesweeper",
  name: "Minesweeper",

  detect(doc: Document): boolean {
    const container = doc.querySelector(".MuiContainer-root");
    if (!container) return false;
    const papers = container.querySelectorAll(":scope > .MuiPaper-root");
    const game = papers[papers.length - 1];
    if (!game) return false;

    const h4 = game.querySelector("h4");
    const text = h4?.textContent?.toLowerCase() ?? "";
    // Only detect during memory phase — if we missed it, we can't solve
    return text.includes("remember all the mines") || text.includes("mark all the mines");
  },

  async solve(doc: Document, dom: DomUtils): Promise<void> {
    let container = dom.getGameContainer();
    if (!container) throw new Error("Minesweeper: game container not found");

    // Read mine positions immediately — every ms counts in the 2s memory window
    const grid = findGrid(container);
    if (!grid) throw new Error("Minesweeper: could not find grid");
    const { width } = grid;

    // Check phase
    const h4 = container.querySelector("h4");
    const title = h4?.textContent?.toLowerCase() ?? "";
    const isMemoryPhase = title.includes("remember");

    let minePositions: number[];

    if (isMemoryPhase) {
      // Read mines immediately
      minePositions = readMines(grid.el);

      // If no mines found yet (DOM might not have rendered icons), retry a few times
      let retries = 0;
      while (minePositions.length === 0 && retries < 10) {
        await dom.sleep(50);
        minePositions = readMines(grid.el);
        retries++;
      }

      // Wait for marking phase to begin
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        container = dom.getGameContainer();
        if (!container) throw new Error("Minesweeper: game container disappeared");
        const currentH4 = container.querySelector("h4");
        if (currentH4?.textContent?.toLowerCase().includes("mark all the mines")) {
          break;
        }
        await dom.sleep(50);
      }
    } else {
      // Already in marking phase — try to read mines anyway (Hunt of Artemis augment shows them)
      minePositions = readMines(grid.el);
      if (minePositions.length === 0) {
        throw new Error("Minesweeper: entered during marking phase, no visible mines");
      }
    }

    if (minePositions.length === 0) {
      throw new Error("Minesweeper: no mines detected");
    }

    // Brief pause to let marking phase UI settle
    await dom.sleep(100);

    // Navigate and mark mines
    // Cursor starts at (0, 0). Grid cells are in row-major order.
    let curRow = 0;
    let curCol = 0;

    // Sort mines by row then column for efficient traversal
    const sorted = minePositions
      .map(idx => ({ row: Math.floor(idx / width), col: idx % width }))
      .sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);

    for (const mine of sorted) {
      // Move vertically
      while (curRow !== mine.row) {
        if (mine.row > curRow) {
          dom.pressKey("ArrowDown");
          curRow++;
        } else {
          dom.pressKey("ArrowUp");
          curRow--;
        }
        await dom.sleep(15);
      }
      // Move horizontally
      while (curCol !== mine.col) {
        if (mine.col > curCol) {
          dom.pressKey("ArrowRight");
          curCol++;
        } else {
          dom.pressKey("ArrowLeft");
          curCol--;
        }
        await dom.sleep(15);
      }

      // Mark mine
      dom.pressKey(" ");
      await dom.sleep(30);
    }
  },
};
