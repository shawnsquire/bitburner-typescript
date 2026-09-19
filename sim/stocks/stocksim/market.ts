/**
 * Market: a standalone, faithful port of the Bitburner v3.0.1 stock market for
 * Monte Carlo strategy backtests. See README.md for API summary, omissions, and
 * how a strategy harness should drive this.
 *
 * Ports (line-by-line, with every Math.random() replaced by an injected Rng call):
 *   - src/StockMarket/StockMarket.ts        stockMarketCycle(), processStockPrices()
 *   - src/StockMarket/Stock.ts               constructor, all instance methods (see stock.ts)
 *   - src/StockMarket/StockMarketHelpers.ts  see helpers.ts
 *   - src/StockMarket/BuyingAndSelling.tsx   buyStock, sellStock, shortStock, sellShort
 *   - src/StockMarket/PlayerInfluencing.ts   influenceStockThroughServerHack/Grow
 *   - src/NetscriptFunctions/StockMarket.ts  getForecast/getVolatility/getPosition and the
 *                                            buy-and-sell return-value conventions (ask/bid/0)
 *   - src/StockMarket/data/Constants.ts, data/InitStockMetadata.ts, Enums.ts (-> metadata.ts)
 *   - src/utils/helpers/getRandomIntInclusive.ts (-> rng.ts)
 */
import type { Rng } from "./rng.ts";
import { mulberry32, getRandomIntInclusive } from "./rng.ts";
import { Stock } from "./stock.ts";
import {
  InitStockMetadata,
  SYMBOLS_IN_ENUM_ORDER,
  StockMarketConstants,
  PositionType,
  forecastForecastChangeFromHack,
  type IConstructorParams,
} from "./metadata.ts";
import { getBuyTransactionCost, getSellTransactionGain, processTransactionForecastMovement } from "./helpers.ts";

/** Snapshot of a stock's internal state, for analysis / strategy harnesses / tests. */
export interface StockState {
  symbol: string;
  name: string;
  price: number;
  lastPrice: number;
  /** Bear(false)/bull(true). Read-only exposure of Stock.b - see deliverable list. */
  b: boolean;
  otlkMag: number;
  otlkMagForecast: number;
  /** Volatility parameter (mv). getVolatility() returns mv/100 - this is the raw mv. */
  mv: number;
  spreadPerc: number;
  cap: number;
  shareTxForMovement: number;
  shareTxUntilMovement: number;
  totalShares: number;
  maxShares: number;
  playerShares: number;
  playerAvgPx: number;
  playerShortShares: number;
  playerAvgShortPx: number;
}

export interface MarketOptions {
  /** Starting player cash. Default 0 (a fresh Bitburner character has no head start). */
  cash?: number;
  /**
   * Override the RNG entirely instead of deriving it from `seed` via mulberry32 -
   * e.g. to replay a previously-recorded stream, or plug in a different generator.
   * When provided, `seed` is ignored for RNG purposes (still required as a
   * parameter, for API stability / logging).
   */
  rng?: Rng;
  /**
   * Override the 33-stock InitStockMetadata table, e.g. with a single hand-built
   * stock for controlled experiments (mirrors the `ctorParams` pattern the game's
   * own jest tests use in test/jest/StockMarket.test.ts).
   */
  stocks?: IConstructorParams[];
  /**
   * Disable forecast drift and cycles: skips stockMarketCycle() (no 45%-chance b
   * flips) AND skips cycleForecast()/cycleForecastForecast() (otlkMag/otlkMagForecast
   * never move) on every tick. Price still moves (that's what's being validated).
   * NOT a feature of the real game - it exists so validate.ts can measure the
   * per-tick price-return distribution against a closed-form expectation without
   * the forecast wandering out from under it. Off by default.
   */
  frozen?: boolean;
}

export class Market {
  private readonly rng: Rng;
  /** Stocks in metadata/insertion order - see the big comment in metadata.ts on why
   *  this differs from StockSymbol enum order, and why it matters (Object.keys()
   *  iteration order in the source's stockMarketCycle()/processStockPrices()). */
  private readonly order: Stock[];
  private readonly bySymbol: Map<string, Stock>;
  private readonly frozen: boolean;

