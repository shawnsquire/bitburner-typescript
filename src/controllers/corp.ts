/**
 * Corporation Controller (Pure Logic)
 *
 * Directive evaluation, ROI-based upgrade scoring, material optimization,
 * employee distribution, investment analysis, and product management.
 *
 * Zero NS imports — safe to import without RAM cost.
 *
 * Import with: import { evaluateDirective, ... } from "/controllers/corp";
 */

import { CorpDirective } from "/types/ports";

// === CONSTANTS ===

export const CITIES = [
  "Sector-12", "Aevum", "Volhaven",
  "Chongqing", "New Tokyo", "Ishima",
] as const;

export type CityName = typeof CITIES[number];

export const CREATION_CITY = "Sector-12";

/** Division names used throughout the corp system. */
export const DIVISION_NAMES = {
  agriculture: "AgriCo",
  chemical: "ChemCo",
  tobacco: "TobaccoCo",
} as const;

/** Division industry types (Bitburner API names). */
export const DIVISION_TYPES = {
  agriculture: "Agriculture",
  chemical: "Chemical",
  tobacco: "Tobacco",
} as const;

/** Division creation costs. */
export const DIVISION_COSTS = {
  Agriculture: 40e9,
  Chemical: 70e9,
  Tobacco: 20e9,
} as const;

/** Employee job names. */
export const EMPLOYEE_JOBS = [
  "Operations", "Engineer", "Business", "Management", "Research & Development",
] as const;

// === INDUSTRY DATA ===

/** Production material factors per industry — determines production multiplier. */
export const INDUSTRY_FACTORS: Record<string, Record<string, number>> = {
  Agriculture: { Hardware: 0.20, Robots: 0.30, "AI Cores": 0.30, "Real Estate": 0.72 },
  Chemical:    { Hardware: 0.20, Robots: 0.25, "AI Cores": 0.20, "Real Estate": 0.25 },
  Tobacco:     { Hardware: 0.15, Robots: 0.20, "AI Cores": 0.15, "Real Estate": 0.15 },
};

/** Storage cost per unit of production material. */
export const MATERIAL_SIZES: Record<string, number> = {
  Hardware: 0.06,
  Robots: 0.5,
  "AI Cores": 0.1,
  "Real Estate": 0.005,
};

/** Materials that divisions produce as output (set sell orders on these). */
export const DIVISION_OUTPUTS: Record<string, string[]> = {
  Agriculture: ["Plants", "Food"],
  Chemical: ["Chemicals"],
  Tobacco: [],  // Products are the output, not materials
};

/** Export formula string — proven community formula. */
export const EXPORT_FORMULA = "(IPROD+IINV/10)*(-1)";

/**
 * Export routes: [fromDivType, toDivType, material]
 * These define the full supply chain. Only routes for materials the
 * destination industry actually requires belong here — verified against
 * IndustryData.ts requiredMaterials: Agriculture needs Water+Chemicals,
 * Chemical needs Plants+Water, Tobacco needs Plants only (no Chemicals).
 */
export const EXPORT_ROUTES: [string, string, string][] = [
  ["Agriculture", "Tobacco", "Plants"],
  ["Agriculture", "Chemical", "Plants"],
  ["Chemical", "Agriculture", "Chemicals"],
];

// === INVESTMENT THRESHOLDS ===

export const INVESTMENT_THRESHOLDS: Record<number, number> = {
  1: 200e9,     // Accept round 1 at $200B+
  2: 5e12,      // Accept round 2 at $5T+
  3: 800e12,    // Accept round 3 at $800T+
};

export const CORP_CREATION_COST = 150e9;

// === OFFICE SIZE DATA ===

/** Seats added per office upgrade (the game's own increment). */
export const OFFICE_UPGRADE_STEP = 3;

/** Default cap on office size; config key `officeMaxSize`. */
export const DEFAULT_OFFICE_MAX_SIZE = 30;

/** Default funds-to-cost ratio required before upgrading; config key `officeUpgradeReserveMult`. */
export const DEFAULT_OFFICE_UPGRADE_RESERVE_MULT = 10;

