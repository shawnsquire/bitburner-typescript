import { describe, it, expect } from "vitest";
import {
  calculateBatchPurchasePlan,
  getPservStatus,
  getBestAffordableRam,
  getBestAffordableUpgrade,
  findSmallestServer,
  getNextUpgradeInfo,
} from "/controllers/pserv";
import { mockNS } from "../helpers/mock-ns";

// Simple doubling cost curve for tests: cost(ram) = ram * 1000.
// Upgrade cost = cost(next) - cost(current), matching the real
// ns.cloud.getServerUpgradeCost formula (see ServerPurchases.ts).
function cloudNs(opts: {
  servers?: string[];
  serverRam?: Record<string, number>;
  serverCap?: number;
  maxPossibleRam?: number;
  money?: number;
}) {
  const servers = opts.servers ?? [];
  const ramOf = opts.serverRam ?? {};
  const costOf = (ram: number) => ram * 1000;
  return mockNS({
    extra: {
      getServerMaxRam: (host: string) => ramOf[host] ?? 0,
      getServerMoneyAvailable: () => opts.money ?? 0,
      format: {
        ram: (n: number) => `${n.toFixed(2)}GB`,
        number: (n: number) => `$${n.toFixed(0)}`,
      },
      cloud: {
        getServerNames: () => servers,
        getServerLimit: () => opts.serverCap ?? 25,
        getRamLimit: () => opts.maxPossibleRam ?? 1_048_576,
        getServerCost: (ram: number) => costOf(ram),
        getServerUpgradeCost: (host: string, ram: number) => {
          if (!servers.includes(host)) return -1; // real API: unknown host -> -1
          const current = ramOf[host] ?? 0;
          if (ram <= current) throw new Error("new ram must be bigger than current ram");
          return costOf(ram) - costOf(current);
        },
      },
    },
  });
}

describe("calculateBatchPurchasePlan", () => {
  it("returns null when there are no empty slots or no budget", () => {
    const ns = cloudNs({});
    expect(calculateBatchPurchasePlan(ns, 1000, 0, 8, 64)).toBeNull();
    expect(calculateBatchPurchasePlan(ns, 0, 5, 8, 64)).toBeNull();
  });

  it("picks the RAM tier that maximizes total RAM within budget and slots", () => {
    const ns = cloudNs({});
    // Budget 10000: 8GB costs 8000 (afford up to 1, since min(slots=5, floor(10000/8000))=1 -> 8GB total)
    // 16GB costs 16000 (unaffordable) -> loop breaks at 16GB, so only 8GB tier is viable.
    const plan = calculateBatchPurchasePlan(ns, 10000, 5, 8, 64);
    expect(plan).toEqual({ ramPerServer: 8, count: 1, totalRam: 8, totalCost: 8000 });
  });

  it("caps count at the number of empty slots", () => {
    const ns = cloudNs({});
    // Budget huge, 2 slots, 8GB costs 8000 -> could afford many, but capped to 2 slots.
    const plan = calculateBatchPurchasePlan(ns, 1_000_000, 2, 8, 8);
    expect(plan).toEqual({ ramPerServer: 8, count: 2, totalRam: 16, totalCost: 16000 });
  });

  it("prefers a higher RAM tier with fewer servers over more low-RAM servers, when it yields more total RAM", () => {
    const ns = cloudNs({});
    // Budget 16000, 5 slots: 8GB tier -> count=min(5, 2)=2 -> totalRam=16
    //                        16GB tier -> count=min(5, 1)=1 -> totalRam=16 (tie, first-found (8GB) wins since strictly-greater comparison)
    const plan = calculateBatchPurchasePlan(ns, 16000, 5, 8, 16);
    expect(plan?.totalRam).toBe(16);
  });
});

describe("getPservStatus", () => {
  it("reports zeroed-out status when there are no purchased servers", () => {
    const ns = cloudNs({ servers: [], serverCap: 25, maxPossibleRam: 1_048_576 });
    const status = getPservStatus(ns);
    expect(status).toEqual({
      servers: [],
      serverCount: 0,
      serverCap: 25,
      totalRam: 0,
      minRam: 0,
      maxRam: 0,
      maxPossibleRam: 1_048_576,
      allMaxed: false,
    });
  });

  it("aggregates ram stats and detects allMaxed when the smallest server is at the game cap", () => {
    const ns = cloudNs({
      servers: ["pserv-0", "pserv-1"],
      serverRam: { "pserv-0": 64, "pserv-1": 64 },
      serverCap: 2,
      maxPossibleRam: 64,
    });
    const status = getPservStatus(ns);
    expect(status.serverCount).toBe(2);
    expect(status.totalRam).toBe(128);
    expect(status.minRam).toBe(64);
    expect(status.maxRam).toBe(64);
    expect(status.allMaxed).toBe(true);
  });

  it("is not allMaxed while any server is below the cap", () => {
    const ns = cloudNs({
      servers: ["pserv-0", "pserv-1"],
      serverRam: { "pserv-0": 32, "pserv-1": 64 },
      maxPossibleRam: 64,
    });
    const status = getPservStatus(ns);
    expect(status.allMaxed).toBe(false);
  });
});

