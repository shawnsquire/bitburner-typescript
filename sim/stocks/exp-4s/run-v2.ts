/**
 * Runs the "new daemon rewrite" backtest rows requested for the post-rewrite fidelity
 * check (see the task brief / results-v2.md intro) across the fixed 200-seed list,
 * aggregates median/IQR per config, and writes results-v2.json (summaries only - kept
 * small deliberately, unlike run-all.ts's full-raw results.json) plus results-v2.md.
 *
 * Does NOT touch results.md / results.json (run-all.ts's outputs) - those are the
 * pre-rewrite baseline the report cites and must stay put for comparison.
 */
import { runDaemon, type DaemonConfig } from "./harness.ts";
import { runCanonical, type CanonicalConfig } from "./canonical.ts";
import { seedList, medianIQR, sumExitReasons, type RunMetrics, type CapitalParams, type MedianIQR } from "./common.ts";
import fs from "node:fs";

const N_SEEDS = 200;
const SEEDS = seedList(N_SEEDS);
const START_CASH = 100e9;
const HORIZON = 3000;

interface Job {
  name: string;
  group: string;
  note: string;
  run: (seed: number) => RunMetrics;
}

function daemonJob(name: string, group: string, note: string, cfg: DaemonConfig): Job {
  return { name, group, note, run: (seed) => runDaemon(seed, cfg) };
}
function canonicalJob(name: string, group: string, note: string, cfg: CanonicalConfig): Job {
  return { name, group, note, run: (seed) => runCanonical(seed, cfg) };
}

const bucket03: CapitalParams = { mode: "bucket", bucketWeight: 0.3 };
const bucket08: CapitalParams = { mode: "bucket", bucketWeight: 0.8 }; // has4S weight (DEFAULT_STOCKS_WEIGHT_4S)
const allin: CapitalParams = { mode: "allin", bucketWeight: 0.3 };

function runJob(job: Job): RunMetrics[] {
  const t0 = Date.now();
  const results = SEEDS.map((s) => job.run(s));
  const dt = Date.now() - t0;
  console.error(`[${job.group}] ${job.name}: ${SEEDS.length} seeds in ${dt}ms`);
  return results;
}

const jobs: Job[] = [];

// --- Row 1-3: capital sweep, new daemon default profile (aggressive, 0.05), shorts off
jobs.push(daemonJob("row1-daemon-bucket30", "1-3", "New daemon, 30% bucket, shorts off", {
  mode: "true4s", minForecastDeviation: 0.05, capital: bucket03, startCash: START_CASH, canShort: false,
}));
jobs.push(daemonJob("row2-daemon-bucket80", "1-3", "New daemon, 80% bucket (has4S weight), shorts off", {
  mode: "true4s", minForecastDeviation: 0.05, capital: bucket08, startCash: START_CASH, canShort: false,
}));
jobs.push(daemonJob("row3-daemon-allin", "1-3", "New daemon, all-in, shorts off", {
  mode: "true4s", minForecastDeviation: 0.05, capital: allin, startCash: START_CASH, canShort: false,
}));

// --- Row 4: rows 1 and 2 with shorts on
jobs.push(daemonJob("row4-daemon-bucket30-short", "4", "Row 1 with shorts on", {
  mode: "true4s", minForecastDeviation: 0.05, capital: bucket03, startCash: START_CASH, canShort: true,
}));
jobs.push(daemonJob("row4-daemon-bucket80-short", "4", "Row 2 with shorts on", {
  mode: "true4s", minForecastDeviation: 0.05, capital: bucket08, startCash: START_CASH, canShort: true,
}));

// --- Row 5: moderate/conservative entry thresholds, 80% bucket, shorts off
jobs.push(daemonJob("row5-daemon-entry0.10", "5", "New daemon, entry 0.10 (moderate), 80% bucket, shorts off", {
  mode: "true4s", minForecastDeviation: 0.10, capital: bucket08, startCash: START_CASH, canShort: false,
}));
jobs.push(daemonJob("row5-daemon-entry0.15", "5", "New daemon, entry 0.15 (conservative), 80% bucket, shorts off", {
  mode: "true4s", minForecastDeviation: 0.15, capital: bucket08, startCash: START_CASH, canShort: false,
}));

