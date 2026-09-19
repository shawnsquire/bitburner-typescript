/**
 * Faithful replay of the repo's real 4S-mode stocks daemon tick loop
 * (src/daemons/stocks.ts `daemon()`), driving the stocksim `Market` instead of `ns`,
 * and calling the exact same pure controller functions the real daemon calls
 * (src/controllers/stocks.ts). See results.md for fidelity notes/caveats.
 *
 * Deliberately NOT replicated (out of scope per the task brief):
 *   - smartMode / hack-daemon awareness (no hack daemon exists in the sim; smart mode
 *     is documented elsewhere as inert/wrong)
 *   - pre4S / scraped-forecast paths, tickWindow price history, MA trend detection
 *     (this harness always has 4S access, tick 1)
 *   - TIX/4S API purchase flow and the wse-access budget carve-out (assumed already
 *     owned - the task brief doesn't ask for this)
 *   - external-position-change detection (previousPositions) - nothing else trades
 *     against the same market in a backtest
 *   - tier RAM selection / respawn logic (not part of the trading behavior)
 */
import { Market } from "../stocksim/market.ts";
import {
  forecastSignal,
  shouldSell,
  shouldStopLoss,
  updatePeakPrice,
  calcWeightedBudget,
  calculatePositionSize,
  meetsCommissionThreshold,
  TRADING_PROFILES,
  type PositionTracking,
  type StopLossParams,
} from "../../../src/controllers/stocks.ts";
import { COMMISSION, HORIZON, MetricsTracker, computeTradingCapital, type CapitalParams, type RunMetrics } from "./common.ts";

export interface DaemonParamOverrides {
  minForecastDeviation?: number;
  sellForecastDeviation?: number;
  hardStopPercent?: number;
  trailingStopPercent?: number;
  maxHoldTicks?: number;
  maxPositions?: number;
  sellCooldownTicks?: number;
  commissionPerTrade?: number;
}

export interface DaemonConfig {
  profile: "aggressive" | "moderate" | "conservative";
  overrides?: DaemonParamOverrides;
  capital: CapitalParams;
  startCash: number;
  canShort: boolean;
  horizon?: number;
  /** Bonus ablation: use bid/ask (the price you'd actually get) instead of mid for the
   *  ongoing peak-tracking/stop-loss check on an already-open position, instead of the
   *  daemon's actual `ns.stock.getPrice(sym)` (mid). Entry price/peak are ALWAYS the
   *  fill price regardless of this flag - that's the daemon's real behavior, not a variant. */
  useFillPriceForStops?: boolean;
}

const PRE_THRESHOLD = 0.03; // writeDefaultConfig default; irrelevant in 4S mode (maRatio always null)

function resolveParams(cfg: DaemonConfig) {
  const base = TRADING_PROFILES[cfg.profile];
  return {
    minForecastDeviation: base.minForecastDeviation,
    sellForecastDeviation: base.sellForecastDeviation,
    hardStopPercent: base.stopLossPercent,
    trailingStopPercent: base.trailingStopPercent,
    maxHoldTicks: base.maxHoldTicks,
    maxPositions: base.maxPositions,
    sellCooldownTicks: 3,
    commissionPerTrade: COMMISSION,
    ...cfg.overrides,
  };
}

interface Candidate {
  sym: string;
  dir: "long" | "short";
  strength: number;
  price: number;
  expectedReturn: number;
  forecast: number;
}

