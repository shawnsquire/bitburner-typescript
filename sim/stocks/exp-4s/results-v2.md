# Stocks Daemon Rewrite: Backtest Results (v2)

Post-rewrite fidelity check for the stocks daemon/controller rewrite (`src/daemons/stocks.ts`, `src/controllers/stocks.ts`). Seeds: 200 (same fixed list as `results.md`). Horizon: 3000 ticks (5 game-hours). Starting cash: $100B. Primary metric: ln(netWorth_end/netWorth_start) * 100 / 3000 ("log-return per 100 ticks"). This report does NOT replace `results.md`/`results.json` (the pre-rewrite baseline); it is a new, separate run against the rewritten daemon/controller, cited here for comparison.

## Row descriptions

| Config | Description |
|---|---|
| row1-daemon-bucket30 | New daemon, 30% bucket, shorts off |
| row2-daemon-bucket80 | New daemon, 80% bucket (has4S weight), shorts off |
| row3-daemon-allin | New daemon, all-in, shorts off |
| row4-daemon-bucket30-short | Row 1 with shorts on |
| row4-daemon-bucket80-short | Row 2 with shorts on |
| row5-daemon-entry0.10 | New daemon, entry 0.10 (moderate), 80% bucket, shorts off |
| row5-daemon-entry0.15 | New daemon, entry 0.15 (conservative), 80% bucket, shorts off |
| row6-canonical-bucket30 | Canonical spread-aware H50, 30% bucket (reference, unchanged) |
| row6-canonical-allin | Canonical spread-aware H50, all-in (reference, unchanged) |
| row7-daemon-estimated | New daemon, estimated mode (pre-4S), preMinForecastDeviation 0.10, 30% bucket, longs only |

## Rows 1-3: capital sweep, new daemon default profile (minForecastDeviation 0.05), shorts off

| Config | log-return/100t (median [IQR]) | Max DD (median [IQR]) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) |
|---|---|---|---|---|---|---|
| row1-daemon-bucket30 | 0.05373 [0.04860, 0.05930] | 4.35% [3.53%, 5.91%] | 37 | 21.23% | 66.8% | 0.3% |
| row2-daemon-bucket80 | 0.10131 [0.09386, 0.11105] | 5.54% [4.60%, 6.53%] | 75 | 119.63% | 19.3% | 0.2% |
| row3-daemon-allin | 0.11155 [0.10328, 0.12213] | 5.94% [4.91%, 6.94%] | 105 | 195.95% | 1.8% | 0.1% |

## Row 4: shorts on (rows 1 and 2)

| Config | log-return/100t (median [IQR]) | Max DD (median [IQR]) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) |
|---|---|---|---|---|---|---|
| row1-daemon-bucket30 | 0.05373 [0.04860, 0.05930] | 4.35% [3.53%, 5.91%] | 37 | 21.23% | 66.8% | 0.3% |
| row4-daemon-bucket30-short | 0.05404 [0.04872, 0.05921] | 3.40% [2.70%, 4.84%] | 32 | 19.12% | 66.3% | 0.4% |
| row2-daemon-bucket80 | 0.10131 [0.09386, 0.11105] | 5.54% [4.60%, 6.53%] | 75 | 119.63% | 19.3% | 0.2% |
| row4-daemon-bucket80-short | 0.10691 [0.09727, 0.11638] | 5.40% [4.67%, 6.33%] | 73 | 138.48% | 18.6% | 0.2% |

## Row 5: entry threshold (moderate 0.10 / conservative 0.15), 80% bucket, shorts off

| Config | log-return/100t (median [IQR]) | Max DD (median [IQR]) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) |
|---|---|---|---|---|---|---|
| row2-daemon-bucket80 | 0.10131 [0.09386, 0.11105] | 5.54% [4.60%, 6.53%] | 75 | 119.63% | 19.3% | 0.2% |
| row5-daemon-entry0.10 | 0.09757 [0.08958, 0.10699] | 5.06% [4.35%, 5.99%] | 42 | 88.33% | 21.3% | 0.3% |
| row5-daemon-entry0.15 | 0.08469 [0.07462, 0.09684] | 4.78% [4.07%, 5.75%] | 20 | 52.11% | 34.7% | 12.6% |

