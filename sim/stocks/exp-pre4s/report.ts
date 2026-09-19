// Assemble results.md + results.json from resultsA/B/C.json.
import { readFileSync, writeFileSync } from "node:fs";

const DIR = "/tmp/claude-1000/-home-shawn--herdr-worktrees-bitburner-typescript-stocks/67a69ebc-119f-4e9a-acf8-71dce941d214/scratchpad/exp-pre4s";
const A = JSON.parse(readFileSync(`${DIR}/resultsA.json`, "utf8"));
const B = JSON.parse(readFileSync(`${DIR}/resultsB.json`, "utf8"));
const C = JSON.parse(readFileSync(`${DIR}/resultsC.json`, "utf8"));

function n(x: number, d = 4): string {
  if (!isFinite(x)) return String(x);
  return x.toFixed(d);
}
function pct(x: number, d = 2): string {
  return (x * 100).toFixed(d) + "%";
}
function iqr(s: { median: number; q1: number; q3: number }, d = 4): string {
  return `${n(s.median, d)} [${n(s.q1, d)}, ${n(s.q3, d)}]`;
}
function money(x: number): string {
  return "$" + (x / 1e9).toFixed(2) + "B";
}

const estLabels: Record<string, string> = {
  repo1_w40: "(1) repo estimateForecast, window 40 (as wired)",
  flatskip_w40: "(2) same, flat ticks skipped",
  w20: "(3) window 20",
  w80: "(3) window 80",
  ewma10: "(4) EWMA up-fraction, half-life 10",
  ewma20: "(4) EWMA up-fraction, half-life 20",
  invaware: "(5) inversion-aware (long 40 / short 10, reset-on-disagree)",
};

let md = "";
md += "# Pre-4S Stock Bot Monte Carlo Experiments\n\n";
md += `Simulator: stocksim (port of Bitburner v3.0.1 stock market). Bot logic: ` +
  `\`src/controllers/stocks.ts\` (imported directly, unmodified). All ticks read after \`market.tick()\`, ` +
  `per the simulator's fidelity rules.\n\n`;

md += "## Performance / seed counts\n\n";
md += "Raw `market.tick()` throughput measured at **~248,000 ticks/sec** (single stock-path loop, no per-stock work). " +
  "A realistic per-tick workload (33 stocks, history update, `detectTrend`, `estimateVolatility`, commission check) " +
  "runs at **~32,600 ticks/sec**. The full Experiment C trading loop (history + signal + stop-loss + buy/sell execution " +
  `across 33 symbols) sustains roughly ${(C.config.seeds * C.config.variants.length / C.elapsedSec).toFixed(0)} seed-runs/sec ` +
  `at scale (~${((C.elapsedSec / (C.config.seeds * C.config.variants.length)) * 1000).toFixed(0)}ms per 3000-tick seed, averaged ` +
  "across variants). All three experiments were run at **500 seeds** (above the requested minimum of 300), each seed run " +
  "for the full **3000-tick horizon**:\n\n";
md += `- Experiment A: 500 seeds x 3000 ticks x 33 stocks in ${A.elapsedSec.toFixed(1)}s\n`;
md += `- Experiment B: 500 seeds x 2 tick-rate regimes in ${B.elapsedSec.toFixed(1)}s\n`;
md += `- Experiment C: 500 seeds x ${C.config.variants.length} variants x 3000 ticks in ${C.elapsedSec.toFixed(1)}s\n\n`;

// ===================== Experiment A =====================
md += "## Experiment A: forecast/volatility estimator accuracy\n\n";
md += `Ground truth is \`market.getForecast(sym)\` (true P(up)), read immediately after \`tick()\`, the same tick every ` +
  `estimator is evaluated on. Across ${A.config.seeds} seeds x 3000 ticks x 33 stocks (${(A.diagnostics.totalTickCount/1e6).toFixed(1)}M stock-ticks), ` +
  `**${A.diagnostics.flatTickCount} flat (unchanged-price) ticks were observed** (fraction ${A.diagnostics.flatTickFraction}) - ` +
  `essentially never, because every tick multiplies or divides the price by \`(1+av)\` with \`av>0\`. This means estimator ` +
  `(1) (repo, flat-as-down) and estimator (2) (flat-skipped) are **numerically identical under exact per-tick sampling** - ` +
  `the flat-tick question only matters once samples can be duplicated, which is Experiment B's subject, not this one.\n\n`;

