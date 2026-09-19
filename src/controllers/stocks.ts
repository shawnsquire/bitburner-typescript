/**
 * Stocks Controller (Pure Logic)
 *
 * Trend detection, signal generation, position sizing, confidence calculation,
 * and server→symbol mapping. Zero NS imports — safe to import without RAM cost.
 *
 * Import with: import { ... } from "/controllers/stocks";
 */

// === TRADING PROFILES ===

export type TradingProfileName = "aggressive" | "moderate" | "conservative" | "custom";

export interface TradingProfile {
  minForecastDeviation: number;
  sellForecastDeviation: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  maxHoldTicks: number;
  maxPositions: number;
}

export const TRADING_PROFILES: Record<Exclude<TradingProfileName, "custom">, TradingProfile> = {
  aggressive: {
    minForecastDeviation: 0.055,
    sellForecastDeviation: 0.02,
    stopLossPercent: 0.10,
    trailingStopPercent: 0.06,
    maxHoldTicks: 45,
    maxPositions: 10,
  },
  moderate: {
    minForecastDeviation: 0.10,
    sellForecastDeviation: 0.05,
    stopLossPercent: 0.15,
    trailingStopPercent: 0.08,
    maxHoldTicks: 60,
    maxPositions: 8,
  },
  conservative: {
    minForecastDeviation: 0.15,
    sellForecastDeviation: 0.08,
    stopLossPercent: 0.20,
    trailingStopPercent: 0.10,
    maxHoldTicks: 75,
    maxPositions: 6,
  },
};

/**
 * Detect which profile matches the current config values, or "custom" if none match.
 */
export function detectActiveProfile(config: TradingProfile): TradingProfileName {
  for (const [name, profile] of Object.entries(TRADING_PROFILES) as [Exclude<TradingProfileName, "custom">, TradingProfile][]) {
    if (
      Math.abs(config.minForecastDeviation - profile.minForecastDeviation) < 0.001 &&
      Math.abs(config.sellForecastDeviation - profile.sellForecastDeviation) < 0.001 &&
      Math.abs(config.stopLossPercent - profile.stopLossPercent) < 0.001 &&
      Math.abs(config.trailingStopPercent - profile.trailingStopPercent) < 0.001 &&
      config.maxHoldTicks === profile.maxHoldTicks &&
      config.maxPositions === profile.maxPositions
    ) {
      return name;
    }
  }
  return "custom";
}

// === SERVER → SYMBOL MAPPING ===

/**
 * Bitburner's fixed mapping of server hostnames to stock symbols.
 * Used for hack daemon awareness (smart mode).
 */
const SERVER_TO_SYMBOL: Record<string, string> = {
  "ecorp": "ECP",
  "megacorp": "MGCP",
  "blade": "BLD",
  "clarkinc": "CLRK",
  "omnitek": "OMTK",
  "4sigma": "FSIG",
  "kuai-gong": "KGI",
  "fulcrumtech": "FLCM",
  "stormtech": "STM",
  "defcomm": "DCOMM",
  "helios": "HLS",
  "vitalife": "VITA",
  "icarus": "ICRS",
  "univ-energy": "UNV",
  "aerocorp": "AERO",
  "omnia": "OMN",
  "solaris": "SLRS",
  "global-pharm": "GPH",
  "nova-med": "NVMD",
  "lexo-corp": "LXO",
  "rho-construction": "RHOC",
  "alpha-ent": "APHE",
  "syscore": "SYSC",
  "computek": "CTK",
  "netlink": "NTLK",
  "omega-net": "OMGA",
  "foodnstuff": "FNS",
  "joesguns": "JGN",
  "sigma-cosmetics": "SGC",
  "catalyst": "CTYS",
  "microdyne": "MDYN",
  "titan-labs": "TITN",
};

const SYMBOL_TO_SERVER: Record<string, string> = {};
for (const [server, symbol] of Object.entries(SERVER_TO_SYMBOL)) {
  SYMBOL_TO_SERVER[symbol] = server;
}

export function getSymbolForServer(hostname: string): string | null {
  return SERVER_TO_SYMBOL[hostname] ?? null;
}

export function getServerForSymbol(symbol: string): string | null {
  return SYMBOL_TO_SERVER[symbol] ?? null;
}

