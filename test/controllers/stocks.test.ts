import { describe, it, expect } from "vitest";
import {
  createPriceHistory,
  addPrice,
  estimateForecast,
  getMovingAverage,
  estimateVolatility,
  detectTrend,
  calcExpectedReturn,
  forecastSignal,
  calcWeightedBudget,
  calculatePositionSize,
  meetsCommissionThreshold,
  shouldSell,
  shouldStopLoss,
  updatePeakPrice,
  getHackAdjustment,
  detectActiveProfile,
  getSymbolForServer,
  getServerForSymbol,
  PositionTracking,
  StopLossParams,
} from "/controllers/stocks";

// === PRICE HISTORY ===

describe("createPriceHistory / addPrice", () => {
  it("caps history at maxLength, dropping oldest first", () => {
    const h = createPriceHistory(3);
    addPrice(h, 1);
    addPrice(h, 2);
    addPrice(h, 3);
    addPrice(h, 4);
    expect(h.prices).toEqual([2, 3, 4]);
  });

  it("tracks tick directions (up/down) aligned with price additions", () => {
    const h = createPriceHistory(10);
    addPrice(h, 10);
    addPrice(h, 12); // up
    addPrice(h, 8); // down
    addPrice(h, 8); // flat -> not up
    expect(h.tickDirections).toEqual([true, false, false]);
  });
});

describe("estimateForecast", () => {
  it("returns null with fewer than minTicks directions", () => {
    const h = createPriceHistory(20);
    for (const p of [1, 2, 3]) addPrice(h, p);
    expect(estimateForecast(h)).toBeNull();
  });

  it("returns the fraction of up-ticks once enough data exists", () => {
    const h = createPriceHistory(20);
    // 11 prices -> 10 directions (minTicks default is 10)
    const prices = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 108];
    for (const p of prices) addPrice(h, p);
    // directions: 9 up, 1 down (last step) = 0.9
    expect(estimateForecast(h)).toBeCloseTo(0.9, 10);
  });
});

describe("getMovingAverage", () => {
  it("returns null with fewer than 2 prices", () => {
    const h = createPriceHistory(10);
    addPrice(h, 5);
    expect(getMovingAverage(h)).toBeNull();
  });

  it("averages all tracked prices", () => {
    const h = createPriceHistory(10);
    [1, 2, 3].forEach((p) => addPrice(h, p));
    expect(getMovingAverage(h)).toBe(2);
  });
});

describe("estimateVolatility", () => {
  it("returns null with fewer than 3 prices", () => {
    const h = createPriceHistory(10);
    addPrice(h, 1);
    addPrice(h, 2);
    expect(estimateVolatility(h)).toBeNull();
  });

  it("returns 0 for a perfectly flat price series", () => {
    const h = createPriceHistory(10);
    [100, 100, 100, 100].forEach((p) => addPrice(h, p));
    expect(estimateVolatility(h)).toBe(0);
  });

  it("returns a positive stddev of returns for a moving series", () => {
    const h = createPriceHistory(10);
    [100, 110, 90, 105].forEach((p) => addPrice(h, p));
    const vol = estimateVolatility(h);
    expect(vol).not.toBeNull();
    expect(vol!).toBeGreaterThan(0);
  });
});

// === TREND DETECTION (PRE-4S) ===

