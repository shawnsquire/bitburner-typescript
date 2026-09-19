import { describe, it, expect } from "vitest";
import { backwardStringSolver } from "/lib/infiltration/solvers/backward-string";
import { fakeGameDoc, fakeGamePaper, fakeDomUtils } from "../../helpers/fake-dom";

describe("backwardStringSolver.detect", () => {
  it("matches the normal 'Type it backward' heading", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Type it backward" }, { tag: "p", text: "ALGORITHM" }]);
    expect(backwardStringSolver.detect(doc as unknown as Document)).toBe(true);
  });

  it("matches the Chaos of Dionysus augment variant 'Type it' (no backward)", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Type it" }, { tag: "p", text: "ALGORITHM" }]);
    expect(backwardStringSolver.detect(doc as unknown as Document)).toBe(true);
  });

  it("returns false for an unrelated screen", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Cut the wires" }]);
    expect(backwardStringSolver.detect(doc as unknown as Document)).toBe(false);
  });
});

describe("backwardStringSolver.solve", () => {
  it("types the mirrored answer paragraph's raw textContent, one key at a time", async () => {
    // Mirrors BackwardGame.tsx: the answer <p> carries transform: scaleX(-1);
    // textContent is still the un-mirrored string that must be typed.
    const paper = fakeGamePaper([
      { tag: "h4", text: "Type it backward" },
      { tag: "p", text: "ALGORITHM", style: { transform: "scaleX(-1)" } },
      { tag: "p", text: "" }, // the player's in-progress guess
    ]);
    const { dom, recorder } = fakeDomUtils(paper);
    await backwardStringSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys.join("")).toBe("ALGORITHM");
  });

  it("falls back to the first non-header text when no scaleX(-1) style is found (augment case)", async () => {
    const paper = fakeGamePaper([
      { tag: "h4", text: "Type it" },
      { tag: "p", text: "BANDWIDTH", style: { transform: "none" } },
      { tag: "p", text: "" },
    ]);
    const { dom, recorder } = fakeDomUtils(paper);
    await backwardStringSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys.join("")).toBe("BANDWIDTH");
  });

  it("types multi-word answers including the literal space character", async () => {
    const paper = fakeGamePaper([
      { tag: "h4", text: "Type it backward" },
      { tag: "p", text: "DATA MINING", style: { transform: "scaleX(-1)" } },
    ]);
    const { dom, recorder } = fakeDomUtils(paper);
    await backwardStringSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys.join("")).toBe("DATA MINING");
    expect(recorder.keys).toContain(" ");
  });

  it("throws when no answer text can be found", async () => {
    const paper = fakeGamePaper([{ tag: "h4", text: "Type it backward" }]);
    const { dom } = fakeDomUtils(paper);
    await expect(backwardStringSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/could not find answer/i);
  });

  it("throws when the game container is gone", async () => {
    const { dom } = fakeDomUtils(() => null);
    await expect(backwardStringSolver.solve(fakeGamePaper([]) as unknown as Document, dom)).rejects.toThrow(/not found/i);
  });
});
