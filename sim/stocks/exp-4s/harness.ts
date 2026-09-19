/**
 * Faithful replay of the repo's real stocks daemon tick loop (src/daemons/stocks.ts
 * `daemon()`), driving the stocksim `Market` instead of `ns`, and calling the exact
 * same pure controller functions the real daemon calls (src/controllers/stocks.ts).
 * See results-v2.md for fidelity notes/caveats.
 *
 * Per-tick order mirrors daemon.ts exactly:
 *   1. tradingCapital read once (daemon.ts:530-534, `getBudgetBalance`)
 *   2. per symbol: sells first (shouldSell on the forecast, daemon.ts:633-667), then
 *      re-read position, then held-position bookkeeping (portfolioValue, ticksHeld;
 *      daemon.ts:669-702), then entry candidates (daemon.ts:704-718)
 *   3. after the symbol loop: one shared cash pool via planPurchases, executed with
 *      buyStock/buyShort (daemon.ts:736-764)
 *
 * Deliberately NOT replicated (out of scope per the task brief, same as the old
 * harness this replaces):
 *   - smartMode / hack-daemon awareness (no hack daemon exists in the sim)
 *   - TIX/4S API purchase flow and the wse-access budget carve-out (assumed already
 *     owned in "true4s" mode; "estimated" mode assumes tier 2 with no 4S at all)
 *   - external-position-change detection (previousPositions) - nothing else trades
 *     against the same market in a backtest
 *   - tier RAM selection / respawn logic (not part of the trading behavior)
 *   - scraped-forecast mode (DOM scraper fallback) - "true4s" mode covers both real
 *     4S and scraped since the daemon treats them identically (both `exactForecast`)
 */
import { Market } from "../stocksim/market.ts";
import {
  createPriceHistory,
  addPrice,
  estimateForecast,
  estimateVolatility,
  forecastSignal,
  spreadFromQuotes,
  planPurchases,
  shouldSell,
  type PriceHistory,
  type PositionTracking,
  type PurchaseCandidate,
  type Direction,
} from "../../../src/controllers/stocks.ts";
import { COMMISSION, HORIZON, MetricsTracker, computeTradingCapital, type CapitalParams, type RunMetrics } from "./common.ts";

/** Signal source: "true4s" reads market.getForecast/getVolatility directly (models
 *  both real 4S and the scraped-forecast fallback, which the daemon treats identically
 *  as `exactForecast`); "estimated" derives forecast/volatility from price history via
 *  estimateForecast/estimateVolatility only, and never calls getForecast/getVolatility -
 *  models tier-2 (pre-4S) operation. */
export type SignalMode = "true4s" | "estimated";

export interface DaemonConfig {
  mode: SignalMode;
  /** Entry gate for exactForecast signals (4S/scraped). Daemon config default: 0.05. */
  minForecastDeviation: number;
  /** Entry gate for estimated signals - wider because the estimate is noisier. Daemon
   *  config default: 0.10. Unused in "true4s" mode. */
  preMinForecastDeviation?: number;
  /** Price-history window for the pre-4S estimator. Daemon config default: 40. */
  tickWindow?: number;
  /** Round-trip hurdle horizon passed to planPurchases. Daemon config default: 50. */
  holdHorizonTicks?: number;
  /** Cash held back from the pool every tick regardless of capital mode. Daemon config
   *  default: 10. */
  cashReservePercent?: number;
  capital: CapitalParams;
  startCash: number;
  canShort: boolean;
  horizon?: number;
}

