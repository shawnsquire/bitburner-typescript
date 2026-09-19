import { describe, it, expect } from "vitest";
import { slashSolver } from "/lib/infiltration/solvers/slash";
import { fakeGameDoc, fakeGamePaper, fakeDomUtils, FakeElement } from "../../helpers/fake-dom";

function docWithPhase(h4Text: string): FakeElement {
  return fakeGameDoc([
    { tag: "h5", text: "Attack after the sentinel drops his guard and is distracted." },
    { tag: "h4", text: h4Text },
  ]);
}

function paperWithPhase(h4Text: string): FakeElement {
  return fakeGamePaper([{ tag: "h4", text: h4Text }]);
}

describe("slashSolver.detect", () => {
  it("matches the guarding phase", () => {
    expect(slashSolver.detect(docWithPhase("Guarding ...") as unknown as Document)).toBe(true);
  });

  it("matches the distracted phase", () => {
    expect(slashSolver.detect(docWithPhase("Distracted!") as unknown as Document)).toBe(true);
  });

  it("matches the alerted phase", () => {
    expect(slashSolver.detect(docWithPhase("Alerted!") as unknown as Document)).toBe(true);
  });

  it("returns false for an unrelated game screen", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Close the brackets" }]);
    expect(slashSolver.detect(doc as unknown as Document)).toBe(false);
  });

  it("returns false when there is no MuiContainer-root at all", () => {
    const doc = new FakeElement({ tag: "div" });
    expect(slashSolver.detect(doc as unknown as Document)).toBe(false);
  });
});

describe("slashSolver.solve", () => {
  it("presses space as soon as the container reads Distracted!", async () => {
    const paper = paperWithPhase("Distracted!");
    const { dom, recorder } = fakeDomUtils(paper);
    await slashSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys).toEqual([" "]);
  });

  it("waits through the guarding phase before pressing space", async () => {
    let calls = 0;
    const getContainer = () => {
      calls++;
      // First couple of polls still show "Guarding ...", then it flips.
      return calls < 3 ? paperWithPhase("Guarding ...") : paperWithPhase("Distracted!");
    };
    const { dom, recorder } = fakeDomUtils(getContainer);
    await slashSolver.solve(paperWithPhase("Guarding ...") as unknown as Document, dom);
    expect(recorder.keys).toEqual([" "]);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("throws if Distracted! never appears before the timeout", async () => {
    const paper = paperWithPhase("Guarding ...");
    const { dom, recorder } = fakeDomUtils(paper);
    await expect(slashSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/timed out/i);
    expect(recorder.keys).toEqual([]);
  });

  it("throws if the game container disappears mid-poll", async () => {
    const paper = paperWithPhase("Guarding ...");
    const { dom } = fakeDomUtils(() => null);
    await expect(slashSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/container disappeared/i);
  });
});
