/**
 * Corporation Daemon (RAM-Tiered)
 *
 * Directive-driven automation: Bootstrap → Scale → Harvest.
 * Full supply chain: Agriculture + Chemicals + Tobacco.
 * Uses dynamic tier selection based on available RAM.
 *
 *   Tier 0 (monitor):  ~120 GB  - Status publishing, directive evaluation
 *   Tier 1 (manage):   ~450 GB  - Auto: employees, sell orders, tea, products, upgrades, materials
 *   Tier 2 (invest):   ~600 GB  - Auto: create corp, expand divisions, investments, go public
 *
 * Usage:
 *   run daemons/corp.js
 */
import { NS, CityName, CorpIndustryName, CorpMaterialName, CorpResearchName, CorpUpgradeName, CorpUnlockName } from "@ns";
import { COLORS } from "/lib/utils";
import { publishStatus } from "/lib/ports";
import { writeDefaultConfig, getConfigNumber, getConfigBool, getConfigString } from "/lib/config";
import {
  STATUS_PORTS,
  CORP_CONTROL_PORT,
  CorpStatus,
  CorpDivisionStatus,
  CorpProductStatus,
  CorpControlMessage,
  CorpPendingAction,
  CorpDirective,
} from "/types/ports";
import { getBudgetBalance, notifyPurchase, signalDone } from "/lib/budget";
import {
  shouldAdvanceDirective,
  calculateOptimalMaterials,
  calculateEmployeeDistribution,
  shouldStartNewProduct,
  evaluateInvestmentOffer,
  calculateProductInvestment,
  scoreUpgrade,
  scoreAdVert,
  getNextResearch,
  generateStatusLine,
  generateNextStep,
  shouldFreezeSpending,
  formatMoney,
  CITIES,
  CREATION_CITY,
  DIVISION_NAMES,
  DIVISION_TYPES,
  DIVISION_COSTS,
  DIVISION_OUTPUTS,
  EXPORT_FORMULA,
  EXPORT_ROUTES,
  EMPLOYEE_JOBS,
  UPGRADES,
  UNLOCK_PRIORITY,
  CORP_CREATION_COST,
} from "/controllers/corp";
import type {
  CorpStateSnapshot,
  DivisionSnapshot,
  WarehouseSnapshot,
  ProductSnapshot,
  EmployeeContext,
} from "/controllers/corp";

const C = COLORS;

/** Cast string to CorpIndustryName for NS API calls. */
const asIndustry = (s: string) => s as CorpIndustryName;

// === TIER DEFINITIONS ===

const BASE_SCRIPT_COST = 1.6;
const RAM_BUFFER_PERCENT = 0.05;

interface TierConfig {
  tier: number;
  name: string;
  functions: string[];
  features: string[];
}

/** Tier 0: read-only monitoring. */
const TIER_0_FUNCTIONS = [
  "getServerMaxRam",
  "getServerUsedRam",
  "getPlayer",
  "corporation.getCorporation",
  "corporation.getDivision",
  "corporation.getOffice",
  "corporation.getWarehouse",
  "corporation.getMaterial",
  "corporation.getProduct",
  "corporation.getInvestmentOffer",
  "corporation.getUpgradeLevel",
  "corporation.getUpgradeLevelCost",
  "corporation.getHireAdVertCost",
  "corporation.hasUnlock",
  "corporation.getConstants",
  "corporation.nextUpdate",
  "corporation.hasCorporation",
  "corporation.getResearchCost",
  "corporation.hasResearched",
  "corporation.getOfficeSizeUpgradeCost",
];

/** Tier 1: management mutations. */
const TIER_1_FUNCTIONS = [
  "corporation.hireEmployee",
  "corporation.setJobAssignment",
  "corporation.sellMaterial",
  "corporation.sellProduct",
  "corporation.setSmartSupply",
  "corporation.buyTea",
  "corporation.throwParty",
  "corporation.levelUpgrade",
  "corporation.hireAdVert",
  "corporation.research",
  "corporation.bulkPurchase",
  "corporation.upgradeWarehouse",
  "corporation.setMaterialMarketTA2",
  "corporation.setProductMarketTA2",
  "corporation.issueDividends",
  "corporation.makeProduct",
  "corporation.discontinueProduct",
  "corporation.buyMaterial",
  "corporation.exportMaterial",
  "corporation.cancelExportMaterial",
];

/** Tier 2: creation and expansion. */
const TIER_2_FUNCTIONS = [
  "corporation.createCorporation",
  "corporation.expandIndustry",
  "corporation.expandCity",
  "corporation.purchaseWarehouse",
  "corporation.purchaseUnlock",
  "corporation.acceptInvestmentOffer",
  "corporation.goPublic",
  "corporation.getUnlockCost",
  "corporation.buyBackShares",
  "corporation.sellShares",
  "corporation.issueNewShares",
];