/** Game constant `corpConstants.officeInitialCost` (Constants.ts). */
const OFFICE_INITIAL_COST = 4e9;

/**
 * Cost to add `increase` seats to an office of `currentSize`.
 * Replicates `calculateOfficeSizeUpgradeCost` in the game's Corporation/helpers.ts.
 */
export function officeSizeUpgradeCost(currentSize: number, increase: number): number {
  if (increase <= 0) return 0;
  const baseCostDivisor = 0.09;
  const baseCostMultiplier = 1 + baseCostDivisor;
  const currentSizeFactor = baseCostMultiplier ** (currentSize / 3);
  const sizeIncreaseFactor = baseCostMultiplier ** (increase / 3) - 1;
  return (OFFICE_INITIAL_COST / baseCostDivisor) * currentSizeFactor * sizeIncreaseFactor;
}

// === UPGRADE DATA ===

export interface UpgradeInfo {
  name: string;
  baseCost: number;
  priceMult: number;
  effectDesc: string;
}

export const UPGRADES: UpgradeInfo[] = [
  { name: "Smart Factories",                     baseCost: 2e9,  priceMult: 1.06, effectDesc: "+3% production" },
  { name: "Smart Storage",                       baseCost: 2e9,  priceMult: 1.06, effectDesc: "+10% warehouse" },
  { name: "Wilson Analytics",                     baseCost: 4e9,  priceMult: 2.0,  effectDesc: "+0.5% ad effectiveness" },
  { name: "Nuoptimal Nootropic Injector Implants", baseCost: 1e9, priceMult: 1.06, effectDesc: "+10% creativity" },
  { name: "Speech Processor Implants",            baseCost: 1e9,  priceMult: 1.06, effectDesc: "+10% charisma" },
  { name: "Neural Accelerators",                  baseCost: 1e9,  priceMult: 1.06, effectDesc: "+10% intelligence" },
  { name: "FocusWires",                           baseCost: 1e9,  priceMult: 1.06, effectDesc: "+10% efficiency" },
  { name: "ABC SalesBots",                        baseCost: 1e9,  priceMult: 1.07, effectDesc: "+1% sales" },
  { name: "Project Insight",                      baseCost: 5e9,  priceMult: 1.07, effectDesc: "+5% research" },
];

/** One-time unlocks in priority order. */
export const UNLOCK_PRIORITY: { name: string; cost: number }[] = [
  { name: "Smart Supply",              cost: 25e9 },
  { name: "Market Research - Demand",  cost: 5e9 },
  { name: "Market Data - Competition", cost: 5e9 },
  { name: "Export",                    cost: 20e9 },
  { name: "Warehouse API",             cost: 50e9 },
  { name: "Office API",                cost: 50e9 },
  { name: "Shady Accounting",          cost: 500e12 },
  { name: "Government Partnership",    cost: 2e15 },
];

// === RESEARCH DATA ===

export interface ResearchInfo {
  name: string;
  cost: number;
}

/** Research priorities in order (per division). */
export const RESEARCH_PRIORITY: ResearchInfo[] = [
  { name: "Hi-Tech R&D Laboratory",   cost: 5000 },
  { name: "Market-TA.I",              cost: 20000 },
  { name: "Market-TA.II",             cost: 50000 },
  { name: "AutoBrew",                 cost: 12000 },
  { name: "AutoPartyManager",         cost: 15000 },
  { name: "Self-Correcting Assemblers", cost: 25000 },
  { name: "Drones",                   cost: 5000 },
  { name: "Drones - Assembly",        cost: 25000 },
  { name: "uPgrade: Fulcrum",         cost: 10000 },
  { name: "uPgrade: Capacity.I",      cost: 20000 },
  { name: "uPgrade: Capacity.II",     cost: 30000 },
];

// === DIRECTIVE ADVANCEMENT THRESHOLDS ===

/** Wilson Analytics level that signals mature advertising. */
const WILSON_MATURITY_LEVEL = 10;

