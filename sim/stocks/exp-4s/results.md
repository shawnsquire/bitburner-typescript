# 4S Stock Strategy Monte Carlo Backtest Results

Seeds: 200 (fixed list, same seeds reused across every config so paths are paired at t=0 - see caveats). Horizon: 3000 ticks (5 game-hours). Primary metric: ln(netWorth_end/netWorth_start) * 100 / 3000 ("log-return per 100 ticks").

## Experiment 1: Daemon profiles (moderate/aggressive/conservative), 30% bucket, 100b cash, shorting off

| Config | log-return/100t (median [IQR]) | Max DD (median) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) | otlkMag erosion (median) |
|---|---|---|---|---|---|---|---|
| exp1-moderate | 0.01635 [0.01543, 0.01798] | 0.54% [0.46%, 0.64%] | 319 | 15.18% | 81.6% | 0.1% | 33.81 |
| exp1-aggressive | 0.01385 [0.01273, 0.01489] | 0.79% [0.66%, 0.92%] | 756 | 28.51% | 78.3% | 0.0% | 95.01 |
| exp1-conservative | 0.01658 [0.01429, 0.01826] | 0.58% [0.49%, 0.69%] | 79 | 6.57% | 86.7% | 8.4% | 10.24 |

Exit reasons (sum across all 200 seeds):

| Config | signal | time-limit | trailing-stop | Total |
|---|---|---|---|---|
| exp1-moderate | 18975 | 44371 | 783 | 64129 |
| exp1-aggressive | 34178 | 100111 | 16778 | 151067 |
| exp1-conservative | 4363 | 11491 | 33 | 15887 |

**Interpretation:** all three profiles hold at most 30% of net worth in stocks (the budget bucket ceiling), and in practice all three sit well under even that: exp1-moderate's median idle-cash fraction is 81.6%, i.e. it deploys only ~18% of net worth on average, not the full 30% the bucket allows. `calcWeightedBudget`'s 2x-equal-share cap (at most 2/maxPositions of the allowance per position) plus `meetsCommissionThreshold` skipping thin candidates leave real headroom unused even before any position-count limit binds - see exp2-budget-allin for how much more there is to deploy. Given that, the profile differences here show up in trade quality, not deployment. Conservative's wider stop/hold-time bands and higher entry bar trade less often for a similar or better return per unit of churn; aggressive trades most and pays the most in spread+commission for it. See exp2 for which single lever moves the needle.

## Experiment 2: Ablations of moderate (exp1-moderate is the baseline row)

| Config | log-return/100t (median [IQR]) | Max DD (median) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) | otlkMag erosion (median) |
|---|---|---|---|---|---|---|---|
| exp1-moderate | 0.01635 [0.01543, 0.01798] | 0.54% [0.46%, 0.64%] | 319 | 15.18% | 81.6% | 0.1% | 33.81 |
| exp2-hardStop=0 | 0.01635 [0.01543, 0.01798] | 0.54% [0.46%, 0.64%] | 319 | 15.18% | 81.6% | 0.1% | 33.81 |
| exp2-trailing=0 | 0.01648 [0.01547, 0.01805] | 0.54% [0.46%, 0.62%] | 319 | 15.20% | 81.6% | 0.1% | 33.79 |
| exp2-maxHoldTicks=0 | 0.02143 [0.01993, 0.02333] | 0.51% [0.44%, 0.61%] | 113 | 5.80% | 80.0% | 0.0% | 20.72 |
| exp2-sellCooldownTicks=0 | 0.01688 [0.01568, 0.01812] | 0.51% [0.45%, 0.61%] | 323 | 15.35% | 81.2% | 0.0% | 34.00 |
| exp2-sellForecastDeviation=0 | 0.01635 [0.01543, 0.01798] | 0.54% [0.46%, 0.64%] | 319 | 15.18% | 81.6% | 0.1% | 33.81 |
| exp2-maxPositions=33 | 0.00737 [0.00679, 0.00799] | 0.24% [0.21%, 0.26%] | 343 | 6.02% | 91.8% | 0.2% | 19.13 |
| exp2-budget-allin | 0.04686 [0.04366, 0.05050] | 1.69% [1.43%, 1.99%] | 257 | 71.16% | 45.3% | 0.4% | 89.23 |
| exp2-all-ablated | 0.03114 [0.02896, 0.03430] | 0.78% [0.69%, 0.88%] | 113 | 9.46% | 70.5% | 0.0% | 27.80 |
| exp2-fillprice-stops | 0.01636 [0.01533, 0.01803] | 0.54% [0.46%, 0.64%] | 320 | 15.19% | 81.6% | 0.1% | 33.81 |

