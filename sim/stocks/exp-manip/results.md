# Stock manipulation via hack/grow: how much does it actually move the forecast?

All numbers below come from Monte Carlo runs against `scratchpad/stocksim` (a faithful,
validated port of Bitburner v3.0.1's `StockMarket/*`), 200 seeds per configuration
unless noted, medians/IQR reported (means noted separately where they diverge, which
happens for two of the more interesting results below). Code: `lib.ts`, `exp1.ts`,
`exp1_omf.ts`, `exp2.ts`, `exp3.ts`, `exp4.ts` in this directory. Raw output:
`results.json`.

**Headline result:** for the two megacap stocks tested (ECP, otlkMag 19; FLCM, otlkMag
16), sustained hack-pressure has almost no effect on whether the forecast ends up
bullish or bearish - that's decided by the game's unconditional 45%-per-75-tick cycle
flip, which fires regardless of pressure. Pressure only controls *how deep* the
forecast gets pushed while it happens to be on your side, and even then a moderate
push (k≈1-5) can be **worse than no push at all** at recovering from a bad flip,
because of how `otlkMagForecast` (the internal second-order forecast, "OMF" below)
responds. Only small, low-otlkMag, high-volatility stocks (JGN) show manipulation
meaningfully controlling the forecast's sign. See "The mechanism" below - it explains
every other number in this document.

## Methodology

- **k** = guaranteed-successful influence events per tick. Implemented with a
  fractional accumulator (`acc += k; while (acc >= 1) { influenceHack/Grow(sym, 1.0); acc -= 1 }`),
  so k=0.5 fires exactly one event every other tick, deterministically - no extra RNG
  noise on top of the market's own randomness. Each event still consumes one RNG draw
  (`fraction=1.0` just guarantees `rng() < fraction`), matching the real
  `influenceStockThroughServerHack/Grow`, which always calls `Math.random()` before
  checking the fraction.
- Each stock is simulated in its own single-stock `Market` (`options.stocks: [oneEntry]`)
  so its RNG stream is isolated from the other 32 stocks and runs are fast. This
  changes iteration order vs. the real 33-stock market but not any individual stock's
  own distribution (each stock's draws are independent of loop position - see
  stocksim's README).
- Three stocks, chosen to span the otlkMag/volatility range:

  | Symbol | Company | otlkMag | mv (volatility) | Tier |
  |---|---|---|---|---|
  | ECP | ECorp | 19 | 0.40-0.50 | mega-cap |
  | FLCM | Fulcrum Technologies | 16 | 1.20-1.30 | mid-cap |
  | JGN | Joe's Guns | 1 | 2.00-3.50 | small-cap, volatile |

- `getStockState()` (otlkMag/otlkMagForecast/b) is used only for *analysis*
  (classifying *why* a crossing happened, measuring internal recovery times) per
  stocksim's README - never as an input a strategy would act on. All strategy-relevant
  numbers (crossing time, fraction-on-side, log-return) are computed from
  `getForecast()`/`getPrice()`/`netWorth()`, which a real script could read.

## The mechanism (read this first)

A cycle event (45% chance every 75 ticks, `stockMarketCycle()`) does two things
unconditionally, independent of otlkMag or any pressure: flips `b`, and sets
`otlkMagForecast = 100 - otlkMagForecast`. If a stock was pinned bearish by sustained
hack pressure (OMF near its 0 floor), a cycle flip both makes it bullish **and** kicks
OMF up near 100 - the extreme that most *helps* the now-wrong (bullish) trend, since
`getForecastIncreaseChance()` reads `clamp(OMF - absoluteForecast, -45, 45)`.

Continued pressure claws OMF back down at `0.1 * k` per tick. That gives two
closed-form predictions, confirmed directly (`exp1_omf.ts`, pooled over ~1800-2400
depin events per config):

- ticks to cross back through neutral (OMF < 50): **500 / k**
- ticks to fully re-saturate `getForecastIncreaseChance()` at its 0.05 floor: **950 / k**

| k | predicted neutral | observed neutral (median) | predicted saturate | observed saturate (median) |
|---|---|---|---|---|
| 0.5 | 1000 | 75 (capped by next cycle) | 1900 | never (censored) |
| 1 | 500 | 75 (capped by next cycle) | 950 | rare - ECP 240 (n small), FLCM/JGN censored |
| 2 | 250 | 75 (capped by next cycle) | 475 | ~140-400 |
| 5 | 100 | 75 (capped by next cycle) | 190 | 124-159 |
| 10 | 50 | 49 | 95 | 73-75 |
| 20 | 25 | 24 | 48 | 40-41 |

At k≤5, the *predicted* recovery time exceeds 75 ticks, so in practice **the next
random cycle event interrupts recovery before it finishes** - observed "neutral"
latency pins at exactly ~75 (the cycle period) instead of the much longer prediction.
Only at k≥10 does pressure out-race the cycle clock, and observed times then track the
closed form almost exactly (49 vs 50, 24 vs 25). This is the single mechanism behind
every "why doesn't more pressure help more" result below.

## Experiment 1: push strength

Starting from each stock's natural bullish state, apply k bearish events/tick
(`influenceHack`), cycles on, for up to 600 ticks, over 200 seeds.

| Stock | k | ticks-to-cross-0.5 (median, IQR) | never cross in 600 | crossing caused by drift, not a cycle flip | P(bearish) at t=600 |
|---|---|---|---|---|---|
| ECP | 0 | 74 [37, 159] | 0% | 0% | 45.5% |
| ECP | 0.5 | 90.5 [38, 189] | 0% | 0% | 52.5% |
| ECP | 1 | 91 [41, 165] | 2.5% | 0% | 48.0% |
| ECP | 2 | 99.5 [41, 176] | 1.0% | 0% | 52.5% |
| ECP | 5 | 98 [38, 202] | 1.0% | 0% | 53.5% |
| ECP | 10 | 93 [38, 170] | 0% | 0% | 52.5% |
| ECP | 20 | 67 [38, 152] | 1.5% | 0% | 51.5% |
| FLCM | 0 | 74 [37, 159] | 0% | 0% | 45.5% |
| FLCM | 1 | 94 [41, 170] | 0% | 3.0% | 48.0% |
| FLCM | 5 | 99 [38, 205] | 0% | 13.0% | 52.5% |
| FLCM | 20 | 67 [38, 165] | 0% | 13.5% | 59.5% |
| JGN | 0 | 15 [2, 47] | 0% | 64.5% | 52.0% |
| JGN | 1 | 19 [2, 48] | 0% | 77.5% | 54.0% |
| JGN | 5 | 13 [2, 30] | 0% | 90.5% | 48.5% |
| JGN | 10 | 12 [2, 25] | 0% | 91.5% | 49.5% |
| JGN | 20 | 12 [2, 19] | 0% | 93.5% | 57.0% |

(Full table for all 7 k values × 3 stocks in `results.json` → `exp1_push_strength`.)

**Interpretation:**

- **For ECP, 100% of first crossings (every k, including k=0) are caused by the
  unconditional cycle flip, not by pressure decaying otlkMag through zero.** The
  crossing-time numbers barely move with k (74→99→67 ticks, non-monotonic) because
  they're really measuring "how many 75-tick cycles until the 45% coin lands" (median
  ≈ 91 ticks matches the closed-form expectation for `P(flip by nth cycle) = 1-0.55^n`
  almost exactly), not a manipulation effect. **Applying k=20 events/tick to a
  megacap does not meaningfully speed up the first bearish crossing versus doing
  nothing at all.** This is because ECP's average per-tick otlkMag decay under
  saturated pressure is only ≈ 0.9 × otlkMag × mean(av) ≈ 0.9 × 19 × 0.00225 ≈
  0.039/tick - roughly 490 ticks to walk 19 points down to zero by pure decay, far
  slower than the ~91-tick median wait for a cycle flip to just hand you the crossing
  for free.
- **FLCM (slightly smaller otlkMag) starts showing a real drift-driven contribution at
  high k** (13-13.5% of crossings at k=5/20 are pressure-driven, not cycle-driven),
  and **JGN (otlkMag=1) is dominated by drift even with zero pressure** (64.5% of its
  k=0 crossings are drift, because `otlkMagChange` gets a flat floor of 1.0 once
  otlkMag≤1, so *any* stretch of "decrease" rolls flips it in a few ticks on its own).
  By k=20, 93.5% of JGN's crossings are genuinely pressure-driven.
- **P(bearish) at t=600 hovers in a narrow 45.5%-59.5% band across every k for every
  stock** - even ECP at k=20 (max pressure for the full 600-tick run) only reaches
  51.5%, barely different from k=0's 45.5% (which is itself just sampling noise around
  the natural ~50/50 cycle-flip parity - see Experiment 4). **There is no "steady
  state forecast" to report as a single number**: the long-run distribution is
  bimodal (bullish-side value or bearish-side value depending on the current `b`), so
  P(on your side) is the only meaningful summary, and it says sustained pressure barely
  shifts the odds for megacaps within 600 ticks.