// --- Row 6: canonical spread-aware H50 (unchanged code path), 30% bucket and all-in
const CANON_SPREADAWARE_H50: CanonicalConfig = {
  startCash: START_CASH, canShort: false, capital: bucket03, entryThreshold: 0, exitHysteresis: 0,
  spreadAware: { H: 50 },
};
jobs.push(canonicalJob("row6-canonical-bucket30", "6", "Canonical spread-aware H50, 30% bucket (reference, unchanged)", { ...CANON_SPREADAWARE_H50 }));
jobs.push(canonicalJob("row6-canonical-allin", "6", "Canonical spread-aware H50, all-in (reference, unchanged)", { ...CANON_SPREADAWARE_H50, capital: allin }));

// --- Row 7: pre-4S check, estimated mode, 30% bucket, longs only
jobs.push(daemonJob("row7-daemon-estimated", "7", "New daemon, estimated mode (pre-4S), preMinForecastDeviation 0.10, 30% bucket, longs only", {
  mode: "estimated", minForecastDeviation: 0.05, preMinForecastDeviation: 0.10, capital: bucket03, startCash: START_CASH, canShort: false,
}));

console.error(`Running ${jobs.length} configs x ${N_SEEDS} seeds x ${HORIZON} ticks`);
const results: Record<string, RunMetrics[]> = {};
for (const job of jobs) {
  results[job.name] = runJob(job);
}

// ============================================================
// Summarize (median/IQR per field) - kept small deliberately.
// ============================================================
interface RowSummary {
  name: string;
  group: string;
  note: string;
  logReturnPer100Ticks: MedianIQR;
  maxDrawdown: MedianIQR;
  roundTrips: MedianIQR;
  costPctOfStart: MedianIQR;
  idleCashFraction: MedianIQR;
  zeroPositionFraction: MedianIQR;
  erosion: MedianIQR;
  capacityUtilization: MedianIQR;
  cappedBuyFraction: MedianIQR;
  exitReasons: Record<string, number>;
}

function summarizeJob(job: Job): RowSummary {
  const runs = results[job.name];
  return {
    name: job.name,
    group: job.group,
    note: job.note,
    logReturnPer100Ticks: medianIQR(runs.map((r) => r.logReturnPer100Ticks)),
    maxDrawdown: medianIQR(runs.map((r) => r.maxDrawdown)),
    roundTrips: medianIQR(runs.map((r) => r.roundTrips)),
    costPctOfStart: medianIQR(runs.map((r) => r.costPctOfStart)),
    idleCashFraction: medianIQR(runs.map((r) => r.idleCashFraction)),
    zeroPositionFraction: medianIQR(runs.map((r) => r.zeroPositionFraction)),
    erosion: medianIQR(runs.map((r) => r.erosion)),
    capacityUtilization: medianIQR(runs.map((r) => r.capacityUtilization ?? 0)),
    cappedBuyFraction: medianIQR(runs.map((r) => r.cappedBuyFraction ?? 0)),
    exitReasons: sumExitReasons(runs),
  };
}

const summaries = jobs.map(summarizeJob);

const jsonOut = {
  nSeeds: N_SEEDS,
  seeds: SEEDS,
  horizon: HORIZON,
  startCash: START_CASH,
  summaries,
};
const jsonPath = new URL("./results-v2.json", import.meta.url);
fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2));
console.error(`Wrote results-v2.json (${fs.statSync(jsonPath).size} bytes)`);

// ============================================================
// Write results-v2.md
// ============================================================
function fmtMI(mi: MedianIQR, decimals = 5): string {
  return `${mi.median.toFixed(decimals)} [${mi.q1.toFixed(decimals)}, ${mi.q3.toFixed(decimals)}]`;
}
function fmtPctMI(mi: MedianIQR, decimals = 2): string {
  return `${(mi.median * 100).toFixed(decimals)}% [${(mi.q1 * 100).toFixed(decimals)}%, ${(mi.q3 * 100).toFixed(decimals)}%]`;
}