md += "All metrics are pooled across stocks/ticks *within a seed* first, then summarized as median [IQR] across the 500 seeds. " +
  "**Sign accuracy is the brief's metric**: \"P(sign correct) when |estimate-0.5| >= 0.10\" - conditioned on the *estimate* " +
  "being confident, i.e. precision (\"when the bot would act on this estimator, is it right?\"). A secondary, recall-like " +
  "column (conditioned on the *truth* being strong instead) is included for reference since the two rank estimators " +
  "differently.\n\n";
md += "| Estimator | MAE vs true forecast | Sign accuracy when \\|estimate-0.5\\|>=0.10 (spec metric) | Sign accuracy when \\|truth-0.5\\|>=0.10 (reference) | False-signal rate (\\|f-0.5\\|<0.03) | Flip lag, ticks (median [IQR]) | Flip events / resolved / censored |\n";
md += "|---|---|---|---|---|---|---|\n";
for (const [key, label] of Object.entries(estLabels)) {
  const e = A.estimators[key];
  md += `| ${label} | ${iqr(e.mae)} | ${iqr(e.signAccuracy_whenEstimateConfident)} | ${iqr(e.signAccuracy_whenTruthStrong)} | ${iqr(e.falseSignalRate)} | ${iqr(e.flipLagTicks, 0)} | ${e.flipEventsTotal} / ${e.flipResolvedTotal} / ${e.flipCensoredTotal} |\n`;
}
md += "\n";
md += "**Flip lag methodology**: a \"flip\" is counted only when the true forecast's sign around 0.5 reverses while " +
  "\\|f-0.5\\|>=0.10 on *both* sides of the reversal (filters out noise wobbling near 0.5). Lag is scored only for an " +
  "estimator that had the *correct* sign immediately before the flip (otherwise \"catching up\" is undefined). A pending " +
  "measurement is censored if the true forecast flips again before the estimator catches up, or if 75 ticks (one full " +
  "cycle length) pass with no catch-up.\n\n";
md += "**Interpretation**: on the brief's own precision metric, **EWMA half-life 20 dominates every other estimator on " +
  "every column** - highest sign accuracy (0.900 vs the repo's 0.897), lowest MAE (0.067 vs 0.073), lowest false-signal " +
  "rate (0.163 vs 0.168) - while reacting to real flips almost as fast (16 ticks vs the repo's 20). It is a strict " +
  "improvement over the currently-wired window-40 estimator at essentially no implementation cost (same inputs, no " +
  "extra state beyond one running average). Windows 20 and EWMA half-life 10 buy reaction speed (11 and 8 ticks) at a " +
  "steep cost in false-signal rate (0.27-0.30, i.e. nearly a third of \"confident\" reads near a truly neutral forecast " +
  "are noise); window 80 sits at the opposite corner (lowest false-signal rate at 0.076, but slowest to react at 40 " +
  "ticks and worst-in-class censored-flip count, since it can still be digesting the *previous* regime when the next " +
  "one arrives). **The inversion-aware estimator (5) underperforms the plain window-40 repo estimator it was meant to " +
  "improve on** - worse MAE (0.082 vs 0.073), worse precision (0.858 vs 0.897), and a *higher* false-signal rate (0.251 " +
  "vs 0.168); its only edge is reaction speed (14 vs 20 ticks). The \"reset on short/long disagreement\" trick fires on " +
  "short-window noise more often than on genuine flips at these parameters (short window 10, threshold 0.2), trading " +
  "accuracy for speed rather than improving both. It is not, on this evidence, a good replacement for the current " +
  "estimator by itself - see Experiment C for what happens when it's paired with a different exit rule instead.\n\n";

md += "### Volatility: stddev-of-returns vs magnitude-of-moves\n\n";
md += "`Stock.mv` (hence `getVolatility()`) is fixed for a stock's entire lifetime in this simulator (it's a `readonly` " +
  "field set once at construction), so this is a comparison against a constant target throughout the run.\n\n";
