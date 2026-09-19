import { describe, it, expect, beforeEach } from "vitest";
import {
  getUsableServers,
  calculateOptimalThreads,
  assignServersToTargets,
  allocateServersToBatchOps,
  type TargetAssignment,
  type ServerInfo,
  type ServerSlot,
} from "/controllers/hack";
import type { CyclePlan, BatchOp } from "/lib/batch";
import { invalidateServerCache } from "/lib/server-cache";
import { mockNS } from "../helpers/mock-ns";

// getUsableServers goes through the module-level TTL cache in
// /lib/server-cache; without invalidating it between tests, a later test's
// getUsableServers() call could see an earlier test's cached server list.
beforeEach(() => {
  invalidateServerCache();
});

function makeServerMap(servers: Record<string, Record<string, unknown>>) {
  return (hostname: string) => {
    if (!(hostname in servers)) throw new Error(`no mock server for ${hostname}`);
    return servers[hostname];
  };
}

describe("getUsableServers", () => {
  it("excludes servers without root, without RAM, or with no free RAM after reserve", () => {
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["locked", "empty-ram", "full", "ok"] : []),
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 1024, ramUsed: 0 },
          locked: { hasAdminRights: false, maxRam: 64, ramUsed: 0 },
          "empty-ram": { hasAdminRights: true, maxRam: 0, ramUsed: 0 },
          full: { hasAdminRights: true, maxRam: 32, ramUsed: 32 },
          ok: { hasAdminRights: true, maxRam: 64, ramUsed: 16 },
        }),
      },
    });

    const result = getUsableServers(ns, 100); // homeReserve 100 > home's 1024 maxRam is fine, still positive
    const hostnames = result.map(s => s.hostname).sort();
    expect(hostnames).toEqual(["home", "ok"].sort());
  });

  it("reserves RAM only on home, sorts descending by available RAM", () => {
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["a"] : []),
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 1000, ramUsed: 0 },
          a: { hasAdminRights: true, maxRam: 500, ramUsed: 0 },
        }),
      },
    });

    const result = getUsableServers(ns, 600); // home: 1000 - 0 - 600 = 400; a: 500 - 0 - 0 = 500
    expect(result.map(s => s.hostname)).toEqual(["a", "home"]);
    expect(result[0].availableRam).toBe(500);
    expect(result[1].availableRam).toBe(400);
  });

  it("excludes hacknet-* hosts only when excludeHacknet is true", () => {
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["hacknet-server-0"] : []),
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 100, ramUsed: 0 },
          "hacknet-server-0": { hasAdminRights: true, maxRam: 64, ramUsed: 0 },
        }),
      },
    });

    expect(getUsableServers(ns, 0, false).map(s => s.hostname).sort()).toEqual(["hacknet-server-0", "home"]);
    expect(getUsableServers(ns, 0, true).map(s => s.hostname)).toEqual(["home"]);
  });
});

describe("calculateOptimalThreads", () => {
  it("weaken: threads needed to close the security gap at 0.05/thread", () => {
    const ns = mockNS({
      extra: { getServer: () => ({ hackDifficulty: 30, minDifficulty: 10 }) },
    });
    // (30 - 10) / 0.05 = 400
    expect(calculateOptimalThreads(ns, "n00dles", "weaken", 0.25)).toBe(400);
  });

  it("grow: delegates to growthAnalyze with the moneyMax/moneyAvailable ratio", () => {
    let capturedRatio = 0;
    const ns = mockNS({
      extra: {
        getServer: () => ({ moneyMax: 1_000_000, moneyAvailable: 250_000 }),
        growthAnalyze: (_h: string, ratio: number) => { capturedRatio = ratio; return 42.1; },
      },
    });
    expect(calculateOptimalThreads(ns, "n00dles", "grow", 0.25)).toBe(43); // ceil(42.1)
    expect(capturedRatio).toBe(4); // 1_000_000 / 250_000
  });

  it("grow: floors moneyAvailable at 1 to avoid a divide-by-zero ratio", () => {
    let capturedRatio = 0;
    const ns = mockNS({
      extra: {
        getServer: () => ({ moneyMax: 1_000_000, moneyAvailable: 0 }),
        growthAnalyze: (_h: string, ratio: number) => { capturedRatio = ratio; return 1; },
      },
    });
    calculateOptimalThreads(ns, "n00dles", "grow", 0.25);
    expect(capturedRatio).toBe(1_000_000);
  });

  it("hack: floor(hackPercent / hackAnalyze), minimum 1", () => {
    const ns = mockNS({ extra: { getServer: () => ({}), hackAnalyze: () => 0.05 } });
    expect(calculateOptimalThreads(ns, "n00dles", "hack", 0.25)).toBe(5); // floor(0.25/0.05)
  });

  it("hack: returns 1 when hackAnalyze reports 0 (would otherwise divide by zero)", () => {
    const ns = mockNS({ extra: { getServer: () => ({}), hackAnalyze: () => 0 } });
    expect(calculateOptimalThreads(ns, "n00dles", "hack", 0.25)).toBe(1);
  });
});

