/**
 * RETIRED as of the stocks daemon/controller rewrite (src/daemons/stocks.ts,
 * src/controllers/stocks.ts). This script generated results.json/results.md against
 * the PRE-REWRITE controller API (TRADING_PROFILES with stopLossPercent/
 * trailingStopPercent/maxHoldTicks/maxPositions, shouldStopLoss, updatePeakPrice,
 * calcWeightedBudget, calculatePositionSize, meetsCommissionThreshold) - every one of
 * those functions was removed from src/controllers/stocks.ts in the rewrite, so this
 * script's experiment configs (profile/overrides objects) no longer describe anything
 * the current harness.ts understands.
 *
 * results.json/results.md are the pre-rewrite baseline the fidelity report cites for
 * comparison and must NOT be regenerated from the new controller (that would silently
 * replace the very numbers the comparison depends on). Deliberately not "fixed" to
 * call the new API instead: doing so would just make it a duplicate of run-v2.ts under
 * the old name, while the true old-controller baseline lives in git history if it's
 * ever needed again.
 *
 * For the post-rewrite backtests, use run-v2.ts (writes results-v2.json/results-v2.md).
 */
console.error(
  "run-all.ts is retired: it targets the pre-rewrite controller API and would " +
    "produce garbage if run against the current src/controllers/stocks.ts, silently " +
    "overwriting the results.json/results.md baseline this report cites. Use " +
    "`node run-v2.ts` instead (writes results-v2.json/results-v2.md).",
);
process.exit(1);
