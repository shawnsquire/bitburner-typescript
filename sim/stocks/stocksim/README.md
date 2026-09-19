# stocksim

A standalone TypeScript port of the Bitburner v3.0.1 stock market, for Monte Carlo
strategy backtests outside the game. No build step, no dependencies - run files
directly with Node 24's native TypeScript stripping:

```
node validate.ts
```

## Files

| File | Contents |
|---|---|
| `rng.ts` | Seeded PRNG (mulberry32) and `getRandomIntInclusive` - every random draw in the sim goes through here, never `Math.random()`. |
| `metadata.ts` | `PositionType`, `IMinMaxRange`/`IConstructorParams`, all 33 stocks' init metadata, `StockMarketConstants`, and the other small numeric constants. |
| `stock.ts` | `Stock` class - port of `src/StockMarket/Stock.ts`. |
| `helpers.ts` | `getBuyTransactionCost`, `getSellTransactionGain`, `processTransactionForecastMovement` - port of `src/StockMarket/StockMarketHelpers.ts`. |
| `market.ts` | `Market` class - the simulator's public API. Ports `StockMarket.ts` (ticking/cycling), `BuyingAndSelling.tsx` (trading), and `PlayerInfluencing.ts` (hack/grow influence). |
| `validate.ts` | Self-checks against the ported formulas. `node validate.ts` must print `All checks PASSED`. |

Every non-trivial piece of logic has a comment pointing at the exact source file/function
it was ported from, and calls out anywhere this port's behavior is deliberately
different from the game's.

## API summary

```ts
const market = new Market(seed, { cash: 1e9 });   // seed: number, options: MarketOptions
// options.rng?: Rng overrides the seed-derived mulberry32 generator entirely (e.g.
// to replay a recorded stream) - every random draw in the sim goes through it.

market.symbols(): string[]                         // 33 ticker symbols, in ns.stock.getSymbols() order
market.tick(): void                                 // advance one update (see "Ticking" below)

market.getPrice(symbol): number
market.getAskPrice(symbol): number                  // what you pay to buy
market.getBidPrice(symbol): number                  // what you receive to sell
market.getForecast(symbol): number                  // (50 +/- otlkMag) / 100, i.e. P(price goes up next tick)
market.getVolatility(symbol): number                // mv / 100 (see "Omitted": darknet multiplier)
market.getMaxShares(symbol): number
market.getPosition(symbol): [longShares, longAvgPx, shortShares, shortAvgPx]

market.buyStock(symbol, shares): number             // returns ask price paid, or 0 on failure
market.sellStock(symbol, shares): number             // returns bid price received, or 0 on failure
market.buyShort(symbol, shares): number              // opens a short; returns BID price, or 0
market.sellShort(symbol, shares): number             // closes a short; returns ASK price, or 0

market.influenceHack(symbol, fraction): void         // fraction = moneyHacked / server.moneyMax
market.influenceGrow(symbol, fraction): void         // fraction = moneyGrown / server.moneyMax

market.getCash(): number
market.netWorth(): number                            // see "netWorth" below

market.getStockState(symbol): StockState             // otlkMag, b, otlkMagForecast, spreadPerc,
                                                      // shareTxForMovement/Until, cap, totalShares, ...
market.getTicksUntilCycle(): number
market.cycleFlips / market.cycleEvents               // diagnostic counters, sim-only (see validate.ts)

market.debugSetPrice(symbol, price): void            // TEST-ONLY. Not a real API - see below.
```

### Trading return conventions

These match `ns.stock.buyStock`/`sellStock`/`buyShort`/`sellShort` exactly
(`src/NetscriptFunctions/StockMarket.ts`): each returns the transaction price on
success, `0` on failure (insufficient cash, zero/negative shares, or exceeding
`maxShares` across long+short combined), and never throws for an ordinary failed
trade. Note the asymmetry: `buyShort` returns the **bid**, `sellShort` returns the
**ask** - that's what the source does, not a typo.

### `netWorth()`

