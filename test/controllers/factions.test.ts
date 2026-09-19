import { describe, it, expect } from "vitest";
import {
  AUG_COST_MULT,
  NFG_REP_MULT,
  NON_WORKABLE_FACTIONS,
  SEQUENTIAL_PURCHASE_FACTIONS,
  DONATION_FAVOR_THRESHOLD,
  NON_DONATABLE_FACTIONS,
  calculatePurchasePriority,
  getAffordableAugs,
  findNextAugmentation,
  findNextWorkableAugmentation,
  getNonWorkableFactionProgress,
  selectBestWorkType,
  getPendingAugs,
  getNeuroFluxInfo,
  calculateNeuroFluxPurchasePlan,
  canDonateToFaction,
  calculateNFGDonatePurchasePlan,
  type FactionData,
  type AugmentationInfo,
} from "/controllers/factions";
import { mockNS } from "../helpers/mock-ns";
import type { Player } from "@ns";

function aug(overrides: Partial<AugmentationInfo> = {}): AugmentationInfo {
  return { name: "Aug", repReq: 0, basePrice: 0, prereqs: [], ...overrides };
}

function faction(overrides: Partial<FactionData> = {}): FactionData {
  return {
    name: "Faction",
    currentRep: 0,
    favor: 0,
    availableAugs: [],
    nextAugRepGap: Infinity,
    ...overrides,
  };
}

function player(overrides: Partial<Player> = {}): Player {
  return {
    factions: [],
    money: 0,
    skills: { hacking: 0, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 0 },
    mults: {},
    ...overrides,
  } as unknown as Player;
}

describe("calculatePurchasePriority", () => {
  it("returns nothing when no faction has enough rep for any aug", () => {
    const data = [faction({ availableAugs: [aug({ name: "A", repReq: 100, basePrice: 1000 })] })];
    expect(calculatePurchasePriority(mockNS(), data)).toEqual([]);
  });

  it("includes only augs where currentRep >= repReq", () => {
    const data = [faction({
      currentRep: 50,
      availableAugs: [
        aug({ name: "Cheap", repReq: 10, basePrice: 100 }),
        aug({ name: "TooExpensive", repReq: 100, basePrice: 200 }),
      ],
    })];
    const plan = calculatePurchasePriority(mockNS(), data);
    expect(plan.map((a) => a.name)).toEqual(["Cheap"]);
  });

  it("excludes sequential-purchase factions like Shadows of Anarchy", () => {
    expect(SEQUENTIAL_PURCHASE_FACTIONS.has("Shadows of Anarchy")).toBe(true);
    const data = [faction({
      name: "Shadows of Anarchy",
      currentRep: 1000,
      availableAugs: [aug({ name: "SoA Aug", repReq: 10, basePrice: 100 })],
    })];
    expect(calculatePurchasePriority(mockNS(), data)).toEqual([]);
  });

  it("dedupes an aug offered by multiple factions, keeping the first encountered", () => {
    const shared = aug({ name: "Shared", repReq: 10, basePrice: 500 });
    const data = [
      faction({ name: "F1", currentRep: 100, availableAugs: [shared] }),
      faction({ name: "F2", currentRep: 100, availableAugs: [shared] }),
    ];
    const plan = calculatePurchasePriority(mockNS(), data);
    expect(plan).toHaveLength(1);
    expect(plan[0].faction).toBe("F1");
  });

  it("sorts by base price descending and compounds the multiplier per purchase", () => {
    const data = [faction({
      currentRep: 1000,
      availableAugs: [
        aug({ name: "Cheap", repReq: 0, basePrice: 100 }),
        aug({ name: "Mid", repReq: 0, basePrice: 500 }),
        aug({ name: "Expensive", repReq: 0, basePrice: 1000 }),
      ],
    })];
    const plan = calculatePurchasePriority(mockNS(), data);
    expect(plan.map((a) => a.name)).toEqual(["Expensive", "Mid", "Cheap"]);
    expect(plan[0].multiplier).toBe(1);
    expect(plan[0].adjustedCost).toBe(1000);
    expect(plan[1].multiplier).toBeCloseTo(AUG_COST_MULT);
    expect(plan[1].adjustedCost).toBe(Math.round(500 * AUG_COST_MULT));
    expect(plan[2].multiplier).toBeCloseTo(AUG_COST_MULT * AUG_COST_MULT);
    expect(plan[2].adjustedCost).toBe(Math.round(100 * AUG_COST_MULT * AUG_COST_MULT));
  });
});

