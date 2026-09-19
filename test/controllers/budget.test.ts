import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEIGHTS,
  HOLDER_BUCKETS,
  createDefaultPersistedState,
  isAugReset,
  computeEffectiveWeights,
  computeAllowances,
  handleCompletion,
  isBucketCapReached,
  WSE_TIX_API_COST,
  WSE_4S_TIX_API_COST,
  WSE_ACCESS_BUCKET,
  DEFAULT_WSE_CARVEOUT_MULT,
  nextWseApiCost,
  computeCarveout,
  applyStocks4SWeight,
  DEFAULT_STOCKS_WEIGHT_4S,
} from "/controllers/budget";

describe("createDefaultPersistedState", () => {
  it("initializes every default bucket as active with zero lifetime spend and no cap", () => {
    const state = createDefaultPersistedState();
    for (const bucket of Object.keys(DEFAULT_WEIGHTS)) {
      expect(state.lifetimeSpent[bucket]).toBe(0);
      expect(state.activeFlags[bucket]).toBe(true);
      expect(state.caps[bucket]).toBeNull();
      expect(state.weights[bucket]).toBe(DEFAULT_WEIGHTS[bucket]);
    }
    expect(state.rushBucket).toBeNull();
    expect(state.frozenWeights).toEqual({});
  });
});

describe("isAugReset", () => {
  it("detects a >90% cash drop", () => {
    expect(isAugReset(1_000_000, 50_000)).toBe(true); // dropped to 5%
  });

  it("does not trigger on a smaller drop", () => {
    expect(isAugReset(1_000_000, 200_000)).toBe(false); // dropped to 20%
  });

  it("never triggers from a non-positive previous balance", () => {
    expect(isAugReset(0, 0)).toBe(false);
    expect(isAugReset(-100, 0)).toBe(false);
  });

  it("does not trigger when cash increases", () => {
    expect(isAugReset(1000, 2000)).toBe(false);
  });
});

describe("computeEffectiveWeights", () => {
  const weights = { stocks: 30, hacknet: 5, servers: 25 };

  it("converts weight percentages to fractions for active buckets", () => {
    const flags = { stocks: true, hacknet: true, servers: true };
    const eff = computeEffectiveWeights(weights, flags, null);
    expect(eff).toEqual({ stocks: 0.30, hacknet: 0.05, servers: 0.25 });
  });

  it("zeros out inactive buckets", () => {
    const flags = { stocks: true, hacknet: false, servers: true };
    const eff = computeEffectiveWeights(weights, flags, null);
    expect(eff.hacknet).toBe(0);
  });

  it("gives the rushed bucket 100% and everything else 0", () => {
    const flags = { stocks: true, hacknet: true, servers: true };
    const eff = computeEffectiveWeights(weights, flags, "hacknet");
    expect(eff).toEqual({ stocks: 0, hacknet: 1, servers: 0 });
  });

  it("ignores rush if the rushed bucket is inactive", () => {
    const flags = { stocks: true, hacknet: false, servers: true };
    const eff = computeEffectiveWeights(weights, flags, "hacknet");
    // rushBucket set but inactive -> falls through to normal weighting
    expect(eff).toEqual({ stocks: 0.30, hacknet: 0, servers: 0.25 });
  });
});