const TIERS: TierConfig[] = [
  { tier: 0, name: "monitor", functions: TIER_0_FUNCTIONS, features: ["status-publishing", "directive-evaluation", "pending-actions"] },
  { tier: 1, name: "manage", functions: [...TIER_0_FUNCTIONS, ...TIER_1_FUNCTIONS], features: ["employees", "sell-orders", "tea-party", "products", "upgrades", "materials", "research", "advert", "dividends", "exports"] },
  { tier: 2, name: "invest", functions: [...TIER_0_FUNCTIONS, ...TIER_1_FUNCTIONS, ...TIER_2_FUNCTIONS], features: ["corp-creation", "division-expansion", "investment-acceptance", "go-public", "unlocks", "share-management"] },
];

// === CONFIG DEFAULTS ===

const CONFIG_DEFAULTS: Record<string, string> = {
  interval: "10000",
  tier: "2",
  directive: "bootstrap",
  pinDirective: "false",
  countdownSeconds: "60",
  dividendRate: "0.1",
  productInvestPct: "0.1",
  corpName: "NovaCorp",
  autoTea: "true",
  enabled: "true",
};

// === RAM CALCULATION ===

function calculateTierRam(ns: NS): { tier: number; name: string; ramNeeded: number }[] {
  return TIERS.map(t => {
    let ram = BASE_SCRIPT_COST;
    for (const fn of t.functions) {
      try { ram += ns.getFunctionRamCost(fn); } catch { /* skip unknown */ }
    }
    ram *= (1 + RAM_BUFFER_PERCENT);
    return { tier: t.tier, name: t.name, ramNeeded: Math.ceil(ram * 10) / 10 };
  });
}

function selectBestTier(ns: NS, maxTier: number): { tier: number; name: string; totalRam: number } {
  const tierRams = calculateTierRam(ns);
  const available = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + 5; // +5 for ramOverride placeholder

  let best = { tier: -1, name: "disabled", totalRam: 0 };
  for (const t of tierRams) {
    if (t.tier > maxTier) continue;
    if (t.ramNeeded <= available) {
      best = { tier: t.tier, name: t.name, totalRam: t.ramNeeded };
    }
  }
  return best;
}

// === ENTRY POINT ===

export async function main(ns: NS): Promise<void> {
  ns.ramOverride(5);

  const maxTier = getConfigNumber(ns, "corp", "tier", 2);
  const tierInfo = selectBestTier(ns, maxTier);

  if (tierInfo.tier < 0) {
    ns.tprint("WARN: Not enough RAM for corp daemon. Need ~120 GB for tier 0.");
    return;
  }

  ns.ramOverride(Math.ceil(tierInfo.totalRam) + 2);
  await daemon(ns, tierInfo.tier, tierInfo.name);
}

// === DAEMON STATE ===

let productCounter = 0;
let pendingAction: CorpPendingAction | null = null;
let tickCount = 0;
let doneSent = false;

// === MAIN DAEMON LOOP ===

async function daemon(ns: NS, maxTier: number, tierName: string): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "corp", CONFIG_DEFAULTS);

  const enabled = getConfigBool(ns, "corp", "enabled", true);
  if (!enabled) {
    publishStatus(ns, STATUS_PORTS.corp, buildDisabledStatus(tierName));
    ns.print(`${C.yellow}Corp daemon disabled by config${C.reset}`);
    return;
  }

  // Initialize product counter from existing products
  productCounter = initProductCounter(ns, maxTier);

  while (true) {
    // Read config every tick (hot-reload)
    const interval = getConfigNumber(ns, "corp", "interval", 10000);
    const directive = getConfigString(ns, "corp", "directive", "bootstrap") as CorpDirective;
    const pinned = getConfigBool(ns, "corp", "pinDirective", false);
    const autoTea = getConfigBool(ns, "corp", "autoTea", true);
    const dividendRate = getConfigNumber(ns, "corp", "dividendRate", 0.1);
    const countdownSec = getConfigNumber(ns, "corp", "countdownSeconds", 60);

    // Process control messages
    processControlMessages(ns, maxTier);

    // Build snapshot
    const snapshot = buildSnapshot(ns);

    // Evaluate directive auto-advance
    let activeDirective = directive;
    const advance = shouldAdvanceDirective(activeDirective, snapshot, pinned);
    if (advance) {
      activeDirective = advance;
      ns.print(`${C.green}Directive auto-advanced to: ${advance}${C.reset}`);
      // Persist the new directive
      try {
        const { setConfigValue } = await import("/lib/config");
        setConfigValue(ns, "corp", "directive", advance);
      } catch { /* ignore */ }
    }

    // Process pending action countdown
    processPendingAction(ns, maxTier, snapshot);

    // Execute automation based on tier and directive
    if (maxTier >= 2) {
      autoCreateCorp(ns, snapshot);
      autoBuyUnlocks(ns, snapshot);
      autoExpandDivisions(ns, snapshot);
      autoSetupExports(ns, snapshot);
      autoAcceptInvestment(ns, snapshot, countdownSec);
      autoGoPublic(ns, snapshot, countdownSec);
    }

    if (maxTier >= 1) {
      autoSellOrders(ns, snapshot);
      autoSmartSupply(ns, snapshot);
      autoEmployees(ns, snapshot);
      if (autoTea) autoTeaParty(ns, snapshot);
      autoProducts(ns, snapshot);
      autoResearch(ns, snapshot);

      const frozen = shouldFreezeSpending(snapshot);
      if (!frozen) {
        autoUpgrades(ns, snapshot);
        autoAdVert(ns, snapshot);
        autoMaterials(ns, snapshot);
      }

      autoDividends(ns, snapshot, activeDirective, dividendRate);

      // Signal budget done after Round 1 accepted
      if (!doneSent && snapshot.hasCorp && snapshot.investmentRound >= 2) {
        signalDone(ns, "corp");
        doneSent = true;
        ns.print(`${C.green}Budget: signaled corp done${C.reset}`);
      }
    }

    // Build and publish status
    const status = buildStatus(ns, snapshot, activeDirective, pinned, maxTier, tierName, autoTea);
    publishStatus(ns, STATUS_PORTS.corp, status);

    // Log
    const profit = snapshot.revenue - snapshot.expenses;
    ns.print(`${C.cyan}=== Corp ===${C.reset} [${activeDirective}] T${maxTier} | ${formatMoney(profit)}/s | tick ${tickCount}`);

    tickCount++;

    // Sleep: try nextUpdate, fallback to interval
    try {
      await ns.corporation.nextUpdate();
    } catch {
      await ns.sleep(interval);
    }
  }
}