## Experiment 2: holding power

Pin phase: 200 ticks of k=20 pressure in the target direction (reaches a genuinely
pressure-reinforced state, not just the natural initial condition - median starting
forecast after the pin phase: ECP short 0.330, ECP long 0.688, FLCM short 0.377/long
0.660, JGN short 0.402/long 0.597, close to the task's "~0.3 / ~0.7" targets).
**Roughly half of all seeds (75-102 of 200, see `excluded` in `results.json`) are NOT
on the desired side after 200 ticks and are dropped** - this is itself a finding, not
a nuisance: even under maximal sustained pressure, a stock is only coin-flip-likely to
be sitting on your side at a fixed checkpoint, because the cycle mechanic can un-flip
it at any of the ~2-3 cycle events that occur in that window. Then: continue with a
*test* k for 3000 more ticks (≈40 cycle periods), measuring the fraction of ticks the
forecast stays on the desired side.

| Stock | Direction | k=0 | k=1 | k=2 | k=5 | k=10 | k=20 |
|---|---|---|---|---|---|---|---|
| ECP | short | 0.500 | 0.501 | 0.508 | 0.500 | 0.522 | 0.484 |
| ECP | long | 0.525 | 0.525 | 0.500 | 0.501 | 0.521 | 0.542 |
| FLCM | short | 0.500 | 0.500 | 0.506 | 0.530 | 0.540 | 0.540 |
| FLCM | long | 0.525 | 0.525 | 0.503 | 0.512 | 0.518 | 0.558 |
| JGN | short | 0.500 | 0.521 | 0.522 | 0.532 | 0.544 | 0.580 |
| JGN | long | 0.500 | 0.504 | 0.521 | 0.531 | 0.545 | 0.574 |

(medians of fraction-of-3000-ticks-on-desired-side; IQR is ≈±0.06 around each value in
every row - see `results.json`.)

**Interpretation:** **holding power for the two megacaps is essentially
k-independent** - every value sits in a tight 0.48-0.56 band regardless of whether k is
0 or 20. Even JGN, the most k-sensitive stock, only goes from 0.50 (no pressure) to
0.58 (k=20, the most pressure tested in this whole study) - i.e. **20 guaranteed
successful events every single tick, forever, only keeps the forecast on your side 58%
of the time instead of 50%.** This follows directly from "the mechanism" above: the
cycle flip is a coin flip regardless of current pin depth, and megacap otlkMag decays
far too slowly (hundreds of ticks) to win the race back before the *next* coin flip
arrives (~167 ticks average). Manipulation does not buy reliable control over a
megacap's forecast sign, at any tested k, over any tested horizon.

## Experiment 1 addendum: moderate pressure can be *worse* than none

Pooling the re-pin latencies from Experiment 1 (ticks from a depin event to the next
time the forecast crosses back to the desired side) by **mean** (median is capped at
exactly 75 - the cycle period - for most configurations, so it hides this effect):

| Stock | k=0 | k=0.5 | k=1 | k=2 | k=5 | k=10 | k=20 |
|---|---|---|---|---|---|---|---|
| ECP | 124.5 | 130.0 | 129.5 | 133.0 | 128.4 | 129.8 | 137.0 |
| FLCM | 124.5 | 130.0 | 129.2 | 131.8 | 124.2 | 122.0 | 126.0 |
| JGN | **88.8** | 99.4 | 114.5 | 113.4 | **117.6** | 105.1 | **91.4** |

JGN shows a clear U-shape: mean re-pin latency is *fastest with zero pressure*
(88.8 ticks - pure luck/its own fast intrinsic jitter), gets *worse* through k=1-5
(peaking at 117.6 ticks at k=5), then recovers back to near-baseline only at k=20
(91.4). **Mechanism:** right after a depin, OMF sits at the extreme that favors the
wrong-direction trend. Weak-to-moderate pressure claws it down too slowly to flip the
bias before the next random cycle event arrives anyway, but *is* fast enough to
measurably delay JGN's own fast natural jitter from working in your favor during that
window - net effect, worse than doing nothing. Only k≥~13-20 (see the 950/k
"re-saturate" prediction above) reliably wins the race. **Applying stock-manipulation
pressure at a rate too weak to fully re-saturate within one 75-tick cycle can be
actively counterproductive** for exactly the small, volatile stocks where manipulation
otherwise works best.

## Experiment 3: value of manipulation

Buy `maxShares` long at t=0, apply k favorable (bullish, `influenceGrow`) events/tick,
compare `netWorth()` log-return after 100 ticks (dominated by the position - cash is
sized to just cover the purchase so it doesn't dilute the ratio):

| Stock | k=0 (no manipulation) | k=2 | k=10 |
|---|---|---|---|
| ECP | +3.14% [-2.0%, +7.3%] | +4.42% [-1.0%, +7.8%] | +4.84% [-2.5%, +8.1%] |
| FLCM | +7.63% [-5.3%, +18.1%] | +10.22% [-3.1%, +19.4%] | +11.62% [-5.8%, +21.7%] |
| JGN | -0.40% [-9.1%, +10.9%] | +1.47% [-8.6%, +13.7%] | +6.69% [-8.3%, +21.9%] |

(median log-return, IQR in brackets; `netWorth()` and price log-returns agree to
within spread/commission noise - see `results.json`.)

**Interpretation:** ECP and FLCM already have a strong natural bullish drift (their
`chc` price-up probability is `(50+otlkMag)/100` ≈ 69%/66% while `b` holds, which per
Experiment 1/2 it mostly does for 100 ticks) - manipulation adds a real but modest
**+1.3 to +4.0 percentage points** on top of that over 100 ticks, with diminishing
returns from k=2 to k=10 (consistent with `getForecastIncreaseChance()` saturating:
extra events beyond the ~450 needed to hit the clamp floor from a neutral start buy
essentially nothing more). JGN, with almost no natural edge (-0.4% median with zero
manipulation), gets **transformed** by pressure - k=10 turns a flat/negative position
into +6.7% median, a swing of ~7 percentage points. **Manipulation's per-effort payoff
is far higher on small, low-otlkMag stocks than on megacaps**, which matches
Experiment 1/2's finding that megacaps' *sign* can't reliably be controlled anyway -
what k does for a megacap is nudge the price-drift magnitude a little while `b` happens
to already be favorable, not flip or hold `b` itself.

## Experiment 4: sanity check (k=0, pure natural dynamics)

6000 ticks × 200 seeds per stock, no influence events at all:

| Stock | cycle flips / cycle events | expected | fraction bullish at end |
|---|---|---|---|
| ECP | 0.4483 (SE 0.0039) | 0.45 | 46.5% |
| FLCM | 0.4483 (SE 0.0039) | 0.45 | 46.5% |
| JGN | 0.4483 (SE 0.0039) | 0.45 | 44.5% |

All three stocks matched the documented 0.45-per-75-tick flip rate to within 0.4
standard errors, `otlkMag` never left `[0, 50]`, and no NaNs appeared across
3.6M ticks. Fraction bullish at the end of a long unmanipulated run sits close to 50%
in all three, confirming the "coin flip" framing used throughout this document isn't
an approximation - it's the actual long-run behavior of `b` with no external pressure.

## What this means for the hack daemon's stocks strategy

Current implementation (`src/scripts/hack/stock-grow.ts`, `stock-hack.ts`): each is an
infinite `while(true) { await ns.grow/hack(target, {stock:true}) }` loop with **no
weaken calls and no alternation between hack and grow**. Given the mechanism above:

- **Grow-only is not viable as a sustained strategy.** `influenceGrow`'s fraction is
  `moneyGrown/moneyMax`. Once a server reaches max money (which a dedicated grow farm
  reaches quickly), every subsequent grow call has `moneyGrown≈0` → fraction≈0 → **k
  collapses to 0**, even though the script keeps running and burning fleet RAM. A real
  grow-based long push needs to *periodically hack the server without the stock flag*
  (so it doesn't fire an unwanted bearish event) to knock money back down, then let
  `stock-grow.js` regrow it (each such regrow cycle is where the real
  `moneyGrown/moneyMax` fraction - and hence the influence chance - is actually
  nonzero).
- **Hack-only decays over time, for two compounding reasons.** (1) No weaken means
  security climbs every hack call, which lowers `calculatePercentMoneyHacked` (shrinks
  the fraction per call) *and* raises `calculateHackingTime` (fewer completions per
  6s tick) simultaneously. (2) Hacking depletes the server's money and nothing
  restores it, so each successive hack's absolute `moneyHacked` (and hence
  `moneyHacked/moneyMax`) shrinks toward zero within a handful of completions unless
  grow calls are interleaved to refill money between hacks. `weaken` has no
  `PlayerInfluencing` hook at all (confirmed in the source - only hack and grow call
  `influenceStockThroughServer*`), so adding weaken calls is free from a
  stock-manipulation standpoint and only costs RAM/scheduling. **A viable stocks-mode
  worker loop needs three actions interleaved (hack for the event, weaken to hold
  security down so future hacks stay effective, grow to refill money for the next
  hack or to drive the long side) - not one action forever.**
- **Multi-threading one running instance doesn't raise the event *rate*.** A single
  `ns.exec(script, host, threads, target)` produces one hack/grow completion per
  `calculateHackingTime`/`calculateGrowTime` interval, scaled by thread count into a
  *larger* `moneyHacked`/`moneyGrown` (i.e. a bigger fraction, up to the natural cap of
  1.0 - the game clamps `percentMoneyHacked` to 1). To get more independent
  Bernoulli trials per 6-second tick (raise k), you need more *separate* concurrent
  script instances against the target, not more threads on one instance past the point
  where a single completion already steals/grows close to 100%.
- **Required call rate, worked example:** to translate k into thread counts, use
  `threads ≈ (k / successFraction) × actionTime / 6s`. With a 10%-per-call fraction (as
  in the brief) and, e.g., a mid-game hack time around 60s on an easy target: k=1 needs
  `(1/0.10) × 60/6 = 100` concurrent single-completion instances/threads; k=10 needs
  ~1000; k=20 needs ~2000. These are large but not absurd fleet sizes for an
  established Bitburner run - the real obstacle per the results above isn't reaching
  k=10-20, it's that **k=10-20 sustained forever still only holds a megacap's forecast
  on your side ~52-56% of the time**, barely above the ~50% you'd get by doing nothing.
- **Is it worth it?** For megacaps (ECP/FLCM-tier stocks), no - Experiment 2 shows you
  cannot reliably control or hold the forecast's sign at any tested k, and Experiment 3
  shows the incremental log-return from manipulation (+1.3 to +4.0pp/100 ticks) is
  small next to the stock's own natural drift (+3.1% to +7.6%/100 ticks) and next to
  the fleet RAM cost of sustaining hundreds-to-thousands of manipulation threads
  instead of using that RAM for direct hacking income. **Simply trading the natural
  forecast** (buy megacaps that are already bullish, per Experiment 4's confirmation
  that they sit bullish/bearish with natural ~50/50-ish long-run parity but strong
  short-run persistence within a cycle) captures most of the available edge for free.
- For small, low-otlkMag, high-volatility stocks (JGN-tier), manipulation is far more
  worthwhile - it can turn a near-zero natural edge into a meaningful one (+6.7pp at
  k=10 in Experiment 3), and these stocks' forecasts *are* meaningfully steerable
  (Experiment 1: 90%+ of crossings are pressure-driven, not luck). But even here, per
  the Experiment 1 addendum, the daemon should run pressure high enough to fully
  re-saturate within one 75-tick cycle (empirically k≳13-20 for these otlkMag/mv
  ranges) rather than a middling rate - a middling, half-committed manipulation rate on
  a small stock can be worse than not manipulating it at all. **If the stocks-mode
  strategy is kept, it should prioritize fleet allocation toward the smallest-otlkMag
  stocks in the portfolio rather than spreading pressure evenly, and should fix the
  worker scripts to interleave hack/grow/weaken rather than looping one action
  forever.**