/** Minimum profit/s to consider corp mature for Harvest. */
const HARVEST_PROFIT_THRESHOLD = 1e12;  // $1T/s

// === STATE SNAPSHOTS (controller inputs) ===

export interface MaterialState {
  name: string;
  stored: number;
  produced: number;
  sold: number;
}

export interface WarehouseSnapshot {
  city: string;
  size: number;
  used: number;
  materials: MaterialState[];
  employees: number;
}

export interface ProductSnapshot {
  name: string;
  progress: number;
  rating: number;
  effectiveRating: number;
  demand: number;
  competition: number;
  stored: number;
  produced: number;
  sold: number;
  developmentCity: string;
}

export interface OfficeSnapshot {
  city: string;
  size: number;
  employees: number;
}

export interface DivisionSnapshot {
  name: string;
  type: string;
  cities: string[];
  revenue: number;
  expenses: number;
  awareness: number;
  popularity: number;
  research: number;
  products: ProductSnapshot[];
  warehouses: WarehouseSnapshot[];
  /** One entry per city the division has an office in. */
  offices: OfficeSnapshot[];
  maxProducts: number;
  hasResearch: (name: string) => boolean;
}

export interface CorpStateSnapshot {
  hasCorp: boolean;
  corpName: string;
  funds: number;
  revenue: number;
  expenses: number;
  isPublic: boolean;
  investmentRound: number;
  currentOffer: number;
  sharePrice: number;
  dividendRate: number;
  dividendIncome: number;
  ownedShares: number;
  issuedShares: number;
  divisions: DivisionSnapshot[];
  upgradeLevels: Record<string, number>;
  upgradeCosts: Record<string, number>;
  unlocks: Record<string, boolean>;
  playerMoney: number;
  wilsonLevel: number;
}

// === OUTPUT TYPES ===

export interface EmployeeAssignment {
  Operations: number;
  Engineer: number;
  Business: number;
  Management: number;
  "Research & Development": number;
}

export interface InvestmentEvaluation {
  acceptable: boolean;
  reason: string;
  round: number;
  offer: number;
  threshold: number;
}

export interface MaterialTargets {
  [material: string]: number;
}

export interface OfficeUpgradePolicy {
  /** Upgrade only when funds >= reserveMult * cost. */
  reserveMult: number;
  /** Never grow an office past this many seats. */
  maxSize: number;
  /** Seats added per upgrade; the last step is clipped to maxSize. */
  step: number;
}

export interface OfficeUpgradePlan {
  division: string;
  city: string;
  currentSize: number;
  increase: number;
  cost: number;
}

// === DIRECTIVE EVALUATION ===

/**
 * Determine what directive the corp SHOULD be in based on current state.
 * Used for initial evaluation and auto-advance.
 */
export function evaluateDirective(snapshot: CorpStateSnapshot): CorpDirective {
  if (!snapshot.hasCorp) return "bootstrap";

  const agri = snapshot.divisions.find(d => d.type === "Agriculture");
  const chem = snapshot.divisions.find(d => d.type === "Chemical");
  const tobacco = snapshot.divisions.find(d => d.type === "Tobacco");

  // Still setting up divisions
  if (!agri || agri.cities.length < 6) return "bootstrap";
  if (!chem || chem.cities.length < 6) return "bootstrap";
  if (!tobacco || tobacco.cities.length < 6) return "bootstrap";

  // Missing critical unlocks
  if (!snapshot.unlocks["Smart Supply"]) return "bootstrap";

  // Not yet accepted Round 1
  if (snapshot.investmentRound < 2) return "bootstrap";

  // Public and mature → harvest
  if (snapshot.isPublic) {
    const profit = snapshot.revenue - snapshot.expenses;
    if (profit >= HARVEST_PROFIT_THRESHOLD && snapshot.wilsonLevel >= WILSON_MATURITY_LEVEL) {
      return "harvest";
    }
    // Public but not yet mature — keep scaling
    return "scale";
  }

  return "scale";
}

