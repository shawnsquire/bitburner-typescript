import { describe, it, expect } from "vitest";
import {
  hasTorRouter,
  analyzeDarkwebPrograms,
  getDarkwebStatus,
  purchaseTorRouter,
  formatMoney,
} from "/controllers/darkweb";
import { mockNS } from "../helpers/mock-ns";

function programNs(opts: {
  hasTor?: boolean;
  costs: Record<string, number>;
  owned?: string[];
  money?: number;
  purchaseResults?: Record<string, boolean>;
}) {
  const hasTor = opts.hasTor ?? true;
  const owned = new Set(opts.owned ?? []);
  return mockNS({
    extra: {
      getServerMoneyAvailable: () => opts.money ?? 0,
      fileExists: (name: string) => owned.has(name),
      singularity: {
        getDarkwebPrograms: () => (hasTor ? Object.keys(opts.costs) : []),
        getDarkwebProgramCost: (name: string) => opts.costs[name],
        purchaseProgram: (name: string) => opts.purchaseResults?.[name] ?? true,
      },
    },
  });
}

describe("hasTorRouter", () => {
  it("returns true when getDarkwebPrograms returns a non-empty list", () => {
    const ns = programNs({ hasTor: true, costs: { "BruteSSH.exe": 500_000 } });
    expect(hasTorRouter(ns)).toBe(true);
  });

  it("returns false when the program list is empty (no TOR)", () => {
    const ns = programNs({ hasTor: false, costs: { "BruteSSH.exe": 500_000 } });
    expect(hasTorRouter(ns)).toBe(false);
  });

  it("returns false instead of throwing when Source-File 4 is unavailable", () => {
    const ns = mockNS({
      extra: {
        singularity: {
          getDarkwebPrograms: () => {
            throw new Error("This singularity function requires Source-File 4 to run.");
          },
        },
      },
    });
    expect(hasTorRouter(ns)).toBe(false);
  });
});

describe("analyzeDarkwebPrograms", () => {
  it("reports the TOR-router cost and does nothing else when TOR isn't owned", () => {
    const ns = programNs({ hasTor: false, costs: {} });
    const result = analyzeDarkwebPrograms(ns);
    expect(result.hasTorRouter).toBe(false);
    expect(result.moneyUntilNext).toBe(200_000);
    expect(result.totalPrograms).toBe(0);
  });

  it("buys every affordable unowned program in cost order and tracks running balance", () => {
    const ns = programNs({
      costs: { "FTPCrack.exe": 1_500_000, "BruteSSH.exe": 500_000, "SQLInject.exe": 250_000_000 },
      money: 2_000_000,
    });

    const result = analyzeDarkwebPrograms(ns, true);

    expect(result.purchased.map(p => p.name).sort()).toEqual(["BruteSSH.exe", "FTPCrack.exe"]);
    expect(result.cannotAfford.map(p => p.name)).toEqual(["SQLInject.exe"]);
    expect(result.playerMoney).toBe(2_000_000 - 500_000 - 1_500_000);
    expect(result.nextProgram?.name).toBe("SQLInject.exe");
  });

  it("does not purchase already-owned programs", () => {
    const ns = programNs({
      costs: { "BruteSSH.exe": 500_000 },
      owned: ["BruteSSH.exe"],
      money: 10_000_000,
    });

    const result = analyzeDarkwebPrograms(ns, true);
    expect(result.purchased).toEqual([]);
    expect(result.alreadyOwned.map(p => p.name)).toEqual(["BruteSSH.exe"]);
    expect(result.ownedCount).toBe(1);
  });

  it("treats a v3 purchaseProgram() false-return as a failed purchase, not a crash", () => {
    const ns = programNs({
      costs: { "BruteSSH.exe": 500_000 },
      money: 10_000_000,
      purchaseResults: { "BruteSSH.exe": false },
    });

    const result = analyzeDarkwebPrograms(ns, true);
    expect(result.purchased).toEqual([]);
    expect(result.cannotAfford.map(p => p.name)).toEqual(["BruteSSH.exe"]);
  });

  it("gates purchases through budgetCheck and moves rejected programs to cannotAfford", () => {
    const ns = programNs({
      costs: { "BruteSSH.exe": 500_000 },
      money: 10_000_000,
    });

    const result = analyzeDarkwebPrograms(ns, true, () => false);
    expect(result.purchased).toEqual([]);
    expect(result.cannotAfford.map(p => p.name)).toEqual(["BruteSSH.exe"]);
  });

  it("getDarkwebStatus never purchases even when everything is affordable", () => {
    const ns = programNs({
      costs: { "BruteSSH.exe": 500_000 },
      money: 10_000_000,
    });

    const status = getDarkwebStatus(ns);
    expect(status.purchased).toEqual([]);
    expect(status.cannotAfford.map(p => p.name)).toEqual(["BruteSSH.exe"]);
  });
});

describe("purchaseTorRouter", () => {
  it("purchases when budgetCheck allows it", () => {
    const ns = mockNS({ extra: { singularity: { purchaseTor: () => true } } });
    expect(purchaseTorRouter(ns, () => true)).toBe(true);
  });

  it("is gated by budgetCheck without ever calling purchaseTor", () => {
    const ns = mockNS({
      extra: {
        singularity: {
          purchaseTor: () => {
            throw new Error("should not be called");
          },
        },
      },
    });
    expect(purchaseTorRouter(ns, () => false)).toBe(false);
  });

  it("returns false instead of throwing when Source-File 4 is unavailable", () => {
    const ns = mockNS({
      extra: {
        singularity: {
          purchaseTor: () => {
            throw new Error("This singularity function requires Source-File 4 to run.");
          },
        },
      },
    });
    expect(purchaseTorRouter(ns)).toBe(false);
  });
});

describe("formatMoney", () => {
  it.each([
    [500, "$500"],
    [1_500, "$1.50k"],
    [2_500_000, "$2.50m"],
    [3_500_000_000, "$3.50b"],
    [4_500_000_000_000, "$4.50t"],
  ])("formats %d as %s", (amount, expected) => {
    expect(formatMoney(amount)).toBe(expected);
  });
});