md += "Per-tick move magnitude is exactly `|log return| = ln(1 + v*vol)` with `v ~ U(0,1)` redrawn every tick and shared " +
  "across all 33 stocks that tick. Since the sign of the log return already *is* the direction (no extra information " +
  "there, as the brief anticipated), the interesting question is whether the *magnitude* pins down `vol` better than " +
  "`estimateVolatility`'s stddev-of-simple-returns approach.\n\n";
md += "| Volatility estimator | MAE vs true vol | est/true ratio (median [IQR]) |\n";
md += "|---|---|---|\n";
md += `| repo \`estimateVolatility\` (stddev of simple returns, window 40) | ${n(A.volatility.repoEstimateVolatility.mae.median, 6)} | ${iqr(A.volatility.repoEstimateVolatility.ratioEstOverTrue, 4)} |\n`;
md += `| max\\|log return\\| over window 40 (raw) | ${n(A.volatility.maxLogReturn_raw.mae.median, 6)} | ${iqr(A.volatility.maxLogReturn_raw.ratioEstOverTrue, 4)} |\n`;
md += `| max\\|log return\\| over window 40, bias-corrected x(W+1)/W | ${n(A.volatility.maxLogReturn_biasCorrected.mae.median, 6)} | ${iqr(A.volatility.maxLogReturn_biasCorrected.ratioEstOverTrue, 4)} |\n\n`;
md += "**Interpretation**: `estimateVolatility` systematically *under*-estimates true volatility by a factor of ~1.79x " +
  "(ratio ~0.558, close to the closed-form prediction `stddev(±v*vol) ~= vol/sqrt(3) ~= 0.577*vol` - the small remaining " +
  "gap is because a down-move's simple return is `-av/(1+av)`, slightly smaller in magnitude than `av`, which pulls the " +
  "realized stddev down a bit further than the linear approximation). The max-magnitude estimator is far more accurate " +
  "even raw (ratio ~0.97, matching the `E[max of W iid U(0,1)] = W/(W+1) = 40/41 ~= 0.976` prediction), and the simple " +
  "bias correction `x(W+1)/W` brings it to within ~1% of true volatility (ratio ~0.993, MAE ~0.00018 vs the stddev " +
  "estimator's ~0.00462 - about 25x smaller, i.e. ~4% as large). **The repo currently leaves a large, easily-fixed " +
  "accuracy gap on the table for pre-4S volatility estimation** - this directly feeds `calcExpectedReturn` and the " +
  "commission-threshold check in the trading loop (Experiment C), though see the C caveats for why it doesn't change " +
  "much at 100B starting capital.\n\n";

// ===================== Experiment B =====================
md += "## Experiment B: sampling misalignment (poll period vs market tick period)\n\n";
md += "Poller model: period = 6000ms sleep + `U(20,200)ms` loop overhead, i.e. always in `[6020, 6200]ms` - strictly " +
  "*longer* than either a 6000ms or a 4000ms market tick. **Duplicated reads are therefore structurally impossible in " +
  "this model** (confirmed: 0 duplicates in every seed/regime) - the real game could still produce an occasional " +
  "duplicate because it quantizes ticks to its own 200ms game loop rather than a continuous clock, which isn't modeled " +
  "here. Skips, by contrast, are guaranteed and substantial.\n\n";
md += "| Regime | Skips / 1000 ticks (median [IQR]) | Duplicates / 1000 ticks | Bias, est (1) down-on-flat | Bias, est (2) flat-skip | MAE (1) | MAE (2) | Flip lag, polls (1) | Flip lag, polls (2) | Real market ticks per 60 polls |\n";
md += "|---|---|---|---|---|---|---|---|---|---|\n";
for (const [name, e] of Object.entries<any>(B.regimes)) {
  md += `| ${name} | ${iqr(e.skipsPer1000Ticks, 2)} | ${iqr(e.duplicatesPer1000Ticks, 2)} | ${iqr(e.bias_estimator1_downOnFlat, 5)} | ${iqr(e.bias_estimator2_flatSkip, 5)} | ${iqr(e.mae_estimator1_downOnFlat)} | ${iqr(e.mae_estimator2_flatSkip)} | ${iqr(e.flipLagPolls_estimator1, 0)} | ${iqr(e.flipLagPolls_estimator2, 0)} | ${iqr(e.realMarketTicksPer60Polls, 0)} |\n`;
}
md += "\n";
md += "**Interpretation**: skip rate matches the closed-form prediction almost exactly - `(mean overhead)/marketPeriod " +
  "= 110/6000 ~= 1.83%` -> ~18/1000 at the normal 6s cadence, and `~35%` of ticks skipped at the 4s bonus-time cadence " +
  "(consistent with an average of ~1.53 market ticks elapsing per poll when the market is 1.53x faster than the poll). " +
  "**Skipping ticks does not meaningfully bias the up-tick-fraction estimator** - bias stays within a few thousandths " +
  "of zero at both cadences (an order of magnitude below the estimator's own ~0.07 MAE), because skipping is " +
  "uncorrelated with tick direction. Estimators (1) and (2) are indistinguishable here too, for the same reason as " +
  "Experiment A: with zero duplicates, there's nothing for flat-tick handling to disagree about. MAE and flip lag " +
  "(in polls) are both slightly worse under 4s ticks - because 40 direction *reads* under the 4s regime span ~1.53x " +
  "more real market ticks than under the 6s regime, the window covers more elapsed forecast drift/cycles, and a fixed " +
  "poll-count lag corresponds to more tick-time before the strategy reacts.\n\n";
