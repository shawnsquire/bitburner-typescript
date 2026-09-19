import { describe, it, expect } from "vitest";
import {
  createPriceHistory,
  addPrice,
  estimateForecast,
  estimateVolatility,
  calcExpectedReturn,
  forecastSignal,
  spreadFromQuotes,
  clearsRoundTrip,
  planPurchases,
  shouldSell,
  longExitProfit,
  shortExitProfit,
  detectActiveProfile,
  profileConfigValues,
  TRADING_PROFILES,
  EWMA_HALF_LIFE,
  PurchaseCandidate,
} from "/controllers/stocks";

// === PRICE HISTORY ===

describe("createPriceHistory / addPrice", () => {
  it("caps history at maxLength, dropping oldest first", () => {
    const h = createPriceHistory(3);
    [1, 2, 3, 4].forEach((p) => addPrice(h, p));
    expect(h.prices).toEqual([2, 3, 4]);
  });

  it("drops a repeated price as a duplicate read instead of counting a direction", () => {
    const h = createPriceHistory(10);
    addPrice(h, 10);
    addPrice(h, 12);
    addPrice(h, 12);
    addPrice(h, 8);
    expect(h.prices).toEqual([10, 12, 8]);
    expect(h.samples).toBe(2);
  });
});

describe("estimateForecast", () => {
  it("returns null with fewer than minTicks directions", () => {
    const h = createPriceHistory(20);
    for (const p of [1, 2, 3]) addPrice(h, p);
    expect(estimateForecast(h)).toBeNull();
  });

  it("is 1 for a monotone rise and 0 for a monotone fall", () => {
    const up = createPriceHistory(40);
    const down = createPriceHistory(40);
    for (let i = 0; i < 30; i++) {
      addPrice(up, 100 + i);
      addPrice(down, 100 - i);
    }
    expect(estimateForecast(up)).toBeCloseTo(1, 10);
    expect(estimateForecast(down)).toBeCloseTo(0, 10);
  });

  it("weights recent ticks more: a flip is detected within about a half-life", () => {
    const h = createPriceHistory(80);
    for (let i = 0; i < 60; i++) addPrice(h, 100 + i); // long bull run
    for (let i = 0; i < EWMA_HALF_LIFE; i++) addPrice(h, 160 - i); // then falling
    // After one half-life of down-ticks the up-fraction is at or below 0.5.
    expect(estimateForecast(h)!).toBeLessThanOrEqual(0.5);
  });

  it("is near 0.5 for alternating ticks", () => {
    const h = createPriceHistory(40);
    for (let i = 0; i < 40; i++) addPrice(h, i % 2 === 0 ? 100 : 101);
    expect(estimateForecast(h)!).toBeGreaterThan(0.4);
    expect(estimateForecast(h)!).toBeLessThan(0.6);
  });
});

describe("estimateVolatility", () => {
  it("returns null with fewer than 3 prices", () => {
    const h = createPriceHistory(10);
    addPrice(h, 1);
    addPrice(h, 2);
    expect(estimateVolatility(h)).toBeNull();
  });

  it("recovers the game's volatility from the largest move in the window", () => {
    // Game move law: price *= (1 + v*vol) or /= (1 + v*vol), v ~ U(0,1).
    const vol = 0.02;
    const h = createPriceHistory(41);
    let price = 1000;
    addPrice(h, price);
    // Deterministic v ramp 0.025..1 over 40 moves, alternating direction
    for (let i = 1; i <= 40; i++) {
      const av = (i / 40) * vol;
      price = i % 2 === 0 ? price * (1 + av) : price / (1 + av);
      addPrice(h, price);
    }
    // Largest move is av = vol exactly; the (W+1)/W correction over-corrects a
    // deterministic ramp slightly, so allow 3%.
    expect(estimateVolatility(h)!).toBeCloseTo(vol * 41 / 40, 3);
  });
});

// === EXPECTED RETURN / SIGNALS ===

describe("calcExpectedReturn", () => {
  it("is volatility times the forecast deviation, signed", () => {
    expect(calcExpectedReturn(0.6, 0.02)).toBeCloseTo(0.002, 10);
    expect(calcExpectedReturn(0.4, 0.02)).toBeCloseTo(-0.002, 10);
    expect(calcExpectedReturn(0.5, 0.5)).toBe(0);
  });
});

describe("forecastSignal", () => {
  it("returns neutral when forecast deviation is below the minimum", () => {
    expect(forecastSignal(0.52, 0.02, 0.10).direction).toBe("neutral");
  });

  it("returns long / short with the signed expected return", () => {
    const long = forecastSignal(0.65, 0.02, 0.10);
    expect(long.direction).toBe("long");
    expect(long.expectedReturn).toBeCloseTo(0.003, 10);
    const short = forecastSignal(0.30, 0.02, 0.10);
    expect(short.direction).toBe("short");
    expect(short.expectedReturn).toBeLessThan(0);
  });
});

// === SPREAD AND ENTRY GATE ===

describe("spreadFromQuotes", () => {
  it("returns the per-side spread fraction of the mid price", () => {
    // spreadPerc 1%: ask = 101, bid = 99 around mid 100
    expect(spreadFromQuotes(101, 99)).toBeCloseTo(0.01, 10);
    expect(spreadFromQuotes(0, 0)).toBe(0);
  });
});