  /** Port of StockMarket.ticksUntilCycle (IStockMarket field). */
  private ticksUntilCycle: number;

  /** Player cash. The source reads/writes Player.money directly; we track it locally. */
  private cash: number;

  /**
   * Count of 45%-chance cycle flips actually taken, summed across all stocks and all
   * ticks. Instrumentation for validate.ts test (b) - NOT present in the source,
   * which has no such counter. Distinct from the `b` flip that cycleForecast() does
   * when otlkMag would go below 0 (see stock.ts) - only stockMarketCycle's flips are
   * counted here.
   */
  cycleFlips = 0;

  /**
   * Count of completed stockMarketCycle() runs (i.e. how many times ticksUntilCycle
   * hit zero). Instrumentation for validate.ts test (b), giving it an exact trial
   * count (cycleEvents * numStocks Bernoulli(0.45) trials) instead of an
   * approximation from elapsed ticks / 75. Not present in the source.
   */
  cycleEvents = 0;

  constructor(seed: number, options: MarketOptions = {}) {
    this.rng = options.rng ?? mulberry32(seed);
    this.frozen = options.frozen ?? false;
    this.cash = options.cash ?? 0;

    const metadata = options.stocks ?? InitStockMetadata;
    this.order = metadata.map((m) => new Stock(this.rng, m));
    this.bySymbol = new Map(this.order.map((s) => [s.symbol, s]));

    // Port of initStockMarket(): StockMarket.ticksUntilCycle = getRandomIntInclusive(1, TicksPerCycle)
    this.ticksUntilCycle = getRandomIntInclusive(this.rng, 1, StockMarketConstants.TicksPerCycle);
  }

  private getStock(symbol: string): Stock {
    const stock = this.bySymbol.get(symbol);
    if (stock == null) {
      throw new Error(`Invalid stock symbol: '${symbol}'`);
    }
    return stock;
  }

  /**
   * Port of NetscriptFunctions/StockMarket.ts `getSymbols` (`Object.values(StockSymbol)`)
   * when using the default 33-stock table. Symbols not found in the canonical
   * StockSymbol enum order (e.g. a custom test stock's symbol) are appended in
   * construction order.
   */
  symbols(): string[] {
    const present = new Set(this.order.map((s) => s.symbol));
    const canonical = SYMBOLS_IN_ENUM_ORDER.filter((sym) => present.has(sym));
    const extra = this.order.map((s) => s.symbol).filter((sym) => !SYMBOLS_IN_ENUM_ORDER.includes(sym));
    return [...canonical, ...extra];
  }

  // ---- Read-only market data (port of NetscriptFunctions/StockMarket.ts getters) ----

  getPrice(symbol: string): number {
    return this.getStock(symbol).price;
  }

  getAskPrice(symbol: string): number {
    return this.getStock(symbol).getAskPrice();
  }

  getBidPrice(symbol: string): number {
    return this.getStock(symbol).getBidPrice();
  }

  /** Port of getForecast: (50 +/- otlkMag) / 100. Deliberately NOT otlkMagForecast -
   *  the second-order forecast is never exposed to Netscript, only used internally
   *  to bias how otlkMag itself evolves (see cycleForecast/getForecastIncreaseChance
   *  in stock.ts). A harness has no legitimate way to read otlkMagForecast except
   *  via getStockState(), which is a simulator-analysis backdoor, not something a
   *  real in-game script could call. */
  getForecast(symbol: string): number {
    const stock = this.getStock(symbol);
    return stock.getAbsoluteForecast() / 100;
  }

  /** Port of getVolatility: mv/100. Darknet volatility multiplier omitted (treated as
   *  1x) - see README "Omitted". */
  getVolatility(symbol: string): number {
    return this.getStock(symbol).mv / 100;
  }

