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
  nextWseApiCost,
  nextWseApiLabel,
  DEFAULT_RESERVE_SHARE,
  PENDING_STALE_MS,
  PendingItem,
  prunePending,
  selectGoal,
  computeReserve,
  isGranted,
  sumProducerIncome,
  updateCashTrend,
  goalEtaSeconds,
  isGoalFeasible,
  CASH_TREND_TAU_SEC,
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

describe("nextWseApiLabel", () => {
  it("labels the TIX API first, then 4S, then nothing", () => {
    expect(nextWseApiLabel(false, false)).toBe("TIX API");
    expect(nextWseApiLabel(true, false)).toBe("4S Market Data TIX API");
    expect(nextWseApiLabel(true, true)).toBeNull();
  });
});

describe("prunePending", () => {
  const now = 1_000_000;
  const fresh: PendingItem = { cost: 100, label: "fresh", at: now - 1000 };
  const stale: PendingItem = { cost: 100, label: "stale", at: now - PENDING_STALE_MS - 1 };
  const zero: PendingItem = { cost: 0, label: "zero", at: now };

  it("keeps fresh entries and drops stale ones and zero costs", () => {
    const result = prunePending({ a: fresh, b: stale, c: zero }, now);
    expect(Object.keys(result)).toEqual(["a"]);
  });

  it("keeps an entry exactly at the stale boundary", () => {
    const edge: PendingItem = { cost: 1, label: "edge", at: now - PENDING_STALE_MS };
    expect(prunePending({ edge }, now)).toEqual({ edge });
  });

  it("returns a new object", () => {
    const input = { a: fresh };
    expect(prunePending(input, now)).not.toBe(input);
  });
});

describe("selectGoal", () => {
  const weights = { ...DEFAULT_WEIGHTS };
  const allActive = Object.fromEntries(Object.keys(weights).map(b => [b, true]));
  const ew = computeEffectiveWeights(weights, allActive, null);
  const item = (cost: number, label = "x"): PendingItem => ({ cost, label, at: 0 });

  it("picks the cheapest pending item", () => {
    const goal = selectGoal({ home: item(1e9, "RAM"), programs: item(250e6, "SQLInject.exe"), servers: item(4e9) }, ew);
    expect(goal).toEqual({ bucket: "programs", label: "SQLInject.exe", cost: 250e6, etaSec: 0 });
  });

  it("ignores buckets whose effective weight is zero (done, frozen, released)", () => {
    const flags = { ...allActive };
    handleCompletion("programs", flags);
    const goal = selectGoal({ home: item(1e9), programs: item(250e6) }, computeEffectiveWeights(weights, flags, null));
    expect(goal?.bucket).toBe("home");
    const zeroed = computeEffectiveWeights({ ...weights, programs: 0 }, allActive, null);
    expect(selectGoal({ programs: item(250e6) }, zeroed)).toBeNull();
  });

  it("ignores a bucket absent from the weights map", () => {
    expect(selectGoal({ typo: item(1) }, ew)).toBeNull();
  });

  it("only the rushed bucket can be the goal during a rush", () => {
    const rushed = computeEffectiveWeights(weights, allActive, "hacknet");
    expect(selectGoal({ programs: item(1), home: item(2) }, rushed)).toBeNull();
    expect(selectGoal({ programs: item(1), hacknet: item(2) }, rushed)?.bucket).toBe("hacknet");
  });

  it("returns null with nothing pending", () => {
    expect(selectGoal({}, ew)).toBeNull();
  });

  it("breaks ties by bucket name", () => {
    expect(selectGoal({ programs: item(5), home: item(5) }, ew)?.bucket).toBe("home");
  });

  describe("with feasibility", () => {
    // 87m cash, 10m/s income, share 50, horizon 2h: a 250m item is 413m away (41 s),
    // a 15.8t home upgrade is 31.6t away (36 days).
    const feas = { cash: 87e6, reserveShare: 50, incomePerSec: 10e6, goalHorizon: 7200 };

    it("skips an item whose ETA exceeds the horizon and takes the next cheapest", () => {
      const goal = selectGoal({ home: item(15.8e12, "Home RAM"), programs: item(250e6, "SQLInject.exe") }, ew, feas);
      expect(goal?.bucket).toBe("programs");
      expect(goal?.etaSec).toBeCloseTo((500e6 - 87e6) / 10e6, 6);
    });

    it("returns null when nothing is feasible", () => {
      expect(selectGoal({ home: item(15.8e12) }, ew, feas)).toBeNull();
    });

    it("always accepts an item already at its grant point, even with zero income", () => {
      const goal = selectGoal({ programs: item(40e6) }, ew, { ...feas, incomePerSec: 0 });
      expect(goal?.bucket).toBe("programs");
      expect(goal?.etaSec).toBe(0);
    });

    it("skips every unreached item when income is zero", () => {
      expect(selectGoal({ programs: item(250e6) }, ew, { ...feas, incomePerSec: 0 })).toBeNull();
    });

    it("disables the check when the horizon is 0", () => {
      expect(selectGoal({ home: item(15.8e12) }, ew, { ...feas, goalHorizon: 0 })?.bucket).toBe("home");
    });
  });
});