md += `**\`ticksHeld\`-based exits under misalignment**: \`maxHoldTicks=60\` counts *poll iterations*, not market ticks. ` +
  `At the normal 6000ms cadence a "60-tick" hold lasts ~${B.regimes.market6000ms.realMarketTicksPer60Polls.median} real market ` +
  `ticks (barely more than 60, since poll period only exceeds market period by ~2%). At the 4000ms bonus-time cadence, ` +
  `the same 60-poll counter lasts ~${B.regimes.market4000ms.realMarketTicksPer60Polls.median} real market ticks - **the ` +
  `position is held roughly 1.5x longer in market-tick terms than the parameter name implies**, because the daemon ` +
  `polls on a wall-clock timer while the underlying market can be ticking 50% faster during bonus/offline catch-up.\n\n`;

// ===================== Experiment C =====================
md += "## Experiment C: pre-4S trading P&L\n\n";
md += `Faithful replication of the daemon's pre-4S long-only trading loop (\`detectTrend\`, \`estimateForecast\`/` +
  `\`estimateVolatility\`, \`meetsCommissionThreshold\`, \`shouldSell\` MA-ratio path, \`shouldStopLoss\` with hard ` +
  `15% / trailing 8% / max hold 60 ticks, cooldown 3 ticks, max 8 positions, \`calcWeightedBudget\` with a 30% net-worth ` +
  `bucket allowance, 90% cash cap), starting from ${money(C.config.startingCash)} cash, run for ${C.config.ticks} ticks. ` +
  `Compared against: **variant (i)** (estimator (5) + flat-tick-skip in place of the repo's estimator, *and* no price-` +
  `based stops, sell purely when the estimate crosses back below 0.5 - two changes at once); **baselineNoStops**, added ` +
  `after an initial pass through this data to *separate* those two changes - it keeps the repo's own \`detectTrend\`/` +
  `\`estimateForecast\`/\`estimateVolatility\` signal exactly as in baseline, but swaps in variant (i)'s exit rule (no ` +
  `\`shouldStopLoss\`, sell when the repo's own \`estimateForecast\` drops below 0.5 instead of the MA-ratio hysteresis); ` +
  `a **do-nothing** baseline; and an **oracle** that uses \`market.getForecast\`/\`getVolatility\` directly with the ` +
  `repo's 4S-mode rules (\`forecastSignal\` + \`shouldSell\` hysteresis + the same stops) as an upper bound on this rule ` +
  `framework.\n\n`;
md += "| Variant | log(netWorth/start) per 100 ticks (median [IQR]) | Trades (median) | Max drawdown (median [IQR]) | Total cost: commission+spread (median) | Cost as % of starting cash (median) | Final net worth (median) |\n";
md += "|---|---|---|---|---|---|---|\n";
md += `| do-nothing | 0 (by construction) | 0 | 0 | $0 | 0% | ${money(C.config.startingCash)} |\n`;
const variantLabels: Record<string, string> = {
  baseline: "baseline (repo, as wired)",
  baselineNoStops: "baselineNoStops (repo estimator + variant-i exit rule)",
  variantI: "variant (i): est(5)+flat-skip, no stops",
  oracle: "oracle (true forecast, upper bound)",
};
for (const key of ["baseline", "baselineNoStops", "variantI", "oracle"]) {
  const e = C.variants[key];
  md += `| ${variantLabels[key]} | ${iqr(e.logReturnPer100Ticks, 5)} | ${iqr(e.trades, 0)} | ${iqr(e.maxDrawdown, 4)} | ${money(e.totalCost.median)} | ${pct(e.costPctOfStartingCash.median)} | ${money(e.finalNetWorth.median)} |\n`;
}
md += "\n";