// === CONTROL MESSAGES ===

function processControlMessages(ns: NS, maxTier: number): void {
  const port = ns.getPortHandle(CORP_CONTROL_PORT);
  while (!port.empty()) {
    const raw = port.read();
    if (raw === "NULL PORT DATA") break;
    try {
      const msg = JSON.parse(raw as string) as CorpControlMessage;
      switch (msg.action) {
        case "set-directive":
          if (msg.directive) {
            ns.print(`${C.green}Directive set to: ${msg.directive}${C.reset}`);
          }
          break;
        case "cancel-pending":
          if (pendingAction) {
            ns.print(`${C.yellow}Cancelled pending: ${pendingAction.description}${C.reset}`);
            pendingAction = null;
          }
          break;
        case "set-dividend-rate":
          if (maxTier >= 1 && msg.dividendRate !== undefined) {
            try { ns.corporation.issueDividends(msg.dividendRate); } catch { /* ignore */ }
            ns.print(`${C.green}Dividend rate → ${(msg.dividendRate * 100).toFixed(1)}%${C.reset}`);
          }
          break;
        case "toggle-auto-tea":
          ns.print(`${C.green}Auto-tea: ${msg.autoTea ? "ON" : "OFF"}${C.reset}`);
          break;
        case "pin-directive":
          ns.print(`${C.green}Directive ${msg.pinned ? "pinned" : "unpinned"}${C.reset}`);
          break;
        case "restart":
          ns.print(`${C.yellow}Restart requested${C.reset}`);
          break;
      }
    } catch { /* skip invalid */ }
  }
}

// === PENDING ACTION SYSTEM ===

function processPendingAction(ns: NS, maxTier: number, snapshot: CorpStateSnapshot): void {
  if (!pendingAction) return;

  const now = Date.now();
  if (now >= pendingAction.expiresAt) {
    // Execute the pending action
    executePendingAction(ns, maxTier, snapshot, pendingAction);
    pendingAction = null;
  }
}

function executePendingAction(ns: NS, maxTier: number, snapshot: CorpStateSnapshot, action: CorpPendingAction): void {
  if (maxTier < 2) return;

  try {
    switch (action.type) {
      case "accept-investment":
        ns.corporation.acceptInvestmentOffer();
        ns.print(`${C.green}Accepted investment R${action.details["round"]}${C.reset}`);
        break;
      case "go-public":
        ns.corporation.goPublic(0);
        ns.print(`${C.green}Corporation is now public${C.reset}`);
        break;
      case "share-buyback":
        // Buy back shares at current price
        try { ns.corporation.buyBackShares(action.details["shares"] as number); } catch { /* ignore */ }
        ns.print(`${C.green}Bought back shares${C.reset}`);
        break;
    }
  } catch (e) {
    ns.print(`${C.red}Failed to execute pending action: ${e}${C.reset}`);
  }
}

function queuePendingAction(
  type: CorpPendingAction["type"],
  description: string,
  details: Record<string, string | number>,
  countdownSec: number,
): void {
  if (pendingAction) return;  // Don't queue if one is already pending
  const now = Date.now();
  pendingAction = {
    id: `${type}-${now}`,
    type,
    description,
    details,
    expiresAt: now + countdownSec * 1000,
    createdAt: now,
  };
}

// === SNAPSHOT BUILDING ===