describe("sumProducerIncome", () => {
  it("sums finite rates and names the sources that counted", () => {
    const r = sumProducerIncome({ hack: 5, hacknet: 3, gang: null, stocks: undefined });
    expect(r.total).toBe(8);
    expect(r.sources).toEqual(["hack", "hacknet"]);
  });

  it("reports no sources when nothing is publishing", () => {
    expect(sumProducerIncome({ hack: null, hacknet: undefined, gang: NaN })).toEqual({ total: 0, sources: [] });
  });

  it("clamps a net negative total (stock losses) at 0", () => {
    expect(sumProducerIncome({ hack: 2, stocks: -5 }).total).toBe(0);
  });
});

describe("updateCashTrend", () => {
  it("seeds from the first sample", () => {
    expect(updateCashTrend(null, 20, 0, 2)).toBe(10);
  });

  it("adds spender purchases back and moves toward the sample with the tau", () => {
    const next = updateCashTrend(10, 0, 40, 2); // sample 20/s
    const alpha = 1 - Math.exp(-2 / CASH_TREND_TAU_SEC);
    expect(next).toBeCloseTo(10 + alpha * 10, 12);
  });

  it("is unchanged without elapsed time", () => {
    expect(updateCashTrend(10, 100, 0, 0)).toBe(10);
    expect(updateCashTrend(null, 100, 0, 0)).toBe(0);
  });
});

describe("goalEtaSeconds and isGoalFeasible", () => {
  it("is 0 once cash covers the grant point", () => {
    expect(goalEtaSeconds(500e6, 250e6, 50, 0)).toBe(0);
    expect(goalEtaSeconds(600e6, 250e6, 50, 1)).toBe(0);
  });

  it("divides the gap to the grant point by income", () => {
    expect(goalEtaSeconds(100e6, 250e6, 50, 10e6)).toBe(40);
  });

  it("is Infinity without income or with share 0", () => {
    expect(goalEtaSeconds(100e6, 250e6, 50, 0)).toBe(Infinity);
    expect(goalEtaSeconds(100e6, 250e6, 0, 10e6)).toBe(Infinity);
  });

  it("feasibility honours the horizon and 0 disables it", () => {
    expect(isGoalFeasible(7200, 7200)).toBe(true);
    expect(isGoalFeasible(7201, 7200)).toBe(false);
    expect(isGoalFeasible(Infinity, 7200)).toBe(false);
    expect(isGoalFeasible(Infinity, 0)).toBe(true);
  });
});

describe("computeReserve and isGranted", () => {
  const goal = { bucket: "programs", label: "SQLInject.exe", cost: 250e6, etaSec: 0 };

  it("reserves the share of cash below the price and caps at the price above it", () => {
    expect(computeReserve(226e6, goal, 50)).toBe(113e6);
    expect(computeReserve(1e9, goal, 50)).toBe(250e6);
  });

  it("reserves nothing without a goal, with a non-positive share, or without cash", () => {
    expect(computeReserve(1e9, null, 50)).toBe(0);
    expect(computeReserve(1e9, goal, 0)).toBe(0);
    expect(computeReserve(1e9, goal, -10)).toBe(0);
    expect(computeReserve(0, goal, 50)).toBe(0);
  });

  it("grants exactly at cost / share and not a dollar below", () => {
    const threshold = goal.cost / (DEFAULT_RESERVE_SHARE / 100); // 500m
    expect(isGranted(goal, computeReserve(threshold, goal, DEFAULT_RESERVE_SHARE))).toBe(true);
    expect(isGranted(goal, computeReserve(threshold - 1, goal, DEFAULT_RESERVE_SHARE))).toBe(false);
    expect(isGranted(null, 1e12)).toBe(false);
  });
});

