/**
 * Reads results.json (written by run-all.ts) and writes results.md: one table per
 * experiment plus a short interpretation, and a fidelity-caveats section.
 */
import fs from "node:fs";
import { medianIQR, sumExitReasons, type RunMetrics, type MedianIQR } from "./common.ts";

const raw = JSON.parse(fs.readFileSync(new URL("./results.json", import.meta.url), "utf8")) as {
  nSeeds: number;
  seeds: number[];
  horizon: number;
  canonicalBestName: string;
  configs: Record<string, unknown>;
  results: Record<string, RunMetrics[]>;
};

function fmtMI(mi: MedianIQR, decimals = 4): string {
  return `${mi.median.toFixed(decimals)} [${mi.q1.toFixed(decimals)}, ${mi.q3.toFixed(decimals)}]`;
}
function fmtPctMI(mi: MedianIQR, decimals = 2): string {
  return `${(mi.median * 100).toFixed(decimals)}% [${(mi.q1 * 100).toFixed(decimals)}%, ${(mi.q3 * 100).toFixed(decimals)}%]`;
}
function field(runs: RunMetrics[], f: keyof RunMetrics): MedianIQR {
  return medianIQR(runs.map((r) => r[f] as number));
}

interface TableRow {
  name: string;
  runs: RunMetrics[];
}

function mainTable(rows: TableRow[]): string {
  const header =
    "| Config | log-return/100t (median [IQR]) | Max DD (median) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) | otlkMag erosion (median) |\n" +
    "|---|---|---|---|---|---|---|---|";
  const lines = rows.map((r) => {
    const lr = field(r.runs, "logReturnPer100Ticks");
    const dd = field(r.runs, "maxDrawdown");
    const rt = field(r.runs, "roundTrips");
    const cost = field(r.runs, "costPctOfStart");
    const idle = field(r.runs, "idleCashFraction");
    const zero = field(r.runs, "zeroPositionFraction");
    const erosion = field(r.runs, "erosion");
    return `| ${r.name} | ${fmtMI(lr, 5)} | ${fmtPctMI(dd)} | ${rt.median} | ${cost.median.toFixed(2)}% | ${(idle.median * 100).toFixed(1)}% | ${(zero.median * 100).toFixed(1)}% | ${erosion.median.toFixed(2)} |`;
  });
  return [header, ...lines].join("\n");
}

function exitReasonTable(rows: TableRow[]): string {
  const allReasons = new Set<string>();
  const sums = rows.map((r) => {
    const s = sumExitReasons(r.runs);
    Object.keys(s).forEach((k) => allReasons.add(k));
    return s;
  });
  const reasons = [...allReasons].sort();
  const header = `| Config | ${reasons.join(" | ")} | Total |\n|---|${reasons.map(() => "---").join("|")}|---|`;
  const lines = rows.map((r, i) => {
    const s = sums[i];
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    return `| ${r.name} | ${reasons.map((rr) => s[rr] ?? 0).join(" | ")} | ${total} |`;
  });
  return [header, ...lines].join("\n");
}

function capacityTable(rows: TableRow[]): string {
  const header = "| Config | Capacity utilization (median mean-per-run) | Capped-buy fraction (median) |\n|---|---|---|";
  const lines = rows.map((r) => {
    const cap = medianIQR(r.runs.map((x) => x.capacityUtilization ?? 0));
    const capped = medianIQR(r.runs.map((x) => x.cappedBuyFraction ?? 0));
    return `| ${r.name} | ${(cap.median * 100).toFixed(1)}% | ${(capped.median * 100).toFixed(1)}% |`;
  });
  return [header, ...lines].join("\n");
}

const R = raw.results;
function rows(names: string[]): TableRow[] {
  return names.map((n) => ({ name: n, runs: R[n] }));
}

const md: string[] = [];
md.push(`# 4S Stock Strategy Monte Carlo Backtest Results`);
md.push("");
md.push(
  `Seeds: ${raw.nSeeds} (fixed list, same seeds reused across every config so paths are ` +
    `paired at t=0 - see caveats). Horizon: ${raw.horizon} ticks (5 game-hours). ` +
    `Primary metric: ln(netWorth_end/netWorth_start) * 100 / ${raw.horizon} ("log-return per 100 ticks").`,
);
md.push("");

