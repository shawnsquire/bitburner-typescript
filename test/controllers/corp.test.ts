import { describe, it, expect } from "vitest";
import {
  evaluateDirective,
  shouldAdvanceDirective,
  calculateOptimalMaterials,
  scoreUpgrade,
  scoreAdVert,
  calculateEmployeeDistribution,
  shouldStartNewProduct,
  calculateProductInvestment,
  getNextResearch,
  evaluateInvestmentOffer,
  shouldFreezeSpending,
  selectOfficeUpgrade,
  officeSizeUpgradeCost,
  formatMoney,
  OFFICE_UPGRADE_STEP,
  DEFAULT_OFFICE_MAX_SIZE,
  DEFAULT_OFFICE_UPGRADE_RESERVE_MULT,
  INDUSTRY_FACTORS,
  EXPORT_ROUTES,
  UNLOCK_PRIORITY,
  DIVISION_COSTS,
  type CorpStateSnapshot,
  type DivisionSnapshot,
  type ProductSnapshot,
  type EmployeeContext,
  type OfficeSnapshot,
  type OfficeUpgradePolicy,
} from "/controllers/corp";

function division(overrides: Partial<DivisionSnapshot> = {}): DivisionSnapshot {
  return {
    name: "AgriCo",
    type: "Agriculture",
    cities: ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"],
    revenue: 0,
    expenses: 0,
    awareness: 0,
    popularity: 0,
    research: 0,
    products: [],
    warehouses: [],
    offices: [],
    maxProducts: 3,
    hasResearch: () => false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CorpStateSnapshot> = {}): CorpStateSnapshot {
  return {
    hasCorp: true,
    corpName: "NovaCorp",
    funds: 0,
    revenue: 0,
    expenses: 0,
    isPublic: false,
    investmentRound: 0,
    currentOffer: 0,
    sharePrice: 0,
    dividendRate: 0,
    dividendIncome: 0,
    ownedShares: 0,
    issuedShares: 0,
    divisions: [],
    upgradeLevels: {},
    upgradeCosts: {},
    unlocks: {},
    playerMoney: 0,
    wilsonLevel: 0,
    ...overrides,
  };
}

describe("evaluateDirective", () => {
  it("stays in bootstrap with no corporation", () => {
    expect(evaluateDirective(snapshot({ hasCorp: false }))).toBe("bootstrap");
  });

  it("stays in bootstrap until all three divisions have 6 cities", () => {
    const s = snapshot({
      divisions: [
        division({ type: "Agriculture", cities: ["Sector-12"] }),
        division({ type: "Chemical" }),
        division({ type: "Tobacco" }),
      ],
      unlocks: { "Smart Supply": true },
      investmentRound: 2,
    });
    expect(evaluateDirective(s)).toBe("bootstrap");
  });

  it("stays in bootstrap without Smart Supply even if divisions are fully expanded", () => {
    const full6 = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];
    const s = snapshot({
      divisions: [
        division({ type: "Agriculture", cities: full6 }),
        division({ type: "Chemical", cities: full6 }),
        division({ type: "Tobacco", cities: full6 }),
      ],
      unlocks: {},
      investmentRound: 2,
    });
    expect(evaluateDirective(s)).toBe("bootstrap");
  });

  it("advances to scale once divisions, Smart Supply, and Round 1 are done", () => {
    const full6 = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];
    const s = snapshot({
      divisions: [
        division({ type: "Agriculture", cities: full6 }),
        division({ type: "Chemical", cities: full6 }),
        division({ type: "Tobacco", cities: full6 }),
      ],
      unlocks: { "Smart Supply": true },
      investmentRound: 2,
    });
    expect(evaluateDirective(s)).toBe("scale");
  });

  it("advances to harvest only when public, profitable, and Wilson is mature", () => {
    const full6 = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];
    const base = snapshot({
      divisions: [
        division({ type: "Agriculture", cities: full6 }),
        division({ type: "Chemical", cities: full6 }),
        division({ type: "Tobacco", cities: full6 }),
      ],
      unlocks: { "Smart Supply": true },
      investmentRound: 2,
      isPublic: true,
    });
    expect(evaluateDirective({ ...base, revenue: 1, expenses: 0, wilsonLevel: 5 })).toBe("scale");
    expect(evaluateDirective({ ...base, revenue: 2e12, expenses: 0, wilsonLevel: 10 })).toBe("harvest");
  });
});

