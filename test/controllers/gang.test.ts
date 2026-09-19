import { describe, it, expect } from "vitest";
import {
  getNextRecruitName,
  selectWantedCleaners,
  calculateWarfareCount,
  determineBalancedPhase,
  assignTasks,
  scoreAscension,
  selectAscensionCandidate,
  rankEquipment,
  avgCombatMultiplier,
  NATO_NAMES,
  type MemberInfo,
  type GangTaskConfig,
  type GangInfo,
  type TaskStats,
  type EquipmentInfo,
  type TerritoryContext,
} from "/controllers/gang";

function member(overrides: Partial<MemberInfo> = {}): MemberInfo {
  return {
    name: "Alpha",
    task: "Unassigned",
    str: 10, def: 10, dex: 10, agi: 10, cha: 10, hack: 10,
    earnedRespect: 0,
    strMult: 1, defMult: 1, dexMult: 1, agiMult: 1,
    ...overrides,
  };
}

function task(overrides: Partial<TaskStats> = {}): TaskStats {
  return {
    name: "Mug People",
    baseMoney: 3.6, baseRespect: 0.00005, baseWanted: 0.00005,
    strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 10, chaWeight: 15, hackWeight: 0,
    isHacking: false, isCombat: true,
    ...overrides,
  };
}

const baseTaskConfig: GangTaskConfig = {
  strategy: "money",
  trainingThreshold: 500,
  wantedThreshold: 0.95,
  growTargetMultiplier: 30,
  growRespectReserve: 2,
};

const baseGangInfo: GangInfo = {
  respect: 1000,
  wantedLevel: 1,
  wantedPenalty: 0.999,
  territory: 0.1,
  isHacking: false,
};

describe("getNextRecruitName", () => {
  it("returns the first unused NATO name", () => {
    expect(getNextRecruitName([])).toBe("Alpha");
    expect(getNextRecruitName(["Alpha", "Bravo"])).toBe("Charlie");
  });

  it("falls back to Member-N once all NATO names are taken", () => {
    expect(getNextRecruitName([...NATO_NAMES])).toBe(`Member-${NATO_NAMES.length + 1}`);
  });
});

describe("avgCombatMultiplier", () => {
  it("averages the four combat ascension multipliers", () => {
    const m = member({ strMult: 1, defMult: 2, dexMult: 3, agiMult: 4 });
    expect(avgCombatMultiplier(m)).toBe(2.5);
  });
});

describe("selectWantedCleaners", () => {
  it("returns no cleaners when penalty is already above threshold", () => {
    expect(selectWantedCleaners([member()], 0.95, 0.99)).toEqual([]);
  });

  it("picks the weakest members first, scaling count with deficit severity", () => {
    const members = [
      member({ name: "Strong", str: 100, def: 100, dex: 100, agi: 100 }),
      member({ name: "Weak", str: 1, def: 1, dex: 1, agi: 1 }),
    ];
    const cleaners = selectWantedCleaners(members, 0.95, 0.5);
    expect(cleaners[0]).toBe("Weak");
  });

  it("never returns more cleaners than there are members", () => {
    const members = [member({ name: "Only", str: 1, def: 1, dex: 1, agi: 1 })];
    const cleaners = selectWantedCleaners(members, 0.95, 0);
    expect(cleaners.length).toBeLessThanOrEqual(members.length);
  });
});

describe("calculateWarfareCount", () => {
  it("defaults to a conservative 2 when there is no territory data", () => {
    expect(calculateWarfareCount([member()], null, 0.1)).toEqual({ count: 2, reason: "no rival data, conservative default" });
  });

  it("returns 0 once territory is effectively complete", () => {
    const ctx: TerritoryContext = { ourPower: 100, rivals: [{ name: "R", power: 10, territory: 0.01, clashChance: 0.9 }], warfareEngaged: true };
    expect(calculateWarfareCount([member()], ctx, 0.995).count).toBe(0);
  });

  it("commits more members when losing (low clash chance)", () => {
    const members = Array.from({ length: 10 }, (_, i) => member({ name: `M${i}` }));
    const ctx: TerritoryContext = { ourPower: 10, rivals: [{ name: "R", power: 100, territory: 0.5, clashChance: 0.3 }], warfareEngaged: true };
    const result = calculateWarfareCount(members, ctx, 0.1);
    expect(result.count).toBeGreaterThanOrEqual(4);
  });

  it("commits fewer members when dominant with a large power ratio", () => {
    const members = Array.from({ length: 10 }, (_, i) => member({ name: `M${i}` }));
    const ctx: TerritoryContext = { ourPower: 1000, rivals: [{ name: "R", power: 10, territory: 0.5, clashChance: 0.95 }], warfareEngaged: true };
    const result = calculateWarfareCount(members, ctx, 0.1);
    expect(result.count).toBe(1);
  });

  it("treats rivals with ~0 territory as needing only a token presence", () => {
    const ctx: TerritoryContext = { ourPower: 100, rivals: [{ name: "R", power: 10, territory: 0, clashChance: -1 }], warfareEngaged: false };
    expect(calculateWarfareCount([member()], ctx, 0.1)).toEqual({ count: 1, reason: "rivals have no territory" });
  });
});