  getMaxShares(symbol: string): number {
    return this.getStock(symbol).maxShares;
  }

  /** Port of getPosition: [longShares, longAvgPx, shortShares, shortAvgPx]. */
  getPosition(symbol: string): [number, number, number, number] {
    const stock = this.getStock(symbol);
    return [stock.playerShares, stock.playerAvgPx, stock.playerShortShares, stock.playerAvgShortPx];
  }

  getCash(): number {
    return this.cash;
  }

  getTicksUntilCycle(): number {
    return this.ticksUntilCycle;
  }

  /** Full read-only snapshot of one stock's internal state, for analysis/tests. */
  getStockState(symbol: string): StockState {
    const s = this.getStock(symbol);
    return {
      symbol: s.symbol,
      name: s.name,
      price: s.price,
      lastPrice: s.lastPrice,
      b: s.b,
      otlkMag: s.otlkMag,
      otlkMagForecast: s.otlkMagForecast,
      mv: s.mv,
      spreadPerc: s.spreadPerc,
      cap: s.cap,
      shareTxForMovement: s.shareTxForMovement,
      shareTxUntilMovement: s.shareTxUntilMovement,
      totalShares: s.totalShares,
      maxShares: s.maxShares,
      playerShares: s.playerShares,
      playerAvgPx: s.playerAvgPx,
      playerShortShares: s.playerShortShares,
      playerAvgShortPx: s.playerAvgShortPx,
    };
  }

  /**
   * TEST-ONLY escape hatch: force a stock's price (and lastPrice) to a fixed value.
   * No equivalent exists in the source - a real script cannot set a stock's price.
   * validate.ts uses this to hold a "frozen" stock's price near its starting point
   * across hundreds of thousands of ticks (so it never hits the soft cap or
   * overflows to Infinity) while still sampling the real per-tick return formula.
   * Do not call this from a strategy harness.
   */
  debugSetPrice(symbol: string, price: number): void {
    const stock = this.getStock(symbol);
    stock.price = price;
    stock.lastPrice = price;
  }

  // ---- Trading (port of src/StockMarket/BuyingAndSelling.tsx) ----
  // Each of the four Netscript-facing methods below mirrors the corresponding
  // ns.stock.* wrapper in src/NetscriptFunctions/StockMarket.ts: run the
  // BuyingAndSelling.tsx logic, and return the transaction price on success or 0
  // on failure (never throws for an ordinary failed trade, matching the game).

  buyStock(symbol: string, shares: number): number {
    const stock = this.getStock(symbol);
    return this.doBuy(stock, shares, PositionType.Long) ? stock.getAskPrice() : 0;
  }

  sellStock(symbol: string, shares: number): number {
    const stock = this.getStock(symbol);
    return this.doSellLong(stock, shares) ? stock.getBidPrice() : 0;
  }

  /** Port of ns.stock.buyShort. Returns the BID price on success (yes, bid, not ask -
   *  that's what the source returns for opening a short: `res ? stock.getBidPrice() : 0`). */
  buyShort(symbol: string, shares: number): number {
    const stock = this.getStock(symbol);
    return this.doBuy(stock, shares, PositionType.Short) ? stock.getBidPrice() : 0;
  }

  /** Port of ns.stock.sellShort. Returns the ASK price on success. */
  sellShort(symbol: string, shares: number): number {
    const stock = this.getStock(symbol);
    return this.doSellShort(stock, shares) ? stock.getAskPrice() : 0;
  }