function buildSnapshot(ns: NS): CorpStateSnapshot {
  const hasCorp = ns.corporation.hasCorporation();
  if (!hasCorp) {
    return {
      hasCorp: false,
      corpName: "",
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
      playerMoney: ns.getPlayer().money,
      wilsonLevel: 0,
    };
  }

  const corp = ns.corporation.getCorporation();
  const divisions: DivisionSnapshot[] = [];

  for (const divName of corp.divisions) {
    const div = ns.corporation.getDivision(divName);
    const warehouses: WarehouseSnapshot[] = [];
    const products: ProductSnapshot[] = [];

    for (const city of (div.cities as CityName[])) {
      try {
        const wh = ns.corporation.getWarehouse(divName, city);
        const materials: { name: string; stored: number; produced: number; sold: number }[] = [];
        for (const mat of ["Water", "Food", "Plants", "Chemicals", "Hardware", "Robots", "AI Cores", "Real Estate"]) {
          try {
            const m = ns.corporation.getMaterial(divName, city, mat as CorpMaterialName);
            materials.push({ name: mat, stored: m.stored, produced: m.productionAmount, sold: m.actualSellAmount });
          } catch { /* ignore */ }
        }
        const office = ns.corporation.getOffice(divName, city);
        warehouses.push({
          city,
          size: wh.size,
          used: wh.sizeUsed,
          materials,
          employees: office.numEmployees,
        });
      } catch { /* no warehouse yet */ }
    }

    // Get products
    for (const prodName of div.products) {
      try {
        const p = ns.corporation.getProduct(divName, CREATION_CITY, prodName);
        products.push({
          name: p.name,
          progress: p.developmentProgress,
          rating: p.rating,
          effectiveRating: p.effectiveRating,
          demand: p.demand ?? 0,
          competition: p.competition ?? 0,
          stored: p.stored,
          produced: p.productionAmount,
          sold: p.actualSellAmount,
          developmentCity: CREATION_CITY,
        });
      } catch { /* ignore */ }
    }

    divisions.push({
      name: div.name,
      type: div.industry,
      cities: div.cities.slice(),
      revenue: div.lastCycleRevenue,
      expenses: div.lastCycleExpenses,
      awareness: div.awareness,
      popularity: div.popularity,
      research: div.researchPoints,
      products,
      warehouses,
      maxProducts: div.maxProducts,
      hasResearch: (rName: string) => {
        try { return ns.corporation.hasResearched(divName, rName as CorpResearchName); } catch { return false; }
      },
    });
  }

  // Build upgrade levels and costs
  const upgradeLevels: Record<string, number> = {};
  const upgradeCosts: Record<string, number> = {};
  for (const u of UPGRADES) {
    try {
      upgradeLevels[u.name] = ns.corporation.getUpgradeLevel(u.name as CorpUpgradeName);
      upgradeCosts[u.name] = ns.corporation.getUpgradeLevelCost(u.name as CorpUpgradeName);
    } catch { /* ignore */ }
  }

  // Build unlocks
  const unlocks: Record<string, boolean> = {};
  for (const u of UNLOCK_PRIORITY) {
    try { unlocks[u.name] = ns.corporation.hasUnlock(u.name as CorpUnlockName); } catch { unlocks[u.name] = false; }
  }

  // Investment info
  let investmentRound = 0;
  let currentOffer = 0;
  try {
    const offer = ns.corporation.getInvestmentOffer();
    investmentRound = offer.round;
    currentOffer = offer.funds;
  } catch { /* ignore */ }

  return {
    hasCorp: true,
    corpName: corp.name,
    funds: corp.funds,
    revenue: corp.revenue,
    expenses: corp.expenses,
    isPublic: corp.public,
    investmentRound,
    currentOffer,
    sharePrice: corp.sharePrice,
    dividendRate: corp.dividendRate,
    dividendIncome: corp.dividendEarnings,
    ownedShares: corp.numShares,
    issuedShares: corp.issuedShares,
    divisions,
    upgradeLevels,
    upgradeCosts,
    unlocks,
    playerMoney: ns.getPlayer().money,
    wilsonLevel: upgradeLevels["Wilson Analytics"] ?? 0,
  };
}

function initProductCounter(ns: NS, maxTier: number): number {
  if (maxTier < 0) return 0;
  try {
    if (!ns.corporation.hasCorporation()) return 0;
    const corp = ns.corporation.getCorporation();
    let maxNum = 0;
    for (const divName of corp.divisions) {
      const div = ns.corporation.getDivision(divName);
      for (const pName of div.products) {
        const match = pName.match(/Product-(\d+)/);
        if (match) {
          maxNum = Math.max(maxNum, parseInt(match[1], 10));
        }
      }
    }
    return maxNum;
  } catch { return 0; }
}

// === TIER 2: CREATION & EXPANSION ===

function autoCreateCorp(ns: NS, snapshot: CorpStateSnapshot): void {
  if (snapshot.hasCorp) return;

  const budgetBalance = getBudgetBalance(ns, "corp");
  if (budgetBalance < CORP_CREATION_COST || snapshot.playerMoney < CORP_CREATION_COST) return;

  const corpName = getConfigString(ns, "corp", "corpName", "NovaCorp");
  try {
    ns.corporation.createCorporation(corpName, true);
    notifyPurchase(ns, "corp", CORP_CREATION_COST, "Corporation creation");
    ns.print(`${C.green}Created corporation: ${corpName}${C.reset}`);
  } catch (e) {
    ns.print(`${C.red}Failed to create corp: ${e}${C.reset}`);
  }
}

