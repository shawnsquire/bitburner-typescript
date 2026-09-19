import { describe, it, expect } from "vitest";
import "../../helpers/window-stub"; // must precede the solver import — see that file's header comment
import { wireCuttingSolver } from "/lib/infiltration/solvers/wire-cutting";
import { fakeGameDoc, fakeGamePaper, fakeDomUtils, FakeSpec } from "../../helpers/fake-dom";

/**
 * Mirrors WireCuttingGame.tsx: `wireCount` label <p>s (1..N), then 11 rows of
 * `wireCount` colored segment <p>s each, all inside one grid Box. Colors cycle
 * per row as `wire.colors[row % wire.colors.length]`, so row0 always shows
 * colors[0] and row1 shows colors[1] (or colors[0] again for single-color wires).
 */
function wireGamePaper(
  instructions: string[],
  wires: { colors: string[] }[],
): ReturnType<typeof fakeGamePaper> {
  const wireCount = wires.length;
  const labels: FakeSpec[] = wires.map((_, i) => ({ tag: "p", text: String(i + 1) }));
  const rows: FakeSpec[] = [];
  for (let row = 0; row < 11; row++) {
    for (const wire of wires) {
      const color = wire.colors[row % wire.colors.length];
      rows.push({ tag: "p", text: "|X|", style: { color } });
    }
  }
  return fakeGamePaper([
    { tag: "h4", text: "Cut the wires with the following properties! (keyboard 1 to 9)" },
    ...instructions.map(text => ({ tag: "p", text }) as FakeSpec),
    { tag: "div", style: { gridTemplateColumns: Array(wireCount).fill("1fr").join(" ") }, children: [...labels, ...rows] },
  ]);
}

describe("wireCuttingSolver.detect", () => {
  it("matches the wire-cutting heading", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Cut the wires with the following properties! (keyboard 1 to 9)" }]);
    expect(wireCuttingSolver.detect(doc as unknown as Document)).toBe(true);
  });

  it("returns false otherwise", () => {
    const doc = fakeGameDoc([{ tag: "h4", text: "Match the symbols!" }]);
    expect(wireCuttingSolver.detect(doc as unknown as Document)).toBe(false);
  });
});

describe("wireCuttingSolver.solve", () => {
  it("cuts the exact wire named by a position instruction", async () => {
    const wires = [{ colors: ["red"] }, { colors: ["blue"] }, { colors: ["white"] }, { colors: ["#FFC107"] }];
    const paper = wireGamePaper(["Cut wire number 3."], wires);
    const { dom, recorder } = fakeDomUtils(paper);
    await wireCuttingSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys).toEqual(["3"]);
  });

  it("cuts every wire matching a color instruction", async () => {
    const wires = [{ colors: ["red"] }, { colors: ["blue"] }, { colors: ["red"] }, { colors: ["white"] }];
    const paper = wireGamePaper(["Cut all wires colored RED."], wires);
    const { dom, recorder } = fakeDomUtils(paper);
    await wireCuttingSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys.sort()).toEqual(["1", "3"]);
  });

  it("cuts a dual-color wire for a color instruction matching its second color", async () => {
    // Wire 2 is red on odd rows (colors[1]) — only visible by checking row 1,
    // which is exactly what ROWS_TO_CHECK=2 is there for.
    const wires = [{ colors: ["blue"] }, { colors: ["white", "red"] }, { colors: ["blue"] }, { colors: ["white"] }];
    const paper = wireGamePaper(["Cut all wires colored RED."], wires);
    const { dom, recorder } = fakeDomUtils(paper);
    await wireCuttingSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys).toEqual(["2"]);
  });

  it("unions multiple instructions (position + color) without duplicating a wire", async () => {
    const wires = [{ colors: ["red"] }, { colors: ["blue"] }, { colors: ["red"] }, { colors: ["white"] }];
    const paper = wireGamePaper(["Cut wire number 1.", "Cut all wires colored RED."], wires);
    const { dom, recorder } = fakeDomUtils(paper);
    await wireCuttingSolver.solve(paper as unknown as Document, dom);
    expect(recorder.keys.sort()).toEqual(["1", "3"]);
  });

  it("throws when no instruction resolves to a wire to cut", async () => {
    // A color mentioned that matches nothing in the (fabricated) grid.
    const wires = [{ colors: ["blue"] }, { colors: ["white"] }, { colors: ["blue"] }, { colors: ["white"] }];
    const paper = wireGamePaper(["Cut all wires colored YELLOW."], wires);
    const { dom } = fakeDomUtils(paper);
    await expect(wireCuttingSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/no wires to cut/i);
  });

  it("throws when the wire grid cannot be found", async () => {
    const paper = fakeGamePaper([{ tag: "h4", text: "Cut the wires with the following properties! (keyboard 1 to 9)" }]);
    const { dom } = fakeDomUtils(paper);
    await expect(wireCuttingSolver.solve(paper as unknown as Document, dom)).rejects.toThrow(/could not find wire grid/i);
  });
});