describe("detectTrend", () => {
  it("stays neutral before enough data for MA or tick-count", () => {
    const h = createPriceHistory(40);
    addPrice(h, 100);
    const sig = detectTrend(h, 0.03, 0.10);
    expect(sig.direction).toBe("neutral");
    expect(sig.strength).toBe(0);
  });

  it("falls back to MA crossover for early ticks (< minTicks for tick-count)", () => {
    const h = createPriceHistory(40);
    [100, 100, 108].forEach((p) => addPrice(h, p)); // MA=(100+100+108)/3=102.67, price/MA>1.03
    const sig = detectTrend(h, 0.03, 0.10);
    expect(sig.direction).toBe("long");
    expect(sig.strength).toBeGreaterThan(0);
  });

  it("prefers tick-count forecast once enough directions exist, ignoring MA", () => {
    const h = createPriceHistory(40);
    // 11 prices, mostly rising -> up-tick fraction well above 0.5+0.10
    const prices = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    prices.forEach((p) => addPrice(h, p));
    const sig = detectTrend(h, 0.03, 0.10);
    expect(sig.direction).toBe("long");
  });

  it("returns neutral when tick-count deviation is below the threshold", () => {
    const h = createPriceHistory(40);
    // Alternating prices -> ~50% up-ticks, deviation near 0
    const prices = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100];
    prices.forEach((p) => addPrice(h, p));
    const sig = detectTrend(h, 0.03, 0.10);
    expect(sig.direction).toBe("neutral");
  });
});

// === EXPECTED RETURN / FORECAST SIGNAL ===

describe("calcExpectedReturn", () => {
  it("is positive when forecast is bullish", () => {
    expect(calcExpectedReturn(0.6, 0.02)).toBeCloseTo(0.002, 10);
  });

  it("is negative when forecast is bearish", () => {
    expect(calcExpectedReturn(0.4, 0.02)).toBeCloseTo(-0.002, 10);
  });

  it("is zero at forecast 0.5 regardless of volatility", () => {
    expect(calcExpectedReturn(0.5, 0.5)).toBe(0);
  });
});

describe("forecastSignal", () => {
  it("returns neutral when forecast deviation is below the minimum", () => {
    const sig = forecastSignal(0.52, 0.02, 0.10);
    expect(sig.direction).toBe("neutral");
    expect(sig.strength).toBe(0);
  });

  it("returns long with strength = |expectedReturn| when bullish enough", () => {
    const sig = forecastSignal(0.65, 0.02, 0.10);
    expect(sig.direction).toBe("long");
    expect(sig.strength).toBeCloseTo(0.02 * 0.15, 10);
  });

  it("returns short when bearish enough", () => {
    const sig = forecastSignal(0.30, 0.02, 0.10);
    expect(sig.direction).toBe("short");
    expect(sig.expectedReturn).toBeLessThan(0);
  });
});

// === POSITION SIZING ===

describe("calcWeightedBudget", () => {
  it("weights allocation by relative signal strength", () => {
    // Two candidates, strengths 3 and 1 (total 4), capital 1000, maxPositions 4 (equalShare=250)
    const strong = calcWeightedBudget(1000, 4, 3, 4);
    const weak = calcWeightedBudget(1000, 4, 1, 4);
    expect(strong).toBeGreaterThan(weak);
  });

  it("caps allocation at 2x the equal share to prevent over-concentration", () => {
    // A single candidate holding 100% of total strength would get all capital uncapped;
    // the cap keeps it at 2x equalShare (2 * 1000/4 = 500)
    const budget = calcWeightedBudget(1000, 4, 10, 10);
    expect(budget).toBe(500);
  });

  it("falls back to full capital when maxPositions or totalStrength is invalid", () => {
    expect(calcWeightedBudget(1000, 0, 1, 1)).toBe(1000);
    expect(calcWeightedBudget(1000, 4, 1, 0)).toBe(1000);
  });
});

describe("calculatePositionSize", () => {
  it("floors shares to what the budget affords", () => {
    expect(calculatePositionSize(1000, 100, 33)).toBe(30); // floor(1000/33)=30
  });

  it("caps at maxShares even with excess cash", () => {
    expect(calculatePositionSize(1_000_000, 5, 1)).toBe(5);
  });

  it("returns 0 for non-positive price or cash", () => {
    expect(calculatePositionSize(1000, 100, 0)).toBe(0);
    expect(calculatePositionSize(0, 100, 10)).toBe(0);
    expect(calculatePositionSize(-5, 100, 10)).toBe(0);
  });
});