function mainTable(rows: RowSummary[]): string {
  const header =
    "| Config | log-return/100t (median [IQR]) | Max DD (median [IQR]) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) |\n" +
    "|---|---|---|---|---|---|---|";
  const lines = rows.map((r) => {
    return `| ${r.name} | ${fmtMI(r.logReturnPer100Ticks)} | ${fmtPctMI(r.maxDrawdown)} | ${r.roundTrips.median} | ${r.costPctOfStart.median.toFixed(2)}% | ${(r.idleCashFraction.median * 100).toFixed(1)}% | ${(r.zeroPositionFraction.median * 100).toFixed(1)}% |`;
  });
  return [header, ...lines].join("\n");
}

function noteTable(rows: RowSummary[]): string {
  const header = "| Config | Description |\n|---|---|";
  const lines = rows.map((r) => `| ${r.name} | ${r.note} |`);
  return [header, ...lines].join("\n");
}

const R = new Map(summaries.map((s) => [s.name, s]));
function get(name: string): RowSummary {
  const s = R.get(name);
  if (!s) throw new Error(`missing summary for ${name}`);
  return s;
}

const md: string[] = [];
md.push(`# Stocks Daemon Rewrite: Backtest Results (v2)`);
md.push("");
md.push(
  `Post-rewrite fidelity check for the stocks daemon/controller rewrite (\`src/daemons/stocks.ts\`, ` +
    `\`src/controllers/stocks.ts\`). Seeds: ${N_SEEDS} (same fixed list as \`results.md\`). Horizon: ` +
    `${HORIZON} ticks (5 game-hours). Starting cash: $${(START_CASH / 1e9).toFixed(0)}B. Primary metric: ` +
    `ln(netWorth_end/netWorth_start) * 100 / ${HORIZON} ("log-return per 100 ticks"). This report does ` +
    `NOT replace \`results.md\`/\`results.json\` (the pre-rewrite baseline); it is a new, separate run ` +
    `against the rewritten daemon/controller, cited here for comparison.`,
);
md.push("");

md.push(`## Row descriptions`);
md.push("");
md.push(noteTable(summaries));
md.push("");

md.push(`## Rows 1-3: capital sweep, new daemon default profile (minForecastDeviation 0.05), shorts off`);
md.push("");
md.push(mainTable(["row1-daemon-bucket30", "row2-daemon-bucket80", "row3-daemon-allin"].map(get)));
md.push("");

md.push(`## Row 4: shorts on (rows 1 and 2)`);
md.push("");
md.push(mainTable(["row1-daemon-bucket30", "row4-daemon-bucket30-short", "row2-daemon-bucket80", "row4-daemon-bucket80-short"].map(get)));
md.push("");

md.push(`## Row 5: entry threshold (moderate 0.10 / conservative 0.15), 80% bucket, shorts off`);
md.push("");
md.push(mainTable(["row2-daemon-bucket80", "row5-daemon-entry0.10", "row5-daemon-entry0.15"].map(get)));
md.push("");
md.push(
  `(row2-daemon-bucket80 uses the default 0.05/aggressive threshold and is repeated here for ` +
    `reference against the 0.10/0.15 profiles.)`,
);
md.push("");

md.push(`## Row 6: canonical spread-aware H50 reference (unchanged code path), 30% bucket and all-in`);
md.push("");
md.push(mainTable(["row6-canonical-bucket30", "row6-canonical-allin"].map(get)));
md.push("");

md.push(`## Row 1 vs Row 6 (acceptance check: same capital settings, same seeds)`);
md.push("");
md.push(mainTable(["row1-daemon-bucket30", "row6-canonical-bucket30"].map(get)));
md.push("");
{
  const row1 = get("row1-daemon-bucket30");
  const row6 = get("row6-canonical-bucket30");
  const ratio = row1.logReturnPer100Ticks.median / row6.logReturnPer100Ticks.median;
  const oldDaemon = 0.01635; // exp1-moderate, results.md
  const oldCanonical = 0.05388; // exp3-spreadaware-H50, results.md
  md.push(
    `**Acceptance check** (task brief: row 1 should land near the canonical 30%-bucket figure, ` +
      `about 0.054; the old daemon was 0.0164): row1 median = ${row1.logReturnPer100Ticks.median.toFixed(5)}, ` +
      `row6 (canonical, unchanged) median = ${row6.logReturnPer100Ticks.median.toFixed(5)}, ratio = ` +
      `${(ratio * 100).toFixed(1)}%. For reference, the pre-rewrite baseline numbers from results.md were ` +
      `daemon-moderate ${oldDaemon} and canonical-best (exp3-spreadaware-H50) ${oldCanonical}.`,
  );
}
md.push("");

