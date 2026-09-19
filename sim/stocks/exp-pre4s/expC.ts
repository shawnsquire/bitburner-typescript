// Experiment C: pre-4S trading P&L - baseline (repo as wired) vs variantI (estimator 5 +
// flat-skip, no price-based stops) vs oracle (true forecast, same trading rules) vs a
// do-nothing baseline.
import { runVariant, STARTING_CASH, TICKS } from "./expC-engine.ts";
import type { Variant, VariantResult } from "./expC-engine.ts";
import { summarize, writeJSON, seedRange, now } from "./common.ts";

const SEED_BASE = 3_000_000;
const NUM_SEEDS = Number(process.argv[2] ?? 500);
const VARIANTS: Variant[] = ["baseline", "baselineNoStops", "variantI", "oracle"];

const seeds = seedRange(SEED_BASE, NUM_SEEDS);
const t0 = now();

const perVariant: Record<Variant, {
  logReturnPer100: number[];
  trades: number[];
  roundTrips: number[];
  maxDrawdown: number[];
  commissionPaid: number[];
  spreadCost: number[];
  totalCost: number[];
  costPctOfStart: number[];
  finalNetWorth: number[];
  exitReasons: Record<string, number>;
}> = {} as any;
for (const v of VARIANTS) {
  perVariant[v] = {
    logReturnPer100: [], trades: [], roundTrips: [], maxDrawdown: [], commissionPaid: [],
    spreadCost: [], totalCost: [], costPctOfStart: [], finalNetWorth: [], exitReasons: {},
  };
}

let doneCount = 0;
for (const seed of seeds) {
  for (const v of VARIANTS) {
    const r: VariantResult = runVariant(seed, v);
    const bucket = perVariant[v];
    bucket.logReturnPer100.push(r.logReturnPer100);
    bucket.trades.push(r.trades);
    bucket.roundTrips.push(r.roundTrips);
    bucket.maxDrawdown.push(r.maxDrawdown);
    bucket.commissionPaid.push(r.commissionPaid);
    bucket.spreadCost.push(r.spreadCost);
    bucket.totalCost.push(r.commissionPaid + r.spreadCost);
    bucket.costPctOfStart.push((r.commissionPaid + r.spreadCost) / STARTING_CASH);
    bucket.finalNetWorth.push(r.finalNetWorth);
    for (const [reason, count] of Object.entries(r.exitReasons)) {
      bucket.exitReasons[reason] = (bucket.exitReasons[reason] ?? 0) + count;
    }
  }
  doneCount++;
  if (doneCount % 50 === 0) console.error(`expC: ${doneCount}/${NUM_SEEDS} seeds done (${((now() - t0) / 1000).toFixed(1)}s)`);
}

const elapsed = now() - t0;
console.error(`expC: ${NUM_SEEDS} seeds x ${VARIANTS.length} variants x ${TICKS} ticks in ${(elapsed / 1000).toFixed(1)}s`);

const result = {
  config: {
    seeds: NUM_SEEDS, ticks: TICKS, seedBase: SEED_BASE, startingCash: STARTING_CASH,
    variants: VARIANTS, doNothing: "trivial: netWorth stays at startingCash forever (no interest); logReturn=0, trades=0, drawdown=0, cost=0 for every seed",
  },
  variants: Object.fromEntries(
    VARIANTS.map((v) => {
      const b = perVariant[v];
      return [
        v,
        {
          logReturnPer100Ticks: summarize(b.logReturnPer100),
          trades: summarize(b.trades),
          roundTrips: summarize(b.roundTrips),
          maxDrawdown: summarize(b.maxDrawdown),
          commissionPaid: summarize(b.commissionPaid),
          spreadCost: summarize(b.spreadCost),
          totalCost: summarize(b.totalCost),
          costPctOfStartingCash: summarize(b.costPctOfStart),
          finalNetWorth: summarize(b.finalNetWorth),
          exitReasonsTotal: b.exitReasons,
        },
      ];
    }),
  ),
  doNothing: { logReturnPer100Ticks: 0, trades: 0, maxDrawdown: 0, totalCost: 0 },
  elapsedSec: elapsed / 1000,
};

writeJSON("/tmp/claude-1000/-home-shawn--herdr-worktrees-bitburner-typescript-stocks/67a69ebc-119f-4e9a-acf8-71dce941d214/scratchpad/exp-pre4s/resultsC.json", result);
console.error("wrote resultsC.json");