describe("computeAllowances with a savings goal", () => {
  // The design's worked example: cash 226m, programs wants SQLInject at 250m,
  // hacknet 15%, home 10%, programs 5%, reserveShare 50.
  const weights = { ...DEFAULT_WEIGHTS, hacknet: 15, home: 10, programs: 5, stocks: 40 };
  const activeFlags = Object.fromEntries(Object.keys(weights).map(b => [b, true]));
  const holdings = { portfolioValue: 99e6, corpFunds: 0 };
  const goal = { bucket: "programs", label: "SQLInject.exe", cost: 250e6, etaSec: 0 };

  function plan(cash: number) {
    return { goal, reserve: computeReserve(cash, goal, 50) };
  }

  it("hides the reserve from every other spender", () => {
    const r = computeAllowances(226e6, holdings, weights, activeFlags, null, plan(226e6));
    expect(r.hacknet.allowance).toBeCloseTo(113e6 * 0.15, 3); // 17m, was 34m
    expect(r.home.allowance).toBeCloseTo(113e6 * 0.10, 3);
  });

  it("gives the goal bucket its weighted share of full cash until granted", () => {
    const r = computeAllowances(226e6, holdings, weights, activeFlags, null, plan(226e6));
    expect(r.programs.allowance).toBeCloseTo(226e6 * 0.05, 3);
  });

  it("grants the full price once the reserve covers it", () => {
    const r = computeAllowances(500e6, holdings, weights, activeFlags, null, plan(500e6));
    expect(r.programs.allowance).toBe(250e6);
    expect(r.programs.maxAllocation).toBe(250e6);
    expect(r.hacknet.allowance).toBeCloseTo(250e6 * 0.15, 3);
  });

  it("leaves holders on their net-worth cap", () => {
    const withGoal = computeAllowances(226e6, holdings, weights, activeFlags, null, plan(226e6));
    const without = computeAllowances(226e6, holdings, weights, activeFlags, null);
    expect(withGoal.stocks.allowance).toBe(without.stocks.allowance);
    expect(withGoal.stocks.maxAllocation).toBe(without.stocks.maxAllocation);
  });

  it("ignores the plan while a rush is active", () => {
    const r = computeAllowances(500e6, holdings, weights, activeFlags, "hacknet", plan(500e6));
    expect(r.hacknet.allowance).toBe(500e6);
    expect(r.programs.allowance).toBe(0);
  });

  it("with the default plan matches the no-goal result", () => {
    const a = computeAllowances(226e6, holdings, weights, activeFlags, null);
    const b = computeAllowances(226e6, holdings, weights, activeFlags, null, { goal: null, reserve: 0 });
    expect(a).toEqual(b);
  });
});

describe("wse-access via the savings goal at reserveShare 50", () => {
  const weights = { ...DEFAULT_WEIGHTS };
  const activeFlags = Object.fromEntries(Object.keys(weights).map(b => [b, true]));
  const holdings = { portfolioValue: 0, corpFunds: 0 };
  const cost = WSE_TIX_API_COST;
  const cash = cost * 2; // 10b: the grant point at the default share

  function allowancesFor(c: number, flags = activeFlags, rush: string | null = null, w = weights) {
    const pending = { [WSE_ACCESS_BUCKET]: { cost, label: "TIX API", at: 0 } };
    const goal = selectGoal(pending, computeEffectiveWeights(w, flags, rush));
    const reserve = computeReserve(c, goal, DEFAULT_RESERVE_SHARE);
    return computeAllowances(c, holdings, w, flags, rush, { goal, reserve });
  }

  it("below the grant point wse-access keeps its weighted 5% allowance", () => {
    const result = allowancesFor(cash - 1);
    expect(result[WSE_ACCESS_BUCKET].allowance).toBeCloseTo((cash - 1) * 0.05, 5);
    expect(result[WSE_ACCESS_BUCKET].allowance).toBeLessThan(cost);
  });

  it("at the grant point wse-access is granted the full price regardless of weight", () => {
    const result = allowancesFor(cash);
    expect(result[WSE_ACCESS_BUCKET].allowance).toBe(cost);
    expect(result[WSE_ACCESS_BUCKET].maxAllocation).toBe(cost);
  });

  it("never lowers an allowance that already exceeds the price", () => {
    const result = allowancesFor(cost * 100); // 5% of 500b = 25b > 5b
    expect(result[WSE_ACCESS_BUCKET].allowance).toBeCloseTo(cost * 5, 5);
  });

  it("other spenders see cash minus the reserve; holders are unchanged", () => {
    const withGoal = allowancesFor(cash);
    const without = computeAllowances(cash, holdings, weights, activeFlags, null);
    expect(withGoal.servers.allowance).toBeCloseTo((cash - cost) * 0.25, 5);
    expect(withGoal.servers.allowance).toBeCloseTo(without.servers.allowance / 2, 5);
    expect(withGoal.stocks.allowance).toBe(without.stocks.allowance);
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

  it("omitting the plan argument leaves the plain weighted behaviour intact", () => {
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