// === MOVING AVERAGE ===

export interface PriceHistory {
  prices: number[];
  maxLength: number;
  tickDirections: boolean[]; // true = price went up from previous tick
}

export function createPriceHistory(maxLength: number): PriceHistory {
  return { prices: [], maxLength, tickDirections: [] };
}

export function addPrice(history: PriceHistory, price: number): void {
  // Track tick direction before adding price
  if (history.prices.length > 0) {
    const prevPrice = history.prices[history.prices.length - 1];
    history.tickDirections.push(price > prevPrice);
    if (history.tickDirections.length > history.maxLength) {
      history.tickDirections.shift();
    }
  }

  history.prices.push(price);
  if (history.prices.length > history.maxLength) {
    history.prices.shift();
  }
}

/**
 * Estimate forecast from tick direction counts.
 * Returns the fraction of up-ticks, which directly estimates P(up) = (50 + otlkMag)/100.
 * Requires at least 10 ticks for a reasonable estimate.
 */
export function estimateForecast(history: PriceHistory, minTicks = 10): number | null {
  if (history.tickDirections.length < minTicks) return null;
  const upTicks = history.tickDirections.filter(d => d).length;
  return upTicks / history.tickDirections.length;
}

export function getMovingAverage(history: PriceHistory): number | null {
  if (history.prices.length < 2) return null;
  const sum = history.prices.reduce((a, b) => a + b, 0);
  return sum / history.prices.length;
}

/**
 * Estimate volatility from price history as standard deviation of tick-to-tick returns.
 * Returns null if not enough data points (need at least 3 prices for 2 returns).
 */