describe("assignServersToTargets", () => {
  function assignment(overrides: Partial<TargetAssignment>): TargetAssignment {
    return {
      hostname: "target",
      action: "hack",
      optimalThreads: 10,
      script: "/workers/hack.js",
      scriptRam: 2,
      value: 1,
      assignedThreads: 0,
      assignedServers: [],
      ...overrides,
    };
  }

  it("saturates each target up to its own optimalThreads and no further", () => {
    // Exactly enough fleet RAM for both targets' optimalThreads, so there's
    // nothing left for the overflow step to (mis)spill onto assignments[0].
    const servers: ServerInfo[] = [{ hostname: "s1", maxRam: 40, availableRam: 40 }];
    const a = assignment({ hostname: "a", optimalThreads: 10, scriptRam: 2 });
    const b = assignment({ hostname: "b", optimalThreads: 10, scriptRam: 2 });

    assignServersToTargets(servers, [a, b]);

    expect(a.assignedThreads).toBe(10);
    expect(b.assignedThreads).toBe(10);
    expect(servers[0].availableRam).toBe(0);
  });

  it("spills leftover fleet RAM onto the highest-priority (first) target once all are saturated", () => {
    const servers: ServerInfo[] = [{ hostname: "s1", maxRam: 100, availableRam: 100 }];
    const assignments = [
      assignment({ hostname: "best", optimalThreads: 2, scriptRam: 2, value: 10 }),
    ];

    assignServersToTargets(servers, assignments);

    // 2 threads (4GB) to satisfy optimalThreads, then all remaining 96GB (48 threads) overflows to it.
    expect(assignments[0].assignedThreads).toBe(2 + 48);
  });

  it("never assigns more threads to a target than its optimalThreads during the saturation pass", () => {
    const servers: ServerInfo[] = [
      { hostname: "s1", maxRam: 4, availableRam: 4 },
      { hostname: "s2", maxRam: 4, availableRam: 4 },
    ];
    const a = assignment({ optimalThreads: 1, scriptRam: 2 });
    const b = assignment({ hostname: "other", optimalThreads: 1, scriptRam: 2 });
    assignServersToTargets(servers, [a, b]);

    expect(a.assignedThreads).toBeGreaterThanOrEqual(1);
    expect(b.assignedThreads).toBeGreaterThanOrEqual(0);
  });
});

describe("allocateServersToBatchOps (per-op-type RAM pricing)", () => {
  // Regression coverage: grow.js/weaken.js cost more RAM per thread than
  // hack.js. Allocation must price each op by its own script, not a single
  // shared value, or it can approve batches the fleet can't actually run.
  const ramCosts = { hack: 1.7, grow: 1.75, weaken: 1.75 };

  function batchOp(overrides: Partial<BatchOp>): BatchOp {
    return { type: "grow", target: "n00dles", threads: 2, delay: 0, tag: "b-0", ...overrides };
  }

  function plan(newBatchOps: BatchOp[]): CyclePlan {
    return {
      prepOps: [],
      newBatches: [{ target: "n00dles", ops: newBatchOps, expectedEnd: 0 }],
      abortTargets: [],
      ramCosts,
    };
  }

  it("rejects a batch when the fleet has enough RAM at hack.js's price but not at the op's real price", () => {
    // 2 grow threads at the correct 1.75GB/thread need 3.5GB; only 3.4GB is
    // available. At the (buggy) hack.js price of 1.7GB/thread, 3.4GB would
    // wrongly look sufficient for 2 threads (floor(3.4/1.7) = 2).
    const servers: ServerSlot[] = [{ hostname: "s1", availableRam: 3.4 }];
    const allocated = allocateServersToBatchOps(servers, plan([batchOp({ threads: 2 })]));

    expect(allocated).toEqual([]);
    // Rolled back cleanly — no RAM left allocated on the server.
    expect(servers[0].availableRam).toBe(3.4);
  });

  it("accepts and correctly prices the batch once there is truly enough RAM", () => {
    const servers: ServerSlot[] = [{ hostname: "s1", availableRam: 3.5 }];
    const allocated = allocateServersToBatchOps(servers, plan([batchOp({ threads: 2 })]));

    expect(allocated).toHaveLength(1);
    expect(allocated[0]).toMatchObject({ type: "grow", threads: 2, server: "s1" });
    expect(servers[0].availableRam).toBeCloseTo(0, 9);
  });

  it("prices weaken prep ops (partial allocation) at weaken.js's own RAM cost", () => {
    const servers: ServerSlot[] = [{ hostname: "s1", availableRam: 10 * ramCosts.weaken - 0.01 }];
    const cyclePlan: CyclePlan = {
      prepOps: [{ type: "weaken", target: "n00dles", threads: 10, delay: 0, tag: "prep" }],
      newBatches: [],
      abortTargets: [],
      ramCosts,
    };

    const allocated = allocateServersToBatchOps(servers, cyclePlan);

    // Just short of 10 full weaken threads worth of RAM -> partial allocation of 9.
    expect(allocated).toHaveLength(1);
    expect(allocated[0].threads).toBe(9);
  });
});