describe("computeAllowances", () => {
  const weights = { stocks: 30, servers: 25, hacknet: 5 };
  const flags = { stocks: true, servers: true, hacknet: true };

  it("gives holders (stocks/corp) an allowance based on net worth minus current holding", () => {
    const result = computeAllowances(
      1_000_000, // cash
      { portfolioValue: 100_000, corpFunds: 0 },
      weights,
      flags,
      null,
    );
    // netWorth = 1,100,000; stocks target = 30% * 1,100,000 = 330,000; minus held 100,000 = 230,000
    expect(result.stocks.isHolder).toBe(true);
    expect(result.stocks.maxAllocation).toBeCloseTo(330_000, 5);
    expect(result.stocks.currentHolding).toBe(100_000);
    expect(result.stocks.allowance).toBeCloseTo(230_000, 5);
  });

  it("clamps a holder's allowance to 0 when already over-allocated", () => {
    const result = computeAllowances(
      1_000_000,
      { portfolioValue: 900_000, corpFunds: 0 }, // way more than 30% of net worth
      weights,
      flags,
      null,
    );
    expect(result.stocks.allowance).toBe(0);
  });

  it("gives spenders an allowance based on cash only, ignoring holdings", () => {
    const result = computeAllowances(
      1_000_000,
      { portfolioValue: 500_000, corpFunds: 0 },
      weights,
      flags,
      null,
    );
    // servers is a spender: 25% of cash (1,000,000), not net worth
    expect(result.servers.isHolder).toBe(false);
    expect(result.servers.allowance).toBeCloseTo(250_000, 5);
  });

  it("routes all allowance to the rushed bucket", () => {
    const result = computeAllowances(
      1_000_000,
      { portfolioValue: 0, corpFunds: 0 },
      weights,
      flags,
      "hacknet",
    );
    expect(result.hacknet.allowance).toBeCloseTo(1_000_000, 5); // 100% of cash
    expect(result.stocks.allowance).toBe(0);
    expect(result.servers.allowance).toBe(0);
  });

  it("zeroes a bucket that is marked inactive", () => {
    const result = computeAllowances(
      1_000_000,
      { portfolioValue: 0, corpFunds: 0 },
      weights,
      { ...flags, servers: false },
      null,
    );
    expect(result.servers.allowance).toBe(0);
  });
});

describe("HOLDER_BUCKETS", () => {
  it("contains exactly stocks and corp", () => {
    expect(HOLDER_BUCKETS.has("stocks")).toBe(true);
    expect(HOLDER_BUCKETS.has("corp")).toBe(true);
    expect(HOLDER_BUCKETS.has("hacknet")).toBe(false);
  });
});

describe("handleCompletion", () => {
  it("deactivates the bucket", () => {
    const flags = { stocks: true, hacknet: true };
    handleCompletion("hacknet", flags);
    expect(flags).toEqual({ stocks: true, hacknet: false });
  });
});

describe("isBucketCapReached", () => {
  it("is never reached when cap is null (uncapped)", () => {
    expect(isBucketCapReached(1_000_000, null)).toBe(false);
  });

  it("is reached once lifetime spend meets or exceeds the cap", () => {
    expect(isBucketCapReached(999, 1000)).toBe(false);
    expect(isBucketCapReached(1000, 1000)).toBe(true);
    expect(isBucketCapReached(1001, 1000)).toBe(true);
  });
});

describe("nextWseApiCost", () => {
  it("wants the 5b TIX API first", () => {
    expect(nextWseApiCost(false, false)).toBe(WSE_TIX_API_COST);
    expect(WSE_TIX_API_COST).toBe(5_000_000_000);
  });

  it("wants the 25b 4S TIX API once the TIX API is owned", () => {
    expect(nextWseApiCost(true, false)).toBe(WSE_4S_TIX_API_COST);
    expect(WSE_4S_TIX_API_COST).toBe(25_000_000_000);
  });

  it("wants nothing once both are owned", () => {
    expect(nextWseApiCost(true, true)).toBe(0);
  });
});

describe("computeCarveout", () => {
  const cost = WSE_TIX_API_COST;

  it("grants nothing below the threshold", () => {
    expect(computeCarveout(cost * DEFAULT_WSE_CARVEOUT_MULT - 1, cost)).toBe(0);
    expect(computeCarveout(cost, cost)).toBe(0);
    expect(computeCarveout(0, cost)).toBe(0);
  });

  it("grants the full price exactly at the threshold and above it", () => {
    expect(computeCarveout(cost * DEFAULT_WSE_CARVEOUT_MULT, cost)).toBe(cost);
    expect(computeCarveout(cost * 100, cost)).toBe(cost);
  });

  it("honours a custom multiplier", () => {
    expect(computeCarveout(cost * 3 - 1, cost, 3)).toBe(0);
    expect(computeCarveout(cost * 3, cost, 3)).toBe(cost);
    expect(computeCarveout(cost, cost, 1)).toBe(cost);
  });

  it("grants nothing when nothing is pending or the multiplier is invalid", () => {
    expect(computeCarveout(1e12, 0)).toBe(0);
    expect(computeCarveout(1e12, cost, 0)).toBe(0);
    expect(computeCarveout(1e12, cost, NaN)).toBe(0);
  });
});