  /** Port of buyStock()/shortStock() (they're identical modulo posType). */
  private doBuy(stock: Stock, shares: number, posType: PositionType): boolean {
    shares = Math.round(shares);
    if (shares <= 0 || isNaN(shares)) return false;

    const totalPrice = getBuyTransactionCost(stock, shares, posType);
    if (totalPrice == null) return false;
    if (this.cash < totalPrice) return false;

    // Would this purchase exceed the maximum number of shares? Checked across BOTH
    // long and short positions combined, per BuyingAndSelling.tsx.
    if (shares + stock.playerShares + stock.playerShortShares > stock.maxShares) return false;

    this.cash -= totalPrice;
    if (posType === PositionType.Long) {
      const origTotal = stock.playerShares * stock.playerAvgPx;
      const newTotal = origTotal + totalPrice - StockMarketConstants.StockMarketCommission;
      stock.playerShares = Math.round(stock.playerShares + shares);
      stock.playerAvgPx = newTotal / stock.playerShares;
    } else {
      const origTotal = stock.playerShortShares * stock.playerAvgShortPx;
      const newTotal = origTotal + totalPrice - StockMarketConstants.StockMarketCommission;
      stock.playerShortShares = Math.round(stock.playerShortShares + shares);
      stock.playerAvgShortPx = newTotal / stock.playerShortShares;
    }

    processTransactionForecastMovement(stock, shares);
    return true;
  }

  /** Port of sellStock(). */
  private doSellLong(stock: Stock, shares: number): boolean {
    if (shares < 0 || isNaN(shares)) return false;
    shares = Math.round(shares);
    if (shares > stock.playerShares) shares = stock.playerShares;
    if (shares === 0) return false;

    const gains = getSellTransactionGain(stock, shares, PositionType.Long);
    if (gains == null) return false;

    this.cash += gains;
    stock.playerShares = Math.round(stock.playerShares - shares);
    if (stock.playerShares === 0) stock.playerAvgPx = 0;

    processTransactionForecastMovement(stock, shares);
    return true;
  }

  /** Port of sellShort(). */
  private doSellShort(stock: Stock, shares: number): boolean {
    if (isNaN(shares) || shares < 0) return false;
    shares = Math.round(shares);
    if (shares > stock.playerShortShares) shares = stock.playerShortShares;
    if (shares === 0) return false;

    // The source also computes `origCost = shares * stock.playerAvgShortPx` here,
    // solely to guard against a NaN/null totalGain; getSellTransactionGain already
    // folds origCost into its short-position math, so we don't need it separately.
    const totalGain = getSellTransactionGain(stock, shares, PositionType.Short);
    if (totalGain == null || isNaN(totalGain)) return false;

    this.cash += totalGain;
    stock.playerShortShares = Math.round(stock.playerShortShares - shares);
    if (stock.playerShortShares === 0) stock.playerAvgShortPx = 0;

    processTransactionForecastMovement(stock, shares);
    return true;
  }

  // ---- Player influence on forecasts (port of src/StockMarket/PlayerInfluencing.ts) ----
  // The source computes the fraction (moneyHacked/server.moneyMax or
  // moneyGrown/server.moneyMax) from a Server object this simulator doesn't model;
  // callers pass that fraction directly.

  /** Port of influenceStockThroughServerHack. `fraction` = moneyHacked / server.moneyMax. */
  influenceHack(symbol: string, fraction: number): void {
    const stock = this.getStock(symbol);
    if (this.rng() < fraction) {
      stock.changeForecastForecast(stock.otlkMagForecast - forecastForecastChangeFromHack);
    }
  }

  /** Port of influenceStockThroughServerGrow. `fraction` = moneyGrown / server.moneyMax. */
  influenceGrow(symbol: string, fraction: number): void {
    const stock = this.getStock(symbol);
    if (this.rng() < fraction) {
      stock.changeForecastForecast(stock.otlkMagForecast + forecastForecastChangeFromHack);
    }
  }

  // ---- Ticking (port of src/StockMarket/StockMarket.ts stockMarketCycle + processStockPrices) ----