/**
 * Check if directive should auto-advance. Returns new directive or null.
 */
export function shouldAdvanceDirective(
  current: CorpDirective,
  snapshot: CorpStateSnapshot,
  pinned: boolean,
): CorpDirective | null {
  if (pinned) return null;

  const target = evaluateDirective(snapshot);
  if (target === current) return null;

  // Only advance forward, never backward
  const order: CorpDirective[] = ["bootstrap", "scale", "harvest"];
  const currentIdx = order.indexOf(current);
  const targetIdx = order.indexOf(target);
  if (targetIdx <= currentIdx) return null;

  return target;
}

// === MATERIAL CALCULATIONS ===

/**
 * Calculate optimal production material targets for a given industry and warehouse.
 *
 * Uses industry factors weighted by storage efficiency to determine the best ratio.
 * The formula: cityMult = prod((0.002*amt + 1)^factor) for each material.
 * To maximize this, we allocate proportional to factor/storageSize (efficiency).
 */
export function calculateOptimalMaterials(
  industry: string,
  warehouseSize: number,
  reservePercent = 0.2,
): MaterialTargets {
  const factors = INDUSTRY_FACTORS[industry];
  if (!factors) return {};

  const availableSpace = warehouseSize * (1 - reservePercent);
  if (availableSpace <= 0) return {};

  // Calculate efficiency: factor / storageSize for each material
  const efficiencies: { name: string; efficiency: number; size: number }[] = [];
  let totalEfficiency = 0;
  for (const [name, factor] of Object.entries(factors)) {
    const size = MATERIAL_SIZES[name] ?? 0.1;
    const eff = factor / size;
    efficiencies.push({ name, efficiency: eff, size });
    totalEfficiency += eff;
  }

  // Allocate space proportional to efficiency
  const targets: MaterialTargets = {};
  for (const { name, efficiency, size } of efficiencies) {
    const spaceAllocation = availableSpace * (efficiency / totalEfficiency);
    const units = Math.floor(spaceAllocation / size);
    if (units > 0) targets[name] = units;
  }

  return targets;
}

// === UPGRADE SCORING ===

/**
 * Score an upgrade by estimated ROI. Higher = better buy.
 *
 * Wilson Analytics gets exponential scoring because it enables the AdVert loop.
 * Employee upgrades get multiplicative scoring.
 * Production upgrades get linear scoring.
 */
export function scoreUpgrade(
  name: string,
  currentLevel: number,
  cost: number,
  corpProfit: number,
  // Reserved for a future ad-synergy scaling factor (see scoreAdVert, which
  // does scale with wilsonLevel) — not yet wired into non-Wilson scoring.
  _wilsonLevel: number,
): number {
  if (cost <= 0 || corpProfit <= 0) return 0;

  // Base score: how many seconds of profit does this cost?
  // Lower = better (cheaper relative to income)
  const paybackTicks = cost / corpProfit;
  if (paybackTicks <= 0) return 0;

  let multiplier = 1;

  if (name === "Wilson Analytics") {
    // Wilson is exponentially valuable because it powers the AdVert loop
    // More valuable at lower levels (diminishing returns but still dominant)
    multiplier = 50 / (1 + currentLevel * 0.3);
  } else if (name === "ABC SalesBots") {
    multiplier = 3;
  } else if (name === "Smart Factories") {
    multiplier = 4;
  } else if (name === "Smart Storage") {
    // Valuable early for warehouse space, less later
    multiplier = 2 / (1 + currentLevel * 0.1);
  } else if (name === "Project Insight") {
    multiplier = 2;
  } else {
    // Employee upgrades (FocusWires, Neural Accelerators, etc.)
    multiplier = 2.5;
  }

  // Score: higher is better
  return (multiplier * 100) / paybackTicks;
}

/**
 * Score an AdVert purchase for a division.
 * Value depends heavily on Wilson Analytics level.
 */