(row2-daemon-bucket80 uses the default 0.05/aggressive threshold and is repeated here for reference against the 0.10/0.15 profiles.)

## Row 6: canonical spread-aware H50 reference (unchanged code path), 30% bucket and all-in

| Config | log-return/100t (median [IQR]) | Max DD (median [IQR]) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) |
|---|---|---|---|---|---|---|
| row6-canonical-bucket30 | 0.05388 [0.04955, 0.06006] | 4.64% [3.54%, 5.87%] | 37 | 21.41% | 66.7% | 0.0% |
| row6-canonical-allin | 0.11171 [0.10361, 0.12207] | 6.03% [5.02%, 7.13%] | 103 | 196.77% | 1.1% | 0.0% |

## Row 1 vs Row 6 (acceptance check: same capital settings, same seeds)

| Config | log-return/100t (median [IQR]) | Max DD (median [IQR]) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) |
|---|---|---|---|---|---|---|
| row1-daemon-bucket30 | 0.05373 [0.04860, 0.05930] | 4.35% [3.53%, 5.91%] | 37 | 21.23% | 66.8% | 0.3% |
| row6-canonical-bucket30 | 0.05388 [0.04955, 0.06006] | 4.64% [3.54%, 5.87%] | 37 | 21.41% | 66.7% | 0.0% |

**Acceptance check** (task brief: row 1 should land near the canonical 30%-bucket figure, about 0.054; the old daemon was 0.0164): row1 median = 0.05373, row6 (canonical, unchanged) median = 0.05388, ratio = 99.7%. For reference, the pre-rewrite baseline numbers from results.md were daemon-moderate 0.01635 and canonical-best (exp3-spreadaware-H50) 0.05388.

## Row 7: pre-4S check (estimated mode, preMinForecastDeviation 0.10, 30% bucket, longs only)

| Config | log-return/100t (median [IQR]) | Max DD (median [IQR]) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) |
|---|---|---|---|---|---|---|
| row7-daemon-estimated | 0.02481 [0.01983, 0.02910] | 6.05% [5.09%, 7.41%] | 81 | 20.43% | 68.4% | 0.6% |

