/**
 * Stocks Controller (Pure Logic)
 *
 * Signal estimation, entry gating, rank-and-fill sizing and exit rules for the
 * stocks daemon. Zero NS imports — safe to import without RAM cost, and safe to
 * import from the dashboard bundle and from the offline simulator (sim/stocks).
 *
 * The rules follow the game's market model (src/StockMarket in the game source):
 *   - expected log return per tick = (forecast - 0.5) * volatility
 *   - the forecast is the complete drift state, so exits key on the forecast alone
 *   - every 75 ticks a stock flips its forecast with 45% probability, instantly
 *   - spread (0.1% to 2% per side) dominates the flat 100k commission
 *
 * Import with: import { ... } from "/controllers/stocks";
 */

// === TRADING PROFILES ===

export type TradingProfileName = "aggressive" | "moderate" | "conservative" | "custom";

/**
 * A profile is an entry threshold. Measured over 200 seeds at 100b (sim/stocks/exp-4s):
 * 0.05 earns the most with about 4.6% max drawdown, 0.10 gives up 7% of return for
 * 3% drawdown, 0.15 gives up 17% for 2.2%.
 */
export interface TradingProfile {
  minForecastDeviation: number;
}

export const TRADING_PROFILES: Record<Exclude<TradingProfileName, "custom">, TradingProfile> = {
  aggressive: { minForecastDeviation: 0.05 },
  moderate: { minForecastDeviation: 0.10 },
  conservative: { minForecastDeviation: 0.15 },
};

/** Config keys and string values the dashboard writes when a profile is selected. */
export function profileConfigValues(name: Exclude<TradingProfileName, "custom">): Record<string, string> {
  const p = TRADING_PROFILES[name];
  return { minForecastDeviation: String(p.minForecastDeviation) };
}

/** Detect which profile matches the current config values, or "custom" if none match. */
export function detectActiveProfile(config: TradingProfile): TradingProfileName {
  for (const [name, profile] of Object.entries(TRADING_PROFILES) as [Exclude<TradingProfileName, "custom">, TradingProfile][]) {
    if (Math.abs(config.minForecastDeviation - profile.minForecastDeviation) < 0.001) {
      return name;
    }
  }
  return "custom";
}

// === PRICE HISTORY (PRE-4S) ===

/** Half-life, in ticks, of the exponentially weighted up-tick fraction. */
export const EWMA_HALF_LIFE = 20;
const EWMA_ALPHA = 1 - Math.pow(2, -1 / EWMA_HALF_LIFE);

export interface PriceHistory {
  prices: number[];
  maxLength: number;
  /** Number of tick directions observed (drives the minimum-sample gate). */
  samples: number;
  /** Exponentially weighted fraction of up-ticks (0..1). */
  ewmaUp: number;
  /** Exponentially weighted total (converges to 1); ewmaUp / ewmaWeight is the estimate. */
  ewmaWeight: number;
}

export function createPriceHistory(maxLength: number): PriceHistory {
  return { prices: [], maxLength, samples: 0, ewmaUp: 0, ewmaWeight: 0 };
}

/**
 * Record a price sample. A price equal to the previous one is a duplicate read of
 * the same tick (the market always moves), so it is dropped rather than counted.
 */
export function addPrice(history: PriceHistory, price: number): void {
  if (history.prices.length > 0) {
    const prevPrice = history.prices[history.prices.length - 1];
    if (price === prevPrice) return;
    const up = price > prevPrice ? 1 : 0;
    history.ewmaUp = history.ewmaUp * (1 - EWMA_ALPHA) + up * EWMA_ALPHA;
    history.ewmaWeight = history.ewmaWeight * (1 - EWMA_ALPHA) + EWMA_ALPHA;
    history.samples++;
  }

  history.prices.push(price);
  if (history.prices.length > history.maxLength) {
    history.prices.shift();
  }
}

/**
 * Estimate the forecast, P(up), from tick directions. Exponentially weighted with a
 * 20-tick half-life; measured against the true forecast this has a lower error, a
 * lower false-signal rate and a faster flip reaction than a uniform 40-tick window
 * (sim/stocks/exp-pre4s). Returns null until minTicks directions have been seen.
 */
export function estimateForecast(history: PriceHistory, minTicks = 10): number | null {
  if (history.samples < minTicks || history.ewmaWeight <= 0) return null;
  return history.ewmaUp / history.ewmaWeight;
}

/**
 * Estimate volatility from price history. The game moves a price by ×(1+v·vol) or
 * ÷(1+v·vol) with v uniform on (0,1), so |log return| = ln(1+v·vol) and the largest
 * move in a window of W returns has expectation vol·W/(W+1). The stddev of returns
 * (the previous estimator) is vol/√3, 1.8x too low. Needs at least 3 prices.
 */
export function estimateVolatility(history: PriceHistory): number | null {
  if (history.prices.length < 3) return null;
  let maxAbs = 0;
  let count = 0;
  for (let i = 1; i < history.prices.length; i++) {
    const prev = history.prices[i - 1];
    const cur = history.prices[i];
    if (prev > 0 && cur > 0) {
      maxAbs = Math.max(maxAbs, Math.abs(Math.log(cur / prev)));
      count++;
    }
  }
  if (count < 2) return null;
  // |log ret| = ln(1+av) ≈ av; invert the log so the estimate is on the av scale
  const maxMove = Math.expm1(maxAbs);
  return maxMove * (count + 1) / count;
}

