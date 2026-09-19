import { describe, it, expect } from "vitest";
import "../../helpers/window-stub"; // must precede the solver import — see that file's header comment
import { cyberpunkSolver } from "/lib/infiltration/solvers/cyberpunk";
import { fakeGameDoc, fakeGamePaper, fakeDomUtils, FakeSpec } from "../../helpers/fake-dom";

/** width x width grid of 2-char hex symbols (row-major), with a bordered cell at cursorIdx. */
function gamePaper(width: number, symbols: string[], targets: string[], cursorIdx: number): ReturnType<typeof fakeGamePaper> {
  const targetSpans: FakeSpec[] = targets.map((t, i): FakeSpec => ({ tag: "span", text: `${t}\u00a0`, style: i === 0 ? { color: "infolight" } : {} }));
  const cells: FakeSpec[] = symbols.map((s, i): FakeSpec => ({
    tag: "p",
    text: s,
    style: i === cursorIdx ? { border: "2px solid infolight", padding: "2px" } : { border: "unset", padding: "4px" },
  }));
  return fakeGamePaper([
    { tag: "h4", text: "Match the symbols!" },
    { tag: "h5", children: [{ tag: "span", text: "Targets: " }, ...targetSpans] },
    { tag: "div", style: { gridTemplateColumns: Array(width).fill("1fr").join(" ") }, children: cells },
  ]);
}

describe("cyberpunkSolver.detect", () => {
  it("matches the 'Match the symbols!' heading", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Match the symbols!" }]);
    expect(cyberpunkSolver.detect(doc as unknown as Document)).toBe(true);
  });

  it("returns false otherwise", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Mark all the mines!" }]);
    expect(cyberpunkSolver.detect(doc as unknown as Document)).toBe(false);
  });
});

describe("cyberpunkSolver.solve", () => {
  it("navigates the cursor to each target in order and presses space to select it", async () => {
    // 3x3 grid, row-major:
    //   A1 B2 C3
    //   D4 E5 F6
    //   07 18 29
    // Cursor starts at index 0 (A1). Targets: F6 (row1,col2), 07 (row2,col0).
    const symbols = ["A1", "B2", "C3", "D4", "E5", "F6", "07", "18", "29"];
    const paper = gamePaper(3, symbols, ["F6", "07"], 0);
    const { dom, recorder } = fakeDomUtils(paper);
    await cyberpunkSolver.solve(paper as unknown as Document, dom);

    // A1(0,0) -> F6(1,2): 1 down, 2 right, then space.
    // F6(1,2) -> 07(2,0): 1 down, 2 left, then space.
    expect(recorder.keys).toEqual([
      "ArrowDown", "ArrowRight", "ArrowRight", " ",
      "ArrowDown", "ArrowLeft", "ArrowLeft", " ",
    ]);
  });

  it("selects a duplicate symbol wherever it appears — the game matches by value, not position", async () => {
    // Single row of 4 (min valid grid width), symbol "AA" appears at index 0 and 2.
    const symbols = ["AA", "BB", "AA", "CC"];
    const paper = gamePaper(4, symbols, ["AA"], 3); // cursor starts at index 3 (CC)
    const { dom, recorder } = fakeDomUtils(paper);
    await cyberpunkSolver.solve(paper as unknown as Document, dom);
    // indexOf finds the first "AA" at index 0; cursor starts at index 3 — 3 lefts, then space.
    expect(recorder.keys).toEqual(["ArrowLeft", "ArrowLeft", "ArrowLeft", " "]);
  });

  it("throws when a target symbol cannot be found anywhere in the grid", async () => {
    const symbols = ["AA", "BB", "CC", "DD"];
    const paper = gamePaper(4, symbols, ["EE"], 0);
    const { dom } = fakeDomUtils(paper);
    await expect(cyberpunkSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/not found in grid/i);
  });

  it("throws when no target symbols can be read", async () => {
    const paper = fakeGamePaper([
      { tag: "h4", text: "Match the symbols!" },
      { tag: "div", style: { gridTemplateColumns: "1fr 1fr 1fr" }, children: [{ tag: "p", text: "AA" }] },
    ]);
    const { dom } = fakeDomUtils(paper);
    await expect(cyberpunkSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/could not find target symbols/i);
  });
});