function autoBuyUnlocks(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;

  for (const u of UNLOCK_PRIORITY) {
    if (snapshot.unlocks[u.name]) continue;
    if (snapshot.funds < u.cost) break;  // Can't afford this one, stop trying

    // Smart Supply is absolute priority — buy immediately
    // Other unlocks: only buy if we have 2x the cost (don't drain funds)
    const threshold = u.name === "Smart Supply" ? u.cost : u.cost * 2;
    if (snapshot.funds < threshold) break;

    try {
      ns.corporation.purchaseUnlock(u.name as CorpUnlockName);
      ns.print(`${C.green}Bought unlock: ${u.name}${C.reset}`);
      snapshot.unlocks[u.name] = true;
      snapshot.funds -= u.cost;
    } catch (e) {
      ns.print(`${C.red}Failed to buy ${u.name}: ${e}${C.reset}`);
      break;
    }
  }
}

function autoExpandDivisions(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;

  // Division creation/expansion order
  const divPlan: { type: string; name: string }[] = [
    { type: DIVISION_TYPES.agriculture, name: DIVISION_NAMES.agriculture },
    { type: DIVISION_TYPES.chemical,    name: DIVISION_NAMES.chemical },
    { type: DIVISION_TYPES.tobacco,     name: DIVISION_NAMES.tobacco },
  ];

  for (const { type, name } of divPlan) {
    const existing = snapshot.divisions.find(d => d.type === type);

    if (!existing) {
      // Create the division
      const cost = DIVISION_COSTS[type as keyof typeof DIVISION_COSTS] ?? 0;
      if (snapshot.funds < cost) continue;
      try {
        ns.corporation.expandIndustry(asIndustry(type), name);
        ns.print(`${C.green}Created division: ${name} (${type})${C.reset}`);
        return;  // One action per tick
      } catch (e) {
        ns.print(`${C.red}Failed to create ${name}: ${e}${C.reset}`);
        continue;
      }
    }

    // Expand to missing cities (one per tick)
    const missingCities = CITIES.filter(c => !existing.cities.includes(c));
    if (missingCities.length > 0) {
      const city = missingCities[0];
      try {
        ns.corporation.expandCity(existing.name, city as CityName);
        ns.print(`${C.green}Expanded ${existing.name} to ${city}${C.reset}`);
      } catch { /* ignore */ }

      // Buy warehouse in the new city
      try {
        ns.corporation.purchaseWarehouse(existing.name, city as CityName);
        ns.print(`${C.green}Purchased warehouse for ${existing.name} in ${city}${C.reset}`);
      } catch { /* ignore */ }

      return;  // One expansion per tick
    }
  }
}

function autoSetupExports(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp || !snapshot.unlocks["Export"]) return;

  for (const [fromType, toType, material] of EXPORT_ROUTES) {
    const fromDiv = snapshot.divisions.find(d => d.type === fromType);
    const toDiv = snapshot.divisions.find(d => d.type === toType);
    if (!fromDiv || !toDiv) continue;

    // Set exports for all cities both divisions share
    for (const city of (fromDiv.cities as CityName[])) {
      if (!toDiv.cities.includes(city)) continue;
      try {
        ns.corporation.exportMaterial(fromDiv.name, city, toDiv.name, city, material as CorpMaterialName, EXPORT_FORMULA);
      } catch { /* already set or error — ignore */ }
    }
  }
}

function autoAcceptInvestment(ns: NS, snapshot: CorpStateSnapshot, countdownSec: number): void {
  if (!snapshot.hasCorp || snapshot.isPublic) return;
  if (snapshot.investmentRound >= 4) return;  // No more investment rounds

  const eval_ = evaluateInvestmentOffer(snapshot.investmentRound, snapshot.currentOffer);
  if (!eval_.acceptable) return;

  // Queue as pending action with countdown
  if (!pendingAction) {
    queuePendingAction(
      "accept-investment",
      `Accepting Round ${snapshot.investmentRound} investment (${formatMoney(snapshot.currentOffer)})`,
      { round: snapshot.investmentRound, offer: snapshot.currentOffer },
      countdownSec,
    );
    ns.print(`${C.yellow}Queued: accept R${snapshot.investmentRound} in ${countdownSec}s${C.reset}`);
  }
}

function autoGoPublic(ns: NS, snapshot: CorpStateSnapshot, countdownSec: number): void {
  if (!snapshot.hasCorp || snapshot.isPublic) return;
  if (snapshot.investmentRound < 4) return;  // Need round 3 accepted first

  if (!pendingAction) {
    queuePendingAction(
      "go-public",
      "Taking corporation public (0 new shares)",
      {},
      countdownSec,
    );
    ns.print(`${C.yellow}Queued: go public in ${countdownSec}s${C.reset}`);
  }
}

// === TIER 1: MANAGEMENT ===