| Config | hard-stop | signal | time-limit | trailing-stop | Total |
|---|---|---|---|---|---|
| exp1-moderate | 0 | 18975 | 44371 | 783 | 64129 |
| exp2-hardStop=0 | 0 | 18975 | 44371 | 783 | 64129 |
| exp2-trailing=0 | 20 | 19023 | 44899 | 0 | 63942 |
| exp2-maxHoldTicks=0 | 0 | 21558 | 0 | 1107 | 22665 |
| exp2-sellCooldownTicks=0 | 0 | 19509 | 44658 | 803 | 64970 |
| exp2-sellForecastDeviation=0 | 0 | 18975 | 44371 | 783 | 64129 |
| exp2-maxPositions=33 | 0 | 20514 | 47537 | 923 | 68974 |
| exp2-budget-allin | 0 | 15207 | 36225 | 627 | 52059 |
| exp2-all-ablated | 0 | 22672 | 0 | 0 | 22672 |
| exp2-fillprice-stops | 0 | 18970 | 44332 | 879 | 64181 |

**Interpretation:** two of the seven single-lever ablations (`hardStop=0`, `sellForecastDeviation=0`) are measured as **bit-for-bit identical** to the baseline across all 200 seeds - not sampling noise, but two structural facts about this market model:
  1. `hard-stop` (15% from entry) never fires with these defaults because `trailing-stop` (8% from peak) is always at least as tight - peak >= entry always, so the trailing trigger price is never below the hard-stop trigger price. The baseline's own exit-reason row already shows `hard-stop: 0`; disabling a lever that never fired changes nothing.
  2. `sellForecastDeviation` (the buy/sell hysteresis band) is close to inert for this position population because most bullish-to-bearish forecast crossings are not gradual drift - they're the market's periodic bull/bear flip (`stockMarketCycle`, 45% chance per stock every 75 ticks), which flips `b` and jumps the forecast from `50+otlkMag` straight to `50-otlkMag` in one tick without otlkMag itself changing. A direct measurement (50 seeds x 33 stocks x 3000 ticks) found the median downward crossing of the 0.5 line jumps by 0.134 in a single tick, and 73% of crossings jump by >=0.05 - large enough to skip clean over any hysteresis band this size. Since `minForecastDeviation=0.10` only lets the daemon buy positions with otlkMag >= 10 in the first place (a >=20-point round-trip flip), most held positions exit via a flip that a +/-5-point hysteresis band can't catch mid-flight. A much wider band (see exp3's hysteresis variant note) would be needed to matter.
  `maxPositions=33` removes the diversification cap entirely, but `calcWeightedBudget` divides the bucket allowance by `maxPositions` for its equal-share baseline, so raising it to 33 also shrinks the per-position budget cap (2x an equal 1/33 share) - read this row as "more, smaller positions", not "more capital deployed"; it's the worst-performing single ablation here.
  **`maxHoldTicks=0` is the standout: a Pareto improvement over baseline** - higher return (0.0214 vs 0.0164), *lower* max drawdown (0.51% vs 0.54%), and much lower cost (5.80% vs 15.18%), because `time-limit` was responsible for 44,371 of the baseline's 64,129 exits (69%) - most positions were being force-closed by the 60-tick clock rather than by price action, and letting them run to a real signal/trailing exit instead both trades less and trades better.
  `budget-allin` (allowance = cash, no 30%-of-net-worth ceiling) is the single biggest lever on absolute deployment and thus on return and drawdown (idle cash falls from 82% to 45%). `all-ablated` stacks every ablation including allin capital, landing between the two - the maxHoldTicks removal and the allin capital effects don't simply add (fewer, longer-held positions need less frequent capital turnover to begin with). `fillprice-stops` swaps the ongoing peak/stop-loss comparison price from mid to bid(long)/ask(short); the effect is in the noise at this sample size (essentially identical to baseline) - the spread here is small relative to the 8-15% stop bands.