Compare against `sim/stocks/exp-pre4s/results.md`'s old-controller baseline (0.0065, `estimateForecast` window-40 + MA-ratio hysteresis + hard/trailing/time stops) and its "no stops" figure (0.011, same old estimator, sell purely on estimate<0.5 crossing, no stops): row7 median = 0.02481, well above both. **This is not a clean paired comparison, so treat it as directional, not exact**: (1) exp-pre4s used 500 seeds based at 3,000,000 (`exp-pre4s/expC.ts` `SEED_BASE`) versus this run's 200 seeds based at 1,000 - a disjoint sample, not the same market paths; (2) three things changed at once versus `baselineNoStops`, not one - the estimator (uniform 40-tick window to EWMA half-life 20, plus the bias-corrected max-log-return volatility estimator in place of stddev-of-returns), the exit rule (already matched - plain 0.5 threshold, no stops), and the position-sizing/entry model (`calcWeightedBudget`/`calculatePositionSize` with a hard `maxPositions=8` cap and 90%-cash ceiling, replaced by `planPurchases`'s rank-and-fill single pool with a spread/commission round-trip hurdle instead of a flat commission-threshold floor). The new controller's improved estimators are exactly what exp-pre4s Experiment A recommended, baked into the rewrite rather than applied as a harness-side improvement, but row7's margin over `baselineNoStops` can't be attributed to the estimator swap alone from this data - the sizing/entry model changed too.

## Exit reasons (sum across all 200 seeds)

| Config | signal | Total |
|---|---|---|
| row1-daemon-bucket30 | 7389 | 7389 |
| row2-daemon-bucket80 | 15142 | 15142 |
| row3-daemon-allin | 21052 | 21052 |
| row4-daemon-bucket30-short | 6653 | 6653 |
| row4-daemon-bucket80-short | 14669 | 14669 |
| row5-daemon-entry0.10 | 8386 | 8386 |
| row5-daemon-entry0.15 | 4107 | 4107 |
| row6-canonical-bucket30 | 7290 | 7290 |
| row6-canonical-allin | 20489 | 20489 |
| row7-daemon-estimated | 16001 | 16001 |

The new daemon has exactly one exit reason, `signal` (`shouldSell` on the forecast) - there are no price-based stops, hold-timer, or cooldown in the rewrite, unlike the old daemon's hard-stop/trailing-stop/time-limit machinery measured in `results.md`.

## Capacity (does the maxShares cap bind at 100b?)

| Config | Capacity utilization (median mean-per-run) | Capped-buy fraction (median) |
|---|---|---|
| row1-daemon-bucket30 | 17.1% | 11.5% |
| row2-daemon-bucket80 | 39.1% | 29.8% |
| row3-daemon-allin | 39.1% | 28.7% |
| row4-daemon-bucket30-short | 18.0% | 10.4% |
| row4-daemon-bucket80-short | 37.7% | 27.1% |
| row5-daemon-entry0.10 | 31.2% | 20.4% |
| row5-daemon-entry0.15 | 26.6% | 12.6% |
| row6-canonical-bucket30 | 18.6% | 12.4% |
| row6-canonical-allin | 81.0% | 67.8% |
| row7-daemon-estimated | 9.9% | 3.7% |

## otlkMag erosion from the strategy's own trading

| Config | Median total otlkMag erosion over 3000 ticks |
|---|---|
| row1-daemon-bucket30 | 47.12 |
| row2-daemon-bucket80 | 128.51 |
| row3-daemon-allin | 176.57 |
| row4-daemon-bucket30-short | 35.59 |
| row4-daemon-bucket80-short | 117.17 |
| row5-daemon-entry0.10 | 84.96 |
| row5-daemon-entry0.15 | 37.40 |
| row6-canonical-bucket30 | 47.18 |
| row6-canonical-allin | 175.22 |
| row7-daemon-estimated | 40.54 |

## Daemon issues noticed while porting (src/daemons/stocks.ts)

No issue found here changes trading behavior or the numbers above - `shouldSell`/`planPurchases`/ `forecastSignal` (the functions that actually decide what to buy/sell) matched the harness exactly, which is what row1-vs-row6 (99.7% ratio, see above) confirms. The following are real, verified-by-reading issues in dashboard/bookkeeping-only code paths, not in trading logic:
  1. **`daemons/stocks.ts:762` double-counts `longCount`/`shortCount` on a same-tick top-up.** `longCount++`/`shortCount++` already run once per held symbol in the "HELD POSITIONS" block (lines 671, 688 - executed earlier in the same per-symbol loop iteration, before that symbol's own shares are re-read). If a symbol already holds a long/short position that also becomes a buy order this tick (a same-direction top-up, which `sharesRoom = maxShares - longShares - shortShares` explicitly allows per the entry-candidate logic at lines 704-718), the post-loop buy block increments the same counter again at line 762. `StocksStatus.longPositions`/`shortPositions` (dashboard display only, not read by any trading decision) can then over-report the number of distinct held positions by the number of same-tick top-ups.
  2. **`daemons/stocks.ts:751/758` don't refresh `positionTracking` on a top-up.** The `if (!positionTracking.has(key))` guard means a top-up buy leaves `entryPrice` at the original fill rather than blending in the new fill (the way the game's own `longAvg`/`shortAvg` would). `PositionTracking.entryPrice`/`forecastAtEntry` are dashboard/trade-history display fields only - no exit rule in the new controller reads them (`shouldSell` takes only `position` and `forecast`) - so this is a display staleness, not a trading-logic bug.
  3. **`daemons/stocks.ts:480-484` values tick-1 inherited P&L at mid price**, inconsistent with every other portfolio/profit calculation in the loop, which uses bid (longs) / ask (shorts) via `longExitProfit`/`shortExitProfit` (e.g. lines 673, 690). This only affects `sessionStartOffset` (a one-time display baseline so the session P&L counter starts near $0 when the daemon inherits already-open positions) and only for positions open before the daemon's first tick - a small, self-correcting, cosmetic skew, not economically meaningful and not modeled in this harness (which always starts from a flat position).
  4. **`spreadFromQuotes(ask, bid)` and canonical.ts's `getStockState().spreadPerc` were checked for equivalence**, since a mismatch here is exactly the kind of thing that could produce a misleadingly-close row1-vs-row6 result: both derive from the same `ask = price*(1+spreadPerc/100)`, `bid = price*(1-spreadPerc/100)` construction (stocksim `stock.ts` `getAskPrice`/`getBidPrice`), so `spreadFromQuotes` recovers `spreadPerc/100` exactly (to floating-point precision) rather than by coincidence - the two controllers' round-trip hurdles are computing the same quantity from different inputs, not independently-derived approximations that happen to agree.

## Harness fidelity notes and caveats

- **tradingCapital's netWorth term (deliberate departure from the pre-rewrite harness).** This harness computes `netWorth = cash + portfolioValue` (matching `src/controllers/budget.ts`'s `computeAllowances`/`daemons/budget.ts`'s own `netWorth` line exactly - verified by reading `daemons/budget.ts:220-241` and `:335` - no corp holdings modeled here), where `portfolioValue` is the daemon's own definition (mark long at bid, short at cost basis). The task brief asked for this harness to keep common.ts's capital model "so numbers are comparable," but also spelled out the allowance formula precisely enough that reading the real budget code seemed worth doing - and it turned up that the pre-rewrite `results.md` harness/canonical.ts instead fed `market.netWorth()` (the sim's liquidation-value method: subtracts commission per leg, marks shorts to current buy-back cost) into that same formula, which is an approximation, not what the real budget daemon computes. `canonical.ts` (row 6, unchanged per the task brief) still uses that older approximation, so rows 1-5/7 and row 6 compute their capital pool from two slightly different netWorth formulas. The row1-vs-row6 comparison above (99.7% ratio, same trading logic and seeds) is direct evidence the difference is immaterial in practice - portfolioValue is a small share of netWorth at the idle-cash fractions observed here (19-82%) - but the two formulas are not identical, so don't read 99.7% as proof of bit-for-bit-identical capital pools, just as proof this particular departure doesn't move the number.
- **Budget bucket timing.** As in the old harness: the real system has the stocks daemon (6s tick) and budget daemon (2s tick, `daemons/budget.ts`'s `interval` config default) as separate processes, so the real `getBudgetBalance()` reads a `portfolioValue` snapshot stale by at most one budget-daemon interval (0-2s) - the budget daemon re-peeks `StocksStatus` roughly 3x more often than the stocks daemon publishes it, not "one stocks-tick behind" as an earlier draft of this note (inherited from the old harness) claimed. This harness computes tradingCapital synchronously every tick from the current tick's own pre-trade position state - no cross-process lag modeled at all, so even this smaller real-world staleness isn't captured either way.
- **"true4s" mode models both real 4S and the scraped-forecast fallback** (the daemon treats both identically as `exactForecast`, differing only in minForecastDeviation vs preMinForecastDeviation, which this harness's `minForecastDeviation`/`preMinForecastDeviation` config fields already separate). The scrape-freshness/staleness gating (`scrapeMaxAge`) itself is not modeled - out of scope, the same as the old harness's treatment of pre-4S/scraped paths.
- **No TIX/4S API purchase flow, no wse-access carve-out, no tier RAM/respawn logic, no external-position-change detection, no smart-mode/hack-daemon awareness** - same exclusions as the old harness, all out of scope per the task brief.
- **Cost accounting** is `|fill price - mid price| * shares + 100,000` per executed trade, summed over the run and expressed as a percent of starting net worth - identical definition to `results.md`.
- **All controller functions used here** (`createPriceHistory`, `addPrice`, `estimateForecast`, `estimateVolatility`, `forecastSignal`, `spreadFromQuotes`, `planPurchases`, `shouldSell`) are imported directly from `src/controllers/stocks.ts` with zero modification. (`longExitProfit`/ `shortExitProfit` were tried and dropped - this harness tracks cost via `MetricsTracker` instead of realized P&L, so their outputs went unused.)
