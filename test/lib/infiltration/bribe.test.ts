import { describe, it, expect } from "vitest";
import { bribeSolver } from "/lib/infiltration/solvers/bribe";
import { fakeGameDoc, fakeGamePaper, fakeDomUtils } from "../../helpers/fake-dom";

// The exact 21-word positive list from Infiltration/model/BribeModel.ts — the
// solver's own POSITIVE_WORDS set must match this verbatim or it will either
// scroll past a real positive word or press space on a negative one.
const GAME_POSITIVE_WORDS = [
  "affectionate", "agreeable", "bright", "charming", "creative",
  "determined", "energetic", "friendly", "funny", "generous",
  "polite", "likable", "diplomatic", "helpful", "giving",
  "kind", "hardworking", "patient", "dynamic", "loyal",
  "straightforward",
];

function paperWithChoice(word: string): ReturnType<typeof fakeGamePaper> {
  return fakeGamePaper([
    { tag: "h4", text: "Say something nice about the guard" },
    { tag: "h5", text: "↑" },
    { tag: "h5", text: word },
    { tag: "h5", text: "↓" },
  ]);
}

describe("bribeSolver.detect", () => {
  it("matches the bribe prompt", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Say something nice about the guard" }]);
    expect(bribeSolver.detect(doc as unknown as Document)).toBe(true);
  });

  it("returns false otherwise", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Match the symbols!" }]);
    expect(bribeSolver.detect(doc as unknown as Document)).toBe(false);
  });
});

describe("bribeSolver word list", () => {
  it("matches the game's 21 positive words exactly (case-insensitive)", async () => {
    for (const word of GAME_POSITIVE_WORDS) {
      const paper = paperWithChoice(word);
      const { dom, recorder } = fakeDomUtils(paper);
      await bribeSolver.solve(paper as unknown as Document, dom);
      expect(recorder.keys, `expected "${word}" to be recognized as positive`).toEqual([" "]);
    }
  });
});

describe("bribeSolver.solve", () => {
  it("presses space immediately when the first word shown is positive", async () => {
    const paper = paperWithChoice("kind");
    const { dom, recorder } = fakeDomUtils(paper);
    await bribeSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys).toEqual([" "]);
  });

  it("scrolls with 'w' past negative words until a positive one appears", async () => {
    const words = ["aggressive", "boastful", "cruel", "generous"];
    let idx = 0;
    const getContainer = () => paperWithChoice(words[Math.min(idx, words.length - 1)]);
    const { dom, recorder } = fakeDomUtils(getContainer);
    // Advance idx every time "w" gets pressed, mimicking BribeModel's index++.
    const originalPressKey = dom.pressKey;
    dom.pressKey = (key: string) => {
      originalPressKey(key);
      if (key === "w") idx++;
    };
    await bribeSolver.solve(paperWithChoice(words[0]) as unknown as Document, dom);
    expect(recorder.keys).toEqual(["w", "w", "w", " "]);
  });

  it("throws after exhausting the cycle without finding a positive word", async () => {
    const paper = paperWithChoice("aggressive");
    const { dom, recorder } = fakeDomUtils(paper);
    await expect(bribeSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/exhausted word cycle/i);
    expect(recorder.keys.every(k => k === "w")).toBe(true);
  });
});