describe("determineBalancedPhase", () => {
  it("returns grow when there are no members", () => {
    expect(determineBalancedPhase([], baseGangInfo, 30)).toBe("grow");
  });

  it("returns grow when average multiplier is below half the target", () => {
    const members = [member({ strMult: 1, defMult: 1, dexMult: 1, agiMult: 1 })];
    expect(determineBalancedPhase(members, baseGangInfo, 30)).toBe("grow");
  });

  it("returns respect while below max member count and past the grow threshold", () => {
    const members = [member({ strMult: 20, defMult: 20, dexMult: 20, agiMult: 20 })];
    expect(determineBalancedPhase(members, baseGangInfo, 30)).toBe("respect");
  });

  it("returns territory once at max members with territory below 99%", () => {
    const members = Array.from({ length: NATO_NAMES.length }, (_, i) =>
      member({ name: `M${i}`, strMult: 20, defMult: 20, dexMult: 20, agiMult: 20 }));
    expect(determineBalancedPhase(members, { ...baseGangInfo, territory: 0.5 }, 30)).toBe("territory");
  });

  it("returns money once maxed on members and territory", () => {
    const members = Array.from({ length: NATO_NAMES.length }, (_, i) =>
      member({ name: `M${i}`, strMult: 20, defMult: 20, dexMult: 20, agiMult: 20 }));
    expect(determineBalancedPhase(members, { ...baseGangInfo, territory: 0.995 }, 30)).toBe("money");
  });
});

describe("assignTasks", () => {
  it("keeps pinned members on their pinned task regardless of strategy", () => {
    const members = [member({ name: "Pinned" })];
    const result = assignTasks(members, baseTaskConfig, baseGangInfo, [task()], { Pinned: "Train Combat" });
    expect(result).toEqual([{ memberName: "Pinned", task: "Train Combat", reason: "pinned" }]);
  });

  it("routes weakest unpinned members to Vigilante Justice when wanted penalty is below threshold", () => {
    const members = [
      member({ name: "Strong", str: 100, def: 100, dex: 100, agi: 100 }),
      member({ name: "Weak", str: 1, def: 1, dex: 1, agi: 1 }),
    ];
    const tasks = [task(), task({ name: "Vigilante Justice", baseMoney: 0, baseRespect: 0, baseWanted: -0.001, isCombat: true })];
    const result = assignTasks(members, baseTaskConfig, { ...baseGangInfo, wantedPenalty: 0.5, wantedLevel: 10 }, tasks, {});
    const weak = result.find(a => a.memberName === "Weak");
    expect(weak?.task).toBe("Vigilante Justice");
  });

  it("does not run wanted cleanup when wanted level is at/below 1 even if penalty is low", () => {
    const members = [member({ name: "Only" })];
    const result = assignTasks(members, baseTaskConfig, { ...baseGangInfo, wantedPenalty: 0.5, wantedLevel: 1 }, [task()], {});
    expect(result[0].task).not.toBe("Vigilante Justice");
  });

  it("sends undertrained members to Train Combat before strategy tasks", () => {
    const members = [member({ name: "Rookie", str: 1, def: 1, dex: 1, agi: 1 })];
    const tasks = [task(), task({ name: "Train Combat", baseMoney: 0, baseRespect: 0, baseWanted: 0 })];
    const result = assignTasks(members, { ...baseTaskConfig, trainingThreshold: 500 }, baseGangInfo, tasks, {});
    expect(result[0].task).toBe("Train Combat");
  });

  it("assigns money-optimizing tasks under the money strategy once trained", () => {
    const members = [member({ name: "Vet", str: 1000, def: 1000, dex: 1000, agi: 1000 })];
    const highMoney = task({ name: "Big Money", baseMoney: 1000 });
    const lowMoney = task({ name: "Small Money", baseMoney: 1 });
    const result = assignTasks(members, { ...baseTaskConfig, strategy: "money", trainingThreshold: 1 }, baseGangInfo, [highMoney, lowMoney], {});
    expect(result[0].task).toBe("Big Money");
  });

  it("in territory strategy, splits strongest members to warfare and the rest to money", () => {
    const members = [
      member({ name: "Strongest", str: 1000, def: 1000, dex: 1000, agi: 1000 }),
      member({ name: "Weakest", str: 900, def: 900, dex: 900, agi: 900 }),
    ];
    const ctx: TerritoryContext = { ourPower: 10, rivals: [{ name: "R", power: 100, territory: 0.5, clashChance: 0.3 }], warfareEngaged: true };
    const result = assignTasks(members, { ...baseTaskConfig, strategy: "territory", trainingThreshold: 1 }, baseGangInfo, [task()], {}, ctx);
    // calculateWarfareCount with clashChance 0.3 and 2 ready members assigns both to warfare
    expect(result.every(a => a.task === "Territory Warfare")).toBe(true);
  });
});