export function estimateVolatility(history: PriceHistory): number | null {
  if (history.prices.length < 3) return null;

  const returns: number[] = [];
  for (let i = 1; i < history.prices.length; i++) {
    if (history.prices[i - 1] > 0) {
      returns.push((history.prices[i] - history.prices[i - 1]) / history.prices[i - 1]);
    }
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

// === TREND DETECTION (PRE-4S) ===

export interface TrendSignal {
  direction: "long" | "short" | "neutral";
  strength: number;  // 0-1, higher = stronger signal
  maRatio: number;   // price / MA ratio
}

/**
 * Generate a trend signal from price history.
 *
 * Prefers tick-count forecast estimation (direct estimate of P(up)) when enough
 * data is available. Falls back to moving average crossover for early ticks.
 */
export function detectTrend(
  history: PriceHistory,
  threshold: number,
  minForecastDeviation = 0.10,
): TrendSignal {
  const ma = getMovingAverage(history);
  const currentPrice = history.prices.length > 0 ? history.prices[history.prices.length - 1] : 0;
  const maRatio = ma !== null && ma > 0 ? currentPrice / ma : 1;

  // Prefer tick-count forecast when available (more direct than MA)
  const estForecast = estimateForecast(history);
  if (estForecast !== null) {
    const deviation = Math.abs(estForecast - 0.5);
    if (deviation >= minForecastDeviation) {
      return {
        direction: estForecast > 0.5 ? "long" : "short",
        strength: Math.min(1, deviation / 0.25), // Normalize: 0.25 deviation = max strength
        maRatio,
      };
    }
    return { direction: "neutral", strength: 0, maRatio };
  }

  // Fallback: MA crossover for early ticks before tick-count has enough data
  if (ma === null || history.prices.length < 3) {
    return { direction: "neutral", strength: 0, maRatio: 1 };
  }

  const maDeviation = maRatio - 1;
  if (maDeviation > threshold) {
    return {
      direction: "long",
      strength: Math.min(1, maDeviation / (threshold * 5)),
      maRatio,
    };
  } else if (maDeviation < -threshold) {
    return {
      direction: "short",
      strength: Math.min(1, Math.abs(maDeviation) / (threshold * 5)),
      maRatio,
    };
  }

  return { direction: "neutral", strength: 0, maRatio };
}

// === EXPECTED RETURN ===

/**
 * Calculate expected return per tick for a stock.
 * Positive = long signal, negative = short signal, magnitude = return per share per tick.
 *
 * This is the core metric used by every successful Bitburner stock script:
 *   expectedReturn = volatility × (forecast - 0.5)
 */
export function calcExpectedReturn(
  forecast: number,
  volatility: number,
): number {
  return volatility * (forecast - 0.5);
}

// === 4S / SCRAPED FORECAST SIGNALS ===

export interface ForecastSignal {
  direction: "long" | "short" | "neutral";
  strength: number;      // absReturn (expected return magnitude)
  forecast: number;
  expectedReturn: number; // signed expected return per tick
}

/**
 * Generate a signal from forecast data using expected return.
 * Buy filter: forecast must deviate from 0.5 by at least minForecastDeviation.
 * Expected return is still used for ranking candidates by strength.
 */
export function forecastSignal(
  forecast: number,
  volatility: number,
  minForecastDeviation: number,
): ForecastSignal {
  const expectedReturn = calcExpectedReturn(forecast, volatility);
  const absReturn = Math.abs(expectedReturn);
  const forecastDeviation = Math.abs(forecast - 0.5);

  if (forecastDeviation >= minForecastDeviation) {
    return {
      direction: expectedReturn > 0 ? "long" : "short",
      strength: absReturn,
      forecast,
      expectedReturn,
    };
  }

  return { direction: "neutral", strength: 0, forecast, expectedReturn };
}

// === POSITION SIZING ===

/**
 * Calculate per-stock budget weighted by signal strength.
 * Stronger signals get more capital, capped at 2x the equal share.
 */
export function calcWeightedBudget(
  tradingCapital: number,
  maxPositions: number,
  candidateStrength: number,
  totalStrength: number,
): number {
  if (maxPositions <= 0 || totalStrength <= 0) return tradingCapital;
  const equalShare = tradingCapital / maxPositions;
  const weightedShare = (candidateStrength / totalStrength) * tradingCapital;
  // Cap at 2x the equal share to prevent over-concentration
  return Math.min(weightedShare, equalShare * 2);
}

/**
 * Calculate position size: full allocation up to diversification cap.
 * Signal-strength scaling removed — qualifying signals get full allocation,
 * and diversification handles risk management.
 */
export function calculatePositionSize(
  availableCash: number,
  maxShares: number,
  pricePerShare: number,
): number {
  if (pricePerShare <= 0 || availableCash <= 0) return 0;

  const sharesByBudget = Math.floor(availableCash / pricePerShare);
  return Math.min(sharesByBudget, maxShares);
}

// === COMMISSION CHECK ===

/**
 * Check if a position can generate enough profit to overcome round-trip commission.
 * Expected profit over minHoldTicks must exceed commission × safetyMultiple.
 */
export function meetsCommissionThreshold(
  shares: number,
  pricePerShare: number,
  expectedReturnPerTick: number,
  commissionPerTrade: number,
  minHoldTicks = 10,
  safetyMultiple = 1.5,
): boolean {
  if (shares <= 0 || pricePerShare <= 0) return false;
  const expectedProfit = shares * pricePerShare * Math.abs(expectedReturnPerTick) * minHoldTicks;
  const totalCommission = commissionPerTrade * 2; // buy + sell
  return expectedProfit > totalCommission * safetyMultiple;
}

// === SELL THRESHOLDS ===

/**
 * Check if a position should be sold based on forecast or MA reversal.
 *
 * For 4S/scraped mode: sell when forecast crosses back past 0.5 by sellForecastDeviation.
 * This creates hysteresis — buy zone is wider than sell zone, preventing twitchy exits.
 *   Buy long:  forecast > 0.5 + minForecastDeviation (e.g., > 0.60)
 *   Hold long:  forecast > 0.5 - sellForecastDeviation (e.g., > 0.45)
 *   Sell long:  forecast < 0.5 - sellForecastDeviation (e.g., < 0.45)
 */
export function shouldSell(
  position: "long" | "short",
  currentForecast: number | null,
  currentMaRatio: number | null,
  sellForecastDeviation: number,
  preThreshold: number,
): boolean {
  // 4S/scraped mode: use forecast with hysteresis
  if (currentForecast !== null) {
    if (position === "long" && currentForecast < (0.5 - sellForecastDeviation)) return true;
    if (position === "short" && currentForecast > (0.5 + sellForecastDeviation)) return true;
    return false;
  }

  // Pre-4S mode: use MA ratio
  if (currentMaRatio !== null) {
    if (position === "long" && currentMaRatio < (1 - preThreshold)) return true;
    if (position === "short" && currentMaRatio > (1 + preThreshold)) return true;
    return false;
  }

  return false;
}

// === STOP-LOSS / TRAILING STOP ===

export interface StopLossParams {
  hardStopPercent: number;    // e.g. 0.05 = 5% hard stop from entry
  trailingStopPercent: number; // e.g. 0.08 = 8% trailing stop from peak
  maxHoldTicks: number;        // e.g. 60 = sell after 60 ticks
}

export interface PositionTracking {
  entryPrice: number;
  peakPrice: number;
  ticksHeld: number;
  direction: "long" | "short";
  forecastAtEntry?: number;
}

export interface StopLossResult {
  shouldExit: boolean;
  reason: string;
}

/**
 * Check if a position should be exited due to stop-loss conditions.
 */
export function shouldStopLoss(
  currentPrice: number,
  tracking: PositionTracking,
  params: StopLossParams,
): StopLossResult {
  // Time limit check first
  if (params.maxHoldTicks > 0 && tracking.ticksHeld >= params.maxHoldTicks) {
    return { shouldExit: true, reason: "time-limit" };
  }

  if (tracking.direction === "long") {
    // Hard stop: price dropped hardStopPercent from entry
    if (params.hardStopPercent > 0) {
      const stopPrice = tracking.entryPrice * (1 - params.hardStopPercent);
      if (currentPrice <= stopPrice) {
        return { shouldExit: true, reason: "hard-stop" };
      }
    }
    // Trailing stop: price dropped trailingStopPercent from peak
    if (params.trailingStopPercent > 0) {
      const trailPrice = tracking.peakPrice * (1 - params.trailingStopPercent);
      if (currentPrice <= trailPrice) {
        return { shouldExit: true, reason: "trailing-stop" };
      }
    }
  } else {
    // Short positions: inverse logic (price rising is bad)
    if (params.hardStopPercent > 0) {
      const stopPrice = tracking.entryPrice * (1 + params.hardStopPercent);
      if (currentPrice >= stopPrice) {
        return { shouldExit: true, reason: "hard-stop" };
      }
    }
    if (params.trailingStopPercent > 0) {
      const trailPrice = tracking.peakPrice * (1 + params.trailingStopPercent);
      if (currentPrice >= trailPrice) {
        return { shouldExit: true, reason: "trailing-stop" };
      }
    }
  }

  return { shouldExit: false, reason: "" };
}

/**
 * Update the peak price for a tracked position.
 * For longs: peak = max seen price. For shorts: peak = min seen price.
 */
export function updatePeakPrice(
  currentPrice: number,
  tracking: PositionTracking,
): number {
  if (tracking.direction === "long") {
    return Math.max(tracking.peakPrice, currentPrice);
  } else {
    return Math.min(tracking.peakPrice, currentPrice);
  }
}

// === HACK AWARENESS (SMART MODE) ===

export interface HackAdjustment {
  confidenceMultiplier: number;
  reason: string;
}

/**
 * Adjust trading confidence based on hack daemon activity.
 *
 * @param symbol - Stock symbol being evaluated
 * @param direction - Position direction (long or short)
 * @param hackTargets - Map of server hostname → phase (prep/batch/etc.)
 */
export function getHackAdjustment(
  symbol: string,
  direction: "long" | "short",
  hackTargets: Map<string, string>,
): HackAdjustment {
  const server = getServerForSymbol(symbol);
  if (!server) return { confidenceMultiplier: 1, reason: "" };

  const phase = hackTargets.get(server);
  if (!phase) return { confidenceMultiplier: 1, reason: "" };

  if (phase === "batch") {
    // Server is being actively hacked → reduces money → stock goes down
    if (direction === "long") {
      return { confidenceMultiplier: 0.5, reason: "hacked" };
    } else {
      return { confidenceMultiplier: 1.3, reason: "hacked" };
    }
  }

  if (phase === "prep") {
    // Server is being grown → money increases → stock goes up
    if (direction === "long") {
      return { confidenceMultiplier: 1.2, reason: "growing" };
    } else {
      return { confidenceMultiplier: 0.7, reason: "growing" };
    }
  }

  return { confidenceMultiplier: 1, reason: "" };
}