function autoSellOrders(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;

  for (const div of snapshot.divisions) {
    const outputs = DIVISION_OUTPUTS[div.type] ?? [];
    for (const city of (div.cities as CityName[])) {
      for (const mat of outputs) {
        try { ns.corporation.sellMaterial(div.name, city, mat as CorpMaterialName, "MAX", "MP"); } catch { /* ignore */ }
      }
    }

    // Also sell products
    for (const prod of div.products) {
      if (prod.progress < 100) continue;
      for (const city of (div.cities as CityName[])) {
        try { ns.corporation.sellProduct(div.name, city, prod.name, "MAX", "MP", true); } catch { /* ignore */ }

        // Enable Market-TA.II if available
        if (div.hasResearch("Market-TA.II")) {
          try { ns.corporation.setProductMarketTA2(div.name, prod.name, true); } catch { /* ignore */ }
        }
      }
    }

    // Enable Market-TA.II on materials if available
    if (div.hasResearch("Market-TA.II")) {
      for (const city of (div.cities as CityName[])) {
        for (const mat of outputs) {
          try { ns.corporation.setMaterialMarketTA2(div.name, city, mat as CorpMaterialName, true); } catch { /* ignore */ }
        }
      }
    }
  }
}

function autoSmartSupply(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp || !snapshot.unlocks["Smart Supply"]) return;

  for (const div of snapshot.divisions) {
    for (const city of (div.cities as CityName[])) {
      try { ns.corporation.setSmartSupply(div.name, city, true); } catch { /* ignore */ }
    }
  }
}

function autoEmployees(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;

  for (const div of snapshot.divisions) {
    const hasProducts = div.products.length > 0;
    const isResearchPhase = div.research < 50000;

    for (const city of (div.cities as CityName[])) {
      const office = getOffice(ns, div.name, city);
      if (!office) continue;

      // Hire to fill office
      while (office.numEmployees < office.size) {
        try {
          ns.corporation.hireEmployee(div.name, city);
          office.numEmployees++;
        } catch { break; }
      }

      if (office.numEmployees === 0) continue;

      // Distribute employees
      const context: EmployeeContext = {
        hasProducts,
        isResearchPhase,
        isCreationCity: city === CREATION_CITY,
      };
      const dist = calculateEmployeeDistribution(office.numEmployees, context);

      for (const job of EMPLOYEE_JOBS) {
        try {
          ns.corporation.setJobAssignment(div.name, city, job, dist[job] ?? 0);
        } catch { /* ignore */ }
      }
      // Clear Intern/Unassigned
      try { ns.corporation.setJobAssignment(div.name, city, "Intern", 0); } catch { /* ignore */ }
    }
  }
}

function autoTeaParty(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;
  if (tickCount % 10 !== 0) return;  // Every 10 ticks

  for (const div of snapshot.divisions) {
    // Skip if division has AutoBrew AND AutoPartyManager researched
    const hasAutoBrew = div.hasResearch("AutoBrew");
    const hasAutoParty = div.hasResearch("AutoPartyManager");
    if (hasAutoBrew && hasAutoParty) continue;

    for (const city of (div.cities as CityName[])) {
      if (!hasAutoBrew) {
        try { ns.corporation.buyTea(div.name, city); } catch { /* ignore */ }
      }
      if (!hasAutoParty) {
        try { ns.corporation.throwParty(div.name, city, 500000); } catch { /* ignore */ }
      }
    }
  }
}

function autoProducts(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;

  // Only Tobacco produces products
  const tobacco = snapshot.divisions.find(d => d.type === "Tobacco");
  if (!tobacco || tobacco.cities.length === 0) return;

  const result = shouldStartNewProduct(tobacco.products, tobacco.maxProducts);

  if (result.shouldStart) {
    // Retire old product if needed
    if (result.retireName) {
      try {
        ns.corporation.discontinueProduct(tobacco.name, result.retireName);
        ns.print(`${C.yellow}Retired product: ${result.retireName}${C.reset}`);
      } catch { /* ignore */ }
    }

    // Start new product
    productCounter++;
    const name = `Product-${productCounter}`;
    const investPct = getConfigNumber(ns, "corp", "productInvestPct", 0.1);
    const investment = calculateProductInvestment(snapshot.funds, investPct);

    try {
      ns.corporation.makeProduct(tobacco.name, CREATION_CITY, name, investment, investment);
      ns.print(`${C.green}Started product: ${name} (${formatMoney(investment)} x2)${C.reset}`);
    } catch (e) {
      ns.print(`${C.red}Failed to start product ${name}: ${e}${C.reset}`);
      productCounter--;  // Revert counter on failure
    }
  }
}

function autoResearch(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;

  for (const div of snapshot.divisions) {
    const next = getNextResearch(div.research, div.hasResearch);
    if (next) {
      try {
        ns.corporation.research(div.name, next.name as CorpResearchName);
        ns.print(`${C.green}Researched ${next.name} in ${div.name}${C.reset}`);
      } catch { /* not enough points or prereqs */ }
    }
  }
}