describe("getAffordableAugs", () => {
  it("stops at the first item that would exceed the budget (no partial skipping)", () => {
    const plan = [
      { ...aug({ name: "A", basePrice: 100 }), faction: "F", adjustedCost: 100, multiplier: 1 },
      { ...aug({ name: "B", basePrice: 900 }), faction: "F", adjustedCost: 900, multiplier: 1 },
      { ...aug({ name: "C", basePrice: 50 }), faction: "F", adjustedCost: 50, multiplier: 1 },
    ];
    const affordable = getAffordableAugs(plan, 500);
    // B (900) blows the budget even though C (50) alone would fit afterward.
    expect(affordable.map((a) => a.name)).toEqual(["A"]);
    expect(affordable[0].runningTotal).toBe(100);
  });

  it("returns everything when the budget covers the whole plan", () => {
    const plan = [
      { ...aug({ name: "A", basePrice: 100 }), faction: "F", adjustedCost: 100, multiplier: 1 },
      { ...aug({ name: "B", basePrice: 200 }), faction: "F", adjustedCost: 200, multiplier: 1 },
    ];
    const affordable = getAffordableAugs(plan, 300);
    expect(affordable.map((a) => a.runningTotal)).toEqual([100, 300]);
  });
});

describe("findNextAugmentation / findNextWorkableAugmentation", () => {
  it("picks the smallest positive rep gap across all factions", () => {
    const data = [
      faction({ name: "Far", currentRep: 0, availableAugs: [aug({ name: "FarAug", repReq: 1000 })] }),
      faction({ name: "Near", currentRep: 90, availableAugs: [aug({ name: "NearAug", repReq: 100 })] }),
    ];
    const next = findNextAugmentation(data);
    expect(next?.faction.name).toBe("Near");
    expect(next?.repGap).toBe(10);
  });

  it("ignores augs already unlocked (gap <= 0)", () => {
    const data = [faction({ currentRep: 100, availableAugs: [aug({ name: "Unlocked", repReq: 50 })] })];
    expect(findNextAugmentation(data)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(findNextAugmentation([])).toBeNull();
  });

  it("findNextWorkableAugmentation skips NON_WORKABLE_FACTIONS and any excluded set", () => {
    expect(NON_WORKABLE_FACTIONS.has("Bladeburners")).toBe(true);
    const data = [
      faction({ name: "Bladeburners", currentRep: 0, availableAugs: [aug({ name: "BB", repReq: 10 })] }),
      faction({ name: "GangFaction", currentRep: 0, availableAugs: [aug({ name: "GangAug", repReq: 20 })] }),
      faction({ name: "Normal", currentRep: 0, availableAugs: [aug({ name: "NormalAug", repReq: 30 })] }),
    ];
    const result = findNextWorkableAugmentation(data, new Set(["GangFaction"]));
    expect(result?.faction.name).toBe("Normal");
  });
});

describe("getNonWorkableFactionProgress", () => {
  it("only reports non-workable (or explicitly extra) factions, sorted by progress descending", () => {
    const data = [
      faction({ name: "Shadows of Anarchy", currentRep: 90, availableAugs: [aug({ name: "SoA", repReq: 100 })] }),
      faction({ name: "MyGang", currentRep: 10, availableAugs: [aug({ name: "GangAug", repReq: 100 })] }),
      faction({ name: "Normal", currentRep: 999, availableAugs: [aug({ name: "NormalAug", repReq: 1000 })] }),
    ];
    const result = getNonWorkableFactionProgress(data, new Set(["MyGang"]));
    expect(result.map((r) => r.faction.name)).toEqual(["Shadows of Anarchy", "MyGang"]);
    expect(result[0].progress).toBeCloseTo(0.9);
  });

  it("skips factions with no remaining (unlocked) augs", () => {
    const data = [faction({ name: "Bladeburners", currentRep: 100, availableAugs: [aug({ name: "Done", repReq: 50 })] })];
    expect(getNonWorkableFactionProgress(data)).toEqual([]);
  });
});

describe("selectBestWorkType", () => {
  it("chooses hacking when it's the player's strongest stat and the faction allows it", () => {
    const p = player({ skills: { hacking: 100, strength: 10, defense: 10, dexterity: 10, agility: 10, charisma: 0, intelligence: 0 } });
    expect(selectBestWorkType(mockNS(), p, "CyberSec")).toBe("hacking");
  });

  it("falls back to field work for hacking-restricted factions even with high hacking", () => {
    const p = player({ skills: { hacking: 999, strength: 10, defense: 10, dexterity: 10, agility: 10, charisma: 0, intelligence: 0 } });
    expect(selectBestWorkType(mockNS(), p, "Slum Snakes")).toBe("field");
  });

  it("defaults to field work when charisma or combat leads and hacking is not selected", () => {
    const p = player({ skills: { hacking: 0, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 100, intelligence: 0 } });
    expect(selectBestWorkType(mockNS(), p, undefined)).toBe("field");
  });
});

describe("getPendingAugs", () => {
  it("counts duplicate augmentation names (e.g. NeuroFlux Governor) correctly instead of a membership filter", () => {
    // 1 NFG installed + 2 more purchased-but-not-installed, plus one other aug fully installed.
    const ns = mockNS({
      extra: {
        singularity: {
          getOwnedAugmentations: (purchased?: boolean) =>
            purchased
              ? ["Other", "NeuroFlux Governor", "NeuroFlux Governor", "NeuroFlux Governor"]
              : ["Other", "NeuroFlux Governor"],
        },
      },
    });
    const pending = getPendingAugs(ns);
    expect(pending).toEqual(["NeuroFlux Governor", "NeuroFlux Governor"]);
  });

  it("returns an empty list when nothing is pending", () => {
    const ns = mockNS({
      extra: {
        singularity: {
          getOwnedAugmentations: () => ["Other"],
        },
      },
    });
    expect(getPendingAugs(ns)).toEqual([]);
  });
});

describe("getNeuroFluxInfo", () => {
  function nfgNS(opts: {
    ownedAugsLevel?: number;
    factions?: string[];
    factionAugs?: Record<string, string[]>;
    factionRep?: Record<string, number>;
    price?: number;
    repRequired?: number;
  }) {
    const factionAugs = opts.factionAugs ?? {};
    const factionRep = opts.factionRep ?? {};
    return mockNS({
      extra: {
        getPlayer: () => player({ factions: (opts.factions ?? []) as never }),
        getResetInfo: () => ({
          ownedAugs: new Map(opts.ownedAugsLevel ? [["NeuroFlux Governor", opts.ownedAugsLevel]] : []),
        }),
        singularity: {
          getAugmentationsFromFaction: (f: string) => factionAugs[f] ?? [],
          getFactionRep: (f: string) => factionRep[f] ?? 0,
          getAugmentationPrice: () => opts.price ?? 0,
          getAugmentationRepReq: () => opts.repRequired ?? 0,
        },
      },
    });
  }

  it("reads currentLevel from getResetInfo().ownedAugs, not by counting getOwnedAugmentations() strings", () => {
    // Regression test: NeuroFlux Governor only ever appears once (or zero times)
    // in getOwnedAugmentations() regardless of its real level, since the game
    // stores it as a single entry with a `.level` field. Counting occurrences
    // would report level 0-1 here even though the real level is 7.
    const ns = nfgNS({ ownedAugsLevel: 7 });
    expect(getNeuroFluxInfo(ns).currentLevel).toBe(7);
  });

  it("reports currentLevel 0 when no NeuroFlux Governor is installed", () => {
    const ns = nfgNS({});
    expect(getNeuroFluxInfo(ns).currentLevel).toBe(0);
  });

  it("auto-selects the joined faction offering NFG with the highest reputation", () => {
    const ns = nfgNS({
      factions: ["Low", "High"],
      factionAugs: { Low: ["NeuroFlux Governor"], High: ["NeuroFlux Governor"] },
      factionRep: { Low: 100, High: 500 },
    });
    const info = getNeuroFluxInfo(ns);
    expect(info.bestFaction).toBe("High");
    expect(info.bestFactionRep).toBe(500);
  });

  it("honors a forced faction that is joined and offers NFG", () => {
    const ns = nfgNS({
      factions: ["Low", "High"],
      factionAugs: { Low: ["NeuroFlux Governor"], High: ["NeuroFlux Governor"] },
      factionRep: { Low: 100, High: 500 },
    });
    const info = getNeuroFluxInfo(ns, "Low");
    expect(info.bestFaction).toBe("Low");
    expect(info.bestFactionRep).toBe(100);
  });

  it("falls back to auto-selection when the forced faction isn't joined", () => {
    const ns = nfgNS({
      factions: ["High"],
      factionAugs: { High: ["NeuroFlux Governor"] },
      factionRep: { High: 500 },
    });
    const info = getNeuroFluxInfo(ns, "NotJoined");
    expect(info.bestFaction).toBe("High");
  });

  it("reports no faction when the forced faction is joined but doesn't offer NFG", () => {
    const ns = nfgNS({
      factions: ["Joined"],
      factionAugs: { Joined: ["Some Other Aug"] },
    });
    const info = getNeuroFluxInfo(ns, "Joined");
    expect(info.bestFaction).toBeNull();
  });
});

describe("calculateNeuroFluxPurchasePlan", () => {
  it("is rep-limited when the first level can't be afforded in reputation", () => {
    const ns = mockNS({
      extra: {
        getPlayer: () => player({ factions: ["F"] as never }),
        getResetInfo: () => ({ ownedAugs: new Map() }),
        singularity: {
          getAugmentationsFromFaction: () => ["NeuroFlux Governor"],
          getFactionRep: () => 10,
          getAugmentationPrice: () => 1000,
          getAugmentationRepReq: () => 100,
        },
      },
    });
    const plan = calculateNeuroFluxPurchasePlan(ns, 1_000_000);
    expect(plan.purchases).toBe(0);
    expect(plan.repLimited).toBe(true);
    expect(plan.nextRepGap).toBe(90);
  });

  it("buys as many levels as money and rep allow, compounding price and rep req", () => {
    const ns = mockNS({
      extra: {
        getPlayer: () => player({ factions: ["F"] as never }),
        getResetInfo: () => ({ ownedAugs: new Map() }),
        singularity: {
          getAugmentationsFromFaction: () => ["NeuroFlux Governor"],
          getFactionRep: () => 1_000_000,
          getAugmentationPrice: () => 100,
          getAugmentationRepReq: () => 10,
        },
      },
    });
    const plan = calculateNeuroFluxPurchasePlan(ns, 100 + Math.round(100 * AUG_COST_MULT));
    expect(plan.purchases).toBe(2);
    expect(plan.perPurchase[0].cost).toBe(100);
    expect(plan.perPurchase[1].cost).toBe(Math.round(100 * AUG_COST_MULT));
  });
});

describe("canDonateToFaction", () => {
  it("requires at least DONATION_FAVOR_THRESHOLD favor", () => {
    const below = mockNS({ extra: { singularity: { getFactionFavor: () => DONATION_FAVOR_THRESHOLD - 1 }, gang: { inGang: () => false } } });
    const atThreshold = mockNS({ extra: { singularity: { getFactionFavor: () => DONATION_FAVOR_THRESHOLD }, gang: { inGang: () => false } } });
    expect(canDonateToFaction(below, "SomeFaction")).toBe(false);
    expect(canDonateToFaction(atThreshold, "SomeFaction")).toBe(true);
  });

  it("refuses factions that never support donations", () => {
    expect(NON_DONATABLE_FACTIONS.has("Bladeburners")).toBe(true);
    const ns = mockNS({ extra: { singularity: { getFactionFavor: () => 9999 }, gang: { inGang: () => false } } });
    expect(canDonateToFaction(ns, "Bladeburners")).toBe(false);
  });

  it("refuses the player's own gang faction", () => {
    const ns = mockNS({
      extra: {
        singularity: { getFactionFavor: () => 9999 },
        gang: { inGang: () => true, getGangInformation: () => ({ faction: "MyGang" }) },
      },
    });
    expect(canDonateToFaction(ns, "MyGang")).toBe(false);
  });
});

describe("calculateNFGDonatePurchasePlan", () => {
  it("returns canExecute=false with no faction when nothing qualifies", () => {
    const ns = mockNS({
      extra: {
        getPlayer: () => player({ factions: [] as never }),
        singularity: {},
        gang: { inGang: () => false },
      },
    });
    const plan = calculateNFGDonatePurchasePlan(ns, 1_000_000);
    expect(plan.canExecute).toBe(false);
    expect(plan.faction).toBe("None");
  });

  it("plans donations to cover the rep gap and buys as long as money allows", () => {
    const ns = mockNS({
      extra: {
        getPlayer: () => player({ factions: ["Rich"] as never, mults: { faction_rep: 1 } as never }),
        fileExists: () => false,
        singularity: {
          getAugmentationsFromFaction: () => ["NeuroFlux Governor"],
          getFactionFavor: () => DONATION_FAVOR_THRESHOLD,
          getFactionRep: () => 0,
          getAugmentationPrice: () => 1_000_000,
          getAugmentationRepReq: () => 100,
        },
        gang: { inGang: () => false },
      },
    });
    // donation for 100 rep (fallback formula: rep * 1e6 / faction_rep_mult) = 100e6
    const plan = calculateNFGDonatePurchasePlan(ns, 100e6 + 1_000_000 + 1);
    expect(plan.faction).toBe("Rich");
    expect(plan.purchases).toBe(1);
    expect(plan.steps[0].donationNeeded).toBe(100e6);
    expect(plan.steps[0].purchaseCost).toBe(1_000_000);
    expect(plan.canExecute).toBe(true);
  });

  it("respects NFG_REP_MULT matching the game's NeuroFluxGovernorLevelMult constant", () => {
    expect(NFG_REP_MULT).toBe(1.14);
  });
});