export function scoreAdVert(
  adVertCost: number,
  corpProfit: number,
  wilsonLevel: number,
): number {
  if (adVertCost <= 0 || corpProfit <= 0) return 0;

  const paybackTicks = adVertCost / corpProfit;
  if (paybackTicks <= 0) return 0;

  // AdVert value scales with Wilson level
  const wilsonMult = 1 + wilsonLevel * 0.5;
  return (wilsonMult * 30) / paybackTicks;
}

// === EMPLOYEE DISTRIBUTION ===

export interface EmployeeContext {
  hasProducts: boolean;
  isResearchPhase: boolean;
  isCreationCity: boolean;
}

/**
 * Calculate optimal employee distribution for a given count.
 * Uses floor rounding with remainder assigned to highest-priority role.
 * Guarantees assignments sum === count.
 */
export function calculateEmployeeDistribution(
  count: number,
  context: EmployeeContext,
): EmployeeAssignment {
  if (count === 0) {
    return { Operations: 0, Engineer: 0, Business: 0, Management: 0, "Research & Development": 0 };
  }

  if (count <= 3) {
    // Minimal: 1 each to the most important roles
    const ops = Math.min(1, count);
    const eng = Math.min(1, count - ops);
    const biz = Math.min(1, count - ops - eng);
    return { Operations: ops, Engineer: eng, Business: biz, Management: 0, "Research & Development": 0 };
  }

  // Define ratios as [role, weight] pairs, ordered by priority for remainder assignment
  let ratios: [string, number][];

  if (context.isResearchPhase && !context.isCreationCity) {
    // Non-creation cities in research phase: maximize R&D
    ratios = [
      ["Research & Development", 0.70],
      ["Operations", 0.10],
      ["Engineer", 0.10],
      ["Business", 0.05],
      ["Management", 0.05],
    ];
  } else if (context.hasProducts && context.isCreationCity) {
    // Creation city with products: quality-focused
    ratios = [
      ["Engineer", 0.30],
      ["Operations", 0.25],
      ["Management", 0.15],
      ["Business", 0.15],
      ["Research & Development", 0.15],
    ];
  } else if (context.hasProducts) {
    // Non-creation cities with products: production + some R&D
    ratios = [
      ["Operations", 0.25],
      ["Engineer", 0.25],
      ["Management", 0.15],
      ["Business", 0.15],
      ["Research & Development", 0.20],
    ];
  } else {
    // Material production (Agriculture, Chemicals)
    ratios = [
      ["Operations", 0.30],
      ["Engineer", 0.25],
      ["Business", 0.20],
      ["Management", 0.15],
      ["Research & Development", 0.10],
    ];
  }

  // Floor-assign each role
  const assignment: Record<string, number> = {};
  let assigned = 0;
  for (const [role, weight] of ratios) {
    const n = Math.floor(count * weight);
    assignment[role] = Math.max(n, 1);  // Minimum 1 per role
    assigned += assignment[role];
  }

  // Distribute remainder to highest-priority role
  let remainder = count - assigned;
  for (const [role] of ratios) {
    if (remainder <= 0) break;
    assignment[role] += remainder;
    remainder = 0;
  }

  // If we over-assigned (from min-1 guarantees), take from lowest priority.
  // With 5 roles, the min-1 floor alone can already exceed `count` (e.g.
  // count=4 forces 5 total). Allow roles to drop to 0 — requiring `> 1`
  // here left small counts with no role to take from and spun forever.
  while (assigned > count) {
    let reduced = false;
    for (let i = ratios.length - 1; i >= 0; i--) {
      const role = ratios[i][0];
      if (assignment[role] > 0) {
        assignment[role]--;
        assigned--;
        reduced = true;
        if (assigned <= count) break;
      }
    }
    if (!reduced) break; // safety net: nothing left to take from
  }

  return {
    Operations: assignment["Operations"] ?? 0,
    Engineer: assignment["Engineer"] ?? 0,
    Business: assignment["Business"] ?? 0,
    Management: assignment["Management"] ?? 0,
    "Research & Development": assignment["Research & Development"] ?? 0,
  };
}

// === OFFICE SIZE ===

