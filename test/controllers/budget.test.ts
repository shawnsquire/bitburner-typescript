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