describe("shouldAdvanceDirective", () => {
  it("never advances when pinned", () => {
    const s = snapshot({ isPublic: true, revenue: 2e12, wilsonLevel: 10, divisions: [], unlocks: { "Smart Supply": true }, investmentRound: 2 });
    expect(shouldAdvanceDirective("bootstrap", s, true)).toBeNull();
  });

  it("never moves backward even if the evaluated target regresses", () => {
    // harvest -> would evaluate to scale/bootstrap under some snapshot, but must not go back
    const s = snapshot({ hasCorp: false });
    expect(shouldAdvanceDirective("harvest", s, false)).toBeNull();
  });

  it("advances forward one directive at a time when the target moved ahead", () => {
    const full6 = ["Sector-12", "Aevum", "Volharan", "Chongqing", "New Tokyo", "Ishima"];
    const s = snapshot({
      divisions: [
        division({ type: "Agriculture", cities: full6 }),
        division({ type: "Chemical", cities: full6 }),
        division({ type: "Tobacco", cities: full6 }),
      ],
      unlocks: { "Smart Supply": true },
      investmentRound: 2,
    });
    expect(shouldAdvanceDirective("bootstrap", s, false)).toBe("scale");
  });

  it("returns null when already at the target directive", () => {
    const s = snapshot({ hasCorp: false });
    expect(shouldAdvanceDirective("bootstrap", s, false)).toBeNull();
  });
});

describe("calculateOptimalMaterials", () => {
  it("returns nothing for an unknown industry", () => {
    expect(calculateOptimalMaterials("Nonsense", 1000)).toEqual({});
  });

  it("returns nothing when the warehouse has no space", () => {
    expect(calculateOptimalMaterials("Agriculture", 0)).toEqual({});
  });

  it("allocates space proportional to factor/size efficiency, reserving a percentage", () => {
    const targets = calculateOptimalMaterials("Agriculture", 1000, 0.2);
    // Every material with a positive allocation should have been floored to a whole unit
    for (const amt of Object.values(targets)) {
      expect(Number.isInteger(amt)).toBe(true);
      expect(amt).toBeGreaterThan(0);
    }
    // Total space used must not exceed the non-reserved portion
    let totalUsed = 0;
    for (const [name, amt] of Object.entries(targets)) {
      const size = name === "Hardware" ? 0.06 : name === "Robots" ? 0.5 : name === "AI Cores" ? 0.1 : 0.005;
      totalUsed += amt * size;
    }
    expect(totalUsed).toBeLessThanOrEqual(1000 * 0.8 + 1e-9);
  });
});

describe("INDUSTRY_FACTORS (game data)", () => {
  it("matches the game's per-industry boost-material factors", () => {
    // Verified against ~/documents/apps/games/bitburner src/Corporation/data/IndustryData.ts (v3.0.1)
    expect(INDUSTRY_FACTORS["Agriculture"]).toEqual({ Hardware: 0.20, Robots: 0.30, "AI Cores": 0.30, "Real Estate": 0.72 });
    expect(INDUSTRY_FACTORS["Chemical"]).toEqual({ Hardware: 0.20, Robots: 0.25, "AI Cores": 0.20, "Real Estate": 0.25 });
    expect(INDUSTRY_FACTORS["Tobacco"]).toEqual({ Hardware: 0.15, Robots: 0.20, "AI Cores": 0.15, "Real Estate": 0.15 });
  });
});

describe("DIVISION_COSTS (game data)", () => {
  it("matches each industry's startingCost", () => {
    expect(DIVISION_COSTS.Agriculture).toBe(40e9);
    expect(DIVISION_COSTS.Chemical).toBe(70e9);
    expect(DIVISION_COSTS.Tobacco).toBe(20e9);
  });
});