The game has no canonical "net worth including stock positions" formula (`Player.money`
never includes unrealized stock value). `netWorth()` is a documented judgment call:
cash, plus what you'd actually receive if you closed every open position right now -
i.e. `getSellTransactionGain()` for each leg (long: `shares*bid - commission`; short:
`origCost + (avgShortPx - ask)*shares - commission`), skipping legs with zero shares
(no phantom commission for a position you don't hold).

### `frozen` option and `debugSetPrice`

`new Market(seed, { frozen: true })` disables `stockMarketCycle()` (no 45%-chance `b`
flips) and `cycleForecast()`/`cycleForecastForecast()` (`otlkMag`/`otlkMagForecast`
never drift) on every tick, while price still moves normally. This isn't a real game
mode - it exists so `validate.ts` can measure the raw per-tick price-return
distribution against a closed-form expectation without the forecast wandering out from
under it mid-run. `debugSetPrice()` is the same kind of test-only backdoor (a real
script cannot set a stock's price). Don't use either in a strategy harness; a strategy
should only ever call the methods above `debugSetPrice` in the API summary.

## How a strategy harness should drive this

A running Netscript script sees the market like this: it calls `ns.stock.nextUpdate()`
(or polls), which resolves once per 6-second update; when it wakes up, prices and
forecasts have already moved, and the script reads them and decides what to trade
*before* the next update happens. There is no way to peek at the market mid-tick or to
trade "at last tick's price after seeing this tick's forecast" - you always act on the
state left behind by the tick that just completed.

A backtest loop should mirror that exactly:

```ts
const market = new Market(seed, { cash: startingCash });

for (let t = 0; t < numTicks; t++) {
  market.tick();                     // one full update - equivalent to nextUpdate() resolving

  for (const sym of market.symbols()) {
    const forecast = market.getForecast(sym);     // what the script would read via ns.stock.getForecast
    const volatility = market.getVolatility(sym); // ns.stock.getVolatility
    // ... strategy decides here, using only forecast/volatility/price/position ...
    // market.buyStock(sym, shares) / sellStock / buyShort / sellShort
  }
}
```

Rules of thumb for fidelity:

- **Always `tick()` before reading anything for that step.** Reading forecasts/prices
  without ticking first just re-reads the same values a real script already saw.
- **Trade using the price returned by the buy/sell call, not `getPrice()` after the
  fact** if you want the exact fill price for accounting - `getPrice()` returns the
  "true" price, `buyStock`/`sellStock`/etc. return ask/bid which include spread.
- **`getForecast()` only exposes `otlkMag`/`b` (as a single 0-1 number), never
  `otlkMagForecast`.** A real script has no function that returns `otlkMagForecast`
  directly (it only shapes how `otlkMag` drifts internally - see `stock.ts`
  `getForecastIncreaseChance`). `market.getStockState()` exposes it anyway, for
  simulator analysis (e.g. plotting internal state, debugging the port itself) - a
  strategy that reads it is no longer simulating a legal Netscript script, and any
  backtest result built on it should be labeled "omniscient" rather than realistic.
- **`influenceHack`/`influenceGrow` need a fraction you'd otherwise get from a
  server**, since this simulator doesn't model servers: pass `moneyHacked/moneyMax`
  or `moneyGrown/moneyMax` yourself.
- **Order of operations within a tick doesn't matter to the sim** (there's no order
  book - see below), so a harness can iterate symbols in any order once per tick.

## Omitted

- **Limit/stop orders** (`ns.stock.placeOrder`/`cancelOrder`/`getOrders`, and the
  order-processing that runs inside the source's price-update loop). These require
  Source-File 8 in the real game and add an entire order-matching subsystem
  (`OrderProcessing.tsx`, `IOrderBook.ts`) that has no bearing on the core price
  process. A harness that wants "place an order, let it fill on a future tick"
  behavior has to layer that on top of `tick()`/`buyStock/sellStock` itself.
- **Darknet volatility multiplier** (`getDarknetVolatilityMult`/
  `scaleDarknetVolatilityIncreases` in `src/DarkNet/effects/effects.ts`). This
  multiplies a stock's effective `mv` based on how many "stock promotion" charges a
  Darknet server has accumulated for that symbol - a whole separate late-game system.
  It defaults to exactly `1` with zero charges (`1 + (1-e^0) + 2*(1-e^0) = 1`), so
  omitting it (treating the multiplier as always `1`) is exact for any playthrough
  that hasn't touched the Darknet, and an approximation (volatility under-estimate)
  otherwise.
- **Offline/bonus-time processing** (`storedCycles`, `msPerStockUpdateMin`, the
  4-second-real-time throttle in `processStockPrices()`, and the resulting "4s ticks
  while catching up on offline time" behavior). Per the task brief, one `tick()` call
  IS one call to `processStockPrices()`'s actual update body - the real-wall-clock
  gating around when that body is allowed to run has no meaning for an offline batch
  simulation and is skipped entirely. A harness modeling "script was offline for N
  game-minutes" should just call `tick()` `N*10` times back to back (10 ticks/minute
  at the normal 6s cadence) rather than trying to reproduce the catch-up throttle.
- **4S Market Data / TIX API / WSE account purchase flow, `getConstants`,
  `getOrganization`, `getPurchaseCost`/`getSaleGain` as separate NS calls.** The sim
  assumes a strategy already has full market access (no `hasWseAccount`/
  `hasTixApiAccess`/`has4SDataTixApi` gating) - `getBuyTransactionCost`/
  `getSellTransactionGain` are available directly through `helpers.ts` if a harness
  wants to preview a trade's cost/gain without executing it.
- **Save/load, `toJSON`/`fromJSON`, the JSON-schema validator.** No save system exists
  for a backtest process.

## Judgment calls and source surprises

- **`getVolatility()` divides by 100 twice, effectively.** `Stock.mv` is constructed
  from metadata like `{min:40, max:50, divisor:100}`, i.e. `mv` is already stored as
  ~0.40-0.50 (not 40-50) after construction. `getVolatility()` then returns `mv/100`
  again, so `ns.stock.getVolatility("ECP")` is really on the order of 0.004-0.005
  (0.4-0.5%), not 40-50%. This is exactly what the source does (confirmed against
  `StockTickerHeaderText.tsx`'s `formatPercent(volatility/100)` and the NS
  `getVolatility` doc comment's own example, "a stock has volatility of 3%... returns
  0.03") - not a bug in this port, just an easy thing to get wrong when porting from
  the field name alone rather than reading both the constructor and the accessor.
- **`influenceForecast()` is a no-op at `otlkMag <= 5`.** Every buy/sell/short/cover
  calls `processTransactionForecastMovement`, which is supposed to pull `otlkMag`
  toward a floor of 5 - but the guard is `if (this.otlkMag > StockForecastInfluenceLimit)`,
  so a stock that's already at or below 5 is completely immune to transaction pressure
  on its first-order forecast (its second-order forecast still moves). Nova Medical
  starts at exactly `otlkMag: 5` and Omnia Cybersystems at `4.5` - trading them does
  nothing to `otlkMag` until/unless a market cycle pushes it back up.
- **`getForecastIncreaseChance()` clamps to `[0.05, 0.95]`.** However far the
  second-order forecast (`otlkMagForecast`) has drifted from the absolute forecast,
  the chance the next `cycleForecast()` step moves `otlkMag` in the "expected"
  direction never reaches 0% or 100% - there's always at least a 1-in-20 chance of a
  forecast surprise, every tick, forever.
- **The soft price cap sets `b = false` durably**, not just for one tick's roll. Once
  `stock.price >= stock.cap`, that tick forces `chc = 0.1` *and* flips the stock
  permanently bearish (`b = false`) - it doesn't reset `b` back on its own; only a
  later `cycleForecast()` crossing zero or a `stockMarketCycle()` 45% roll can undo it.
  Combined with `chc=0.1` this makes a stock that hits its cap heavily likely to fall
  back below it and then behave normally again, but the "always bearish now" state
  persists across that soft-cap event.
- **Iteration order isn't the same as `ns.stock.getSymbols()`'s order.** The engine's
  internal update loop iterates stocks in the order `initStockMarket()` inserted them
  (`InitStockMetadata` array order); `getSymbols()` returns `Object.values(StockSymbol)`,
  a *different* object with its own declaration order. Concretely: `InitStockMetadata`
  has ...FoodNStuff, Sigma Cosmetics, Joe's Guns..., while the `StockSymbol` enum-object
  has ...FoodNStuff, Joe's Guns, ..., Sigma Cosmetics (at the very end, with the other
  three non-`LocationName` companies). This never affects any individual stock's
  distribution (each stock's random draws are independent of loop position) but it
  does mean `Market#symbols()` (which mirrors `getSymbols()`) is not the order
  `tick()` internally processes stocks in - see the comment on `InitStockMetadata` in
  `metadata.ts`.
- **`stockMarketCycle()` reassigns `ticksUntilCycle = 75` once per stock**, inside the
  per-stock loop, i.e. up to 33 redundant writes of the same constant. Ported as a
  single write after the loop in `market.ts` (`Market#stockMarketCycle`) since it's
  the same value regardless of how many times or where it's assigned - purely a
  clarity simplification, not a behavior change.
- **`influenceHack`/`influenceGrow` move the forecast differently than trading
  does.** A hack/grow calls `Stock#changeForecastForecast(otlkMagForecast -/+ 0.1)`,
  which just clamps to `[0, 100]` - it can push `otlkMagForecast` *away* from 50,
  same as a market cycle's flip can. A buy/sell/short/cover instead calls
  `Stock#influenceForecastForecast`, which always pulls `otlkMagForecast` *toward*
  50 and never overshoots it. Both are "0.1-ish changes to otlkMagForecast" at a
  glance, but they're different methods with different clamping behavior - ported
  faithfully as two separate calls in `market.ts` (`influenceHack`/`influenceGrow`
  vs. the trading methods going through `helpers.ts`'s
  `processTransactionForecastMovement`), not unified into one helper.
- **`netWorth()` has no source equivalent** - see above; it's this simulator's own
  addition, documented as a liquidation-value definition rather than treated as
  ported game behavior.
- **Erasable-TypeScript note**: `PositionType` (the only one of the source's
  `StockMarket/Enums.ts` enums this sim needs - `OrderType` is irrelevant with no
  order book) is ported as an `as const` object with a derived union type instead of
  a real TS `enum`, since Node's native type-stripping (no build step, per the task
  constraints) rejects enums, namespaces, and constructor parameter properties.