md.push(`## Experiment 1: Daemon profiles (moderate/aggressive/conservative), 30% bucket, 100b cash, shorting off`);
md.push("");
md.push(mainTable(rows(["exp1-moderate", "exp1-aggressive", "exp1-conservative"])));
md.push("");
md.push(`Exit reasons (sum across all ${raw.nSeeds} seeds):`);
md.push("");
md.push(exitReasonTable(rows(["exp1-moderate", "exp1-aggressive", "exp1-conservative"])));
md.push("");
md.push(
  `**Interpretation:** all three profiles hold at most 30% of net worth in stocks (the budget ` +
    `bucket ceiling), and in practice all three sit well under even that: exp1-moderate's median ` +
    `idle-cash fraction is 81.6%, i.e. it deploys only ~18% of net worth on average, not the full ` +
    `30% the bucket allows. \`calcWeightedBudget\`'s 2x-equal-share cap (at most 2/maxPositions of ` +
    `the allowance per position) plus \`meetsCommissionThreshold\` skipping thin candidates leave ` +
    `real headroom unused even before any position-count limit binds - see exp2-budget-allin for ` +
    `how much more there is to deploy. Given that, the profile differences here show up in trade ` +
    `quality, not deployment. Conservative's wider stop/hold-time bands and higher entry bar trade ` +
    `less often for a similar or better return per unit of churn; aggressive trades most and pays ` +
    `the most in spread+commission for it. See exp2 for which single lever moves the needle.`,
);
md.push("");

const exp2Names = [
  "exp1-moderate",
  "exp2-hardStop=0",
  "exp2-trailing=0",
  "exp2-maxHoldTicks=0",
  "exp2-sellCooldownTicks=0",
  "exp2-sellForecastDeviation=0",
  "exp2-maxPositions=33",
  "exp2-budget-allin",
  "exp2-all-ablated",
  "exp2-fillprice-stops",
];
md.push(`## Experiment 2: Ablations of moderate (exp1-moderate is the baseline row)`);
md.push("");
md.push(mainTable(rows(exp2Names)));
md.push("");
md.push(exitReasonTable(rows(exp2Names)));
md.push("");
md.push(
  `**Interpretation:** two of the seven single-lever ablations (\`hardStop=0\`, ` +
    `\`sellForecastDeviation=0\`) are measured as **bit-for-bit identical** to the baseline across ` +
    `all 200 seeds - not sampling noise, but two structural facts about this market model:\n` +
    `  1. \`hard-stop\` (15% from entry) never fires with these defaults because \`trailing-stop\` ` +
    `(8% from peak) is always at least as tight - peak >= entry always, so the trailing trigger ` +
    `price is never below the hard-stop trigger price. The baseline's own exit-reason row already ` +
    `shows \`hard-stop: 0\`; disabling a lever that never fired changes nothing.\n` +
    `  2. \`sellForecastDeviation\` (the buy/sell hysteresis band) is close to inert for this ` +
    `position population because most bullish-to-bearish forecast crossings are not gradual drift ` +
    `- they're the market's periodic bull/bear flip (\`stockMarketCycle\`, 45% chance per stock ` +
    `every 75 ticks), which flips \`b\` and jumps the forecast from \`50+otlkMag\` straight to ` +
    `\`50-otlkMag\` in one tick without otlkMag itself changing. A direct measurement (50 seeds x ` +
    `33 stocks x 3000 ticks) found the median downward crossing of the 0.5 line jumps by 0.134 in a ` +
    `single tick, and 73% of crossings jump by >=0.05 - large enough to skip clean over any ` +
    `hysteresis band this size. Since \`minForecastDeviation=0.10\` only lets the daemon buy ` +
    `positions with otlkMag >= 10 in the first place (a >=20-point round-trip flip), most held ` +
    `positions exit via a flip that a +/-5-point hysteresis band can't catch mid-flight. A much ` +
    `wider band (see exp3's hysteresis variant note) would be needed to matter.\n` +
    `  \`maxPositions=33\` removes the diversification cap entirely, but \`calcWeightedBudget\` ` +
    `divides the bucket allowance by \`maxPositions\` for its equal-share baseline, so raising it ` +
    `to 33 also shrinks the per-position budget cap (2x an equal 1/33 share) - read this row as ` +
    `"more, smaller positions", not "more capital deployed"; it's the worst-performing single ` +
    `ablation here.\n` +
    `  **\`maxHoldTicks=0\` is the standout: a Pareto improvement over baseline** - higher return ` +
    `(0.0214 vs 0.0164), *lower* max drawdown (0.51% vs 0.54%), and much lower cost (5.80% vs ` +
    `15.18%), because \`time-limit\` was responsible for 44,371 of the baseline's 64,129 exits (69%) ` +
    `- most positions were being force-closed by the 60-tick clock rather than by price action, and ` +
    `letting them run to a real signal/trailing exit instead both trades less and trades better.\n` +
    `  \`budget-allin\` (allowance = cash, no 30%-of-net-worth ceiling) is the single biggest lever ` +
    `on absolute deployment and thus on return and drawdown (idle cash falls from 82% to 45%). ` +
    `\`all-ablated\` stacks every ablation including allin capital, landing between the two - the ` +
    `maxHoldTicks removal and the allin capital effects don't simply add (fewer, longer-held ` +
    `positions need less frequent capital turnover to begin with). \`fillprice-stops\` swaps the ` +
    `ongoing peak/stop-loss comparison price from mid to bid(long)/ask(short); the effect is in the ` +
    `noise at this sample size (essentially identical to baseline) - the spread here is small ` +
    `relative to the 8-15% stop bands.`,
);
md.push("");