describe("EXPORT_ROUTES", () => {
  it("only routes materials the destination industry actually requires", () => {
    // Tobacco's requiredMaterials is { Plants: 1 } only (no Chemicals) —
    // a Chemical -> Tobacco Chemicals route would waste warehouse space
    // and starve Agriculture's Chemicals import.
    const toTobacco = EXPORT_ROUTES.filter(([, to]) => to === "Tobacco");
    expect(toTobacco).toEqual([["Agriculture", "Tobacco", "Plants"]]);
  });

  it("covers every division's required imports", () => {
    expect(EXPORT_ROUTES).toContainEqual(["Agriculture", "Chemical", "Plants"]);
    expect(EXPORT_ROUTES).toContainEqual(["Chemical", "Agriculture", "Chemicals"]);
  });
});

describe("UNLOCK_PRIORITY", () => {
  it("includes all eight corporation-wide unlocks with their game costs", () => {
    // Verified against CorpUnlockName / CorpUnlocks in the game checkout.
    const byName = Object.fromEntries(UNLOCK_PRIORITY.map(u => [u.name, u.cost]));
    expect(byName).toEqual({
      "Smart Supply": 25e9,
      "Market Research - Demand": 5e9,
      "Market Data - Competition": 5e9,
      "Export": 20e9,
      "Warehouse API": 50e9,
      "Office API": 50e9,
      "Shady Accounting": 500e12,
      "Government Partnership": 2e15,
    });
  });
});

describe("scoreUpgrade", () => {
  it("returns 0 when cost or profit is non-positive", () => {
    expect(scoreUpgrade("Smart Factories", 0, 0, 100, 0)).toBe(0);
    expect(scoreUpgrade("Smart Factories", 0, 100, 0, 0)).toBe(0);
  });

  it("scores Wilson Analytics higher at lower levels (diminishing returns)", () => {
    const low = scoreUpgrade("Wilson Analytics", 0, 4e9, 1e6, 0);
    const high = scoreUpgrade("Wilson Analytics", 20, 4e9, 1e6, 0);
    expect(low).toBeGreaterThan(high);
  });

  it("gives a cheaper upgrade a higher score at equal profit", () => {
    const cheap = scoreUpgrade("ABC SalesBots", 0, 1e9, 1e6, 0);
    const expensive = scoreUpgrade("ABC SalesBots", 0, 10e9, 1e6, 0);
    expect(cheap).toBeGreaterThan(expensive);
  });
});

describe("scoreAdVert", () => {
  it("returns 0 when cost or profit is non-positive", () => {
    expect(scoreAdVert(0, 100, 0)).toBe(0);
    expect(scoreAdVert(100, 0, 0)).toBe(0);
  });

  it("scales up with Wilson level", () => {
    const low = scoreAdVert(1e9, 1e6, 0);
    const high = scoreAdVert(1e9, 1e6, 20);
    expect(high).toBeGreaterThan(low);
  });
});

describe("calculateEmployeeDistribution", () => {
  it("returns all zeros for zero employees", () => {
    const ctx: EmployeeContext = { hasProducts: false, isResearchPhase: false, isCreationCity: false };
    expect(calculateEmployeeDistribution(0, ctx)).toEqual({
      Operations: 0, Engineer: 0, Business: 0, Management: 0, "Research & Development": 0,
    });
  });

  it("always sums to the requested count", () => {
    const ctx: EmployeeContext = { hasProducts: true, isResearchPhase: false, isCreationCity: true };
    for (let n = 0; n <= DEFAULT_OFFICE_MAX_SIZE; n++) {
      const dist = calculateEmployeeDistribution(n, ctx);
      const total = Object.values(dist).reduce((a, b) => a + b, 0);
      expect(total).toBe(n);
    }
  });

  it("heavily weights R&D for non-creation-city research phase offices", () => {
    const ctx: EmployeeContext = { hasProducts: false, isResearchPhase: true, isCreationCity: false };
    const dist = calculateEmployeeDistribution(20, ctx);
    expect(dist["Research & Development"]).toBeGreaterThan(dist.Operations);
    expect(dist["Research & Development"]).toBeGreaterThan(dist.Management);
  });
});