## Experiment 3: Canonical 4S strategy variants, same capital settings as exp1 (except exp3-allin)

| Config | log-return/100t (median [IQR]) | Max DD (median) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) | otlkMag erosion (median) |
|---|---|---|---|---|---|---|---|
| exp3-baseline | 0.05043 [0.04650, 0.05597] | 2.95% [2.33%, 3.75%] | 26 | 16.06% | 66.5% | 0.0% | 29.28 |
| exp3-entry0.05 | 0.05378 [0.04949, 0.06011] | 4.54% [3.48%, 5.84%] | 38 | 21.43% | 66.7% | 0.0% | 47.15 |
| exp3-entry0.15 | 0.04471 [0.03879, 0.05075] | 2.22% [1.91%, 2.68%] | 18 | 11.18% | 68.6% | 7.5% | 13.47 |
| exp3-spreadaware-H25 | 0.05369 [0.04956, 0.06005] | 4.67% [3.58%, 6.01%] | 36 | 21.23% | 66.7% | 0.0% | 47.18 |
| exp3-spreadaware-H50 | 0.05388 [0.04955, 0.06006] | 4.64% [3.54%, 5.87%] | 37 | 21.41% | 66.7% | 0.0% | 47.18 |
| exp3-spreadaware-H100 | 0.05388 [0.04955, 0.06006] | 4.64% [3.54%, 5.87%] | 37 | 21.41% | 66.7% | 0.0% | 47.18 |
| exp3-diversified-N4 | 0.02897 [0.02713, 0.03155] | 0.68% [0.59%, 0.89%] | 109 | 7.75% | 73.7% | 0.0% | 24.02 |
| exp3-diversified-N8 | 0.01950 [0.01820, 0.02136] | 0.39% [0.34%, 0.50%] | 115 | 4.69% | 82.0% | 0.0% | 16.56 |
| exp3-hysteresis0.05 | 0.05043 [0.04650, 0.05597] | 2.95% [2.33%, 3.75%] | 26 | 16.03% | 66.5% | 0.0% | 29.28 |
| exp3-allin | 0.10465 [0.09666, 0.11667] | 5.77% [4.87%, 6.82%] | 47 | 120.43% | 11.0% | 0.0% | 105.57 |

| Config | signal | Total |
|---|---|---|
| exp3-baseline | 5185 | 5185 |
| exp3-entry0.05 | 7459 | 7459 |
| exp3-entry0.15 | 3691 | 3691 |
| exp3-spreadaware-H25 | 7236 | 7236 |
| exp3-spreadaware-H50 | 7290 | 7290 |
| exp3-spreadaware-H100 | 7291 | 7291 |
| exp3-diversified-N4 | 21868 | 21868 |
| exp3-diversified-N8 | 22991 | 22991 |
| exp3-hysteresis0.05 | 5185 | 5185 |
| exp3-allin | 9319 | 9319 |

**canonical-best (by median log-return/100t among the bucket-capital variants): `exp3-spreadaware-H50`.** Its config is reused verbatim (only `startCash`/`canShort` overridden) for experiments 4 and 5 below.

