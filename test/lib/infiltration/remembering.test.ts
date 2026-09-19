import { describe, it, expect } from "vitest";
import { rememberingSolver } from "/lib/infiltration/solvers/remembering";
import { fakeGameDoc, fakeDomUtils } from "../../helpers/fake-dom";

// This solver is a documented no-op placeholder kept only so the registry has
// the ID from the original spec (see the file's own header comment) — it
// must never match any real screen, since minesweeper/cheat-code already
// handle every "remembering" style game.
describe("rememberingSolver", () => {
  it("never detects, even against arbitrary game screens", () => {
    const screens = [
      fakeGameDoc([{ tag: "h4", text: "Remember all the mines!" }]),
      fakeGameDoc([{ tag: "h4", text: "Enter the Code!" }]),
      fakeGameDoc([{ tag: "h4", text: "Close the brackets" }]),
      fakeGameDoc([]),
    ];
    for (const doc of screens) {
      expect(rememberingSolver.detect(doc as unknown as Document)).toBe(false);
    }
  });

  it("throws if solve() is ever invoked directly", async () => {
    const doc = fakeGameDoc([]);
    const { dom } = fakeDomUtils(doc);
    await expect(rememberingSolver.solve(doc as unknown as Document, dom)).rejects.toThrow();
  });
});