/**
 * Pick the next office to grow, or null if none qualifies.
 *
 * Candidates are offices below `policy.maxSize`, ordered by current size
 * ascending (ties keep division then city order), so the smallest office
 * always goes first. Because the game's cost formula is monotonic in current
 * size, that office is also the cheapest. The plan is returned only when
 * `funds >= policy.reserveMult * cost`; otherwise nothing is affordable and
 * the result is null. Office upgrades spend corporation funds, never the
 * player budget.
 */
export function selectOfficeUpgrade(
  snapshot: Pick<CorpStateSnapshot, "funds" | "divisions">,
  policy: OfficeUpgradePolicy,
): OfficeUpgradePlan | null {
  const step = Math.max(1, Math.floor(policy.step));
  const maxSize = Math.floor(policy.maxSize);
  const reserveMult = Math.max(0, policy.reserveMult);

  let best: { division: string; city: string; size: number } | null = null;
  for (const div of snapshot.divisions) {
    for (const office of div.offices) {
      if (office.size >= maxSize) continue;
      if (!best || office.size < best.size) {
        best = { division: div.name, city: office.city, size: office.size };
      }
    }
  }
  if (!best) return null;

  const increase = Math.min(step, maxSize - best.size);
  if (increase <= 0) return null;
  const cost = officeSizeUpgradeCost(best.size, increase);
  if (snapshot.funds < reserveMult * cost) return null;

  return { division: best.division, city: best.city, currentSize: best.size, increase, cost };
}

// === PRODUCT MANAGEMENT ===

/**
 * Whether to start a new product, and which to retire if at cap.
 */
export function shouldStartNewProduct(
  products: ProductSnapshot[],
  maxProducts: number,
): { shouldStart: boolean; retireName: string | null } {
  const completed = products.filter(p => p.progress >= 100);
  const inDev = products.filter(p => p.progress < 100);

  // Don't start while one is developing
  if (inDev.length > 0) return { shouldStart: false, retireName: null };

  // Under cap — start new
  if (products.length < maxProducts) return { shouldStart: true, retireName: null };

  // At cap — retire worst rated completed product
  if (completed.length > 0) {
    const worst = completed.reduce((a, b) => a.rating < b.rating ? a : b);
    return { shouldStart: true, retireName: worst.name };
  }

  return { shouldStart: false, retireName: null };
}

/**
 * Calculate product investment amount (split equally between design and marketing).
 */
export function calculateProductInvestment(funds: number, pct: number): number {
  return Math.max(1e6, Math.floor(funds * pct));
}

// === RESEARCH ===

/**
 * Get next research to buy for a division.
 * Only returns research when the division has >= 2x the cost in stored points.
 */
export function getNextResearch(
  divisionResearch: number,
  hasResearch: (name: string) => boolean,
): ResearchInfo | null {
  for (const r of RESEARCH_PRIORITY) {
    if (hasResearch(r.name)) continue;
    if (divisionResearch >= r.cost * 2) {
      return r;
    }
    // Don't skip ahead — research tree has dependencies
    break;
  }
  return null;
}

// === INVESTMENT EVALUATION ===

/**
 * Evaluate whether to accept an investment offer.
 *
 * NOTE: investmentRound from API is the CURRENT available round (1-based).
 *   round=1 → first offer available (not yet accepted any)
 *   round=2 → round 1 accepted, round 2 available
 */
export function evaluateInvestmentOffer(
  round: number,
  offer: number,
): InvestmentEvaluation {
  const threshold = INVESTMENT_THRESHOLDS[round] ?? Infinity;

  const acceptable = offer >= threshold;
  const pct = threshold > 0 ? Math.round((offer / threshold) * 100) : 0;
  const reason = acceptable
    ? `Offer ${formatMoney(offer)} meets threshold (${pct}%)`
    : `Offer ${formatMoney(offer)} at ${pct}% of ${formatMoney(threshold)} threshold`;

  return { acceptable, reason, round, offer, threshold };
}

// === STATUS TEXT GENERATION ===