**Interpretation:** at the same 30%-bucket capital ceiling as exp1, the canonical baseline (0.0504 log-return/100t) modestly out-earns daemon-moderate (0.0164, exp1) - roughly 3x, not the ~4x an earlier (buggy) version of this harness reported. The gap comes from redeploying capital the instant forecast crosses back rather than holding through `maxHoldTicks`, not from trading more capital: canonical's idle-cash fraction (66.5%) is close to exp2-all-ablated's (70.5%, same capital settings, daemon logic, `maxHoldTicks` also removed) once both are sized correctly, and its round-trip count (26) is far below the daemon's (319) - fewer, larger, better-timed trades, at a materially higher cost-per-trade and drawdown (2.95% vs exp1-moderate's 0.54%). `hysteresis0.05` is bit-for-bit identical to the plain 0.5 exit for the same structural reason as exp2's `sellForecastDeviation=0` row - most crossings of the 0.5 line are instant bull/bear flips wide enough to jump straight past a 5-point hysteresis band (see exp2 for the measurement). `entry0.05` and `spread-aware` (H25/H50/H100) land in a tight cluster (0.0537-0.0539) a bit above the `entry0.10` baseline - all three let in more/weaker candidates than the 0.10 default, and the extra volume pays for the weaker average edge at this capital level; `entry0.15` trades least (18 round trips) and returns least (0.0447). H50 and H100 are themselves bit-for-bit identical: the spread/commission hurdle divides the expected-return bar by H, so once H is large enough that the hurdle stops binding for almost every candidate, raising it further changes no decision; H25's tighter hurdle filters a handful more marginal candidates and comes in just under the two. `diversified` (N=4, N=8) is dominated by everything else here - capping each position at 1/N of the bucket allowance throttles deployment (idle cash 74-82%, worse than the baseline's own 66.5%) for a drawdown reduction that isn't worth its cost in return. `allin` is the standout row: with the 30%-of-net-worth ceiling removed it deploys 89% of net worth on average (idle cash 11.0%, vs. baseline's 66.5%) and more than doubles the bucket-capped return (0.1047 vs 0.0504) for a roughly proportional increase in drawdown (5.77% vs 2.95%) - see exp4 for how that scales with absolute capital.

## Experiment 4: Capital sensitivity

### daemon-moderate

| Config | log-return/100t (median [IQR]) | Max DD (median) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) | otlkMag erosion (median) |
|---|---|---|---|---|---|---|---|
| exp4-daemon-moderate-cash1000000000 | 0.01758 [0.01629, 0.01900] | 0.63% [0.57%, 0.74%] | 299.5 | 23.30% | 80.3% | 0.2% | 0.63 |
| exp4-daemon-moderate-cash10000000000 | 0.01800 [0.01661, 0.01944] | 0.56% [0.48%, 0.68%] | 343 | 17.93% | 80.9% | 0.1% | 6.76 |
| exp4-daemon-moderate-cash100000000000 | 0.01635 [0.01543, 0.01798] | 0.54% [0.46%, 0.64%] | 319 | 15.18% | 81.6% | 0.1% | 33.81 |
| exp4-daemon-moderate-cash1000000000000 | 0.01268 [0.01161, 0.01402] | 0.50% [0.44%, 0.60%] | 215.5 | 10.41% | 85.1% | 1.0% | 113.19 |
| exp4-daemon-moderate-cash10000000000000 | 0.00321 [0.00252, 0.00399] | 0.43% [0.34%, 0.55%] | 87.5 | 2.55% | 95.6% | 25.1% | 186.76 |

Capacity (does the maxShares cap bind at high capital?):

| Config | Capacity utilization (median mean-per-run) | Capped-buy fraction (median) |
|---|---|---|
| exp4-daemon-moderate-cash1000000000 | 0.1% | 0.0% |
| exp4-daemon-moderate-cash10000000000 | 0.5% | 0.0% |
| exp4-daemon-moderate-cash100000000000 | 3.2% | 0.0% |
| exp4-daemon-moderate-cash1000000000000 | 21.7% | 4.2% |
| exp4-daemon-moderate-cash10000000000000 | 96.5% | 88.1% |

### daemon-all-ablated

| Config | log-return/100t (median [IQR]) | Max DD (median) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) | otlkMag erosion (median) |
|---|---|---|---|---|---|---|---|
| exp4-daemon-all-ablated-cash1000000000 | 0.03356 [0.03121, 0.03655] | 0.89% [0.82%, 1.02%] | 115 | 12.82% | 69.6% | 0.0% | 0.37 |
| exp4-daemon-all-ablated-cash10000000000 | 0.03377 [0.03134, 0.03663] | 0.82% [0.72%, 0.93%] | 118 | 10.84% | 69.4% | 0.0% | 4.28 |
| exp4-daemon-all-ablated-cash100000000000 | 0.03114 [0.02896, 0.03430] | 0.78% [0.69%, 0.88%] | 113 | 9.46% | 70.5% | 0.0% | 27.80 |
| exp4-daemon-all-ablated-cash1000000000000 | 0.02410 [0.02223, 0.02668] | 0.68% [0.60%, 0.78%] | 95 | 6.38% | 75.7% | 0.0% | 83.45 |
| exp4-daemon-all-ablated-cash10000000000000 | 0.00890 [0.00714, 0.01148] | 0.41% [0.34%, 0.50%] | 64 | 1.88% | 90.6% | 2.5% | 159.95 |