  /**
   * Advance the market by one tick. One tick == one call to the "does an update
   * actually happen" body of processStockPrices() in the source - i.e. this
   * simulator treats every tick as a real update. The source's storedCycles /
   * lastUpdate real-wall-clock throttle (which exists so the game can catch up
   * after being closed, and to rate-limit how often the 200ms-cycle game loop is
   * allowed to trigger a stock update) has no meaning for an offline Monte Carlo
   * loop and is omitted entirely - see README "Omitted".
   *
   * Also omitted: order-book processing (processOrders for limit/stop orders) -
   * this simulator has no order book; see README "Omitted".
   */
  tick(): void {
    // Port of the top of processStockPrices(): decrement ticksUntilCycle, and run
    // the cycle if it hits zero, BEFORE the price loop.
    if (!this.frozen) {
      --this.ticksUntilCycle;
      if (this.ticksUntilCycle <= 0) {
        this.stockMarketCycle();
      }
    }

    // One shared v = Math.random() per tick, used by every stock (source: `const v
    // = Math.random();` outside the per-stock loop).
    const v = this.rng();

    for (const stock of this.order) {
      const volatility = stock.mv; // darknet multiplier omitted (== 1) - see README
      let av = (v * volatility) / 100;
      if (isNaN(av)) {
        av = 0.02;
      }

      let chc = 50;
      if (stock.b) {
        chc = (chc + stock.otlkMag) / 100;
      } else {
        chc = (chc - stock.otlkMag) / 100;
      }
      if (stock.price >= stock.cap) {
        chc = 0.1; // "Soft Limit" on stock price. It could still go up but its unlikely
        stock.b = false;
      }
      if (isNaN(chc)) {
        chc = 0.5;
      }

      const c = this.rng();
      if (c < chc) {
        stock.changePrice(stock.price * (1 + av));
      } else {
        stock.changePrice(stock.price / (1 + av));
      }

      if (this.frozen) continue; // frozen: no forecast drift, no shareTx creep

      let otlkMagChange = stock.otlkMag * av;
      if (stock.otlkMag < 5) {
        if (stock.otlkMag <= 1) {
          otlkMagChange = 1;
        } else {
          otlkMagChange *= 10;
        }
      }
      stock.cycleForecast(otlkMagChange);
      stock.cycleForecastForecast(otlkMagChange / 2);

      // Shares required for price movement gradually approaches max over time
      stock.shareTxUntilMovement = Math.min(stock.shareTxUntilMovement + 10, stock.shareTxForMovement);
    }
  }

  /** Port of stockMarketCycle(): each stock independently has a 45% chance to flip
   *  `b` and flip its second-order forecast around 50. Runs before the price loop
   *  in the tick where ticksUntilCycle hits zero. */
  private stockMarketCycle(): void {
    for (const stock of this.order) {
      const roll = this.rng();
      if (roll < 0.45) {
        stock.b = !stock.b;
        stock.flipForecastForecast();
        this.cycleFlips++;
      }
    }
    // Source assigns `StockMarket.ticksUntilCycle = TicksPerCycle` inside the loop,
    // once per stock (so the same constant gets written up to 33 times) - hoisted
    // out here since it's the same value regardless of loop position.
    this.ticksUntilCycle = StockMarketConstants.TicksPerCycle;
    this.cycleEvents++;
    // scaleDarknetVolatilityIncreases(0.4) omitted - no darknet state modeled.
  }

  // ---- Net worth ----

  /**
   * cash + liquidation value of every open position, valued the way the game
   * itself values a sale: getSellTransactionGain() for the long leg (shares * bid
   * - commission) and for the short leg (origCost + (avgShortPx - ask) * shares -
   * commission). There is no canonical "net worth including stocks" formula in the
   * source (Player.money never includes unrealized stock value) - this is a
   * judgment call for the simulator, chosen to answer "what could I actually walk
   * away with right now, including the exit commission I'd have to pay." A
   * position with zero shares contributes nothing (no phantom commission for legs
   * that don't exist).
   */
  netWorth(): number {
    let total = this.cash;
    for (const stock of this.order) {
      if (stock.playerShares > 0) {
        const longGain = getSellTransactionGain(stock, stock.playerShares, PositionType.Long);
        if (longGain != null) total += longGain;
      }
      if (stock.playerShortShares > 0) {
        const shortGain = getSellTransactionGain(stock, stock.playerShortShares, PositionType.Short);
        if (shortGain != null) total += shortGain;
      }
    }
    return total;
  }
}