// === EXPECTED RETURN ===

/**
 * Expected log return per tick. Positive = long, negative = short.
 *   expectedReturn = volatility × (forecast − 0.5)
 */
export function calcExpectedReturn(forecast: number, volatility: number): number {
  return volatility * (forecast - 0.5);
}

// === SIGNALS ===

export type Direction = "long" | "short";

export interface ForecastSignal {
  direction: Direction | "neutral";
  forecast: number;
  expectedReturn: number; // signed, per tick
}

/**
 * Entry signal from a forecast. Neutral unless the forecast is at least
 * minForecastDeviation away from 0.5.
 */
export function forecastSignal(forecast: number, volatility: number, minForecastDeviation: number): ForecastSignal {
  const expectedReturn = calcExpectedReturn(forecast, volatility);
  if (Math.abs(forecast - 0.5) >= minForecastDeviation && expectedReturn !== 0) {
    return { direction: expectedReturn > 0 ? "long" : "short", forecast, expectedReturn };
  }
  return { direction: "neutral", forecast, expectedReturn };
}

// === SPREAD ===

/** Per-side spread as a fraction of the mid price, from the ask and bid the game quotes. */
export function spreadFromQuotes(ask: number, bid: number): number {
  const mid = (ask + bid) / 2;
  if (mid <= 0) return 0;
  return Math.max(0, (ask - bid) / (2 * mid));
}

/**
 * Entry gate: the expected return over `horizonTicks` must cover the round trip
 * (spread paid on entry and exit, plus two commissions on the order's notional).
 * Expected time to the next forecast flip is about 167 ticks; 50 was the best
 * horizon in the backtests and anything from 50 to 100 is equivalent.
 */
export function clearsRoundTrip(
  expectedReturnPerTick: number,
  spread: number,
  commission: number,
  notional: number,
  horizonTicks: number,
): boolean {
  if (notional <= 0 || horizonTicks <= 0) return false;
  const hurdle = 2 * spread + (2 * commission) / notional;
  return Math.abs(expectedReturnPerTick) * horizonTicks >= hurdle;
}

// === RANK-AND-FILL SIZING ===

export interface PurchaseCandidate {
  symbol: string;
  direction: Direction;
  /** Signed expected log return per tick. */
  expectedReturn: number;
  /** Price paid per share: ask for a long, bid for a short. */
  fillPrice: number;
  /** Per-side spread fraction (see spreadFromQuotes). */
  spread: number;
  /** Shares that can still be bought before maxShares (long + short combined). */
  sharesRoom: number;
}

export interface PurchaseOrder {
  symbol: string;
  direction: Direction;
  shares: number;
  /** fillPrice × shares + commission. */
  cost: number;
}

export interface PlanOptions {
  commission: number;
  horizonTicks: number;
  /** Skip orders whose notional is below this (dust would pay a full commission). */
  minOrderNotional: number;
}

/**
 * Rank candidates by |expected return| and fill each to its share room until the
 * cash pool is exhausted. One shared pool drains across the orders: this is what
 * lets one strong signal take most of the capital instead of spreading it evenly.
 * Candidates that do not clear the round-trip hurdle at the size they would get are
 * skipped, not shrunk.
 */
export function planPurchases(
  candidates: PurchaseCandidate[],
  cashPool: number,
  opts: PlanOptions,
): PurchaseOrder[] {
  const ranked = candidates
    .filter((c) => c.sharesRoom > 0 && c.fillPrice > 0 && c.expectedReturn !== 0)
    .sort((a, b) => Math.abs(b.expectedReturn) - Math.abs(a.expectedReturn));

  const orders: PurchaseOrder[] = [];
  let cash = cashPool;
  for (const c of ranked) {
    const affordable = Math.floor((cash - opts.commission) / c.fillPrice);
    const shares = Math.min(affordable, c.sharesRoom);
    if (shares <= 0) continue;
    const notional = shares * c.fillPrice;
    if (notional < opts.minOrderNotional) continue;
    if (!clearsRoundTrip(c.expectedReturn, c.spread, opts.commission, notional, opts.horizonTicks)) continue;
    const cost = notional + opts.commission;
    orders.push({ symbol: c.symbol, direction: c.direction, shares, cost });
    cash -= cost;
    if (cash <= opts.commission) break;
  }
  return orders;
}

// === EXITS ===

/**
 * Exit rule: a long is held while the forecast is above 0.5 and a short while it is
 * below. Forecast crossings are mostly instant flips of ten points or more, so a
 * hysteresis band around 0.5 changes nothing except holding losers a little longer.
 * Works for the true forecast (4S, scraped) and for the pre-4S estimate alike.
 */
export function shouldSell(position: Direction, forecast: number | null): boolean {
  if (forecast === null) return false;
  if (position === "long") return forecast < 0.5;
  return forecast > 0.5;
}

// === POSITION TRACKING ===

export interface PositionTracking {
  entryPrice: number;
  ticksHeld: number;
  direction: Direction;
  forecastAtEntry?: number;
}

// === P&L ===

/** Net proceeds of closing a long: shares at the bid less commission. */
export function longExitProfit(shares: number, avgPrice: number, bid: number, commission: number): number {
  return shares * (bid - avgPrice) - commission;
}

/** Net profit of covering a short: shares × (entry − ask) less commission. */
export function shortExitProfit(shares: number, avgPrice: number, ask: number, commission: number): number {
  return shares * (avgPrice - ask) - commission;
}
