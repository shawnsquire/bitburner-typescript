# Stocks

Stock market trading with three data sources: moving-average signals before
4S data, forecasts scraped from the game's stock UI, and the 4S TIX API.
Source: `src/daemons/stocks.ts` (loop), `src/controllers/stocks.ts` (signals,
sizing, stops, profiles), `src/actions/scrape-forecasts.ts`.

## Run

```
run daemons/stocks.js
```

Optional daemon in `start.js`. Needs 19 GB free to launch; it then grows to
about 31 GB for pre-4S trading and about 36 GB for 4S mode. When it gains 4S
access it respawns into the higher tier if that fits, otherwise it stays.

The TIX API no longer needs a WSE account in v3. Shorting is probed once at
startup and used only where the BitNode allows it.

## Modes

| Mode | Data | When |
|---|---|---|
| `monitor` | Prices only | No TIX API yet, or `enabled=false`. |
| `pre4s` | Moving-average crossover on the last `tickWindow` prices | TIX API bought, no 4S. |
| `scraped` | Forecasts from `/data/stock-forecasts.json` written by the scrape action | File younger than `scrapeMaxAge`. |
| `4s` | `getForecast` and `getVolatility` | 4S TIX API bought. |

## Config: `/config/stocks.txt`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Trade at all. |
| `pollInterval` | `6000` | Poll interval (ms); the market ticks every 6 s. |
| `smartMode` | `true` | Lower confidence on stocks whose server the hack daemon is attacking, using the hack status port. |
| `minForecastDeviation` | `0.10` | Forecast distance from 0.5 required to open a position. |
| `sellForecastDeviation` | `0.05` | Forecast distance at which a position is closed (hysteresis). |
| `preThreshold` | `0.03` | Pre-4S: moving-average deviation that counts as a signal. |
| `tickWindow` | `40` | Price history length per symbol. |
| `maxPositions` | `8` | Open positions at once. |
| `stopLossPercent` | `0.15` | Hard stop from entry. |
| `trailingStopPercent` | `0.08` | Trailing stop from the best price seen. |
| `maxHoldTicks` | `60` | Force-close after this many ticks (0 = never). |
| `sellCooldownTicks` | `3` | Ticks to wait before re-entering a symbol. |
| `commissionPerTrade` | `100000` | The game's fixed commission; a trade must clear this. |
| `scrapeMaxAge` | `120000` | How old a scraped forecast file may be (ms). |

Profiles (Aggressive, Moderate, Conservative) are presets over these keys,
defined in `TRADING_PROFILES` and applied from the dashboard.

## Ports and budget

Publishes `StocksStatus` on `STATUS_PORTS.stocks`. Control port
`STOCKS_CONTROL_PORT` accepts `reload-config` and `reset-pnl`. Consumes
`STATUS_PORTS.hack` for smart mode. Budget buckets: `stocks` for capital
(a holder bucket, measured against net worth) and `wse-access` for buying the
TIX API (5b) and 4S data (25b). The budget daemon carves out the full price of
the next API once cash reaches `wseCarveoutMult` times it (default 2, in
`/config/budget.txt`), so the TIX API is bought at 10b cash and 4S at 50b
instead of the 100b and 500b the bucket's 5 percent weight alone would allow.
The daemon reads `hasTIX` and `has4S` from this daemon's status port to know
which price is pending; see `docs/systems/budget.md`. The 4S TIX price is the
base 25b and ignores the BitNode multiplier on it.

## Dashboard

Money group, Stocks tab. Shows positions, signals, session profit split by long
and short, trade history and the market grid. Buttons: profile, restart, reset
profit, scrape 4S, sell all.

## Related scripts

| Command | Purpose |
|---|---|
| `run actions/scrape-forecasts.js` | Read forecast and volatility off the open Stock Market page into `/data/stock-forecasts.json`. Requires the page to be open. 1.6 GB. |
| `run tools/control/sell-all-stocks.js` | Close every position. Used by the dashboard's Sell All and by `actions/firesale.js`. |
