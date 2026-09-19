# Stocks

Stock market trading with three data sources: forecasts estimated from tick
directions before 4S data, forecasts scraped from the game's stock UI, and the
4S TIX API. Source: `src/daemons/stocks.ts` (loop), `src/controllers/stocks.ts`
(estimators, entry gate, rank-and-fill sizing, exit rule, profiles),
`src/actions/scrape-forecasts.ts`. The strategy was chosen by Monte Carlo
backtest against a port of the game's market engine; the simulator and the runs
live in `sim/stocks/` and the reasoning is summarised at the end of this page.

## Run

```
run daemons/stocks.js
```

Optional daemon in `start.js`. Needs 19 GB free to launch; it then grows to
35 GB for pre-4S trading and 40 GB for 4S mode. When it gains 4S access it
respawns into the higher tier if that fits, otherwise it stays.

The TIX API no longer needs a WSE account in v3. Shorting is probed once at
startup and used only where the BitNode allows it (BN8 or SF8.2). The loop
runs once per market tick by awaiting `ns.stock.nextUpdate()` (0 GB), so it
never double-samples or skips a tick, including the 4 s ticks during bonus
time.

## Modes

| Mode | Data | When |
|---|---|---|
| `monitor` | Prices only | No TIX API yet, or `enabled=false`. |
| `pre4s` | Forecast and volatility estimated from the last `tickWindow` prices | TIX API bought, no 4S. |
| `scraped` | Forecasts from `/data/stock-forecasts.json` written by the scrape action | File younger than `scrapeMaxAge`. |
| `4s` | `getForecast` and `getVolatility` | 4S TIX API bought. |

## Strategy

Every tick, for every symbol:

1. **Exit.** A long is sold the tick the forecast is below 0.5; a short is
   covered the tick it is above. There are no price-based stops, no hold timer
   and no re-entry cooldown. The forecast is the complete drift state of a
   stock, so price history adds nothing once it is known, and most forecast
   crossings are the market's instant flip, which no hysteresis band can catch.
2. **Signal.** Expected log return per tick is `volatility × (forecast − 0.5)`.
   A stock is a candidate when `|forecast − 0.5|` is at least
   `minForecastDeviation` (4S and scraped) or `preMinForecastDeviation`
   (estimated), and it is not held in the opposite direction.
3. **Rank and fill.** Candidates are sorted by `|expected return|` and each is
   bought to its `maxShares` room in turn until one shared cash pool is spent.
   The pool is the smaller of the budget daemon's `stocks` allowance and cash
   minus `cashReservePercent`. An order is skipped when its notional is below
   100 commissions or when
   `|expected return| × holdHorizonTicks < 2 × spread + 2 × commission / notional`,
   with the per-side spread read from the ask and bid.

Pre-4S the forecast is the exponentially weighted fraction of up-ticks (20-tick
half-life) and volatility is the largest absolute log return in the window
scaled by `(W+1)/W`, which recovers the game's `mv` to within 1 percent; the
standard deviation of returns is 1.8× too low for this move law. Duplicate
price reads are dropped, not counted as down-ticks.

## Config: `/config/stocks.txt`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Trade at all. |
| `minForecastDeviation` | `0.05` | Forecast distance from 0.5 required to open a position on an exact forecast (4S or scraped). This is the profile knob. |
| `preMinForecastDeviation` | `0.10` | The same, for the estimated pre-4S forecast, which is noisier. |
| `holdHorizonTicks` | `50` | Ticks of expected return that must cover the round-trip spread and commission before entry. 50 to 100 are equivalent; below 25 starts rejecting good entries. |
| `tickWindow` | `40` | Price history length per symbol (pre-4S volatility window). |
| `cashReservePercent` | `10` | Percent of cash never put into new positions. |
| `scrapeMaxAge` | `120000` | How old a scraped forecast file may be (ms). |

Profiles (Aggressive 0.05, Moderate 0.10, Conservative 0.15) are presets of
`minForecastDeviation`, defined once in `TRADING_PROFILES` and applied from the
dashboard. Measured at 100b over 200 seeds they return 0.054 / 0.050 / 0.045
log per 100 ticks with 4.6 / 3.0 / 2.2 percent maximum drawdown. The default
is the aggressive preset because drawdown here is a few percent of a position
that liquidates in one tick.

Commission comes from `ns.stock.getConstants()`, not config.

## Ports and budget

Publishes `StocksStatus` on `STATUS_PORTS.stocks`. Control port
`STOCKS_CONTROL_PORT` accepts `reload-config` and `reset-pnl`. Budget buckets:
`stocks` for capital (a holder bucket, measured against net worth; 30 percent
by default and lifted to `stocksWeight4S`, default 80, once 4S is owned, see
`docs/systems/budget.md`) and `wse-access` for buying the TIX API (5b) and 4S
data (25b). The budget daemon carves out the full price of the next API once
cash reaches `wseCarveoutMult` times it (default 2), so the TIX API is bought
at 10b cash and 4S at 50b. The daemon reads `hasTIX` and `has4S` from this
daemon's status port to know which price is pending. The 4S TIX price is the
base 25b and ignores the BitNode multiplier on it.

Realized profit books each exit at the fill price less the sell-side commission
(the buy side is already inside the game's average price). Unrealized profit
values longs at the bid and shorts at the ask. Positions closed outside the
daemon, in full or in part, are booked at the current bid or ask as
`external` trades.

## Dashboard

Money group, Stocks tab. Shows positions, signals (expected return per tick and
forecast), session profit split by long and short, trade history and the market
grid. Buttons: profile, restart, reset profit, scrape 4S, sell all.

## Related scripts

| Command | Purpose |
|---|---|
| `run actions/scrape-forecasts.js` | Read forecast and volatility off the open Stock Market page into `/data/stock-forecasts.json`. Requires only that the page is open: the ticker rows carry the raw stock object whether or not 4S data is owned. 1.6 GB. |
| `run tools/control/sell-all-stocks.js` | Close every position. Used by the dashboard's Sell All and by `actions/firesale.js`. |
| `run actions/install-augments.js` | Sells every position before installing; the game re-initialises the market on install. |

## Why these rules (2026-09-19 analysis)

Measured with `sim/stocks/` (200 seeds, 3000 ticks, 100b, medians of log return
per 100 ticks):

| Configuration | Return | Notes |
|---|---|---|
| Previous daemon, moderate profile | 0.016 | 69% of exits were the 60-tick hold timer; 82% of net worth idle |
| Same with the hold timer removed | 0.021 | fewer trades, lower drawdown |
| Same, every price rule removed, 30% bucket | 0.031 | |
| Rank-and-fill with spread gate, 30% bucket | 0.054 | this daemon |
| Rank-and-fill, all cash | 0.105 | about 23× net worth over five game-hours |

The market flips each stock's forecast with 45 percent probability every 75
ticks, so any single run is dominated by luck; only medians over many seeds
mean anything. The market has a capacity ceiling of roughly 5T (20 percent of
every float), and past about 1T of capital every strategy's return rate falls
because `maxShares` binds. Stock manipulation through `{stock: true}` hacks was
measured too and cannot hold a megacap's forecast against the flip at any
rate; the hack daemon's stocks strategy was removed on that evidence.