describe("meetsCommissionThreshold", () => {
  it("rejects a zero expected return regardless of size (pre-4S bootstrap safety)", () => {
    expect(meetsCommissionThreshold(1000, 50, 0, 100_000)).toBe(false);
  });

  it("accepts when expected profit clears commission with the safety multiple", () => {
    // shares*price*|return|*minHoldTicks > commission*2*1.5
    // 1000 shares * $50 * 0.01 * 10 = $5000; commission*2*1.5 = 100000*2*1.5=300000 -> should fail (too small)
    expect(meetsCommissionThreshold(1000, 50, 0.01, 100_000)).toBe(false);
    // Bigger position clears it: 100000 shares * $50 * 0.01 * 10 = $500,000 > $300,000
    expect(meetsCommissionThreshold(100_000, 50, 0.01, 100_000)).toBe(true);
  });

  it("rejects non-positive shares or price", () => {
    expect(meetsCommissionThreshold(0, 50, 0.5, 100_000)).toBe(false);
    expect(meetsCommissionThreshold(100, 0, 0.5, 100_000)).toBe(false);
  });
});

// === SELL THRESHOLDS ===

describe("shouldSell", () => {
  it("uses forecast hysteresis for long positions when forecast is available", () => {
    expect(shouldSell("long", 0.44, null, 0.05, 0.03)).toBe(true); // below 0.5 - 0.05
    expect(shouldSell("long", 0.46, null, 0.05, 0.03)).toBe(false); // above hold threshold
  });

  it("uses forecast hysteresis for short positions when forecast is available", () => {
    expect(shouldSell("short", 0.56, null, 0.05, 0.03)).toBe(true);
    expect(shouldSell("short", 0.54, null, 0.05, 0.03)).toBe(false);
  });

  it("falls back to MA ratio when forecast is null", () => {
    expect(shouldSell("long", null, 0.96, 0.05, 0.03)).toBe(true); // < 1 - 0.03
    expect(shouldSell("short", null, 1.04, 0.05, 0.03)).toBe(true); // > 1 + 0.03
    expect(shouldSell("long", null, 0.99, 0.05, 0.03)).toBe(false);
  });

  it("returns false when neither forecast nor MA ratio is available", () => {
    expect(shouldSell("long", null, null, 0.05, 0.03)).toBe(false);
  });
});

// === STOP-LOSS ===

function tracking(overrides: Partial<PositionTracking> = {}): PositionTracking {
  return { entryPrice: 100, peakPrice: 100, ticksHeld: 0, direction: "long", ...overrides };
}

const stopParams: StopLossParams = { hardStopPercent: 0.10, trailingStopPercent: 0.05, maxHoldTicks: 60 };

describe("shouldStopLoss", () => {
  it("exits on time limit before checking price", () => {
    const t = tracking({ ticksHeld: 60, entryPrice: 100, peakPrice: 100 });
    const result = shouldStopLoss(100, t, stopParams);
    expect(result).toEqual({ shouldExit: true, reason: "time-limit" });
  });

  it("exits a long position on hard stop", () => {
    const t = tracking({ entryPrice: 100, peakPrice: 100 });
    expect(shouldStopLoss(89, t, stopParams).reason).toBe("hard-stop");
    // 96 is above both the hard-stop (90) and trailing-stop (peak 100 * 0.95 = 95) floors
    expect(shouldStopLoss(96, t, stopParams).shouldExit).toBe(false);
  });

  it("exits a long position on trailing stop from peak", () => {
    const t = tracking({ entryPrice: 100, peakPrice: 120 });
    // 120 * (1 - 0.05) = 114; price at 113 should trigger, price at 100 also triggers hard-stop first check order doesn't matter here since both would exit
    expect(shouldStopLoss(113, t, stopParams).reason).toBe("trailing-stop");
  });

  it("exits a short position when price rises past entry or peak thresholds", () => {
    const t = tracking({ direction: "short", entryPrice: 100, peakPrice: 90 });
    expect(shouldStopLoss(111, t, stopParams).reason).toBe("hard-stop"); // 100*1.10=110
    const t2 = tracking({ direction: "short", entryPrice: 100, peakPrice: 80 });
    expect(shouldStopLoss(85, t2, stopParams).reason).toBe("trailing-stop"); // 80*1.05=84
  });

  it("does not exit when price is within all thresholds", () => {
    const t = tracking({ entryPrice: 100, peakPrice: 105 });
    expect(shouldStopLoss(102, t, stopParams)).toEqual({ shouldExit: false, reason: "" });
  });

  it("ignores a threshold that is set to 0 (disabled)", () => {
    const disabled: StopLossParams = { hardStopPercent: 0, trailingStopPercent: 0, maxHoldTicks: 0 };
    const t = tracking({ entryPrice: 100, peakPrice: 100, ticksHeld: 99999 });
    expect(shouldStopLoss(1, t, disabled)).toEqual({ shouldExit: false, reason: "" });
  });
});

