import { describe, it, expect } from "vitest";
import { cheatCodeSolver } from "/lib/infiltration/solvers/cheat-code";
import { fakeGameDoc, fakeGamePaper, fakeDomUtils, FakeSpec } from "../../helpers/fake-dom";

const UP = "↑";
const DOWN = "↓";
const LEFT = "←";
const RIGHT = "→";

/**
 * Mirrors CheatCodeGame.tsx: each arrow renders as a <span>, dimmed (opacity
 * 0.4) unless it's the current index; future arrows show "?" instead of the
 * real symbol unless the player has the TrickeryOfHermes augment.
 */
function paperWithCode(code: string[], index: number, revealFuture = false): ReturnType<typeof fakeGamePaper> {
  const spans: FakeSpec[] = code.map((arrow, i): FakeSpec => ({
    tag: "span",
    text: i > index && !revealFuture ? "?" : arrow,
    style: i !== index ? { opacity: "0.4" } : {},
  }));
  return fakeGamePaper([
    { tag: "h4", text: "Enter the Code!" },
    { tag: "h4", children: [{ tag: "div", children: spans }] },
  ]);
}

describe("cheatCodeSolver.detect", () => {
  it("matches the 'Enter the Code!' heading", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Enter the Code!" }]);
    expect(cheatCodeSolver.detect(doc as unknown as Document)).toBe(true);
  });

  it("returns false otherwise", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Match the symbols!" }]);
    expect(cheatCodeSolver.detect(doc as unknown as Document)).toBe(false);
  });
});

describe("cheatCodeSolver.solve", () => {
  it("presses only the full-opacity (current index) arrow, in order", async () => {
    const code = [UP, RIGHT, DOWN, LEFT];
    let index = 0;
    // Once the real code is exhausted the game transitions away from
    // CheatCodeGame entirely (onSuccess ends the stage) — model that instead
    // of an out-of-range index, so the solver's own stop condition (no arrow
    // found) is what ends the loop, same as it would in the live game.
    const getContainer = () => (index < code.length ? paperWithCode(code, index) : fakeGamePaper([{ tag: "h4", text: "Get Ready!" }]));
    const { dom, recorder } = fakeDomUtils(getContainer);
    const originalPressKey = dom.pressKey;
    dom.pressKey = (key: string) => {
      originalPressKey(key);
      index++; // model advances index on every correct keypress
    };
    await cheatCodeSolver.solve(paperWithCode(code, 0) as unknown as Document, dom);
    expect(recorder.keys).toEqual(["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"]);
  });

  it("ignores future '?' placeholders and only reveals the current arrow", async () => {
    // Without the augment, arrows past the cursor render "?" — confirm the
    // solver never tries to press a "?" key and correctly reads only index 0.
    const paper = paperWithCode([RIGHT, UP, DOWN], 0);
    const { dom, recorder } = fakeDomUtils(paper);
    await cheatCodeSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys[0]).toBe("ArrowRight");
    expect(recorder.keys).not.toContain("?");
  });

  it("still only presses the current index even with the reveal-future augment on", async () => {
    // TrickeryOfHermes reveals future arrows too, but they stay at 0.4 opacity,
    // so the solver's opacity check must still isolate just the current one.
    const code = [LEFT, DOWN, UP];
    let index = 0;
    const getContainer = () => (index < code.length ? paperWithCode(code, index, true) : fakeGamePaper([{ tag: "h4", text: "Get Ready!" }]));
    const { dom, recorder } = fakeDomUtils(getContainer);
    const originalPressKey = dom.pressKey;
    dom.pressKey = (key: string) => {
      originalPressKey(key);
      index++;
    };
    await cheatCodeSolver.solve(paperWithCode(code, 0, true) as unknown as Document, dom);
    expect(recorder.keys).toEqual(["ArrowLeft", "ArrowDown", "ArrowUp"]);
  });

  it("stops (does not throw) once no more arrows are found", async () => {
    const paper = fakeGamePaper([{ tag: "h4", text: "Enter the Code!" }, { tag: "h4", children: [] }]);
    const { dom, recorder } = fakeDomUtils(paper);
    await expect(cheatCodeSolver.solve(paper as unknown as Document, dom)).resolves.toBeUndefined();
    expect(recorder.keys).toEqual([]);
  });
});