const exp3Names = [
  "exp3-baseline",
  "exp3-entry0.05",
  "exp3-entry0.15",
  "exp3-spreadaware-H25",
  "exp3-spreadaware-H50",
  "exp3-spreadaware-H100",
  "exp3-diversified-N4",
  "exp3-diversified-N8",
  "exp3-hysteresis0.05",
  "exp3-allin",
];
md.push(`## Experiment 3: Canonical 4S strategy variants, same capital settings as exp1 (except exp3-allin)`);
md.push("");
md.push(mainTable(rows(exp3Names)));
md.push("");
md.push(exitReasonTable(rows(exp3Names)));
md.push("");
md.push(
  `**canonical-best (by median log-return/100t among the bucket-capital variants): \`${raw.canonicalBestName}\`.** ` +
    `Its config is reused verbatim (only \`startCash\`/\`canShort\` overridden) for experiments 4 and 5 below.`,
);
md.push("");
md.push(
  `**Interpretation:** at the same 30%-bucket capital ceiling as exp1, the canonical baseline ` +
    `(0.0504 log-return/100t) modestly out-earns daemon-moderate (0.0164, exp1) - roughly 3x, not ` +
    `the ~4x an earlier (buggy) version of this harness reported. The gap comes from redeploying ` +
    `capital the instant forecast crosses back rather than holding through \`maxHoldTicks\`, not ` +
    `from trading more capital: canonical's idle-cash fraction (66.5%) is close to exp2-all-ablated's ` +
    `(70.5%, same capital settings, daemon logic, \`maxHoldTicks\` also removed) once both are sized ` +
    `correctly, and its round-trip count (26) is far below the daemon's (319) - fewer, larger, ` +
    `better-timed trades, at a materially higher cost-per-trade and drawdown (2.95% vs ` +
    `exp1-moderate's 0.54%). ` +
    `\`hysteresis0.05\` is bit-for-bit identical to the plain 0.5 exit for the same structural ` +
    `reason as exp2's \`sellForecastDeviation=0\` row - most crossings of the 0.5 line are instant ` +
    `bull/bear flips wide enough to jump straight past a 5-point hysteresis band (see exp2 for the ` +
    `measurement). \`entry0.05\` and \`spread-aware\` (H25/H50/H100) land in a tight cluster ` +
    `(0.0537-0.0539) a bit above the \`entry0.10\` baseline - all three let in more/weaker ` +
    `candidates than the 0.10 default, and the extra volume pays for the weaker average edge at ` +
    `this capital level; \`entry0.15\` trades least (18 round trips) and returns least (0.0447). ` +
    `H50 and H100 are themselves bit-for-bit identical: the spread/commission hurdle divides the ` +
    `expected-return bar by H, so once H is large enough that the hurdle stops binding for almost ` +
    `every candidate, raising it further changes no decision; H25's tighter hurdle filters a ` +
    `handful more marginal candidates and comes in just under the two. \`diversified\` (N=4, N=8) ` +
    `is dominated by everything else here - capping each position at 1/N of the bucket allowance ` +
    `throttles deployment (idle cash 74-82%, worse than the baseline's own 66.5%) for a drawdown ` +
    `reduction that isn't worth its cost in return. \`allin\` is the standout row: with the ` +
    `30%-of-net-worth ceiling removed it deploys 89% of net worth on average (idle cash 11.0%, ` +
    `vs. baseline's 66.5%) and more than doubles the bucket-capped return (0.1047 vs 0.0504) for a ` +
    `roughly proportional increase in drawdown (5.77% vs 2.95%) - see exp4 for how that scales with ` +
    `absolute capital.`,
);
md.push("");

