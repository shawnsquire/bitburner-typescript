import { describe, it, expect } from "vitest";
import {
  MONEY_PER_HASH,
  CACHE_EXEMPT_UTILISATION,
  PaybackCandidate,
  paybackSeconds,
  estimateNodeMoneyRate,
  estimateServerHashRate,
  isExemptFromHorizon,
  partitionByPayback,
} from "/controllers/hacknet";

describe("MONEY_PER_HASH", () => {
  it("is the Sell for Money rate: 4 hashes per $1m", () => {
    expect(MONEY_PER_HASH).toBe(250_000);
  });
});

describe("paybackSeconds", () => {
  it("divides cost by the marginal rate", () => {
    expect(paybackSeconds(1000, 10)).toBe(100);
    expect(paybackSeconds(0, 10)).toBe(0);
  });

  it("is Infinity when the rate is not positive or the cost is invalid", () => {
    expect(paybackSeconds(1000, 0)).toBe(Infinity);
    expect(paybackSeconds(1000, -5)).toBe(Infinity);
    expect(paybackSeconds(1000, NaN)).toBe(Infinity);
    expect(paybackSeconds(-1, 10)).toBe(Infinity);
  });
});

describe("estimateNodeMoneyRate", () => {
  it("matches the game's node formula shape", () => {
    expect(estimateNodeMoneyRate(1, 1, 1, 1)).toBeCloseTo(1.5, 10);
    expect(estimateNodeMoneyRate(2, 1, 1, 1)).toBeCloseTo(3, 10);
    expect(estimateNodeMoneyRate(1, 2, 1, 1)).toBeCloseTo(1.5 * 1.035, 10);
    expect(estimateNodeMoneyRate(1, 1, 7, 1)).toBeCloseTo(3, 10);
    expect(estimateNodeMoneyRate(1, 1, 1, 2)).toBeCloseTo(3, 10);
  });
});

describe("estimateServerHashRate", () => {
  it("reproduces the daemon's old fallback estimate", () => {
    expect(estimateServerHashRate(1, 0, 1, 1, 1)).toBeCloseTo(0.001, 10);
    expect(estimateServerHashRate(10, 2, 8, 6, 2)).toBeCloseTo(10 * 0.001 * 6 * 2 * 2, 10);
    expect(estimateServerHashRate(5, 8, 8, 1, 1)).toBe(0);
  });
});

describe("partitionByPayback", () => {
  const c = (type: PaybackCandidate["type"], paybackSec: number, cost = 100): PaybackCandidate => ({ type, cost, paybackSec });

  it("skips candidates over the horizon and keeps the rest in order", () => {
    const list = [c("level", 10), c("ram", 5000), c("cores", 3600), c("new", 7200)];
    const r = partitionByPayback(list, 3600, 0.1, 3);
    expect(r.eligible.map(x => x.type)).toEqual(["level", "cores"]);
    expect(r.skipped).toBe(2);
    expect(r.bestSkippedSec).toBe(5000);
  });

  it("keeps everything when the horizon is Infinity, including Infinity-payback cache upgrades", () => {
    const list = [c("cache", Infinity), c("level", 1e9)];
    const r = partitionByPayback(list, Infinity, 0.1, 3);
    expect(r.eligible).toHaveLength(2);
    expect(r.skipped).toBe(0);
    expect(r.bestSkippedSec).toBeNull();
  });

  it("exempts cache upgrades only while hashes are about to overflow", () => {
    expect(partitionByPayback([c("cache", Infinity)], 3600, 0.95, 3).eligible).toHaveLength(1);
    expect(partitionByPayback([c("cache", Infinity)], 3600, 0.5, 3).eligible).toHaveLength(0);
    expect(isExemptFromHorizon(c("cache", Infinity), CACHE_EXEMPT_UTILISATION, 3)).toBe(false);
  });

  it("always allows the first node", () => {
    expect(partitionByPayback([c("new", 1e9)], 3600, 0, 0).eligible).toHaveLength(1);
    expect(partitionByPayback([c("new", 1e9)], 3600, 0, 1).eligible).toHaveLength(0);
  });

  it("reports null as the best skipped payback when only Infinity items were skipped", () => {
    const r = partitionByPayback([c("cache", Infinity)], 3600, 0.5, 3);
    expect(r.skipped).toBe(1);
    expect(r.bestSkippedSec).toBeNull();
  });
});