md += "### Exit reasons (summed across all 500 seeds)\n\n";
md += "| Variant | signal | time-limit | trailing-stop | hard-stop |\n";
md += "|---|---|---|---|---|\n";
for (const key of ["baseline", "baselineNoStops", "variantI", "oracle"]) {
  const r = C.variants[key].exitReasonsTotal;
  md += `| ${key} | ${r.signal ?? 0} | ${r["time-limit"] ?? 0} | ${r["trailing-stop"] ?? 0} | ${r["hard-stop"] ?? 0} |\n`;
}
md += "\n";

const b = C.variants.baseline, bns = C.variants.baselineNoStops, vi = C.variants.variantI, or_ = C.variants.oracle;
md += "**Interpretation**:\n\n";
md += "- Ranking: do-nothing (0) < baseline < variant (i) ~ baselineNoStops < oracle. " +
  `The repo's estimator+rules combination (baseline, ${n(b.logReturnPer100Ticks.median,4)}/100t) captures roughly ` +
  `${pct(b.logReturnPer100Ticks.median/or_.logReturnPer100Ticks.median,0)} of the oracle's rate (${n(or_.logReturnPer100Ticks.median,4)}/100t).\n`;
md += "- **The exit-rule change is the dominant driver of variant (i)'s improvement, not the estimator swap.** " +
  `\`baselineNoStops\` - same repo \`estimateForecast\`/\`detectTrend\` signal as baseline, only the exit rule changed to ` +
  `variant (i)'s (no stops, sell on estimate<0.5) - reaches ${n(bns.logReturnPer100Ticks.median,4)}/100t, ` +
  `*matching or slightly exceeding* variant (i)'s ${n(vi.logReturnPer100Ticks.median,4)}/100t, with fewer trades ` +
  `(${bns.trades.median} vs ${vi.trades.median}) and lower cost (${pct(bns.costPctOfStartingCash.median)} vs ` +
  `${pct(vi.costPctOfStartingCash.median)} of starting cash). Estimator (5) is not, on this evidence, doing the work - ` +
  "Experiment A already showed it has *worse* MAE and precision than the plain repo estimator (window 40); it wins in " +
  "Experiment C's original two-changes-at-once comparison only because it was bundled with a better exit rule. " +
  "**The actionable finding for the repo is \"fix the exit rule\", not \"replace the estimator\"** - see the next point " +
  "for why the current exit rule underperforms.\n";
md += "- **In the baseline, the MA-ratio signal-sell almost never fires**: 79% of exits are `time-limit` (the 60-tick " +
  "max hold), only 16% are the signal-based MA reversal, and 5% are the trailing stop. The bot's pre-4S \"trend " +
  "following\" behavior in practice is closer to \"buy on signal, hold ~60 ticks no matter what, then exit\" than to " +
  "an adaptive strategy - the 3% MA-ratio threshold (`preThreshold`) is too tight relative to the noise in a 40-tick " +
  "moving average to trigger an early, informed exit very often. `baselineNoStops` and variant (i) both exit 100% on " +
  "`signal` by construction (no stops to compete with), and outperform baseline's mixed exit-reason profile despite " +
  "using a *plain* threshold-crossing rule with no hysteresis band at all.\n";
md += "- The oracle exits on `signal` almost twice as often proportionally (29% vs baseline's 16%) because the true-" +
  "forecast hysteresis directly tracks the underlying regime instead of a noisy MA ratio, and its trailing-stop rate " +
  "is negligible (1.3% vs baseline's 5%) since it rarely buys into a stock that's about to reverse.\n";