md.push(`## Experiment 4: Capital sensitivity`);
md.push("");
for (const strat of ["daemon-moderate", "daemon-all-ablated", "canonical-best"]) {
  md.push(`### ${strat}`);
  md.push("");
  const names = [1e9, 10e9, 100e9, 1e12, 10e12].map((c) => `exp4-${strat}-cash${c}`);
  md.push(mainTable(rows(names)));
  md.push("");
  md.push(`Capacity (does the maxShares cap bind at high capital?):`);
  md.push("");
  md.push(capacityTable(rows(names)));
  md.push("");
}
md.push(
  `**Interpretation:** all three strategies get *worse* per-100-tick returns as capital grows, ` +
    `and it's a capacity story, not a strategy-quality story. \`maxShares\` per stock is fixed; ` +
    `the daemon's bucket allowance and canonical's cash-limited buys both grow with net worth, but ` +
    `neither can put more than \`maxShares\` into any one symbol. Capacity utilization confirms it: ` +
    `daemon-moderate's capped-buy fraction is ~0% up to 100b, then 4% at 1T, then 88% at 10T; ` +
    `canonical-best (which concentrates capital into fewer, larger positions) starts hitting the ` +
    `cap earlier - 3% capped at 10b, 12% at 100b, 31% at 1T, 94% at 10T. Idle cash tells the same ` +
    `story from the other side: daemon-moderate's idle-cash fraction rises from 80% (1b) to 96% ` +
    `(10T) as capital it structurally cannot deploy piles up; canonical-best's rises more gently ` +
    `(65% to 77%) since it's already spending most of what it can at every level up to the cap. ` +
    `canonical-best keeps a clear edge over both daemon variants at every capital level, including ` +
    `at 10T where every strategy is mostly capacity-bound (0.0134 canonical-best vs 0.0032 ` +
    `daemon-moderate vs 0.0089 daemon-all-ablated log-return/100t) - interestingly canonical-best's ` +
    `round-trip count *rises* sharply at 10T (276, vs 37 at 100b) as capacity forces it to keep ` +
    `re-entering small residual room instead of making one clean large buy. Practical implication ` +
    `for the real game: past roughly 1T cash with the 33-stock 4S market, no amount of strategy ` +
    `improvement recovers the return rate available at 100b-1T - the market itself is out of ` +
    `capacity.`,
);
md.push("");