/**
 * tradingCapital per daemon.ts:530-534 + src/controllers/budget.ts computeAllowances:
 * allowance = max(0, weight*netWorth - portfolioValue), netWorth = cash + portfolioValue
 * (no corp holdings modeled here). portfolioValue is the daemon's own definition (mark
 * long at bid, short at cost basis, daemon.ts:673-692) - NOT the sim's `market.netWorth()`
 * liquidation-value method, which subtracts commission per leg and marks shorts to their
 * current buy-back cost instead of cost basis. The old exp-4s harness/canonical.ts used
 * `market.netWorth()` for this formula's netWorth term as a documented approximation;
 * this harness uses the budget controller's actual netWorth definition instead, since the
 * task brief spells out the allowance formula precisely. The difference is small in
 * practice (idle-cash fractions observed here run 60-95%, so portfolioValue is a small
 * share of netWorth either way) but the two are not identical formulas - see results-v2.md.
 */
function tradingCapitalForTick(capital: CapitalParams, cash: number, portfolioValue: number): number {
  const netWorth = cash + portfolioValue;
  return computeTradingCapital(capital, netWorth, portfolioValue, cash);
}

export function runDaemon(seed: number, cfg: DaemonConfig): RunMetrics {
  const horizon = cfg.horizon ?? HORIZON;
  const market = new Market(seed, { cash: cfg.startCash });
  const symbols = market.symbols();
  const commission = COMMISSION;
  const holdHorizonTicks = cfg.holdHorizonTicks ?? 50;
  const cashReservePercent = cfg.cashReservePercent ?? 10;
  const preMinForecastDeviation = cfg.preMinForecastDeviation ?? 0.10;
  const tickWindow = cfg.tickWindow ?? 40;
  const reserveFraction = Math.min(Math.max(cashReservePercent, 0), 100) / 100;

  const tracker = new MetricsTracker(seed, market.netWorth());
  const positionTracking = new Map<string, PositionTracking>();
  const priceHistories = new Map<string, PriceHistory>();

  for (let t = 0; t < horizon; t++) {
    market.tick();

    // --- tradingCapital: read once before the per-symbol loop (daemon.ts:530-534),
    // from portfolioValue as of the END of the previous tick (the daemon's actual
    // ordering: getBudgetBalance() is called before this tick has touched anything).
    let portfolioValue = 0;
    for (const sym of symbols) {
      const [longShares, , shortShares, shortAvg] = market.getPosition(sym);
      if (longShares > 0) portfolioValue += longShares * market.getBidPrice(sym);
      if (shortShares > 0) portfolioValue += shortShares * shortAvg;
    }
    const tradingCapital = tradingCapitalForTick(cfg.capital, market.getCash(), portfolioValue);

    const candidates: PurchaseCandidate[] = [];

    for (const sym of symbols) {
      const ask = market.getAskPrice(sym);
      const bid = market.getBidPrice(sym);
      const spread = spreadFromQuotes(ask, bid);
      let [longShares, longAvg, shortShares, shortAvg] = market.getPosition(sym);

      // Price history bookkeeping - always updated, exactly like daemon.ts:589-594
      // (used for the pre-4S estimate; harmless bookkeeping otherwise).
      if (!priceHistories.has(sym)) priceHistories.set(sym, createPriceHistory(tickWindow));
      const history = priceHistories.get(sym)!;
      addPrice(history, market.getPrice(sym));

      // --- Forecast + volatility (daemon.ts:596-616)
      let forecast: number | null;
      let volatility: number | null;
      if (cfg.mode === "true4s") {
        forecast = market.getForecast(sym);
        volatility = market.getVolatility(sym);
      } else {
        forecast = estimateForecast(history);
        volatility = estimateVolatility(history);
      }

      const minDeviation = cfg.mode === "true4s" ? cfg.minForecastDeviation : preMinForecastDeviation;
      const sig = forecast !== null && volatility !== null && volatility > 0
        ? forecastSignal(forecast, volatility, minDeviation)
        : null;
      const signalDir: Direction | "neutral" = sig ? sig.direction : "neutral";
      const expectedReturn = sig ? sig.expectedReturn : 0;

      // === EXITS (daemon.ts:632-667): sell first, then re-read position ===
      if (longShares > 0 && shouldSell("long", forecast)) {
        const longKey = `${sym}-long`;
        const before = market.getStockState(sym).otlkMag;
        const fill = market.sellStock(sym, longShares);
        if (fill > 0) {
          const after = market.getStockState(sym).otlkMag;
          tracker.recordErosion(before, after);
          tracker.recordTradeCost(fill, market.getPrice(sym), longShares, commission);
          tracker.recordExit("signal");
          positionTracking.delete(longKey);
          [longShares, longAvg, shortShares, shortAvg] = market.getPosition(sym);
        }
      }
      if (shortShares > 0 && shouldSell("short", forecast)) {
        const shortKey = `${sym}-short`;
        const before = market.getStockState(sym).otlkMag;
        const fill = market.sellShort(sym, shortShares);
        if (fill > 0) {
          const after = market.getStockState(sym).otlkMag;
          tracker.recordErosion(before, after);
          tracker.recordTradeCost(fill, market.getPrice(sym), shortShares, commission);
          tracker.recordExit("signal");
          positionTracking.delete(shortKey);
          [longShares, longAvg, shortShares, shortAvg] = market.getPosition(sym);
        }
      }

      // === HELD POSITIONS (daemon.ts:669-702): bookkeeping at post-exit shares ===
      if (longShares > 0) {
        const longKey = `${sym}-long`;
        if (!positionTracking.has(longKey)) {
          positionTracking.set(longKey, { entryPrice: longAvg, ticksHeld: 0, direction: "long" });
        }
        positionTracking.get(longKey)!.ticksHeld++;
      }
      if (shortShares > 0) {
        const shortKey = `${sym}-short`;
        if (!positionTracking.has(shortKey)) {
          positionTracking.set(shortKey, { entryPrice: shortAvg, ticksHeld: 0, direction: "short" });
        }
        positionTracking.get(shortKey)!.ticksHeld++;
      }

      // === ENTRY CANDIDATES (daemon.ts:704-718) ===
      if (signalDir !== "neutral" && (signalDir === "long" || cfg.canShort)) {
        const opposite = signalDir === "long" ? shortShares : longShares;
        if (opposite === 0) {
          const sharesRoom = market.getMaxShares(sym) - longShares - shortShares;
          candidates.push({
            symbol: sym,
            direction: signalDir,
            expectedReturn,
            fillPrice: signalDir === "long" ? ask : bid,
            spread,
            sharesRoom,
          });
        }
      }
    }

    // === BUY (daemon.ts:736-764): one shared pool, ranked by |expectedReturn| ===
    if (candidates.length > 0) {
      const cashPool = Math.min(tradingCapital, market.getCash() * (1 - reserveFraction));
      const orders = planPurchases(candidates, cashPool, {
        commission,
        horizonTicks: holdHorizonTicks,
        minOrderNotional: commission * 100,
      });
      for (const order of orders) {
        const before = market.getStockState(order.symbol).otlkMag;
        const fill = order.direction === "long"
          ? market.buyStock(order.symbol, order.shares)
          : market.buyShort(order.symbol, order.shares);
        if (fill <= 0) continue;
        const after = market.getStockState(order.symbol).otlkMag;
        tracker.recordErosion(before, after);
        const key = `${order.symbol}-${order.direction}`;
        if (!positionTracking.has(key)) {
          positionTracking.set(key, { entryPrice: fill, ticksHeld: 0, direction: order.direction });
        }
        tracker.recordTradeCost(fill, market.getPrice(order.symbol), order.shares, commission);
        tracker.recordBuyCapacity(order.shares, market.getMaxShares(order.symbol));
      }
    }

    // --- Sample post-trade state for drawdown/idle metrics.
    let openPositions = 0;
    for (const sym of symbols) {
      const [l, , s] = market.getPosition(sym);
      if (l > 0 || s > 0) openPositions++;
    }
    tracker.sampleTick(market.netWorth(), market.getCash(), openPositions);
  }

  return tracker.finish(market.netWorth());
}