/**
 * Generate the one-line status for the overview card.
 */
export function generateStatusLine(
  directive: CorpDirective,
  snapshot: CorpStateSnapshot,
): string {
  if (!snapshot.hasCorp) return "Saving to create corporation";

  const agri = snapshot.divisions.find(d => d.type === "Agriculture");
  const chem = snapshot.divisions.find(d => d.type === "Chemical");
  const tobacco = snapshot.divisions.find(d => d.type === "Tobacco");

  switch (directive) {
    case "bootstrap": {
      if (!agri) return "Creating Agriculture division";
      if (agri.cities.length < 6) return `Expanding Agriculture (${agri.cities.length}/6)`;
      if (!snapshot.unlocks["Smart Supply"]) return "Saving for Smart Supply";
      if (!chem) return "Creating Chemical division";
      if (chem.cities.length < 6) return `Expanding Chemical (${chem.cities.length}/6)`;
      if (!tobacco) return "Creating Tobacco division";
      if (tobacco.cities.length < 6) return `Expanding Tobacco (${tobacco.cities.length}/6)`;
      if (snapshot.investmentRound < 2) {
        const eval_ = evaluateInvestmentOffer(snapshot.investmentRound, snapshot.currentOffer);
        return `Waiting for R1 (${Math.round((eval_.offer / eval_.threshold) * 100)}%)`;
      }
      return "Completing bootstrap";
    }
    case "scale": {
      if (!snapshot.isPublic && snapshot.investmentRound <= 3) {
        const eval_ = evaluateInvestmentOffer(snapshot.investmentRound, snapshot.currentOffer);
        return `Scaling \u2022 R${snapshot.investmentRound} at ${Math.round((eval_.offer / eval_.threshold) * 100)}%`;
      }
      if (!snapshot.isPublic && snapshot.investmentRound >= 4) return "Ready to go public";
      return `Scaling \u2022 Wilson Lv${snapshot.wilsonLevel}`;
    }
    case "harvest": {
      const profit = snapshot.revenue - snapshot.expenses;
      return `Harvesting \u2022 ${formatMoney(profit)}/s`;
    }
  }
}

/**
 * Generate the "next step" detail text.
 */
export function generateNextStep(
  directive: CorpDirective,
  snapshot: CorpStateSnapshot,
): string {
  if (!snapshot.hasCorp) {
    return `Need ${formatMoney(CORP_CREATION_COST)} to create corporation`;
  }

  switch (directive) {
    case "bootstrap":
      if (!snapshot.unlocks["Smart Supply"]) {
        return "Priority: Smart Supply unlock ($25B)";
      }
      if (!snapshot.unlocks["Export"]) {
        return "Priority: Export unlock ($20B)";
      }
      return "Expanding divisions and waiting for Round 1";

    case "scale": {
      // Find highest-ROI next purchase
      const profit = snapshot.revenue - snapshot.expenses;
      if (profit > 0) {
        const wilsonCost = snapshot.upgradeCosts["Wilson Analytics"] ?? 0;
        if (wilsonCost > 0 && wilsonCost <= snapshot.funds * 0.5) {
          return `Next: Wilson Lv${snapshot.wilsonLevel + 1} (${formatMoney(wilsonCost)})`;
        }
      }
      return "Optimizing upgrades and products";
    }

    case "harvest":
      return "Maximizing dividend income";
  }
}

// === INVESTMENT FREEZE ===

/**
 * Whether discretionary spending should be frozen during investment windows.
 * Freeze when we're within 60% of the threshold — preserve funds for offer.
 */
export function shouldFreezeSpending(snapshot: CorpStateSnapshot): boolean {
  if (snapshot.isPublic) return false;
  const threshold = INVESTMENT_THRESHOLDS[snapshot.investmentRound];
  if (!threshold) return false;
  return snapshot.currentOffer >= threshold * 0.6;
}

// === HELPERS ===

export function formatMoney(n: number): string {
  if (n >= 1e15) return `$${(n / 1e15).toFixed(1)}q`;
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}t`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}b`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