md.push(`## Experiment 5: Shorting on vs off (100b cash)`);
md.push("");
md.push(
  mainTable(
    rows([
      "exp5-daemon-moderate-short-off",
      "exp5-daemon-moderate-short-on",
      "exp5-canonical-best-short-off",
      "exp5-canonical-best-short-on",
    ]),
  ),
);
md.push("");
md.push(
  `**Interpretation:** shorting helps both strategies, but by very different amounts. ` +
    `daemon-moderate gets a clean win on both axes: return +28.6% (0.0210 vs 0.0164), round trips ` +
    `+49.5% (477 vs 319, more qualifying candidates now that bear signals are tradeable), and max ` +
    `drawdown *lower* (0.46% vs 0.54%). canonical-best's effect is much smaller and mostly shows up ` +
    `as reduced risk, not more return: return +2.2% (0.0551 vs 0.0539), round trips essentially flat ` +
    `(38 vs 37 - canonical was already trading most of the strong signals it could find on the long ` +
    `side alone), but max drawdown drops 27% (3.38% vs 4.64%). The asymmetry makes sense given each ` +
    `strategy's own bottleneck: the daemon is candidate-starved (\`minForecastDeviation=0.10\` + ` +
    `\`maxPositions=8\` leaves headroom - shorting simply doubles its opportunity set), while ` +
    `canonical-best is capital-starved at 100b (idle cash already only ~66%, and it ranks by ` +
    `\`|expectedReturn|\` regardless of direction) - adding shorts mostly swaps in some bear trades ` +
    `for weaker bull ones rather than adding net new volume, which smooths the equity curve without ` +
    `moving the return much. Bull and bear forecasts in this sim are symmetric by construction ` +
    `(\`getForecast\` is \`(50+/-otlkMag)/100\`, and \`stockMarketCycle\`'s flip is symmetric too); ` +
    `this sim also has no equivalent of the live game's occasional extreme upside runs (only a soft ` +
    `price cap, which limits upside more than downside), so a short book's textbook unbounded-loss ` +
    `risk doesn't show up here as a drawdown cost - treat "shorting doesn't increase drawdown" as ` +
    `somewhat specific to this simulator's price process, not necessarily to the live game.`,
);
md.push("");

md.push(`## otlkMag erosion from the strategy's own trading`);
md.push("");
md.push(
  "| Strategy | Median total otlkMag erosion over 3000 ticks (100b, bucket capital, shorting off) |\n|---|---|\n" +
    `| daemon-moderate | ${medianIQR(R["exp1-moderate"].map((r) => r.erosion)).median.toFixed(2)} |\n` +
    `| canonical-best (${raw.canonicalBestName}) | ${medianIQR(R[raw.canonicalBestName]?.map((r) => r.erosion) ?? R["exp3-baseline"].map((r) => r.erosion)).median.toFixed(2)} |`,
);
md.push("");
md.push(
  `otlkMag erosion = sum over every trade of (otlkMag before - otlkMag after), read from ` +
    `\`market.getStockState(sym).otlkMag\` immediately either side of the \`buy*\`/\`sell*\` call ` +
    `(this is the simulator-analysis backdoor the stocksim README calls out - legitimate for this ` +
    `measurement, not for the strategies' own decisions, which never read it). A positive number ` +
    `means the strategy's own churn is, on net, pulling every stock's forecast magnitude toward ` +
    `neutral (50/50) - self-inflicted alpha decay. canonical-best erodes forecasts ~1.4x more in ` +
    `total than daemon-moderate (47.18 vs 33.81) while making ~8.6x *fewer* round trips (37 vs 319, ` +
    `exp3/exp1 medians) - implying roughly 12x more erosion per trade. ` +
    `\`processTransactionForecastMovement\`'s influence scales with shares traded relative to each ` +
    `stock's \`shareTxForMovement\`, and canonical-best concentrates cash into fewer, much larger ` +
    `positions (no \`maxPositions\`-driven fragmentation, and no diversification cap in its ` +
    `\`canonical-best\` config), so each of its trades moves far more shares and erodes far more ` +
    `forecast per trade, even though it trades much less often in absolute terms.`,
);
md.push("");