describe("getBestAffordableRam", () => {
  it("returns 0 when even the minimum tier is unaffordable", () => {
    const ns = cloudNs({});
    expect(getBestAffordableRam(ns, 5000, 8, 1024)).toBe(0); // 8GB costs 8000 > 5000
  });

  it("returns 0 when nothing is affordable", () => {
    const ns = cloudNs({});
    expect(getBestAffordableRam(ns, 100, 8, 64)).toBe(0);
  });

  it("returns the min tier when only it is affordable", () => {
    const ns = cloudNs({});
    expect(getBestAffordableRam(ns, 8000, 8, 64)).toBe(8);
  });

  it("returns the largest affordable tier below the cap", () => {
    const ns = cloudNs({});
    // 8GB=8000, 16GB=16000, 32GB=32000; budget 20000 affords up to 16GB.
    expect(getBestAffordableRam(ns, 20000, 8, 64)).toBe(16);
  });
});

describe("getBestAffordableUpgrade", () => {
  it("stays at current RAM when even the next tier is unaffordable", () => {
    const ns = cloudNs({ servers: ["pserv-0"], serverRam: { "pserv-0": 8 } });
    expect(getBestAffordableUpgrade(ns, "pserv-0", 100, 8, 64)).toBe(8);
  });

  it("upgrades as far as the budget allows, stopping at maxRam", () => {
    const ns = cloudNs({ servers: ["pserv-0"], serverRam: { "pserv-0": 8 } });
    // From 8 -> 16 costs cost(16)-cost(8)=8000; 16 -> 32 costs cost(32)-cost(16)=16000.
    // Budget 8000 affords only the first step.
    expect(getBestAffordableUpgrade(ns, "pserv-0", 8000, 8, 64)).toBe(16);
  });

  it("never exceeds maxRam even with unlimited budget", () => {
    const ns = cloudNs({ servers: ["pserv-0"], serverRam: { "pserv-0": 8 } });
    expect(getBestAffordableUpgrade(ns, "pserv-0", 1e18, 8, 32)).toBe(32);
  });
});

describe("findSmallestServer", () => {
  it("returns null when there are no purchased servers", () => {
    const ns = cloudNs({ servers: [] });
    expect(findSmallestServer(ns)).toBeNull();
  });

  it("finds the server with the least RAM", () => {
    const ns = cloudNs({
      servers: ["big", "small", "mid"],
      serverRam: { big: 64, small: 8, mid: 32 },
    });
    expect(findSmallestServer(ns)).toEqual({ hostname: "small", ram: 8 });
  });
});

describe("getNextUpgradeInfo", () => {
  it("returns null when there are no servers to upgrade", () => {
    const ns = cloudNs({ servers: [] });
    expect(getNextUpgradeInfo(ns, 0)).toBeNull();
  });

  it("returns null once the smallest server is already at the game max", () => {
    const ns = cloudNs({ servers: ["a"], serverRam: { a: 64 }, maxPossibleRam: 64 });
    expect(getNextUpgradeInfo(ns, 0)).toBeNull();
  });

  it("reports affordability of the next upgrade for the smallest server", () => {
    const ns = cloudNs({
      servers: ["a"],
      serverRam: { a: 8 },
      maxPossibleRam: 64,
      money: 1_000_000,
    });
    // upgrade 8 -> 16 costs cost(16)-cost(8) = 16000-8000 = 8000, affordable with 1,000,000 money.
    expect(getNextUpgradeInfo(ns, 0)).toBe("Can upgrade a to 16.00GB");
  });

  it("reports how much more money is needed when unaffordable", () => {
    const ns = cloudNs({
      servers: ["a"],
      serverRam: { a: 8 },
      maxPossibleRam: 64,
      money: 100,
    });
    expect(getNextUpgradeInfo(ns, 0)).toMatch(/^Need .* for a → 16.00GB$/);
  });
});