Capacity (does the maxShares cap bind at high capital?):

| Config | Capacity utilization (median mean-per-run) | Capped-buy fraction (median) |
|---|---|---|
| exp4-daemon-all-ablated-cash1000000000 | 0.1% | 0.0% |
| exp4-daemon-all-ablated-cash10000000000 | 0.9% | 0.0% |
| exp4-daemon-all-ablated-cash100000000000 | 6.5% | 0.8% |
| exp4-daemon-all-ablated-cash1000000000000 | 34.8% | 10.8% |
| exp4-daemon-all-ablated-cash10000000000000 | 99.3% | 94.9% |

### canonical-best

| Config | log-return/100t (median [IQR]) | Max DD (median) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) | otlkMag erosion (median) |
|---|---|---|---|---|---|---|---|
| exp4-canonical-best-cash1000000000 | 0.06793 [0.06067, 0.07911] | 7.45% [6.24%, 9.58%] | 20 | 36.42% | 64.6% | 0.0% | 3.06 |
| exp4-canonical-best-cash10000000000 | 0.06259 [0.05777, 0.07191] | 7.01% [5.63%, 8.88%] | 24.5 | 31.44% | 65.3% | 0.0% | 17.43 |
| exp4-canonical-best-cash100000000000 | 0.05388 [0.04955, 0.06006] | 4.64% [3.54%, 5.87%] | 37 | 21.41% | 66.7% | 0.0% | 47.18 |
| exp4-canonical-best-cash1000000000000 | 0.03885 [0.03499, 0.04430] | 2.05% [1.73%, 2.48%] | 71.5 | 12.22% | 68.2% | 0.0% | 123.84 |
| exp4-canonical-best-cash10000000000000 | 0.01335 [0.01167, 0.01601] | 0.46% [0.39%, 0.60%] | 276 | 5.29% | 77.2% | 0.0% | 315.44 |

Capacity (does the maxShares cap bind at high capital?):

| Config | Capacity utilization (median mean-per-run) | Capped-buy fraction (median) |
|---|---|---|
| exp4-canonical-best-cash1000000000 | 1.7% | 0.0% |
| exp4-canonical-best-cash10000000000 | 7.3% | 3.1% |
| exp4-canonical-best-cash100000000000 | 18.6% | 12.4% |
| exp4-canonical-best-cash1000000000000 | 42.4% | 31.1% |
| exp4-canonical-best-cash10000000000000 | 95.4% | 93.5% |

**Interpretation:** all three strategies get *worse* per-100-tick returns as capital grows, and it's a capacity story, not a strategy-quality story. `maxShares` per stock is fixed; the daemon's bucket allowance and canonical's cash-limited buys both grow with net worth, but neither can put more than `maxShares` into any one symbol. Capacity utilization confirms it: daemon-moderate's capped-buy fraction is ~0% up to 100b, then 4% at 1T, then 88% at 10T; canonical-best (which concentrates capital into fewer, larger positions) starts hitting the cap earlier - 3% capped at 10b, 12% at 100b, 31% at 1T, 94% at 10T. Idle cash tells the same story from the other side: daemon-moderate's idle-cash fraction rises from 80% (1b) to 96% (10T) as capital it structurally cannot deploy piles up; canonical-best's rises more gently (65% to 77%) since it's already spending most of what it can at every level up to the cap. canonical-best keeps a clear edge over both daemon variants at every capital level, including at 10T where every strategy is mostly capacity-bound (0.0134 canonical-best vs 0.0032 daemon-moderate vs 0.0089 daemon-all-ablated log-return/100t) - interestingly canonical-best's round-trip count *rises* sharply at 10T (276, vs 37 at 100b) as capacity forces it to keep re-entering small residual room instead of making one clean large buy. Practical implication for the real game: past roughly 1T cash with the 33-stock 4S market, no amount of strategy improvement recovers the return rate available at 100b-1T - the market itself is out of capacity.