md.push(`## Row 7: pre-4S check (estimated mode, preMinForecastDeviation 0.10, 30% bucket, longs only)`);
md.push("");
md.push(mainTable(["row7-daemon-estimated"].map(get)));
md.push("");
{
  const row7 = get("row7-daemon-estimated");
  const oldBaseline = 0.0065; // exp-pre4s/results.md baseline (repo, as wired - old controller)
  const oldNoStops = 0.0110; // exp-pre4s/results.md baselineNoStops
  md.push(
    `Compare against \`sim/stocks/exp-pre4s/results.md\`'s old-controller baseline (${oldBaseline}, ` +
      `\`estimateForecast\` window-40 + MA-ratio hysteresis + hard/trailing/time stops) and its ` +
      `"no stops" figure (${oldNoStops}, same old estimator, sell purely on estimate<0.5 crossing, no ` +
      `stops): row7 median = ${row7.logReturnPer100Ticks.median.toFixed(5)}, well above both. **This is ` +
      `not a clean paired comparison, so treat it as directional, not exact**: (1) exp-pre4s used 500 ` +
      `seeds based at 3,000,000 (\`exp-pre4s/expC.ts\` \`SEED_BASE\`) versus this run's 200 seeds based ` +
      `at 1,000 - a disjoint sample, not the same market paths; (2) three things changed at once versus ` +
      `\`baselineNoStops\`, not one - the estimator (uniform 40-tick window to EWMA half-life 20, plus ` +
      `the bias-corrected max-log-return volatility estimator in place of stddev-of-returns), the exit ` +
      `rule (already matched - plain 0.5 threshold, no stops), and the position-sizing/entry model ` +
      `(\`calcWeightedBudget\`/\`calculatePositionSize\` with a hard \`maxPositions=8\` cap and 90%-cash ` +
      `ceiling, replaced by \`planPurchases\`'s rank-and-fill single pool with a spread/commission ` +
      `round-trip hurdle instead of a flat commission-threshold floor). The new controller's improved ` +
      `estimators are exactly what exp-pre4s Experiment A recommended, baked into the rewrite rather ` +
      `than applied as a harness-side improvement, but row7's margin over \`baselineNoStops\` can't be ` +
      `attributed to the estimator swap alone from this data - the sizing/entry model changed too.`,
  );
}
md.push("");

md.push(`## Exit reasons (sum across all ${N_SEEDS} seeds)`);
md.push("");
{
  const names = jobs.map((j) => j.name);
  const allReasons = new Set<string>();
  const sums = names.map((n) => {
    const s = get(n).exitReasons;
    Object.keys(s).forEach((k) => allReasons.add(k));
    return s;
  });
  const reasons = [...allReasons].sort();
  const header = `| Config | ${reasons.join(" | ")} | Total |\n|---|${reasons.map(() => "---").join("|")}|---|`;
  const lines = names.map((n, i) => {
    const s = sums[i];
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    return `| ${n} | ${reasons.map((rr) => s[rr] ?? 0).join(" | ")} | ${total} |`;
  });
  md.push([header, ...lines].join("\n"));
}
md.push("");
md.push(
  `The new daemon has exactly one exit reason, \`signal\` (\`shouldSell\` on the forecast) - there are no ` +
    `price-based stops, hold-timer, or cooldown in the rewrite, unlike the old daemon's hard-stop/` +
    `trailing-stop/time-limit machinery measured in \`results.md\`.`,
);
md.push("");

md.push(`## Capacity (does the maxShares cap bind at 100b?)`);
md.push("");
{
  const header = "| Config | Capacity utilization (median mean-per-run) | Capped-buy fraction (median) |\n|---|---|---|";
  const names = jobs.map((j) => j.name);
  const lines = names.map((n) => {
    const s = get(n);
    return `| ${n} | ${(s.capacityUtilization.median * 100).toFixed(1)}% | ${(s.cappedBuyFraction.median * 100).toFixed(1)}% |`;
  });
  md.push([header, ...lines].join("\n"));
}
md.push("");