describe("clearsRoundTrip", () => {
  it("requires the expected return over the horizon to cover spread and commission", () => {
    // 0.1% per tick over 50 ticks = 5% vs hurdle 2*1% + 2*100k/10m = 2% + 2% = 4%
    expect(clearsRoundTrip(0.001, 0.01, 100_000, 10_000_000, 50)).toBe(true);
    // Same edge, 2% spread: hurdle 4% + 2% = 6% > 5%
    expect(clearsRoundTrip(0.001, 0.02, 100_000, 10_000_000, 50)).toBe(false);
    // Tiny notional: commission dominates
    expect(clearsRoundTrip(0.001, 0.001, 100_000, 1_000_000, 50)).toBe(false);
  });

  it("uses the magnitude for shorts", () => {
    expect(clearsRoundTrip(-0.001, 0.005, 100_000, 1e9, 50)).toBe(true);
  });

  it("rejects non-positive notional or horizon", () => {
    expect(clearsRoundTrip(0.01, 0, 0, 0, 50)).toBe(false);
    expect(clearsRoundTrip(0.01, 0, 0, 1e9, 0)).toBe(false);
  });
});

// === RANK AND FILL ===

const opts = { commission: 100_000, horizonTicks: 50, minOrderNotional: 10_000_000 };

function cand(overrides: Partial<PurchaseCandidate>): PurchaseCandidate {
  return { symbol: "X", direction: "long", expectedReturn: 0.002, fillPrice: 100, spread: 0.002, sharesRoom: 1e9, ...overrides };
}

describe("planPurchases", () => {
  it("fills the strongest candidate first and drains one shared pool", () => {
    const weak = cand({ symbol: "WEAK", expectedReturn: 0.001, sharesRoom: 1e6 });
    const strong = cand({ symbol: "STRONG", expectedReturn: 0.004, sharesRoom: 1e6 });
    const orders = planPurchases([weak, strong], 150_000_000 + 2 * 100_000, opts);
    expect(orders.map((o) => o.symbol)).toEqual(["STRONG", "WEAK"]);
    expect(orders[0].shares).toBe(1e6); // capped by room: 100m
    // 50m + 200k − 100k commission left over → 500k shares... minus the second commission
    expect(orders[1].shares).toBe(Math.floor((150_200_000 - 100_100_000 - 100_000) / 100));
    const spent = orders.reduce((s, o) => s + o.cost, 0);
    expect(spent).toBeLessThanOrEqual(150_200_000);
  });

  it("ranks shorts by magnitude alongside longs", () => {
    const long = cand({ symbol: "L", expectedReturn: 0.001 });
    const short = cand({ symbol: "S", direction: "short", expectedReturn: -0.003 });
    const orders = planPurchases([long, short], 1e9, opts);
    expect(orders[0].symbol).toBe("S");
    expect(orders[0].direction).toBe("short");
  });

  it("skips candidates with no room, no price, or that fail the round-trip gate", () => {
    const full = cand({ symbol: "FULL", sharesRoom: 0 });
    const wide = cand({ symbol: "WIDE", spread: 0.05 }); // 0.2%*50 = 10% < 2*5% + …
    const ok = cand({ symbol: "OK" });
    const orders = planPurchases([full, wide, ok], 1e9, opts);
    expect(orders.map((o) => o.symbol)).toEqual(["OK"]);
  });

  it("does not place dust orders below the minimum notional", () => {
    const c = cand({ symbol: "DUST" });
    expect(planPurchases([c], 5_000_000, opts)).toEqual([]);
  });

  it("never spends more than the pool including commissions", () => {
    const a = cand({ symbol: "A", expectedReturn: 0.003, sharesRoom: 1e5 });
    const b = cand({ symbol: "B", expectedReturn: 0.002, sharesRoom: 1e5 });
    const pool = 12_000_000;
    const orders = planPurchases([a, b], pool, opts);
    const spent = orders.reduce((s, o) => s + o.cost, 0);
    expect(spent).toBeLessThanOrEqual(pool);
    expect(orders.length).toBe(1); // A takes 10m + 100k; B would be dust
  });
});

// === EXITS ===

describe("shouldSell", () => {
  it("sells a long the moment the forecast drops below 0.5", () => {
    expect(shouldSell("long", 0.49)).toBe(true);
    expect(shouldSell("long", 0.5)).toBe(false);
    expect(shouldSell("long", 0.51)).toBe(false);
  });

  it("covers a short the moment the forecast rises above 0.5", () => {
    expect(shouldSell("short", 0.51)).toBe(true);
    expect(shouldSell("short", 0.5)).toBe(false);
  });

  it("holds when there is no forecast at all", () => {
    expect(shouldSell("long", null)).toBe(false);
  });
});

// === P&L ===

describe("exit profit", () => {
  it("books a long at the bid less the sell commission", () => {
    expect(longExitProfit(1000, 100, 110, 100_000)).toBe(1000 * 10 - 100_000);
  });

  it("books a short at the ask less the cover commission", () => {
    expect(shortExitProfit(1000, 100, 90, 100_000)).toBe(1000 * 10 - 100_000);
  });
});

// === PROFILES ===

describe("profiles", () => {
  it("recognises each preset from the config it writes", () => {
    for (const name of ["aggressive", "moderate", "conservative"] as const) {
      const cfg = profileConfigValues(name);
      expect(detectActiveProfile({ minForecastDeviation: Number(cfg.minForecastDeviation) })).toBe(name);
    }
  });

  it("returns custom for a non-matching threshold", () => {
    expect(detectActiveProfile({ minForecastDeviation: 0.07 })).toBe("custom");
  });

  it("orders presets from widest to narrowest entry", () => {
    expect(TRADING_PROFILES.aggressive.minForecastDeviation).toBeLessThan(TRADING_PROFILES.moderate.minForecastDeviation);
    expect(TRADING_PROFILES.moderate.minForecastDeviation).toBeLessThan(TRADING_PROFILES.conservative.minForecastDeviation);
  });
});