function autoUpgrades(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;
  if (!snapshot.unlocks["Smart Supply"]) return;  // Don't spend until Smart Supply owned

  const profit = snapshot.revenue - snapshot.expenses;
  if (profit <= 0) return;

  // Score all available upgrades
  const candidates: { name: string; cost: number; score: number }[] = [];
  for (const u of UPGRADES) {
    const level = snapshot.upgradeLevels[u.name] ?? 0;
    const cost = snapshot.upgradeCosts[u.name] ?? Infinity;
    if (cost > snapshot.funds * 0.2) continue;  // Max 20% of funds per upgrade

    const score = scoreUpgrade(u.name, level, cost, profit, snapshot.wilsonLevel);
    if (score > 0) candidates.push({ name: u.name, cost, score });
  }

  // Buy the highest-scored upgrade
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 0) {
    const best = candidates[0];
    try {
      ns.corporation.levelUpgrade(best.name as CorpUpgradeName);
      ns.print(`${C.green}Upgraded: ${best.name} (score: ${best.score.toFixed(1)})${C.reset}`);
    } catch { /* ignore */ }
  }
}

function autoAdVert(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;
  if (!snapshot.unlocks["Smart Supply"]) return;

  const profit = snapshot.revenue - snapshot.expenses;
  if (profit <= 0) return;

  // Only buy AdVert for Tobacco (the product division)
  const tobacco = snapshot.divisions.find(d => d.type === "Tobacco");
  if (!tobacco) return;

  try {
    const cost = ns.corporation.getHireAdVertCost(tobacco.name);
    if (cost > snapshot.funds * 0.1) return;  // Max 10% of funds

    const score = scoreAdVert(cost, profit, snapshot.wilsonLevel);
    if (score > 1) {
      ns.corporation.hireAdVert(tobacco.name);
      ns.print(`${C.green}Hired AdVert for ${tobacco.name} (score: ${score.toFixed(1)})${C.reset}`);
    }
  } catch { /* ignore */ }
}

function autoMaterials(ns: NS, snapshot: CorpStateSnapshot): void {
  if (!snapshot.hasCorp) return;
  if (!snapshot.unlocks["Smart Supply"]) return;

  for (const div of snapshot.divisions) {
    const targets = calculateOptimalMaterials(div.type, 0);  // We'll use per-city warehouse size
    if (Object.keys(targets).length === 0) continue;

    for (const wh of div.warehouses) {
      const cityTargets = calculateOptimalMaterials(div.type, wh.size);

      for (const [material, targetAmt] of Object.entries(cityTargets)) {
        // Find current stored amount
        const stored = wh.materials.find(m => m.name === material);
        const currentAmt = stored?.stored ?? 0;
        const needed = targetAmt - currentAmt;

        if (needed > 10) {
          // Buy in bulk — purchase amount per second, runs for 10s per cycle
          const buyPerSec = Math.ceil(needed / 10);
          try {
            ns.corporation.buyMaterial(div.name, wh.city as CityName, material as CorpMaterialName, buyPerSec);
          } catch { /* ignore */ }
        } else {
          // Stop buying if we've reached target
          try {
            ns.corporation.buyMaterial(div.name, wh.city as CityName, material as CorpMaterialName, 0);
          } catch { /* ignore */ }
        }
      }
    }
  }
}

function autoDividends(ns: NS, snapshot: CorpStateSnapshot, directive: CorpDirective, configRate: number): void {
  if (!snapshot.hasCorp || !snapshot.isPublic) return;

  // No dividends during bootstrap/scale — preserve funds for growth
  const targetRate = directive === "harvest" ? configRate : 0;

  if (Math.abs(snapshot.dividendRate - targetRate) > 0.001) {
    try {
      ns.corporation.issueDividends(targetRate);
      ns.print(`${C.green}Set dividend rate: ${(targetRate * 100).toFixed(1)}%${C.reset}`);
    } catch { /* ignore */ }
  }
}

// === HELPERS ===

function getOffice(ns: NS, divName: string, cityStr: string): { numEmployees: number; size: number } | null {
  try {
    const o = ns.corporation.getOffice(divName, cityStr as CityName);
    return { numEmployees: o.numEmployees, size: o.size };
  } catch { return null; }
}

// === STATUS BUILDING ===

function buildDisabledStatus(tierName: string): CorpStatus {
  return {
    tier: 0,
    tierName: tierName as CorpStatus["tierName"],
    availableFeatures: [],
    unavailableFeatures: [],
    exists: false,
    corpName: "",
    directive: "bootstrap",
    directivePinned: false,
    funds: 0, fundsFormatted: "$0",
    revenue: 0, revenueFormatted: "$0",
    expenses: 0, expensesFormatted: "$0",
    profit: 0, profitFormatted: "$0",
    statusLine: "Disabled",
    nextStep: "Enable corp in settings",
    pendingAction: null,
    investmentRound: 0,
    currentOffer: 0, currentOfferFormatted: "$0",
    isPublic: false,
    sharePrice: 0, sharePriceFormatted: "$0",
    dividendRate: 0,
    ownedShares: 0,
    issuedShares: 0,
    dividendIncome: 0, dividendIncomeFormatted: "$0",
    divisions: [],
    products: [],
    upgrades: [],
    unlocks: [],
    autoTea: false,
    budgetBalance: 0, budgetBalanceFormatted: "$0",
  };
}