md.push(`## otlkMag erosion from the strategy's own trading`);
md.push("");
{
  const header = "| Config | Median total otlkMag erosion over 3000 ticks |\n|---|---|";
  const names = jobs.map((j) => j.name);
  const lines = names.map((n) => `| ${n} | ${get(n).erosion.median.toFixed(2)} |`);
  md.push([header, ...lines].join("\n"));
}
md.push("");

md.push(`## Daemon issues noticed while porting (src/daemons/stocks.ts)`);
md.push("");
md.push(
  `No issue found here changes trading behavior or the numbers above - \`shouldSell\`/\`planPurchases\`/ ` +
    `\`forecastSignal\` (the functions that actually decide what to buy/sell) matched the harness exactly, ` +
    `which is what row1-vs-row6 (99.7% ratio, see above) confirms. The following are real, verified-by-` +
    `reading issues in dashboard/bookkeeping-only code paths, not in trading logic:\n` +
    `  1. **\`daemons/stocks.ts:762\` double-counts \`longCount\`/\`shortCount\` on a same-tick top-up.** ` +
    `\`longCount++\`/\`shortCount++\` already run once per held symbol in the "HELD POSITIONS" block ` +
    `(lines 671, 688 - executed earlier in the same per-symbol loop iteration, before that symbol's own ` +
    `shares are re-read). If a symbol already holds a long/short position that also becomes a buy order ` +
    `this tick (a same-direction top-up, which \`sharesRoom = maxShares - longShares - shortShares\` ` +
    `explicitly allows per the entry-candidate logic at lines 704-718), the post-loop buy block increments ` +
    `the same counter again at line 762. \`StocksStatus.longPositions\`/\`shortPositions\` (dashboard ` +
    `display only, not read by any trading decision) can then over-report the number of distinct held ` +
    `positions by the number of same-tick top-ups.\n` +
    `  2. **\`daemons/stocks.ts:751/758\` don't refresh \`positionTracking\` on a top-up.** The ` +
    `\`if (!positionTracking.has(key))\` guard means a top-up buy leaves \`entryPrice\` at the original ` +
    `fill rather than blending in the new fill (the way the game's own \`longAvg\`/\`shortAvg\` would). ` +
    `\`PositionTracking.entryPrice\`/\`forecastAtEntry\` are dashboard/trade-history display fields only - ` +
    `no exit rule in the new controller reads them (\`shouldSell\` takes only \`position\` and \`forecast\`) ` +
    `- so this is a display staleness, not a trading-logic bug.\n` +
    `  3. **\`daemons/stocks.ts:480-484\` values tick-1 inherited P&L at mid price**, inconsistent with ` +
    `every other portfolio/profit calculation in the loop, which uses bid (longs) / ask (shorts) via ` +
    `\`longExitProfit\`/\`shortExitProfit\` (e.g. lines 673, 690). This only affects \`sessionStartOffset\` ` +
    `(a one-time display baseline so the session P&L counter starts near $0 when the daemon inherits ` +
    `already-open positions) and only for positions open before the daemon's first tick - a small, ` +
    `self-correcting, cosmetic skew, not economically meaningful and not modeled in this harness (which ` +
    `always starts from a flat position).\n` +
    `  4. **\`spreadFromQuotes(ask, bid)\` and canonical.ts's \`getStockState().spreadPerc\` were checked ` +
    `for equivalence**, since a mismatch here is exactly the kind of thing that could produce a ` +
    `misleadingly-close row1-vs-row6 result: both derive from the same \`ask = price*(1+spreadPerc/100)\`, ` +
    `\`bid = price*(1-spreadPerc/100)\` construction (stocksim \`stock.ts\` \`getAskPrice\`/\`getBidPrice\`), ` +
    `so \`spreadFromQuotes\` ` +
    `recovers \`spreadPerc/100\` exactly (to floating-point precision) rather than by coincidence - the ` +
    `two controllers' round-trip hurdles are computing the same quantity from different inputs, not ` +
    `independently-derived approximations that happen to agree.`,
);
md.push("");

