// Experiment C engine: replicate the daemon's pre-4S trading loop (longs only), plus
// two comparison variants, driven against the stocksim Market.
import { Market } from "/tmp/claude-1000/-home-shawn--herdr-worktrees-bitburner-typescript-stocks/67a69ebc-119f-4e9a-acf8-71dce941d214/scratchpad/stocksim/market.ts";
import {
  createPriceHistory,
  addPrice,
  detectTrend,
  forecastSignal,
  calcExpectedReturn,
  calcWeightedBudget,
  calculatePositionSize,
  meetsCommissionThreshold,
  estimateForecast,
  estimateVolatility,
  shouldSell,
  shouldStopLoss,
  updatePeakPrice,
} from "../../../src/controllers/stocks.ts";
import type {
  PriceHistory,
  PositionTracking,
  StopLossParams,
} from "../../../src/controllers/stocks.ts";
import { createInvAware, updateInvAware } from "./estimators.ts";
import type { InvAwareState } from "./estimators.ts";

export const STARTING_CASH = 100e9;
export const TICKS = 3000;
export const TICK_WINDOW = 40;
export const PRE_THRESHOLD = 0.03;
export const MIN_FORECAST_DEV = 0.10;
export const SELL_FORECAST_DEV = 0.05;
export const COMMISSION = 1e5;
export const MAX_POSITIONS = 8;
export const COOLDOWN_TICKS = 3;
export const BUDGET_FRACTION = 0.3;
export const CASH_CAP = 0.9;
const STOP_PARAMS: StopLossParams = { hardStopPercent: 0.15, trailingStopPercent: 0.08, maxHoldTicks: 60 };

export type Variant = "baseline" | "variantI" | "oracle" | "baselineNoStops";

export interface VariantResult {
  logReturn: number; // ln(final netWorth / starting cash) over the whole run
  logReturnPer100: number;
  trades: number; // buy executions
  roundTrips: number; // sell executions
  maxDrawdown: number; // fraction, 0-1
  commissionPaid: number;
  spreadCost: number;
  finalNetWorth: number;
  finalPositions: number;
  exitReasons: Record<string, number>;
}

interface Candidate {
  sym: string;
  strength: number;
  price: number; // mid, at decision time
  expectedReturn: number;
  forecast?: number;
}