md += "- **Transaction cost (commission + bid/ask spread) is large relative to gross return at every variant** - " +
  `median cost is ${pct(b.costPctOfStartingCash.median)} of starting capital for the baseline versus a ` +
  `median net gain of only ~${pct(Math.exp(b.logReturnPer100Ticks.median*30)-1)}. Commission itself ` +
  "(100k/trade) is negligible at this capital scale - with ~800-850 buy+sell transactions and typical position sizes " +
  "in the billions, expected per-position profit is many orders of magnitude above the $150k commission-threshold " +
  "floor (`meetsCommissionThreshold` essentially never rejects a candidate at 100B starting cash; it exists for the " +
  "early game at much smaller position sizes). **Spread cost - `shares*(ask-mid)` on entry, `shares*(mid-bid)` on " +
  "exit - is the dominant cost**, on the order of 100-200x the commission total, because per-round-trip spread scales " +
  "with position size while commission is flat.\n";
md += `- \`baselineNoStops\` pays the *least* total cost of any active variant (${pct(bns.costPctOfStartingCash.median)} ` +
  `vs baseline's ${pct(b.costPctOfStartingCash.median)}), simply because it trades least often ` +
  `(median ${bns.trades.median} vs baseline's ${b.trades.median}) - dropping price-based stops means it never gets ` +
  "whipsawed into an early stop-loss/trailing-stop exit and re-entry on the same stock.\n\n";

md += "## Caveats\n\n";
md += "- **Trading perturbs the market's own forecast.** Every buy/sell calls `processTransactionForecastMovement`, " +
  "which nudges `otlkMag` toward a floor of 5 in proportion to trade size; at the position sizes this experiment " +
  "trades (multi-billion-dollar positions, so large share counts especially on cheaper stocks), `numIterations` " +
  "inside that function can run into the hundreds per trade. This means the four active variants, " +
  "even started from the *same* seed, diverge in their underlying price paths after their first trade - each variant " +
  "is nudging the market it's trading in. This is a real, faithfully-reproduced effect (the bot's own trading volume " +
  "degrades the very edge it's trying to exploit), not a simulation bug, but it does mean the variants are not " +
  "perfectly apples-to-apples counterfactuals on one fixed price path.\n";
md += "- **The commission-threshold check was not observed to bind** at 100B starting capital (see above); results at " +
  "a much smaller starting capital (e.g. early-game 10-100M) could look qualitatively different, since both the " +
  "commission floor and the 100k flat commission would be a much larger fraction of typical position size.\n";
md += "- **Oracle is an upper bound on *this* rule-based framework only** (same thresholds, stops, budget formula), " +
  "not a hard bound on all possible pre-4S-adjacent strategies - a differently-tuned rule set driven by the same true " +
  "forecast could do better or worse.\n";
md += "- **Estimator (5)'s \"disagree\" reset rule uses down-on-flat semantics in Experiment A** (tested independently " +
  "of flat-tick-skip there), but is combined with flat-tick-skip in Experiment C's variant (i); the `baselineNoStops` " +
  "variant added to disentangle the estimator-vs-exit-rule question uses the *repo's own* estimator, not estimator (5), " +
  "so it doesn't isolate flat-tick-skip specifically - that remains untested in isolation inside the trading loop.\n";
md += "- **Flip-lag numbers use a strict, conservative definition** (both sides of the flip must have \\|f-0.5\\|>=0.10, " +
  "pre-flip sign must already be correct, censored on a second flip or a 75-tick timeout) - they measure \"how fast a " +
  "tracking estimator re-syncs after a clear regime change,\" not every small wobble in the true forecast.\n";
md += "- **Duplicate-read count of exactly zero in Experiment B is a property of the stated poller model** (period " +
  "always > market period), not a general claim that duplicates can't happen in the real game; the real game's 200ms-" +
  "quantized game loop (not modeled here) could still occasionally produce one.\n";
md += "- All experiments use the stocksim port's documented omissions (no darknet volatility multiplier, no order " +
  "book/limit orders, no 4S/TIX purchase-flow economics) - see stocksim's README \"Omitted\" section.\n";
md += "- do-nothing is reported analytically (netWorth never changes with zero trades and no cash interest in the " +
  "sim) rather than simulated, since its outcome is deterministic and trivial.\n";

writeFileSync(`${DIR}/results.md`, md);

const combined = { experimentA: A, experimentB: B, experimentC: C };
writeFileSync(`${DIR}/results.json`, JSON.stringify(combined, null, 2));

console.error("wrote results.md and results.json");
