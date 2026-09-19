import { describe, it, expect } from "vitest";
import { bracketsSolver } from "/lib/infiltration/solvers/brackets";
import { fakeGameDoc, fakeGamePaper, fakeDomUtils } from "../../helpers/fake-dom";

describe("bracketsSolver.detect", () => {
  it("matches the 'Close the brackets' heading", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Close the brackets" }]);
    expect(bracketsSolver.detect(doc as unknown as Document)).toBe(true);
  });

  it("returns false for an unrelated screen", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Enter the Code!" }]);
    expect(bracketsSolver.detect(doc as unknown as Document)).toBe(false);
  });
});

describe("bracketsSolver.solve", () => {
  it("closes brackets in reverse order of the displayed open brackets", async () => {
    const paper = fakeGamePaper([
      { tag: "h4", text: "Close the brackets" },
      { tag: "p", text: "([{<", style: { fontSize: "5em" } },
    ]);
    const { dom, recorder } = fakeDomUtils(paper);
    await bracketsSolver.solve(paper as unknown as Document, dom);
    // Open order ( [ { < -> innermost-last must close first: > } ] )
    expect(recorder.keys).toEqual([">", "}", "]", ")"]);
  });

  // Regression: BracketGame.tsx renders `${left}${right}` followed by a
  // <BlinkingCursor/> that alternates every 1s between "|" and a non-breaking
  // space. Before stripping the cursor char, the "|" phase made the pure
  // bracket-character regex fail every other second, which could exhaust the
  // whole 20-attempt/1s retry window without ever matching and throw.
  it("still solves when the paragraph text has a trailing blinking-cursor '|'", async () => {
    const paper = fakeGamePaper([
      { tag: "h4", text: "Close the brackets" },
      { tag: "p", text: "({|", style: { fontSize: "5em" } },
    ]);
    const { dom, recorder } = fakeDomUtils(paper);
    await bracketsSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys).toEqual(["}", ")"]);
  });

  it("still solves when the trailing character is a non-breaking space", async () => {
    const paper = fakeGamePaper([
      { tag: "h4", text: "Close the brackets" },
      { tag: "p", text: "({ ", style: { fontSize: "5em" } },
    ]);
    const { dom, recorder } = fakeDomUtils(paper);
    await bracketsSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys).toEqual(["}", ")"]);
  });

  it("throws after exhausting retries if no bracket text is ever found", async () => {
    const paper = fakeGamePaper([{ tag: "h4", text: "Close the brackets" }]);
    const { dom } = fakeDomUtils(paper);
    await expect(bracketsSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/could not find bracket text/i);
  });
});