export function runVariant(seed: number, variant: Variant): VariantResult {
  const market = new Market(seed, { cash: STARTING_CASH });
  const symbols = market.symbols();

  const histories = new Map<string, PriceHistory>(); // used for vol (all variants) + baseline forecast/MA
  const invStates = new Map<string, InvAwareState>(); // variantI only
  const tracking = new Map<string, PositionTracking>();
  const cooldowns = new Map<string, number>();

  for (const sym of symbols) {
    histories.set(sym, createPriceHistory(TICK_WINDOW));
    if (variant === "variantI") invStates.set(sym, createInvAware(TICK_WINDOW, 10, "skipFlat"));
  }

  let trades = 0;
  let roundTrips = 0;
  let commissionPaid = 0;
  let spreadCost = 0;
  let peakNetWorth = STARTING_CASH;
  let maxDrawdown = 0;
  const exitReasons: Record<string, number> = {};

  for (let t = 0; t < TICKS; t++) {
    market.tick();

    // Pass 0: net worth / portfolio value / trading capital (30% bucket allowance).
    const netWorth = market.netWorth();
    let portfolioValue = 0;
    for (const sym of symbols) {
      const [longShares] = market.getPosition(sym);
      if (longShares > 0) portfolioValue += longShares * market.getPrice(sym);
    }
    const tradingCapital = Math.max(0, BUDGET_FRACTION * netWorth - portfolioValue);

    peakNetWorth = Math.max(peakNetWorth, netWorth);
    if (peakNetWorth > 0) maxDrawdown = Math.max(maxDrawdown, (peakNetWorth - netWorth) / peakNetWorth);

    const candidates: Candidate[] = [];
    let positionCountThisTick = 0;

    // Pass 1: per-symbol signal, existing-position management, candidate collection.
    for (const sym of symbols) {
      const price = market.getPrice(sym);
      const [longShares, longAvg] = market.getPosition(sym);
      const hadSharesAtStart = longShares > 0;

      const history = histories.get(sym)!;
      addPrice(history, price);

      let signalDir: "long" | "short" | "neutral" = "neutral";
      let signalStrength = 0;
      let expectedReturn = 0;
      let forecastVal: number | undefined;
      let maRatio: number | null = null;
      let forecastForSell: number | null = null;

      if (variant === "oracle") {
        const forecast = market.getForecast(sym);
        const volatility = market.getVolatility(sym);
        const sig = forecastSignal(forecast, volatility, MIN_FORECAST_DEV);
        signalDir = sig.direction;
        signalStrength = sig.strength;
        expectedReturn = sig.expectedReturn;
        forecastVal = forecast;
        forecastForSell = forecast;
      } else if (variant === "baseline" || variant === "baselineNoStops") {
        const volatility = estimateVolatility(history);
        const sig = detectTrend(history, PRE_THRESHOLD, MIN_FORECAST_DEV);
        signalDir = sig.direction;
        signalStrength = sig.strength;
        maRatio = sig.maRatio;
        const estFc = estimateForecast(history);
        if (estFc !== null) {
          forecastVal = estFc;
          if (volatility !== null && volatility > 0) expectedReturn = calcExpectedReturn(estFc, volatility);
        }
      } else {
        // variantI: estimator (5), flat ticks skipped, no price-based stops.
        const volatility = estimateVolatility(history);
        const inv = invStates.get(sym)!;
        const est5 = updateInvAware(inv, price);
        if (est5 !== null) {
          forecastVal = est5;
          const deviation = Math.abs(est5 - 0.5);
          if (deviation >= MIN_FORECAST_DEV) {
            signalDir = est5 > 0.5 ? "long" : "short";
            signalStrength = Math.min(1, deviation / 0.25);
          }
          if (volatility !== null && volatility > 0) expectedReturn = calcExpectedReturn(est5, volatility);
        }
      }

      if (hadSharesAtStart) {
        positionCountThisTick++;
        let tr = tracking.get(sym);
        if (!tr) {
          tr = { entryPrice: longAvg, peakPrice: price, ticksHeld: 0, direction: "long" };
          tracking.set(sym, tr);
        }
        tr.ticksHeld++;
        tr.peakPrice = updatePeakPrice(price, tr);

        const usesStops = variant === "baseline" || variant === "oracle";
        const usesEstimateThresholdSellRule = variant === "variantI" || variant === "baselineNoStops";

        let sold = false;
        if (usesStops) {
          const stopCheck = shouldStopLoss(price, tr, STOP_PARAMS);
          if (stopCheck.shouldExit) {
            const fillBid = market.sellStock(sym, longShares);
            if (fillBid > 0) {
              spreadCost += longShares * (price - fillBid);
              commissionPaid += COMMISSION;
              roundTrips++;
              exitReasons[stopCheck.reason] = (exitReasons[stopCheck.reason] ?? 0) + 1;
              tracking.delete(sym);
              cooldowns.set(sym, t);
              sold = true;
            }
          }
        }

        if (!sold) {
          const shouldExitSignal = usesEstimateThresholdSellRule
            ? forecastVal !== undefined && forecastVal < 0.5
            : shouldSell("long", forecastForSell, maRatio, SELL_FORECAST_DEV, PRE_THRESHOLD);
          if (shouldExitSignal) {
            const fillBid = market.sellStock(sym, longShares);
            if (fillBid > 0) {
              spreadCost += longShares * (price - fillBid);
              commissionPaid += COMMISSION;
              roundTrips++;
              exitReasons["signal"] = (exitReasons["signal"] ?? 0) + 1;
              tracking.delete(sym);
              cooldowns.set(sym, t);
            }
          }
        }
      }

      if (!hadSharesAtStart && signalDir === "long" && signalStrength > 0) {
        candidates.push({ sym, strength: signalStrength, price, expectedReturn, forecast: forecastVal });
      }
    }

    // Pass 2: execute buys, weighted by strength, respecting cooldown & diversification cap.
    candidates.sort((a, b) => b.strength - a.strength);
    const totalStrength = candidates.reduce((s, c) => s + c.strength, 0);
    let newPositions = 0;
    for (const cand of candidates) {
      if (MAX_POSITIONS > 0 && positionCountThisTick + newPositions >= MAX_POSITIONS) break;

      const lastSold = cooldowns.get(cand.sym);
      if (lastSold !== undefined && t - lastSold < COOLDOWN_TICKS) continue;

      const maxShares = market.getMaxShares(cand.sym);
      const playerCash = market.getCash();
      const perStockBudget = calcWeightedBudget(tradingCapital, MAX_POSITIONS, cand.strength, totalStrength);
      const availCash = Math.min(perStockBudget, playerCash * CASH_CAP, tradingCapital);
      const sharesToBuy = calculatePositionSize(availCash, maxShares, cand.price);
      if (sharesToBuy <= 0) continue;

      if (!meetsCommissionThreshold(sharesToBuy, cand.price, cand.expectedReturn, COMMISSION)) continue;

      const fillAsk = market.buyStock(cand.sym, sharesToBuy);
      if (fillAsk > 0) {
        spreadCost += sharesToBuy * (fillAsk - cand.price);
        commissionPaid += COMMISSION;
        trades++;
        newPositions++;
        tracking.set(cand.sym, {
          entryPrice: fillAsk,
          peakPrice: fillAsk,
          ticksHeld: 0,
          direction: "long",
          forecastAtEntry: cand.forecast,
        });
      }
    }
  }

  const finalNetWorth = market.netWorth();
  const logReturn = finalNetWorth > 0 ? Math.log(finalNetWorth / STARTING_CASH) : -Infinity;
  let finalPositions = 0;
  for (const sym of symbols) {
    const [longShares] = market.getPosition(sym);
    if (longShares > 0) finalPositions++;
  }

  return {
    logReturn,
    logReturnPer100: logReturn / (TICKS / 100),
    trades,
    roundTrips,
    maxDrawdown,
    commissionPaid,
    spreadCost,
    finalNetWorth,
    finalPositions,
    exitReasons,
  };
}