describe("updatePeakPrice", () => {
  it("tracks the max price for long positions", () => {
    const t = tracking({ direction: "long", peakPrice: 100 });
    expect(updatePeakPrice(90, t)).toBe(100);
    expect(updatePeakPrice(110, t)).toBe(110);
  });

  it("tracks the min price for short positions", () => {
    const t = tracking({ direction: "short", peakPrice: 100 });
    expect(updatePeakPrice(110, t)).toBe(100);
    expect(updatePeakPrice(90, t)).toBe(90);
  });
});

// === HACK AWARENESS ===

describe("getHackAdjustment", () => {
  it("returns neutral for a symbol with no mapped server", () => {
    expect(getHackAdjustment("ZZZZ", "long", new Map())).toEqual({ confidenceMultiplier: 1, reason: "" });
  });

  it("returns neutral when the mapped server isn't being targeted", () => {
    expect(getHackAdjustment("ECP", "long", new Map())).toEqual({ confidenceMultiplier: 1, reason: "" });
  });

  it("reduces long confidence and boosts short confidence when a server is being batch-hacked", () => {
    const targets = new Map([["ecorp", "batch"]]);
    expect(getHackAdjustment("ECP", "long", targets)).toEqual({ confidenceMultiplier: 0.5, reason: "hacked" });
    expect(getHackAdjustment("ECP", "short", targets)).toEqual({ confidenceMultiplier: 1.3, reason: "hacked" });
  });

  it("boosts long confidence and reduces short confidence during prep/grow", () => {
    const targets = new Map([["ecorp", "prep"]]);
    expect(getHackAdjustment("ECP", "long", targets)).toEqual({ confidenceMultiplier: 1.2, reason: "growing" });
    expect(getHackAdjustment("ECP", "short", targets)).toEqual({ confidenceMultiplier: 0.7, reason: "growing" });
  });
});

// === SERVER <-> SYMBOL MAPPING ===

describe("getSymbolForServer / getServerForSymbol", () => {
  it("round-trips known mappings", () => {
    expect(getSymbolForServer("ecorp")).toBe("ECP");
    expect(getServerForSymbol("ECP")).toBe("ecorp");
  });

  it("returns null for unknown entries", () => {
    expect(getSymbolForServer("not-a-server")).toBeNull();
    expect(getServerForSymbol("ZZZZ")).toBeNull();
  });
});

// === TRADING PROFILES ===

describe("detectActiveProfile", () => {
  it("recognizes the built-in moderate profile", () => {
    expect(
      detectActiveProfile({
        minForecastDeviation: 0.10,
        sellForecastDeviation: 0.05,
        stopLossPercent: 0.15,
        trailingStopPercent: 0.08,
        maxHoldTicks: 60,
        maxPositions: 8,
      }),
    ).toBe("moderate");
  });

  it("returns custom for a non-matching combination", () => {
    expect(
      detectActiveProfile({
        minForecastDeviation: 0.11,
        sellForecastDeviation: 0.05,
        stopLossPercent: 0.15,
        trailingStopPercent: 0.08,
        maxHoldTicks: 60,
        maxPositions: 8,
      }),
    ).toBe("custom");
  });
});