## Experiment 5: Shorting on vs off (100b cash)

| Config | log-return/100t (median [IQR]) | Max DD (median) | Round trips (median) | Cost % of start (median) | Idle cash % (median) | Zero-position ticks % (median) | otlkMag erosion (median) |
|---|---|---|---|---|---|---|---|
| exp5-daemon-moderate-short-off | 0.01635 [0.01543, 0.01798] | 0.54% [0.46%, 0.64%] | 319 | 15.18% | 81.6% | 0.1% | 33.81 |
| exp5-daemon-moderate-short-on | 0.02102 [0.01997, 0.02230] | 0.46% [0.40%, 0.56%] | 477 | 18.50% | 78.3% | 0.0% | 40.46 |
| exp5-canonical-best-short-off | 0.05388 [0.04955, 0.06006] | 4.64% [3.54%, 5.87%] | 37 | 21.41% | 66.7% | 0.0% | 47.18 |
| exp5-canonical-best-short-on | 0.05505 [0.05044, 0.06023] | 3.38% [2.66%, 4.88%] | 38 | 19.87% | 65.4% | 0.0% | 36.91 |

**Interpretation:** shorting helps both strategies, but by very different amounts. daemon-moderate gets a clean win on both axes: return +28.6% (0.0210 vs 0.0164), round trips +49.5% (477 vs 319, more qualifying candidates now that bear signals are tradeable), and max drawdown *lower* (0.46% vs 0.54%). canonical-best's effect is much smaller and mostly shows up as reduced risk, not more return: return +2.2% (0.0551 vs 0.0539), round trips essentially flat (38 vs 37 - canonical was already trading most of the strong signals it could find on the long side alone), but max drawdown drops 27% (3.38% vs 4.64%). The asymmetry makes sense given each strategy's own bottleneck: the daemon is candidate-starved (`minForecastDeviation=0.10` + `maxPositions=8` leaves headroom - shorting simply doubles its opportunity set), while canonical-best is capital-starved at 100b (idle cash already only ~66%, and it ranks by `|expectedReturn|` regardless of direction) - adding shorts mostly swaps in some bear trades for weaker bull ones rather than adding net new volume, which smooths the equity curve without moving the return much. Bull and bear forecasts in this sim are symmetric by construction (`getForecast` is `(50+/-otlkMag)/100`, and `stockMarketCycle`'s flip is symmetric too); this sim also has no equivalent of the live game's occasional extreme upside runs (only a soft price cap, which limits upside more than downside), so a short book's textbook unbounded-loss risk doesn't show up here as a drawdown cost - treat "shorting doesn't increase drawdown" as somewhat specific to this simulator's price process, not necessarily to the live game.

## otlkMag erosion from the strategy's own trading

| Strategy | Median total otlkMag erosion over 3000 ticks (100b, bucket capital, shorting off) |
|---|---|
| daemon-moderate | 33.81 |
| canonical-best (exp3-spreadaware-H50) | 47.18 |

otlkMag erosion = sum over every trade of (otlkMag before - otlkMag after), read from `market.getStockState(sym).otlkMag` immediately either side of the `buy*`/`sell*` call (this is the simulator-analysis backdoor the stocksim README calls out - legitimate for this measurement, not for the strategies' own decisions, which never read it). A positive number means the strategy's own churn is, on net, pulling every stock's forecast magnitude toward neutral (50/50) - self-inflicted alpha decay. canonical-best erodes forecasts ~1.4x more in total than daemon-moderate (47.18 vs 33.81) while making ~8.6x *fewer* round trips (37 vs 319, exp3/exp1 medians) - implying roughly 12x more erosion per trade. `processTransactionForecastMovement`'s influence scales with shares traded relative to each stock's `shareTxForMovement`, and canonical-best concentrates cash into fewer, much larger positions (no `maxPositions`-driven fragmentation, and no diversification cap in its `canonical-best` config), so each of its trades moves far more shares and erodes far more forecast per trade, even though it trades much less often in absolute terms.

## Harness fidelity notes and caveats

- **Budget bucket timing.** The real system has the stocks daemon (6s tick) and the budget daemon (2s tick) as separate processes; the budget daemon's `portfolioValue` for the `stocks` bucket allowance is one stocks-daemon-publish behind (and that publish itself uses positions read before that tick's sells). This harness computes `tradingCapital` synchronously every tick from the *current* tick's pre-trade positions - no cross-process lag. Effect is expected to be small (portfolioValue moves slowly relative to a single tick) but is not measured directly.
- **4S access from tick 1, no API purchase flow.** The TIX/4S API purchase gating, the wse-access budget carve-out, and pre-4S/scraped-forecast/MA-trend code paths are out of scope per the task brief; the harness always has full 4S access.
- **Smart mode and hack-daemon awareness are omitted** (no hack daemon exists in the sim; the task brief calls smart mode inert/wrong).
- **Same seed does not mean identical market path across strategies once trading starts.** The RNG draw count per tick is fixed and state-independent, but every buy/sell/short/cover calls `processTransactionForecastMovement`, which changes `otlkMag`/`otlkMagForecast` and hence the stock's own future price/forecast drift. Two strategies given the same seed see identical markets only up to the first tick either one of them trades a given symbol - after that, paths for that symbol diverge. This is expected and is exactly what the otlkMag-erosion metric is measuring, not a harness bug.
- **Canonical's entry ranking is recomputed fresh every tick**, including for symbols already held below `maxShares` - it will keep adding to a winning position tick after tick as long as cash and headroom remain, which is the "buy as many shares as cash allows" spec taken literally. No artificial minimum-trade-size floor was added; in practice the integer-share floor in `calculatePositionSize`-equivalent sizing already prevents sub-share dust trades once the capital pool is mostly deployed.
- **`canonical-best` was chosen from the bucket-capital exp3 variants only** (excluding `exp3-allin`, which is a capital-axis comparison, not a trading-logic variant) by median primary metric, then carried into experiments 4 and 5 unchanged except for `startCash`/`canShort`.
- **Idle-cash fraction** is `mean(cash / netWorth)` sampled once per tick after that tick's trades - a continuous measure of underdeployment, not a binary "any cash sitting idle" flag. `zero-position-ticks %` is the complementary binary measure (fraction of ticks with no open position at all).
- **Cost accounting** is `|fill price - mid price| * shares + 100,000` per executed trade, summed over the run and expressed as a percent of starting net worth. This captures spread and commission together (the task's "total spread+commission paid").
- **Canonical position sizing charges the actual per-share cost (ask for a long, bid for a short), reserves the commission, and decrements a running per-tick allowance pool as each candidate is filled**, rather than sizing off the mid price and re-applying the full per-tick allowance to every candidate in turn. An earlier version of this harness did the latter, which (a) let bucket-mode runs deploy 2-3x their intended 30% ceiling per tick before cash ran out, inflating canonical's return relative to the daemon at the "same capital settings", and (b) made `allin` mode nearly non-functional (`floor(cash/mid)*ask + commission > cash` almost always, so the only buys that succeeded were ones capped by `maxShares` headroom - `cappedBuyFraction: 1` in that mode). All exp3/4/5 canonical numbers in this report are from the corrected sizing.
- All controller functions (`forecastSignal`, `shouldSell`, `shouldStopLoss`, `updatePeakPrice`, `calcWeightedBudget`, `calculatePositionSize`, `meetsCommissionThreshold`, `TRADING_PROFILES`) are imported directly from `src/controllers/stocks.ts` with zero modification - the daemon harness is calling the exact same pure functions the real daemon calls, wired the same way (see `harness.ts` inline comments against `daemons/stocks.ts` line numbers).
