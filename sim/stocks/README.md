# Stock market simulator and backtests

Offline Monte Carlo tooling for the stocks daemon. Nothing here ships into the game
or is covered by the repo typecheck, lint or vitest; it runs directly on Node 24's
native TypeScript stripping (`node file.ts`, explicit `.ts` import extensions, no
enums). No dependencies.

| Directory | Contents |
|---|---|
| `stocksim/` | Line-by-line port of the game's `src/StockMarket/*` at v3.0.1 with a seeded RNG. `node stocksim/validate.ts` (also `npm run sim`) must print `All checks PASSED`. Read `stocksim/README.md` for the API and what is omitted. |
| `exp-4s/` | 4S-mode backtests: the daemon's tick loop replayed with the real `src/controllers/stocks.ts` functions (`harness.ts`), the canonical rank-and-fill strategy (`canonical.ts`), ablations, capital sweep, shorting. `node exp-4s/run-all.ts` regenerates `results.md` in a few minutes; the 3.5 MB raw `results.json` it writes is not committed. |
| `exp-pre4s/` | Pre-4S estimator accuracy, poll misalignment, and trading P&L (`expA.ts`, `expB.ts`, `expC.ts`). |
| `exp-manip/` | Hack/grow stock-influence dynamics (`exp1.ts` to `exp4.ts`). |
| `review-notes.md` | Condensed findings of the 2026-09-19 code review that accompanied these runs. |

The analysis these were built for is summarised in `docs/systems/stocks.md`
(strategy section). Harness files import the controller with a relative path
(`../../../src/controllers/stocks.ts`), so the experiments always test the shipped
logic.
