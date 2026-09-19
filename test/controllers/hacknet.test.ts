import { describe, it, expect } from "vitest";
import {
  HASH_STRATEGY_MAP,
  isHashSpendStrategy,
  primaryHackTarget,
  resolveHashSpend,
} from "/controllers/hacknet";
import { HashSpendStrategy, TargetAssignment } from "/types/ports";

// Exact HashUpgradeEnum strings from the game (src/Hacknet/Enums.ts, v3.0.1).
const GAME_HASH_UPGRADES = [
  "Sell for Money",
  "Sell for Corporation Funds",
  "Reduce Minimum Security",
  "Increase Maximum Money",
  "Improve Studying",
  "Improve Gym Training",
  "Exchange for Corporation Research",
  "Exchange for Bladeburner Rank",
  "Exchange for Bladeburner SP",
  "Generate Coding Contract",
  "Company Favor",
];

function target(hostname: string, rank: number): TargetAssignment {
  return {
    rank,
    hostname,
    action: "hack",
    assignedThreads: 0,
    optimalThreads: 0,
    threadsSaturated: false,
    moneyPercent: 0,
    moneyDisplay: "",
    securityDelta: "",
    securityClean: true,
    eta: "",
    expectedMoney: 0,
    expectedMoneyFormatted: "",
    totalThreads: 0,
    completionEta: null,
    hackThreads: 0,
    growThreads: 0,
    weakenThreads: 0,
  };
}

describe("HASH_STRATEGY_MAP", () => {
  it("covers every hash upgrade the game defines, with exact names", () => {
    const mapped = Object.values(HASH_STRATEGY_MAP).sort();
    expect(mapped).toEqual([...GAME_HASH_UPGRADES].sort());
  });

  it("isHashSpendStrategy accepts every key and rejects unknown or prototype names", () => {
    for (const key of Object.keys(HASH_STRATEGY_MAP)) {
      expect(isHashSpendStrategy(key)).toBe(true);
    }
    expect(isHashSpendStrategy("sell")).toBe(false);
    expect(isHashSpendStrategy("")).toBe(false);
    expect(isHashSpendStrategy("toString")).toBe(false);
  });
});

describe("primaryHackTarget", () => {
  it("returns null with no targets", () => {
    expect(primaryHackTarget(null)).toBeNull();
    expect(primaryHackTarget(undefined)).toBeNull();
    expect(primaryHackTarget([])).toBeNull();
  });

  it("picks the lowest rank regardless of array order", () => {
    const targets = [target("joesguns", 3), target("n00dles", 1), target("foodnstuff", 2)];
    expect(primaryHackTarget(targets)).toBe("n00dles");
  });

  it("skips entries without a hostname", () => {
    const targets = [target("", 1), target("phantasy", 2)];
    expect(primaryHackTarget(targets)).toBe("phantasy");
  });
});

describe("resolveHashSpend", () => {
  const noTargetStrategies: HashSpendStrategy[] = [
    "money", "corp-funds", "corp-research", "study", "gym",
    "bladeburner-rank", "bladeburner-sp", "coding-contract",
  ];

  it.each(noTargetStrategies)("%s takes no target and is always valid", (strategy) => {
    const plan = resolveHashSpend(strategy, "ignored", [target("n00dles", 1)]);
    expect(plan).toEqual({
      strategy,
      upgrade: HASH_STRATEGY_MAP[strategy],
      target: null,
      targetSource: null,
      isValid: true,
      reason: null,
    });
  });

  describe.each(["reduce-security", "increase-money"] as HashSpendStrategy[])("%s", (strategy) => {
    it("uses spendTarget when set, trimmed", () => {
      const plan = resolveHashSpend(strategy, "  phantasy ", [target("n00dles", 1)]);
      expect(plan.isValid).toBe(true);
      expect(plan.target).toBe("phantasy");
      expect(plan.targetSource).toBe("config");
      expect(plan.upgrade).toBe(HASH_STRATEGY_MAP[strategy]);
    });

    it("falls back to the hack daemon's primary target when spendTarget is empty", () => {
      const plan = resolveHashSpend(strategy, "", [target("joesguns", 2), target("n00dles", 1)]);
      expect(plan.isValid).toBe(true);
      expect(plan.target).toBe("n00dles");
      expect(plan.targetSource).toBe("hack-daemon");
    });

    it("is invalid with a reason when neither a config target nor a hack target exists", () => {
      for (const targets of [null, undefined, []]) {
        const plan = resolveHashSpend(strategy, "   ", targets);
        expect(plan.isValid).toBe(false);
        expect(plan.target).toBeNull();
        expect(plan.targetSource).toBeNull();
        expect(plan.reason).toContain(strategy);
        expect(plan.reason).toContain("spendTarget");
      }
    });
  });

  describe("company-favor", () => {
    it("uses spendTarget as the company name", () => {
      const plan = resolveHashSpend("company-favor", "MegaCorp", [target("n00dles", 1)]);
      expect(plan).toEqual({
        strategy: "company-favor",
        upgrade: "Company Favor",
        target: "MegaCorp",
        targetSource: "config",
        isValid: true,
        reason: null,
      });
    });

    it("never falls back to a hack target and is invalid without spendTarget", () => {
      const plan = resolveHashSpend("company-favor", "", [target("n00dles", 1)]);
      expect(plan.isValid).toBe(false);
      expect(plan.target).toBeNull();
      expect(plan.reason).toContain("company");
    });
  });
});