describe("scoreAscension", () => {
  it("auto-ascends when the best gain meets the auto threshold", () => {
    const result = scoreAscension({ str: 2, def: 1, dex: 1, agi: 1, cha: 1, hack: 1 }, 1.5, 1.15);
    expect(result).toEqual({ action: "auto", bestGain: 2, bestStat: "str" });
  });

  it("flags for review when between review and auto thresholds", () => {
    const result = scoreAscension({ str: 1.2, def: 1, dex: 1, agi: 1, cha: 1, hack: 1 }, 1.5, 1.15);
    expect(result.action).toBe("flag");
  });

  it("skips when below the review threshold", () => {
    const result = scoreAscension({ str: 1.05, def: 1, dex: 1, agi: 1, cha: 1, hack: 1 }, 1.5, 1.15);
    expect(result.action).toBe("skip");
  });

  it("only considers combat stats (str/def/dex/agi), not cha/hack", () => {
    const result = scoreAscension({ str: 1, def: 1, dex: 1, agi: 1, cha: 5, hack: 5 }, 1.5, 1.15);
    expect(result.action).toBe("skip");
    expect(result.bestGain).toBe(1);
  });
});

describe("selectAscensionCandidate", () => {
  it("returns null when no candidate meets the threshold", () => {
    const candidates = [{ name: "A", result: { str: 1, def: 1, dex: 1, agi: 1, cha: 1, hack: 1 } }];
    expect(selectAscensionCandidate(candidates, 1.5)).toBeNull();
  });

  it("picks the single best candidate, staggering ascensions one at a time", () => {
    const candidates = [
      { name: "A", result: { str: 1.6, def: 1, dex: 1, agi: 1, cha: 1, hack: 1 } },
      { name: "B", result: { str: 2.0, def: 1, dex: 1, agi: 1, cha: 1, hack: 1 } },
    ];
    const best = selectAscensionCandidate(candidates, 1.5);
    expect(best?.name).toBe("B");
  });
});

describe("rankEquipment", () => {
  const equalWeightsTask: TaskStats = task({ strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25, chaWeight: 0, hackWeight: 0 });

  it("filters out already-owned equipment", () => {
    const equipment: EquipmentInfo[] = [{ name: "Baseball Bat", cost: 1e6, type: "w", stats: { str: 1.04, def: 1.04 } }];
    const ranked = rankEquipment(equipment, equalWeightsTask, new Set(["Baseball Bat"]));
    expect(ranked).toEqual([]);
  });

  it("treats a missing stat as no bonus (0 delta), not a penalty", () => {
    // equalWeightsTask.strWeight === 25 (game task weights are 0-100), so
    // only the str term (0.1 excess * weight 25) contributes.
    const equipment: EquipmentInfo[] = [{ name: "Str Only", cost: 1e6, type: "w", stats: { str: 1.1 } }];
    const ranked = rankEquipment(equipment, equalWeightsTask, new Set());
    expect(ranked[0].roi).toBeCloseTo((0.1 * 25) / 1e6, 10);
  });

  it("values equipment boosting more stats over equipment boosting fewer at the same cost and per-stat bonus", () => {
    // Regression test: ROI must use (mult - 1), not the raw multiplier,
    // otherwise the "+1" baseline swamps the actual bonus and equipment
    // affecting more stats is undervalued relative to single-stat gear.
    const equipment: EquipmentInfo[] = [
      { name: "FourStat", cost: 10e6, type: "g", stats: { str: 1.1, def: 1.1, dex: 1.1, agi: 1.1 } },
      { name: "OneStat", cost: 10e6, type: "g", stats: { str: 1.1 } },
    ];
    const ranked = rankEquipment(equipment, equalWeightsTask, new Set());
    const fourStat = ranked.find(r => r.name === "FourStat")!;
    const oneStat = ranked.find(r => r.name === "OneStat")!;
    expect(fourStat.roi).toBeCloseTo(4 * oneStat.roi, 10);
  });

  it("sorts by ROI descending and excludes non-positive ROI items", () => {
    const equipment: EquipmentInfo[] = [
      { name: "Cheap", cost: 1e6, type: "w", stats: { str: 1.04 } },
      { name: "Expensive", cost: 100e6, type: "w", stats: { str: 1.3 } },
      { name: "NoEffect", cost: 1e6, type: "w", stats: {} },
    ];
    const ranked = rankEquipment(equipment, equalWeightsTask, new Set());
    expect(ranked.map(r => r.name)).toEqual(["Cheap", "Expensive"]);
  });

  it("falls back to equal default weights when there is no current task", () => {
    const equipment: EquipmentInfo[] = [{ name: "Balanced", cost: 1e6, type: "w", stats: { str: 1.1, hack: 1.1 } }];
    const ranked = rankEquipment(equipment, null, new Set());
    expect(ranked[0].roi).toBeGreaterThan(0);
  });
});
