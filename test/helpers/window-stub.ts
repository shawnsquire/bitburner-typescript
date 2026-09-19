/**
 * Minimal `window.getComputedStyle` stub for solvers that read `globalThis["window"]`
 * once at module load time (src/lib/infiltration/solvers/{cyberpunk,minesweeper,wire-cutting}.ts).
 *
 * Import this file FIRST — before importing any of those solver modules — so
 * `globalThis.window` exists by the time their top-level `const win = ...`
 * line runs. Reads straight off FakeElement.style (see test/helpers/fake-dom.ts),
 * so a test only needs to set the relevant style properties on its fake elements.
 */
interface FakeComputedStyle {
  gridTemplateColumns: string;
  gridTemplateRows: string;
  borderWidth: string;
  borderTopWidth: string;
  paddingTop: string;
  color: string;
}

if (typeof (globalThis as unknown as { window?: unknown }).window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    getComputedStyle(el: { style?: Record<string, string> }): FakeComputedStyle {
      const style = el?.style ?? {};
      return {
        gridTemplateColumns: style.gridTemplateColumns ?? "none",
        gridTemplateRows: style.gridTemplateRows ?? "none",
        borderWidth: style.borderWidth ?? "0px",
        borderTopWidth: style.borderTopWidth ?? "0px",
        paddingTop: style.paddingTop ?? "0px",
        color: style.color ?? "",
      };
    },
  };
}