function buildStatus(
  ns: NS,
  snapshot: CorpStateSnapshot,
  directive: CorpDirective,
  pinned: boolean,
  maxTier: number,
  tierName: string,
  autoTea: boolean,
): CorpStatus {
  const tierConfig = TIERS[maxTier] ?? TIERS[0];
  const allFeatures = TIERS.flatMap(t => t.features);
  const available = tierConfig.features;
  const unavailable = allFeatures.filter(f => !available.includes(f));

  const profit = snapshot.revenue - snapshot.expenses;
  const budgetBalance = getBudgetBalance(ns, "corp");

  // Build division statuses
  const divisions: CorpDivisionStatus[] = snapshot.divisions.map(div => ({
    name: div.name,
    type: div.type,
    cities: div.cities,
    revenue: div.revenue,
    revenueFormatted: ns.format.number(div.revenue),
    expenses: div.expenses,
    expensesFormatted: ns.format.number(div.expenses),
    profit: div.revenue - div.expenses,
    profitFormatted: ns.format.number(div.revenue - div.expenses),
    awareness: div.awareness,
    popularity: div.popularity,
    research: div.research,
    researchFormatted: ns.format.number(div.research),
    materialMultiplier: 0,  // TODO: calculate from warehouse materials
    products: div.products.map(p => ({
      name: p.name,
      progress: p.progress,
      rating: p.rating,
      effectiveRating: p.effectiveRating,
      demand: p.demand,
      competition: p.competition,
      stored: p.stored,
      produced: p.produced,
      sold: p.sold,
      developmentCity: p.developmentCity,
    })),
    warehouses: div.warehouses.map(wh => ({
      city: wh.city,
      size: wh.size,
      used: wh.used,
      usedPercent: wh.size > 0 ? Math.round((wh.used / wh.size) * 100) : 0,
      employees: wh.employees,
    })),
  }));

  // Flatten all products from all divisions
  const products: CorpProductStatus[] = snapshot.divisions.flatMap(div =>
    div.products.map(p => ({
      name: p.name,
      progress: p.progress,
      rating: p.rating,
      effectiveRating: p.effectiveRating,
      demand: p.demand,
      competition: p.competition,
      stored: p.stored,
      produced: p.produced,
      sold: p.sold,
      developmentCity: p.developmentCity,
    })),
  );

  // Build upgrade list
  const upgrades = UPGRADES.map(u => ({
    name: u.name,
    level: snapshot.upgradeLevels[u.name] ?? 0,
    cost: snapshot.upgradeCosts[u.name] ?? 0,
    costFormatted: ns.format.number(snapshot.upgradeCosts[u.name] ?? 0),
  }));

  // Build unlock list
  const unlocks = UNLOCK_PRIORITY.map(u => ({
    name: u.name,
    owned: snapshot.unlocks[u.name] ?? false,
    cost: u.cost,
    costFormatted: ns.format.number(u.cost),
  }));

  // Pending action with live countdown
  let pendingActionStatus: CorpPendingAction | null = null;
  if (pendingAction) {
    pendingActionStatus = { ...pendingAction };
  }

  return {
    tier: maxTier,
    tierName: tierName as CorpStatus["tierName"],
    availableFeatures: available,
    unavailableFeatures: unavailable,
    exists: snapshot.hasCorp,
    corpName: snapshot.corpName,
    directive,
    directivePinned: pinned,
    funds: snapshot.funds,
    fundsFormatted: ns.format.number(snapshot.funds),
    revenue: snapshot.revenue,
    revenueFormatted: ns.format.number(snapshot.revenue),
    expenses: snapshot.expenses,
    expensesFormatted: ns.format.number(snapshot.expenses),
    profit,
    profitFormatted: ns.format.number(profit),
    statusLine: generateStatusLine(directive, snapshot),
    nextStep: generateNextStep(directive, snapshot),
    pendingAction: pendingActionStatus,
    investmentRound: snapshot.investmentRound,
    currentOffer: snapshot.currentOffer,
    currentOfferFormatted: ns.format.number(snapshot.currentOffer),
    isPublic: snapshot.isPublic,
    sharePrice: snapshot.sharePrice,
    sharePriceFormatted: ns.format.number(snapshot.sharePrice),
    dividendRate: snapshot.dividendRate,
    ownedShares: snapshot.ownedShares,
    issuedShares: snapshot.issuedShares,
    dividendIncome: snapshot.dividendIncome,
    dividendIncomeFormatted: ns.format.number(snapshot.dividendIncome),
    divisions,
    products,
    upgrades,
    unlocks,
    autoTea,
    budgetBalance,
    budgetBalanceFormatted: ns.format.number(budgetBalance),
  };
}
