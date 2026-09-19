import { describe, it, expect } from "vitest";
import "../../helpers/window-stub"; // must precede the solver import — see that file's header comment
import { minesweeperSolver } from "/lib/infiltration/solvers/minesweeper";
import { fakeGameDoc, fakeGamePaper, fakeDomUtils, FakeSpec } from "../../helpers/fake-dom";

function cell(icon?: "Report" | "Close" | "Flag"): FakeSpec {
  const iconTestId: Record<string, string> = { Report: "ReportIcon", Close: "CloseIcon", Flag: "FlagIcon" };
  return {
    tag: "p",
    children: icon ? [{ tag: "svg", attrs: { "data-testid": iconTestId[icon] } }] : [],
  };
}

/** width x height grid; mineIdx = indices (row-major) that show the Report icon. */
function memoryPhasePaper(width: number, height: number, mineIdx: number[]): ReturnType<typeof fakeGamePaper> {
  const cells: FakeSpec[] = [];
  for (let i = 0; i < width * height; i++) cells.push(cell(mineIdx.includes(i) ? "Report" : undefined));
  return fakeGamePaper([
    { tag: "h4", text: "Remember all the mines!" },
    {
      tag: "div",
      style: { gridTemplateColumns: Array(width).fill("1fr").join(" "), gridTemplateRows: Array(height).fill("1fr").join(" ") },
      children: cells,
    },
  ]);
}

/** Marking phase: cursor cell renders a Close icon, correctly-marked cells render a Flag icon. */
function markingPhasePaper(
  width: number,
  height: number,
  opts: { cursorIdx?: number; markedIdx?: number[]; augmentFlaggedIdx?: number[] } = {},
): ReturnType<typeof fakeGamePaper> {
  const { cursorIdx, markedIdx = [], augmentFlaggedIdx = [] } = opts;
  const cells: FakeSpec[] = [];
  for (let i = 0; i < width * height; i++) {
    if (i === cursorIdx) cells.push(cell("Close"));
    else if (markedIdx.includes(i)) cells.push(cell("Flag"));
    else if (augmentFlaggedIdx.includes(i)) cells.push(cell("Report"));
    else cells.push(cell());
  }
  return fakeGamePaper([
    { tag: "h4", text: "Mark all the mines!" },
    {
      tag: "div",
      style: { gridTemplateColumns: Array(width).fill("1fr").join(" "), gridTemplateRows: Array(height).fill("1fr").join(" ") },
      children: cells,
    },
  ]);
}

describe("minesweeperSolver.detect", () => {
  it("matches the memory phase heading", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Remember all the mines!" }]);
    expect(minesweeperSolver.detect(doc as unknown as Document)).toBe(true);
  });

  it("matches the marking phase heading", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Mark all the mines!" }]);
    expect(minesweeperSolver.detect(doc as unknown as Document)).toBe(true);
  });

  it("returns false otherwise", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Cut the wires" }]);
    expect(minesweeperSolver.detect(doc as unknown as Document)).toBe(false);
  });
});

describe("minesweeperSolver.solve", () => {
  it("navigates to and marks every mine shown during the memory phase", async () => {
    // 3x3 grid, mines at row-major indices 0 and 4 (row0col0, row1col1).
    const memory = memoryPhasePaper(3, 3, [0, 4]);
    const marking = markingPhasePaper(3, 3);
    let calls = 0;
    // solve() reads the container once for the memory-phase snapshot, then
    // polls it again in a "wait for marking phase" loop — return memory on
    // the first read and marking on every read after, like the real
    // 2s memory -> marking transition.
    const getContainer = () => (calls++ === 0 ? memory : marking);
    const { dom, recorder } = fakeDomUtils(getContainer);

    await minesweeperSolver.solve(memory as unknown as Document, dom);

    // Cursor starts at (0,0) — mine 0 needs no movement, mine 4 is (row1,col1):
    // one ArrowDown + one ArrowRight, then Space for each mine, in row-major order.
    expect(recorder.keys).toEqual([" ", "ArrowDown", "ArrowRight", " "]);
  });

  it("does not mistake the marking-phase cursor's Close icon for a mine (regression)", async () => {
    // Entering mid marking-phase with no memorized mines and no Hunt of
    // Artemis augment: readMines() must find zero mines rather than treating
    // the cursor's <Close/> icon (also an <svg>) as one — that would place a
    // flag at the cursor's own position (0,0) and fail if it isn't a mine.
    const marking = markingPhasePaper(3, 3, { cursorIdx: 0 });
    const { dom } = fakeDomUtils(marking);
    await expect(minesweeperSolver.solve(marking as unknown as Document, dom)).rejects.toThrow(/no visible mines/i);
  });

  it("reads augment-revealed mines (Report icon) during the marking phase", async () => {
    // 3x3 is the minimum real grid size (Trivial difficulty).
    const marking = markingPhasePaper(3, 3, { cursorIdx: 0, augmentFlaggedIdx: [8] });
    const { dom, recorder } = fakeDomUtils(marking);
    await minesweeperSolver.solve(marking as unknown as Document, dom);
    expect(recorder.keys[recorder.keys.length - 1]).toBe(" ");
  });

  it("throws if no grid can be found", async () => {
    const paper = fakeGamePaper([{ tag: "h4", text: "Remember all the mines!" }]);
    const { dom } = fakeDomUtils(paper);
    await expect(minesweeperSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/could not find grid/i);
  });
});