md.push(`## Harness fidelity notes and caveats`);
md.push("");
md.push(
  `- **Budget bucket timing.** The real system has the stocks daemon (6s tick) and the budget ` +
    `daemon (2s tick) as separate processes; the budget daemon's \`portfolioValue\` for the ` +
    `\`stocks\` bucket allowance is one stocks-daemon-publish behind (and that publish itself uses ` +
    `positions read before that tick's sells). This harness computes \`tradingCapital\` ` +
    `synchronously every tick from the *current* tick's pre-trade positions - no cross-process lag. ` +
    `Effect is expected to be small (portfolioValue moves slowly relative to a single tick) but is ` +
    `not measured directly.\n` +
    `- **4S access from tick 1, no API purchase flow.** The TIX/4S API purchase gating, the ` +
    `wse-access budget carve-out, and pre-4S/scraped-forecast/MA-trend code paths are out of scope ` +
    `per the task brief; the harness always has full 4S access.\n` +
    `- **Smart mode and hack-daemon awareness are omitted** (no hack daemon exists in the sim; the ` +
    `task brief calls smart mode inert/wrong).\n` +
    `- **Same seed does not mean identical market path across strategies once trading starts.** The ` +
    `RNG draw count per tick is fixed and state-independent, but every buy/sell/short/cover calls ` +
    `\`processTransactionForecastMovement\`, which changes \`otlkMag\`/\`otlkMagForecast\` and hence ` +
    `the stock's own future price/forecast drift. Two strategies given the same seed see identical ` +
    `markets only up to the first tick either one of them trades a given symbol - after that, ` +
    `paths for that symbol diverge. This is expected and is exactly what the otlkMag-erosion metric ` +
    `is measuring, not a harness bug.\n` +
    `- **Canonical's entry ranking is recomputed fresh every tick**, including for symbols already ` +
    `held below \`maxShares\` - it will keep adding to a winning position tick after tick as long as ` +
    `cash and headroom remain, which is the "buy as many shares as cash allows" spec taken literally. ` +
    `No artificial minimum-trade-size floor was added; in practice the integer-share floor in ` +
    `\`calculatePositionSize\`-equivalent sizing already prevents sub-share dust trades once the ` +
    `capital pool is mostly deployed.\n` +
    `- **\`canonical-best\` was chosen from the bucket-capital exp3 variants only** (excluding ` +
    `\`exp3-allin\`, which is a capital-axis comparison, not a trading-logic variant) by median ` +
    `primary metric, then carried into experiments 4 and 5 unchanged except for \`startCash\`/` +
    `\`canShort\`.\n` +
    `- **Idle-cash fraction** is \`mean(cash / netWorth)\` sampled once per tick after that tick's ` +
    `trades - a continuous measure of underdeployment, not a binary "any cash sitting idle" flag. ` +
    `\`zero-position-ticks %\` is the complementary binary measure (fraction of ticks with no open ` +
    `position at all).\n` +
    `- **Cost accounting** is \`|fill price - mid price| * shares + 100,000\` per executed trade, ` +
    `summed over the run and expressed as a percent of starting net worth. This captures spread ` +
    `and commission together (the task's "total spread+commission paid").\n` +
    `- **Canonical position sizing charges the actual per-share cost (ask for a long, bid for a ` +
    `short), reserves the commission, and decrements a running per-tick allowance pool as each ` +
    `candidate is filled**, rather than sizing off the mid price and re-applying the full per-tick ` +
    `allowance to every candidate in turn. An earlier version of this harness did the latter, which ` +
    `(a) let bucket-mode runs deploy 2-3x their intended 30% ceiling per tick before cash ran out, ` +
    `inflating canonical's return relative to the daemon at the "same capital settings", and (b) ` +
    `made \`allin\` mode nearly non-functional (\`floor(cash/mid)*ask + commission > cash\` almost ` +
    `always, so the only buys that succeeded were ones capped by \`maxShares\` headroom - ` +
    `\`cappedBuyFraction: 1\` in that mode). All exp3/4/5 canonical numbers in this report are from ` +
    `the corrected sizing.\n` +
    `- All controller functions (\`forecastSignal\`, \`shouldSell\`, \`shouldStopLoss\`, ` +
    `\`updatePeakPrice\`, \`calcWeightedBudget\`, \`calculatePositionSize\`, ` +
    `\`meetsCommissionThreshold\`, \`TRADING_PROFILES\`) are imported directly from ` +
    `\`src/controllers/stocks.ts\` with zero modification - the daemon harness is calling the exact ` +
    `same pure functions the real daemon calls, wired the same way (see \`harness.ts\` inline ` +
    `comments against \`daemons/stocks.ts\` line numbers).`,
);
md.push("");

fs.writeFileSync(new URL("./results.md", import.meta.url), md.join("\n"));
console.error("Wrote results.md");