describe("computeAllowances with the wse-access carve-out", () => {
  const weights = { ...DEFAULT_WEIGHTS };
  const activeFlags = Object.fromEntries(Object.keys(weights).map(b => [b, true]));
  const holdings = { portfolioValue: 0, corpFunds: 0 };
  const cost = WSE_TIX_API_COST;
  const cash = cost * DEFAULT_WSE_CARVEOUT_MULT; // 10b: at the default threshold

  function allowancesFor(c: number, flags = activeFlags, rush: string | null = null, w = weights) {
    const carveouts = { [WSE_ACCESS_BUCKET]: computeCarveout(c, cost) };
    return computeAllowances(c, holdings, w, flags, rush, carveouts);
  }

  it("below the threshold wse-access keeps its weighted 5% allowance", () => {
    const result = allowancesFor(cash - 1);
    expect(result[WSE_ACCESS_BUCKET].allowance).toBeCloseTo((cash - 1) * 0.05, 5);
    expect(result[WSE_ACCESS_BUCKET].allowance).toBeLessThan(cost);
  });

  it("at the threshold wse-access is granted the full price regardless of weight", () => {
    const result = allowancesFor(cash);
    expect(result[WSE_ACCESS_BUCKET].allowance).toBe(cost);
    expect(result[WSE_ACCESS_BUCKET].maxAllocation).toBe(cost);
  });

  it("never lowers an allowance that already exceeds the carve-out", () => {
    const result = allowancesFor(cost * 100); // 5% of 500b = 25b > 5b
    expect(result[WSE_ACCESS_BUCKET].allowance).toBeCloseTo(cost * 5, 5);
  });

  it("does not change any other bucket's allowance", () => {
    const withCarveout = allowancesFor(cash);
    const without = computeAllowances(cash, holdings, weights, activeFlags, null);
    for (const bucket of Object.keys(weights)) {
      if (bucket === WSE_ACCESS_BUCKET) continue;
      expect(withCarveout[bucket].allowance).toBe(without[bucket].allowance);
    }
  });

  it("post-done (after signalDone) the bucket gets nothing even with plenty of cash", () => {
    const flags = { ...activeFlags };
    handleCompletion(WSE_ACCESS_BUCKET, flags);
    const result = allowancesFor(cost * 100, flags);
    expect(result[WSE_ACCESS_BUCKET].allowance).toBe(0);
  });

  it("does not apply while another bucket is rushed", () => {
    const result = allowancesFor(cost * 100, activeFlags, "hacknet");
    expect(result[WSE_ACCESS_BUCKET].allowance).toBe(0);
    expect(result.hacknet.allowance).toBe(cost * 100);
  });

  it("does not apply to a bucket whose weight is 0 (frozen or released)", () => {
    const result = allowancesFor(cost * 100, activeFlags, null, { ...weights, [WSE_ACCESS_BUCKET]: 0 });
    expect(result[WSE_ACCESS_BUCKET].allowance).toBe(0);
  });

  it("omitting the carveouts argument leaves the original behaviour intact", () => {
    const result = computeAllowances(cash, holdings, weights, activeFlags, null);
    expect(result[WSE_ACCESS_BUCKET].allowance).toBeCloseTo(cash * 0.05, 5);
  });
});

describe("applyStocks4SWeight", () => {
  const base = { ...DEFAULT_WEIGHTS };

  it("lifts the stocks weight to the 4S weight once 4S data is owned", () => {
    const out = applyStocks4SWeight(base, true);
    expect(out.stocks).toBe(DEFAULT_STOCKS_WEIGHT_4S);
    expect(out.servers).toBe(base.servers);
    expect(base.stocks).toBe(30); // pure: input untouched
  });

  it("leaves the weight alone without 4S", () => {
    expect(applyStocks4SWeight(base, false).stocks).toBe(30);
  });

  it("never lowers a weight the user set higher", () => {
    expect(applyStocks4SWeight({ ...base, stocks: 95 }, true, 80).stocks).toBe(95);
  });

  it("leaves a frozen or zeroed bucket at zero, and does nothing when disabled", () => {
    expect(applyStocks4SWeight({ ...base, stocks: 0 }, true).stocks).toBe(0);
    expect(applyStocks4SWeight(base, true, 0).stocks).toBe(30);
  });
});