describe("officeSizeUpgradeCost (game data)", () => {
  it("matches calculateOfficeSizeUpgradeCost for the first step of a new office", () => {
    // (4e9 / 0.09) * 1.09^(3/3) * (1.09^(3/3) - 1) = 4.36e9
    expect(officeSizeUpgradeCost(3, 3)).toBeCloseTo(4.36e9, -6);
  });

  it("grows with current size and is zero for a non-positive increase", () => {
    expect(officeSizeUpgradeCost(6, 3)).toBeGreaterThan(officeSizeUpgradeCost(3, 3));
    expect(officeSizeUpgradeCost(27, 3)).toBeGreaterThan(officeSizeUpgradeCost(24, 3));
    expect(officeSizeUpgradeCost(3, 0)).toBe(0);
  });
});

describe("selectOfficeUpgrade", () => {
  const policy: OfficeUpgradePolicy = {
    reserveMult: DEFAULT_OFFICE_UPGRADE_RESERVE_MULT,
    maxSize: DEFAULT_OFFICE_MAX_SIZE,
    step: OFFICE_UPGRADE_STEP,
  };
  const office = (city: string, size: number): OfficeSnapshot => ({ city, size, employees: size });

  it("returns null when there are no offices", () => {
    expect(selectOfficeUpgrade(snapshot({ funds: 1e15 }), policy)).toBeNull();
  });

  it("picks the office with the lowest headcount across divisions", () => {
    const s = snapshot({
      funds: 1e15,
      divisions: [
        division({ name: "AgriCo", offices: [office("Sector-12", 9), office("Aevum", 6)] }),
        division({ name: "ChemCo", type: "Chemical", offices: [office("Sector-12", 3), office("Aevum", 12)] }),
      ],
    });
    const plan = selectOfficeUpgrade(s, policy);
    expect(plan).toMatchObject({ division: "ChemCo", city: "Sector-12", currentSize: 3, increase: 3 });
    expect(plan?.cost).toBeCloseTo(officeSizeUpgradeCost(3, 3), -3);
  });

  it("breaks ties by division order then city order", () => {
    const s = snapshot({
      funds: 1e15,
      divisions: [
        division({ name: "AgriCo", offices: [office("Sector-12", 6), office("Aevum", 3), office("Volhaven", 3)] }),
        division({ name: "ChemCo", type: "Chemical", offices: [office("Sector-12", 3)] }),
      ],
    });
    expect(selectOfficeUpgrade(s, policy)).toMatchObject({ division: "AgriCo", city: "Aevum" });
  });

  it("requires funds of at least reserveMult times the cost", () => {
    const cost = officeSizeUpgradeCost(3, 3);
    const divs = [division({ offices: [office("Sector-12", 3)] })];
    expect(selectOfficeUpgrade(snapshot({ funds: cost * 10 - 1, divisions: divs }), policy)).toBeNull();
    expect(selectOfficeUpgrade(snapshot({ funds: cost * 10, divisions: divs }), policy)).not.toBeNull();
  });

  it("skips offices already at maxSize and returns null when all are", () => {
    const s = snapshot({
      funds: 1e18,
      divisions: [division({ offices: [office("Sector-12", 30), office("Aevum", 27)] })],
    });
    expect(selectOfficeUpgrade(s, policy)).toMatchObject({ city: "Aevum", currentSize: 27, increase: 3 });
    const full = snapshot({ funds: 1e18, divisions: [division({ offices: [office("Sector-12", 30)] })] });
    expect(selectOfficeUpgrade(full, policy)).toBeNull();
  });

  it("clips the last step so an office never exceeds maxSize", () => {
    const s = snapshot({ funds: 1e18, divisions: [division({ offices: [office("Sector-12", 30)] })] });
    const plan = selectOfficeUpgrade(s, { ...policy, maxSize: 32 });
    expect(plan).toMatchObject({ currentSize: 30, increase: 2 });
    expect(plan?.cost).toBeCloseTo(officeSizeUpgradeCost(30, 2), -3);
  });

  it("honours a lower maxSize from config", () => {
    const s = snapshot({ funds: 1e18, divisions: [division({ offices: [office("Sector-12", 9)] })] });
    expect(selectOfficeUpgrade(s, { ...policy, maxSize: 9 })).toBeNull();
  });

  it("always chooses the cheapest candidate because cost rises with size", () => {
    const s = snapshot({
      funds: 1e18,
      divisions: [division({ offices: [office("Sector-12", 12), office("Aevum", 18), office("Volhaven", 6)] })],
    });
    const plan = selectOfficeUpgrade(s, policy)!;
    for (const o of s.divisions[0].offices) {
      expect(plan.cost).toBeLessThanOrEqual(officeSizeUpgradeCost(o.size, OFFICE_UPGRADE_STEP));
    }
  });
});