export function runDaemon(seed: number, cfg: DaemonConfig): RunMetrics {
  const horizon = cfg.horizon ?? HORIZON;
  const market = new Market(seed, { cash: cfg.startCash });
  const symbols = market.symbols();
  const params = resolveParams(cfg);
  const stopParams: StopLossParams = {
    hardStopPercent: params.hardStopPercent,
    trailingStopPercent: params.trailingStopPercent,
    maxHoldTicks: params.maxHoldTicks,
  };

  const tracker = new MetricsTracker(seed, market.netWorth());
  const positionTracking = new Map<string, PositionTracking>();
  const sellCooldowns = new Map<string, number>();
  let tickCount = 0;

  for (let t = 0; t < horizon; t++) {
    market.tick();
    tickCount++;

    // --- Budget: tradingCapital read once before the per-symbol loop, exactly like
    // the real daemon reading getBudgetBalance() before its symbol loop. portfolioValue
    // uses the daemon's own definition (mark-to-mid longs, cost-basis shorts), NOT the
    // sim's netWorth() liquidation value - see docs/systems/budget.md + daemon lines
    // ~719/792.
    let portfolioValue = 0;
    for (const sym of symbols) {
      const [longShares, , shortShares, shortAvg] = market.getPosition(sym);
      if (longShares > 0) portfolioValue += longShares * market.getPrice(sym);
      if (shortShares > 0) portfolioValue += shortShares * shortAvg;
    }
    const netWorthNow = market.netWorth();
    const tradingCapital = computeTradingCapital(cfg.capital, netWorthNow, portfolioValue, market.getCash());

    const buyCandidates: Candidate[] = [];
    let longCount = 0;
    let shortCount = 0;

    for (const sym of symbols) {
      const price = market.getPrice(sym);
      const [longShares, , shortShares, shortAvg] = market.getPosition(sym);
      const forecast = market.getForecast(sym);
      const volatility = market.getVolatility(sym);
      const sig = forecastSignal(forecast, volatility, params.minForecastDeviation);

      if (longShares > 0) {
        longCount++;
        const longKey = `${sym}-long`;
        let tracking = positionTracking.get(longKey);
        if (!tracking) {
          // Inherited/untracked position (shouldn't happen from a clean start, but
          // mirrors the daemon's defensive init-on-first-sight for parity).
          tracking = { entryPrice: price, peakPrice: price, ticksHeld: 0, direction: "long" };
          positionTracking.set(longKey, tracking);
        }
        tracking.ticksHeld++;
        const checkPrice = cfg.useFillPriceForStops ? market.getBidPrice(sym) : price;
        tracking.peakPrice = updatePeakPrice(checkPrice, tracking);

        let sold = false;
        const stopCheck = shouldStopLoss(checkPrice, tracking, stopParams);
        if (stopCheck.shouldExit) {
          const before = market.getStockState(sym).otlkMag;
          const fill = market.sellStock(sym, longShares);
          if (fill > 0) {
            const after = market.getStockState(sym).otlkMag;
            tracker.recordErosion(before, after);
            tracker.recordTradeCost(fill, price, longShares, params.commissionPerTrade);
            tracker.recordExit(stopCheck.reason);
            positionTracking.delete(longKey);
            sellCooldowns.set(sym, tickCount);
            sold = true;
          }
        }
        if (!sold) {
          const shouldSellLong = shouldSell("long", forecast, null, params.sellForecastDeviation, PRE_THRESHOLD);
          if (shouldSellLong) {
            const before = market.getStockState(sym).otlkMag;
            const fill = market.sellStock(sym, longShares);
            if (fill > 0) {
              const after = market.getStockState(sym).otlkMag;
              tracker.recordErosion(before, after);
              tracker.recordTradeCost(fill, price, longShares, params.commissionPerTrade);
              tracker.recordExit("signal");
              positionTracking.delete(longKey);
              sellCooldowns.set(sym, tickCount);
            }
          }
        }
      }

      if (shortShares > 0) {
        shortCount++;
        const shortKey = `${sym}-short`;
        let tracking = positionTracking.get(shortKey);
        if (!tracking) {
          tracking = { entryPrice: price, peakPrice: price, ticksHeld: 0, direction: "short" };
          positionTracking.set(shortKey, tracking);
        }
        tracking.ticksHeld++;
        const checkPrice = cfg.useFillPriceForStops ? market.getAskPrice(sym) : price;
        tracking.peakPrice = updatePeakPrice(checkPrice, tracking);

        let sold = false;
        const stopCheck = shouldStopLoss(checkPrice, tracking, stopParams);
        if (stopCheck.shouldExit) {
          const before = market.getStockState(sym).otlkMag;
          const fill = market.sellShort(sym, shortShares);
          if (fill > 0) {
            const after = market.getStockState(sym).otlkMag;
            tracker.recordErosion(before, after);
            tracker.recordTradeCost(fill, price, shortShares, params.commissionPerTrade);
            tracker.recordExit(stopCheck.reason);
            positionTracking.delete(shortKey);
            sellCooldowns.set(sym, tickCount);
            sold = true;
          }
        }
        if (!sold) {
          const shouldSellShortFlag = shouldSell("short", forecast, null, params.sellForecastDeviation, PRE_THRESHOLD);
          if (shouldSellShortFlag) {
            const before = market.getStockState(sym).otlkMag;
            const fill = market.sellShort(sym, shortShares);
            if (fill > 0) {
              const after = market.getStockState(sym).otlkMag;
              tracker.recordErosion(before, after);
              tracker.recordTradeCost(fill, price, shortShares, params.commissionPerTrade);
              tracker.recordExit("signal");
              positionTracking.delete(shortKey);
              sellCooldowns.set(sym, tickCount);
            }
          }
        }
      }

      if (sig.direction !== "neutral" && sig.strength > 0) {
        if (sig.direction === "long" && longShares === 0) {
          buyCandidates.push({ sym, dir: "long", strength: sig.strength, price, expectedReturn: sig.expectedReturn, forecast });
        } else if (sig.direction === "short" && shortShares === 0 && cfg.canShort) {
          buyCandidates.push({ sym, dir: "short", strength: sig.strength, price, expectedReturn: sig.expectedReturn, forecast });
        }
      }
    }

    // --- Buys, sorted by strength desc; weighted allocation; diversification cap.
    buyCandidates.sort((a, b) => b.strength - a.strength);
    const totalCandidateStrength = buyCandidates.reduce((sum, c) => sum + c.strength, 0);
    const currentPositionCount = longCount + shortCount;
    let newPositions = 0;
    for (const cand of buyCandidates) {
      if (params.maxPositions > 0 && currentPositionCount + newPositions >= params.maxPositions) break;

      if (params.sellCooldownTicks > 0) {
        const lastSoldTick = sellCooldowns.get(cand.sym);
        if (lastSoldTick !== undefined && tickCount - lastSoldTick < params.sellCooldownTicks) continue;
      }

      const maxShares = market.getMaxShares(cand.sym);
      const playerCash = market.getCash();
      const perStockBudget = calcWeightedBudget(tradingCapital, params.maxPositions, cand.strength, totalCandidateStrength);
      const availCash = Math.min(perStockBudget, playerCash * 0.9, tradingCapital);
      const sharesToBuy = calculatePositionSize(availCash, maxShares, cand.price);
      if (sharesToBuy <= 0) continue;

      if (!meetsCommissionThreshold(sharesToBuy, cand.price, cand.expectedReturn, params.commissionPerTrade)) {
        continue;
      }

      if (cand.dir === "long") {
        const before = market.getStockState(cand.sym).otlkMag;
        const fill = market.buyStock(cand.sym, sharesToBuy);
        if (fill > 0) {
          const after = market.getStockState(cand.sym).otlkMag;
          tracker.recordErosion(before, after);
          tracker.recordTradeCost(fill, cand.price, sharesToBuy, params.commissionPerTrade);
          tracker.recordBuyCapacity(sharesToBuy, maxShares);
          positionTracking.set(`${cand.sym}-long`, { entryPrice: fill, peakPrice: fill, ticksHeld: 0, direction: "long", forecastAtEntry: cand.forecast });
          newPositions++;
        }
      } else {
        const before = market.getStockState(cand.sym).otlkMag;
        const fill = market.buyShort(cand.sym, sharesToBuy);
        if (fill > 0) {
          const after = market.getStockState(cand.sym).otlkMag;
          tracker.recordErosion(before, after);
          tracker.recordTradeCost(fill, cand.price, sharesToBuy, params.commissionPerTrade);
          tracker.recordBuyCapacity(sharesToBuy, maxShares);
          positionTracking.set(`${cand.sym}-short`, { entryPrice: fill, peakPrice: fill, ticksHeld: 0, direction: "short", forecastAtEntry: cand.forecast });
          newPositions++;
        }
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