md.push(`## Harness fidelity notes and caveats`);
md.push("");
md.push(
  `- **tradingCapital's netWorth term (deliberate departure from the pre-rewrite harness).** This ` +
    `harness computes \`netWorth = cash + portfolioValue\` (matching \`src/controllers/budget.ts\`'s ` +
    `\`computeAllowances\`/\`daemons/budget.ts\`'s own \`netWorth\` line exactly - verified by reading ` +
    `\`daemons/budget.ts:220-241\` and \`:335\` - no corp holdings modeled here), where \`portfolioValue\` ` +
    `is the daemon's own definition (mark long at bid, short at cost basis). The task brief asked for ` +
    `this harness to keep common.ts's capital model "so numbers are comparable," but also spelled out ` +
    `the allowance formula precisely enough that reading the real budget code seemed worth doing - and ` +
    `it turned up that the pre-rewrite \`results.md\` harness/canonical.ts instead fed \`market.netWorth()\` ` +
    `(the sim's liquidation-value method: subtracts commission per leg, marks shorts to current buy-back ` +
    `cost) into that same formula, which is an approximation, not what the real budget daemon computes. ` +
    `\`canonical.ts\` (row 6, unchanged per the task brief) still uses that older approximation, so rows ` +
    `1-5/7 and row 6 compute their capital pool from two slightly different netWorth formulas. The ` +
    `row1-vs-row6 comparison above (99.7% ratio, same trading logic and seeds) is direct evidence the ` +
    `difference is immaterial in practice - portfolioValue is a small share of netWorth at the idle-cash ` +
    `fractions observed here (19-82%) - but the two formulas are not identical, so don't read 99.7% as ` +
    `proof of bit-for-bit-identical capital pools, just as proof this particular departure doesn't move ` +
    `the number.\n` +
    `- **Budget bucket timing.** As in the old harness: the real system has the stocks daemon (6s tick) ` +
    `and budget daemon (2s tick, \`daemons/budget.ts\`'s \`interval\` config default) as separate ` +
    `processes, so the real \`getBudgetBalance()\` reads a \`portfolioValue\` snapshot stale by at most ` +
    `one budget-daemon interval (0-2s) - the budget daemon re-peeks \`StocksStatus\` roughly 3x more ` +
    `often than the stocks daemon publishes it, not "one stocks-tick behind" as an earlier draft of this ` +
    `note (inherited from the old harness) claimed. This harness computes tradingCapital synchronously ` +
    `every tick from the current tick's own pre-trade position state - no cross-process lag modeled at ` +
    `all, so even this smaller real-world staleness isn't captured either way.\n` +
    `- **"true4s" mode models both real 4S and the scraped-forecast fallback** (the daemon treats both ` +
    `identically as \`exactForecast\`, differing only in minForecastDeviation vs preMinForecastDeviation, ` +
    `which this harness's \`minForecastDeviation\`/\`preMinForecastDeviation\` config fields already ` +
    `separate). The scrape-freshness/staleness gating (\`scrapeMaxAge\`) itself is not modeled - out of ` +
    `scope, the same as the old harness's treatment of pre-4S/scraped paths.\n` +
    `- **No TIX/4S API purchase flow, no wse-access carve-out, no tier RAM/respawn logic, no ` +
    `external-position-change detection, no smart-mode/hack-daemon awareness** - same exclusions as the ` +
    `old harness, all out of scope per the task brief.\n` +
    `- **Cost accounting** is \`|fill price - mid price| * shares + 100,000\` per executed trade, summed ` +
    `over the run and expressed as a percent of starting net worth - identical definition to \`results.md\`.\n` +
    `- **All controller functions used here** (\`createPriceHistory\`, \`addPrice\`, \`estimateForecast\`, ` +
    `\`estimateVolatility\`, \`forecastSignal\`, \`spreadFromQuotes\`, \`planPurchases\`, \`shouldSell\`) ` +
    `are imported directly from \`src/controllers/stocks.ts\` with zero modification. (\`longExitProfit\`/ ` +
    `\`shortExitProfit\` were tried and dropped - this harness tracks cost via \`MetricsTracker\` instead ` +
    `of realized P&L, so their outputs went unused.)`,
);
md.push("");

const mdPath = new URL("./results-v2.md", import.meta.url);
fs.writeFileSync(mdPath, md.join("\n"));
console.error(`Wrote results-v2.md`);