describe("shouldStartNewProduct", () => {
  function product(overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
    return {
      name: "P1", progress: 100, rating: 10, effectiveRating: 10, demand: 0, competition: 0,
      stored: 0, produced: 0, sold: 0, developmentCity: "Sector-12",
      ...overrides,
    };
  }

  it("does not start a new product while one is still in development", () => {
    const result = shouldStartNewProduct([product({ progress: 50 })], 3);
    expect(result).toEqual({ shouldStart: false, retireName: null });
  });

  it("starts a new product when under the cap", () => {
    expect(shouldStartNewProduct([], 3)).toEqual({ shouldStart: true, retireName: null });
  });

  it("retires the worst-rated completed product when at cap", () => {
    const products = [product({ name: "Best", rating: 100 }), product({ name: "Worst", rating: 1 })];
    expect(shouldStartNewProduct(products, 2)).toEqual({ shouldStart: true, retireName: "Worst" });
  });
});

describe("calculateProductInvestment", () => {
  it("floors to a percentage of funds with a $1M minimum", () => {
    expect(calculateProductInvestment(100e9, 0.1)).toBe(10e9);
    expect(calculateProductInvestment(1000, 0.1)).toBe(1e6);
  });
});

describe("getNextResearch", () => {
  it("returns the first un-researched item once it has 2x its cost saved up", () => {
    const has = () => false;
    expect(getNextResearch(9999, has)).toBeNull(); // Lab costs 5000, needs 10000 saved
    expect(getNextResearch(10001, has)?.name).toBe("Hi-Tech R&D Laboratory");
  });

  it("returns null when the next item cannot yet be afforded", () => {
    const has = (name: string) => name === "Hi-Tech R&D Laboratory";
    expect(getNextResearch(1000, has)).toBeNull();
  });

  it("skips items that are already researched", () => {
    const has = (name: string) => name === "Hi-Tech R&D Laboratory";
    expect(getNextResearch(999999, has)?.name).toBe("Market-TA.I");
  });
});

describe("evaluateInvestmentOffer", () => {
  it("accepts once the offer meets the round's threshold", () => {
    expect(evaluateInvestmentOffer(1, 200e9).acceptable).toBe(true);
    expect(evaluateInvestmentOffer(1, 199e9).acceptable).toBe(false);
  });

  it("is never acceptable for an unlisted round (threshold defaults to Infinity)", () => {
    expect(evaluateInvestmentOffer(99, 1e18).acceptable).toBe(false);
  });
});

describe("shouldFreezeSpending", () => {
  it("never freezes once public", () => {
    expect(shouldFreezeSpending(snapshot({ isPublic: true, investmentRound: 1, currentOffer: 1e12 }))).toBe(false);
  });

  it("freezes when within 60% of the round's threshold", () => {
    expect(shouldFreezeSpending(snapshot({ investmentRound: 1, currentOffer: 200e9 * 0.6 }))).toBe(true);
    expect(shouldFreezeSpending(snapshot({ investmentRound: 1, currentOffer: 200e9 * 0.5 }))).toBe(false);
  });
});

describe("formatMoney", () => {
  it("scales to the appropriate suffix", () => {
    expect(formatMoney(500)).toBe("$500");
    expect(formatMoney(1500)).toBe("$1.5k");
    expect(formatMoney(2.5e6)).toBe("$2.5m");
    expect(formatMoney(3.4e9)).toBe("$3.4b");
    expect(formatMoney(5.6e12)).toBe("$5.6t");
    expect(formatMoney(7.8e15)).toBe("$7.8q");
  });
});
