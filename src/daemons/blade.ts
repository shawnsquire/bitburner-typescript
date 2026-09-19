/**
 * Bladeburner Daemon (Tiered Architecture)
 *
 * Long-running daemon that automates Bladeburner actions, skill upgrades,
 * and city management. Publishes BladeburnerStatus to the status port.
 *
 * Operates in graduated tiers based on available RAM:
 *
 *   Tier 0 (Monitor):    ~low   - Read-only status display
 *   Tier 1 (Analysis):   ~mid   - Full action/skill enumeration + success chances
 *   Tier 2 (Automation): ~high  - Performs actions, switches cities, upgrades skills
 *
 * Usage:
 *   run daemons/blade.js
 */
import { NS, BladeburnerActionName } from "@ns";
import { COLORS } from "/lib/utils";
import {
  selectAction,
  recommendSkillUpgrade,
  selectBestCity,
  DEFAULT_BLADE_CONFIG,
  BLADEBURNER_CITIES,
  BladeState,
  ActionData,
  SkillData,
  CityData,
  BladeConfig,
} from "/controllers/blade";
import { calcAvailableAfterKills, freeRamForTarget } from "/lib/ram-utils";
import { publishStatus } from "/lib/ports";
import {
  STATUS_PORTS,
  BladeburnerStatus,
  BladeTierName,
  BladeActionInfo,
  BladeSkillInfo,
  BladeCityInfo,
} from "/types/ports";
import { writeDefaultConfig, getConfigString, getConfigNumber, getConfigBool, setConfigValue } from "/lib/config";

// === NS TYPE HELPERS ===
// BladeburnerActionName is exported by @ns, but the city/skill name types
// (CityName, BladeburnerSkillName) are not — derive them positionally instead
// of casting to `any` so calls still get real type checking.
type BladeCityName = Parameters<NS["bladeburner"]["switchCity"]>[0];
type BladeSkillName = Parameters<NS["bladeburner"]["upgradeSkill"]>[0];

// === TIER DEFINITIONS ===

interface BladeTierConfig {
  tier: number;
  name: BladeTierName;
  functions: string[];
  features: string[];
  description: string;
}

const BASE_FUNCTIONS = [
  "getServerMaxRam",
  "getServerUsedRam",
  "ps",
  "getScriptRam",
  "getPlayer",
  "getPortHandle",
  "fileExists",
  // Referenced by lib/ram-utils.ts (freeRamForTarget/calcAvailableAfterKills, called from
  // main() at every tier) and directly by the monitor/analysis self-upgrade path (ns.spawn).
  "kill",
  "spawn",
];

const BLADE_TIERS: BladeTierConfig[] = [
  {
    tier: 0,
    name: "monitor",
    functions: [
      "bladeburner.inBladeburner",
      "bladeburner.getRank",
      "bladeburner.getStamina",
      "bladeburner.getSkillPoints",
      "bladeburner.getCurrentAction",
      "bladeburner.getCity",
      "bladeburner.getCityChaos",
      "bladeburner.getCityEstimatedPopulation",
      "bladeburner.getBonusTime",
      "bladeburner.getNextBlackOp",
    ],
    features: ["status-display"],
    description: "Read-only status display",
  },
  {
    tier: 1,
    name: "analysis",
    functions: [
      "bladeburner.getContractNames",
      "bladeburner.getOperationNames",
      "bladeburner.getBlackOpNames",
      "bladeburner.getGeneralActionNames",
      "bladeburner.getActionEstimatedSuccessChance",
      "bladeburner.getActionCountRemaining",
      "bladeburner.getActionTime",
      "bladeburner.getActionRepGain",
      "bladeburner.getSkillNames",
      "bladeburner.getSkillLevel",
      "bladeburner.getSkillUpgradeCost",
      "bladeburner.getCityCommunities",
    ],
    features: ["success-chances", "action-counts", "skill-levels", "city-analysis"],
    description: "Full action/skill enumeration with success chances",
  },
  {
    tier: 2,
    name: "automation",
    functions: [
      "bladeburner.startAction",
      "bladeburner.upgradeSkill",
      "bladeburner.switchCity",
      "bladeburner.joinBladeburnerDivision",
      "bladeburner.joinBladeburnerFaction",
      "bladeburner.nextUpdate",
    ],
    features: ["auto-action", "city-switch", "join-division", "join-faction"],
    description: "Full automation with action execution",
  },
];

// === DYNAMIC RAM CALCULATION ===

const BASE_SCRIPT_COST = 1.6;
const RAM_BUFFER_PERCENT = 0.05;

function calculateTierRam(ns: NS, tierIndex: number): number {
  let ram = BASE_SCRIPT_COST;
  for (const fn of BASE_FUNCTIONS) {
    ram += ns.getFunctionRamCost(fn);
  }
  for (let i = 0; i <= tierIndex; i++) {
    for (const fn of BLADE_TIERS[i].functions) {
      ram += ns.getFunctionRamCost(fn);
    }
  }
  ram *= (1 + RAM_BUFFER_PERCENT);
  return Math.ceil(ram * 10) / 10;
}

function calculateAllTierRamCosts(ns: NS): number[] {
  return BLADE_TIERS.map((_, i) => calculateTierRam(ns, i));
}

function selectBestTier(
  potentialRam: number,
  tierRamCosts: number[],
): { tier: BladeTierConfig; ramCost: number } {
  let bestTierIndex = 0;
  for (let i = BLADE_TIERS.length - 1; i >= 0; i--) {
    if (potentialRam >= tierRamCosts[i]) {
      bestTierIndex = i;
      break;
    }
  }
  return { tier: BLADE_TIERS[bestTierIndex], ramCost: tierRamCosts[bestTierIndex] };
}

function getAvailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = 0; i <= tier; i++) features.push(...BLADE_TIERS[i].features);
  return features;
}

function getUnavailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = tier + 1; i < BLADE_TIERS.length; i++) features.push(...BLADE_TIERS[i].features);
  return features;
}

// === CONFIG ===

function readBladeConfig(ns: NS): BladeConfig {
  return {
    operationThreshold: getConfigNumber(ns, "blade", "operationThreshold", DEFAULT_BLADE_CONFIG.operationThreshold),
    blackOpThreshold: getConfigNumber(ns, "blade", "blackOpThreshold", DEFAULT_BLADE_CONFIG.blackOpThreshold),
    contractThreshold: getConfigNumber(ns, "blade", "contractThreshold", DEFAULT_BLADE_CONFIG.contractThreshold),
    staminaMinPercent: getConfigNumber(ns, "blade", "staminaMinPercent", DEFAULT_BLADE_CONFIG.staminaMinPercent),
    staminaRestoreTo: getConfigNumber(ns, "blade", "staminaRestoreTo", DEFAULT_BLADE_CONFIG.staminaRestoreTo),
    staminaTrainMax: getConfigNumber(ns, "blade", "staminaTrainMax", DEFAULT_BLADE_CONFIG.staminaTrainMax),
    chaosMax: getConfigNumber(ns, "blade", "chaosMax", DEFAULT_BLADE_CONFIG.chaosMax),
    chaosTarget: getConfigNumber(ns, "blade", "chaosTarget", DEFAULT_BLADE_CONFIG.chaosTarget),
    successSpreadMax: getConfigNumber(ns, "blade", "successSpreadMax", DEFAULT_BLADE_CONFIG.successSpreadMax),
    populationMin: getConfigNumber(ns, "blade", "populationMin", DEFAULT_BLADE_CONFIG.populationMin),
  };
}

// === DATA GATHERING ===

/** BB API action type strings (enum values, not controller types) */
type BBActionType = "General" | "Contracts" | "Operations" | "Black Operations";

/** Map controller BladeAction types to BB API strings */
function toBBActionType(type: string): BBActionType {
  switch (type) {
    case "Contract": return "Contracts";
    case "Operation": return "Operations";
    case "BlackOp": return "Black Operations";
    default: return type as BBActionType;
  }
}

function gatherActionData(
  ns: NS,
  type: BBActionType,
  names: string[],
): ActionData[] {
  return names.map(name => {
    const [successMin, successMax] = ns.bladeburner.getActionEstimatedSuccessChance(type, name as BladeburnerActionName);
    return {
      name,
      successMin: successMin * 100,
      successMax: successMax * 100,
      count: ns.bladeburner.getActionCountRemaining(type, name as BladeburnerActionName),
      time: ns.bladeburner.getActionTime(type, name as BladeburnerActionName),
      rankGain: ns.bladeburner.getActionRepGain(type, name as BladeburnerActionName),
    };
  });
}

function gatherSkillData(ns: NS): SkillData[] {
  return ns.bladeburner.getSkillNames().map(name => ({
    name,
    level: ns.bladeburner.getSkillLevel(name),
    upgradeCost: ns.bladeburner.getSkillUpgradeCost(name),
  }));
}

function gatherCityData(ns: NS): CityData[] {
  return BLADEBURNER_CITIES.map(name => ({
    name,
    chaos: ns.bladeburner.getCityChaos(name),
    population: ns.bladeburner.getCityEstimatedPopulation(name),
    communities: ns.bladeburner.getCityCommunities(name),
  }));
}

// === STATUS FORMATTING ===

function formatAction(action: ActionData): BladeActionInfo {
  return {
    name: action.name,
    successMin: action.successMin,
    successMax: action.successMax,
    successFormatted: `${action.successMin.toFixed(0)}-${action.successMax.toFixed(0)}%`,
    count: Math.floor(action.count),
    time: action.time,
    timeFormatted: `${(action.time / 1000).toFixed(0)}s`,
    rankGain: Math.round(action.rankGain * 100) / 100,
  };
}

function formatSkill(skill: SkillData): BladeSkillInfo {
  return {
    name: skill.name,
    level: skill.level,
    upgradeCost: skill.upgradeCost,
    upgradeCostFormatted: skill.upgradeCost.toLocaleString(),
  };
}

function formatCity(ns: NS, city: CityData): BladeCityInfo {
  return {
    name: city.name,
    chaos: city.chaos,
    chaosFormatted: city.chaos.toFixed(1),
    population: city.population,
    populationFormatted: ns.format.number(city.population, 1),
    communities: city.communities,
  };
}

function formatBonusTime(ms: number): string {
  if (ms <= 1000) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function currentActionDisplay(action: ReturnType<NS["bladeburner"]["getCurrentAction"]>): { text: string; type: BladeburnerStatus["currentActionType"] } {
  if (!action) return { text: "Idle", type: "idle" };
  // action.type comes from the BladeburnerActionType enum values, which are plural
  // ("Contracts", "Operations", "Black Operations"), not the singular controller
  // BladeAction["type"] strings — match on the exact API strings, not a guessed prefix.
  switch (action.type) {
    case "General": return { text: action.name, type: "general" };
    case "Contracts": return { text: `Contract: ${action.name}`, type: "contract" };
    case "Operations": return { text: `Op: ${action.name}`, type: "operation" };
    case "Black Operations": return { text: `BlackOp: ${action.name}`, type: "blackop" };
    default: return { text: `${action.type}: ${action.name}`, type: "general" };
  }
}

// === TIER LOOP FUNCTIONS ===

async function runMonitorMode(
  ns: NS,
  currentRam: number,
  tierRamCosts: number[],
): Promise<void> {
  const UPGRADE_CHECK_INTERVAL = 6;
  let cyclesSinceUpgradeCheck = 0;
  const interval = getConfigNumber(ns, "blade", "interval", 5000);

  while (true) {
    ns.clearLog();

    if (!ns.bladeburner.inBladeburner()) {
      const status = makeNotInBBStatus(0, "monitor", currentRam);
      publishStatus(ns, STATUS_PORTS.blade, status);
      ns.print(`${COLORS.yellow}Not in Bladeburner division${COLORS.reset}`);
      await ns.sleep(interval);
      continue;
    }

    const [stam, maxStam] = ns.bladeburner.getStamina();
    const rank = ns.bladeburner.getRank();
    const action = ns.bladeburner.getCurrentAction();
    const { text: actionText, type: actionType } = currentActionDisplay(action);
    const city = ns.bladeburner.getCity();
    const chaos = ns.bladeburner.getCityChaos(city);
    const pop = ns.bladeburner.getCityEstimatedPopulation(city);
    const sp = ns.bladeburner.getSkillPoints();
    const bt = ns.bladeburner.getBonusTime();
    const status: BladeburnerStatus = {
      tier: 0,
      tierName: "monitor",
      availableFeatures: getAvailableFeatures(0),
      unavailableFeatures: getUnavailableFeatures(0),
      currentRamUsage: currentRam,
      inBladeburner: true,
      rank,
      rankFormatted: ns.format.number(rank, 0),
      stamina: stam,
      maxStamina: maxStam,
      staminaPercent: maxStam > 0 ? (stam / maxStam) * 100 : 0,
      staminaFormatted: `${ns.format.number(stam, 0)}/${ns.format.number(maxStam, 0)}`,
      skillPoints: sp,
      skillPointsFormatted: ns.format.number(sp, 0),
      city,
      cityChaos: chaos,
      cityChaosFormatted: chaos.toFixed(1),
      cityPopulation: pop,
      cityPopulationFormatted: ns.format.number(pop, 1),
      bonusTime: bt,
      bonusTimeFormatted: formatBonusTime(bt),
      currentAction: actionText,
      currentActionType: actionType,
    };

    publishStatus(ns, STATUS_PORTS.blade, status);
    printMonitorStatus(ns, status);

    // Check for upgrade
    cyclesSinceUpgradeCheck++;
    if (cyclesSinceUpgradeCheck >= UPGRADE_CHECK_INTERVAL) {
      cyclesSinceUpgradeCheck = 0;
      const potentialRam = calcAvailableAfterKills(ns) + currentRam;
      for (let i = BLADE_TIERS.length - 1; i > 0; i--) {
        if (potentialRam >= tierRamCosts[i]) {
          ns.tprint(`INFO: Upgrading blade daemon from monitor to ${BLADE_TIERS[i].name}`);
          ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 });
          return;
        }
      }
    }

    await ns.sleep(interval);
  }
}

async function runAnalysisMode(
  ns: NS,
  currentRam: number,
  tierRamCosts: number[],
): Promise<void> {
  const UPGRADE_CHECK_INTERVAL = 10;
  let cyclesSinceUpgradeCheck = 0;
  const interval = getConfigNumber(ns, "blade", "interval", 3000);

  while (true) {
    ns.clearLog();

    if (!ns.bladeburner.inBladeburner()) {
      const status = makeNotInBBStatus(1, "analysis", currentRam);
      publishStatus(ns, STATUS_PORTS.blade, status);
      ns.print(`${COLORS.yellow}Not in Bladeburner division${COLORS.reset}`);
      await ns.sleep(interval);
      continue;
    }

    const status = computeFullStatus(ns, 1, "analysis", currentRam);
    publishStatus(ns, STATUS_PORTS.blade, status);
    printFullStatus(ns, status);

    // Check for upgrade
    cyclesSinceUpgradeCheck++;
    if (cyclesSinceUpgradeCheck >= UPGRADE_CHECK_INTERVAL) {
      cyclesSinceUpgradeCheck = 0;
      const potentialRam = calcAvailableAfterKills(ns) + currentRam;
      if (potentialRam >= tierRamCosts[2]) {
        ns.tprint(`INFO: Upgrading blade daemon from analysis to automation`);
        ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 });
        return;
      }
    }

    await ns.sleep(interval);
  }
}

async function runAutomationMode(
  ns: NS,
  currentRam: number,
): Promise<void> {
  let isDiplomacyActive = false;
  let isResting = false;

  // Try to join BB division if not already in
  if (!ns.bladeburner.inBladeburner()) {
    const player = ns.getPlayer();
    const combatStats = Math.min(
      player.skills.strength,
      player.skills.defense,
      player.skills.dexterity,
      player.skills.agility,
    );
    if (combatStats >= 100) {
      const joined = ns.bladeburner.joinBladeburnerDivision();
      if (joined) {
        ns.tprint("SUCCESS: Joined Bladeburner division");
      } else {
        ns.tprint("WARN: Could not join Bladeburner division");
      }
    }
  }

  while (true) {
    ns.clearLog();

    if (!ns.bladeburner.inBladeburner()) {
      const status = makeNotInBBStatus(2, "automation", currentRam);
      publishStatus(ns, STATUS_PORTS.blade, status);
      ns.print(`${COLORS.yellow}Not in Bladeburner division${COLORS.reset}`);

      // Try to join each cycle
      const player = ns.getPlayer();
      const combatStats = Math.min(
        player.skills.strength,
        player.skills.defense,
        player.skills.dexterity,
        player.skills.agility,
      );
      if (combatStats >= 100) {
        ns.bladeburner.joinBladeburnerDivision();
      }
      await ns.sleep(5000);
      continue;
    }

    const config = readBladeConfig(ns);
    const focusHolder = getConfigString(ns, "focus", "holder", "");
    const sleeveHolder = getConfigString(ns, "focus", "sleeveHolder", "");
    const hasSimulacrum = getConfigBool(ns, "focus", "simulacrum", false);
    const focusYielding = !hasSimulacrum && focusHolder !== "" && focusHolder !== "blade" && sleeveHolder !== "blade";

    // Gather full state
    const contracts = gatherActionData(ns, "Contracts", ns.bladeburner.getContractNames());
    const operations = gatherActionData(ns, "Operations", ns.bladeburner.getOperationNames());
    const skills = gatherSkillData(ns);
    const cities = gatherCityData(ns);
    const nextBlackOpRaw = ns.bladeburner.getNextBlackOp();
    const [stam, maxStam] = ns.bladeburner.getStamina();
    const rank = ns.bladeburner.getRank();
    const city = ns.bladeburner.getCity();

    let nextBlackOp: BladeState["nextBlackOp"] = null;
    if (nextBlackOpRaw) {
      const [boMin, boMax] = ns.bladeburner.getActionEstimatedSuccessChance("Black Operations", nextBlackOpRaw.name as BladeburnerActionName);
      nextBlackOp = {
        name: nextBlackOpRaw.name,
        rankRequired: nextBlackOpRaw.rank,
        successMin: boMin * 100,
        successMax: boMax * 100,
      };
    }

    // Determine best city before action selection so diplomacy/chaos
    // checks use the city we'll actually work in
    const bestCity = selectBestCity(city, cities, config.chaosMax);
    const effectiveCity = bestCity || city;
    const effectiveCityData = cities.find(c => c.name === effectiveCity);

    const bladeState: BladeState = {
      inBladeburner: true,
      rank,
      stamina: stam,
      maxStamina: maxStam,
      staminaPercent: maxStam > 0 ? (stam / maxStam) * 100 : 0,
      skillPoints: ns.bladeburner.getSkillPoints(),
      city: effectiveCity,
      cityChaos: effectiveCityData?.chaos ?? ns.bladeburner.getCityChaos(city),
      cityPopulation: effectiveCityData?.population ?? ns.bladeburner.getCityEstimatedPopulation(city),
      bonusTime: ns.bladeburner.getBonusTime(),
      currentAction: null,
      contracts,
      operations,
      nextBlackOp,
      skills,
      cities,
      isDiplomacyActive,
      isResting,
    };

    // Determine recommended action
    const recommended = selectAction(bladeState, config);
    isDiplomacyActive = recommended?.name === "Diplomacy";
    isResting = recommended?.name === "Hyperbolic Regeneration Chamber";

    // Raid quarantine: override city for Raids to protect high-pop cities
    let targetCity: string | null = bestCity;
    if (recommended?.name === "Raid") {
      targetCity = selectBestCity(city, cities, config.chaosMax, "Raid") || targetCity;
    }

    // Execute actions if we hold focus
    if (!focusYielding && recommended) {
      // Switch city if needed
      if (targetCity) {
        ns.bladeburner.switchCity(targetCity as BladeCityName);
        ns.print(`${COLORS.green}Switched to ${targetCity}${COLORS.reset}`);
      }

      // Only start action if it differs from what's already running
      const current = ns.bladeburner.getCurrentAction();
      const alreadyRunning = current &&
        current.type === toBBActionType(recommended.type) &&
        current.name === recommended.name;

      if (!alreadyRunning) {
        ns.bladeburner.startAction(toBBActionType(recommended.type), recommended.name as BladeburnerActionName);
      }
    }

    // Handle skill buy commands from dashboard
    const pendingSkill = getConfigString(ns, "blade", "buySkill", "");
    if (pendingSkill) {
      const cost = ns.bladeburner.getSkillUpgradeCost(pendingSkill as BladeSkillName);
      if (cost <= ns.bladeburner.getSkillPoints()) {
        const success = ns.bladeburner.upgradeSkill(pendingSkill as BladeSkillName);
        if (success) {
          ns.tprint(`SUCCESS: Upgraded ${pendingSkill}`);
        }
      }
      setConfigValue(ns, "blade", "buySkill", "");
    }

    // Handle "buy all" — loop: recommend → buy → re-read → repeat
    if (getConfigString(ns, "blade", "buyAllSkills", "") === "true") {
      setConfigValue(ns, "blade", "buyAllSkills", "");
      let bought = 0;
      while (true) {
        const freshSkills = gatherSkillData(ns);
        const sp = ns.bladeburner.getSkillPoints();
        const rec = recommendSkillUpgrade(freshSkills, sp);
        if (!rec) break;
        const success = ns.bladeburner.upgradeSkill(rec.name as BladeSkillName);
        if (!success) break;
        bought++;
      }
      if (bought > 0) {
        ns.tprint(`SUCCESS: Bought ${bought} skill upgrade${bought > 1 ? "s" : ""}`);
      }
    }

    // Try to join BB faction if eligible
    ns.bladeburner.joinBladeburnerFaction();

    // Compute and publish status
    const status = computeFullStatus(ns, 2, "automation", currentRam, {
      contracts,
      operations,
      skills,
      cities,
      nextBlackOp,
      recommended,
      focusYielding,
      config,
    });
    publishStatus(ns, STATUS_PORTS.blade, status);
    printFullStatus(ns, status);

    // Use nextUpdate for tighter BB cycle alignment
    await ns.bladeburner.nextUpdate();
  }
}

// === STATUS HELPERS ===

function makeNotInBBStatus(tier: number, tierName: BladeTierName, currentRam: number): BladeburnerStatus {
  return {
    tier,
    tierName,
    availableFeatures: getAvailableFeatures(tier),
    unavailableFeatures: getUnavailableFeatures(tier),
    currentRamUsage: currentRam,
    inBladeburner: false,
    rank: 0,
    rankFormatted: "0",
    stamina: 0,
    maxStamina: 0,
    staminaPercent: 0,
    staminaFormatted: "0/0",
    skillPoints: 0,
    skillPointsFormatted: "0",
    city: "—",
    cityChaos: 0,
    cityChaosFormatted: "0",
    cityPopulation: 0,
    cityPopulationFormatted: "0",
    bonusTime: 0,
    bonusTimeFormatted: "0s",
    currentAction: "Not in Bladeburner",
    currentActionType: "idle",
  };
}

interface FullStatusData {
  contracts?: ActionData[];
  operations?: ActionData[];
  skills?: SkillData[];
  cities?: CityData[];
  nextBlackOp?: BladeState["nextBlackOp"];
  recommended?: { type: string; name: string } | null;
  focusYielding?: boolean;
  config?: BladeConfig;
}

function computeFullStatus(
  ns: NS,
  tier: number,
  tierName: BladeTierName,
  currentRam: number,
  data?: FullStatusData,
): BladeburnerStatus {
  const [stam, maxStam] = ns.bladeburner.getStamina();
  const rank = ns.bladeburner.getRank();
  const action = ns.bladeburner.getCurrentAction();
  const { text: actionText, type: actionType } = currentActionDisplay(action);
  const city = ns.bladeburner.getCity();
  const chaos = ns.bladeburner.getCityChaos(city);
  const pop = ns.bladeburner.getCityEstimatedPopulation(city);
  const sp = ns.bladeburner.getSkillPoints();
  const bt = ns.bladeburner.getBonusTime();

  // Gather data at analysis+ tiers if not provided
  const contracts = data?.contracts ?? (tier >= 1 ? gatherActionData(ns, "Contracts", ns.bladeburner.getContractNames()) : undefined);
  const operations = data?.operations ?? (tier >= 1 ? gatherActionData(ns, "Operations", ns.bladeburner.getOperationNames()) : undefined);
  const skills = data?.skills ?? (tier >= 1 ? gatherSkillData(ns) : undefined);
  const cities = data?.cities ?? (tier >= 1 ? gatherCityData(ns) : undefined);

  let nextBlackOp = data?.nextBlackOp;
  if (nextBlackOp === undefined && tier >= 1) {
    const raw = ns.bladeburner.getNextBlackOp();
    if (raw) {
      const [boMin, boMax] = ns.bladeburner.getActionEstimatedSuccessChance("Black Operations", raw.name as BladeburnerActionName);
      nextBlackOp = { name: raw.name, rankRequired: raw.rank, successMin: boMin * 100, successMax: boMax * 100 };
    } else {
      nextBlackOp = null;
    }
  }

  const skillRecommendation = skills ? recommendSkillUpgrade(skills, sp) : null;

  const status: BladeburnerStatus = {
    tier,
    tierName,
    availableFeatures: getAvailableFeatures(tier),
    unavailableFeatures: getUnavailableFeatures(tier),
    currentRamUsage: currentRam,
    inBladeburner: true,
    rank,
    rankFormatted: ns.format.number(rank, 0),
    stamina: stam,
    maxStamina: maxStam,
    staminaPercent: maxStam > 0 ? (stam / maxStam) * 100 : 0,
    staminaFormatted: `${ns.format.number(stam, 0)}/${ns.format.number(maxStam, 0)}`,
    skillPoints: sp,
    skillPointsFormatted: ns.format.number(sp, 0),
    city,
    cityChaos: chaos,
    cityChaosFormatted: chaos.toFixed(1),
    cityPopulation: pop,
    cityPopulationFormatted: ns.format.number(pop, 1),
    bonusTime: bt,
    bonusTimeFormatted: formatBonusTime(bt),
    currentAction: actionText,
    currentActionType: actionType,
  };

  if (contracts) status.contracts = contracts.map(formatAction);
  if (operations) status.operations = operations.map(formatAction);
  if (skills) {
    status.skills = skills.map(formatSkill);
    status.recommendedSkill = skillRecommendation ? {
      name: skillRecommendation.name,
      cost: skillRecommendation.cost,
      costFormatted: skillRecommendation.cost.toLocaleString(),
    } : null;
  }
  if (cities) status.cities = cities.map(c => formatCity(ns, c));

  if (nextBlackOp) {
    status.nextBlackOp = {
      name: nextBlackOp.name,
      rankRequired: nextBlackOp.rankRequired,
      rankMet: rank >= nextBlackOp.rankRequired,
      successMin: nextBlackOp.successMin,
      successMax: nextBlackOp.successMax,
      successFormatted: `${nextBlackOp.successMin.toFixed(0)}-${nextBlackOp.successMax.toFixed(0)}%`,
    };
  } else if (nextBlackOp === null) {
    status.nextBlackOp = null;
  }

  if (data?.recommended) {
    status.recommendedAction = `${data.recommended.type}: ${data.recommended.name}`;
  }
  if (data?.focusYielding !== undefined) {
    status.focusYielding = data.focusYielding;
  }
  if (data?.config) {
    status.config = data.config;
  }

  return status;
}

// === PRINT HELPERS ===

function printMonitorStatus(ns: NS, s: BladeburnerStatus): void {
  ns.print(`${COLORS.cyan}=== BLADEBURNER (Monitor) ===${COLORS.reset}`);
  ns.print(`Rank: ${COLORS.green}${s.rankFormatted}${COLORS.reset}  Stamina: ${s.staminaFormatted} (${s.staminaPercent.toFixed(0)}%)`);
  ns.print(`City: ${s.city}  Chaos: ${s.cityChaosFormatted}  Pop: ${s.cityPopulationFormatted}`);
  ns.print(`SP: ${s.skillPointsFormatted}  Bonus: ${s.bonusTimeFormatted}`);
  ns.print(`Action: ${COLORS.yellow}${s.currentAction}${COLORS.reset}`);
}

function printFullStatus(ns: NS, s: BladeburnerStatus): void {
  ns.print(`${COLORS.cyan}=== BLADEBURNER (${s.tierName}) ===${COLORS.reset}`);
  ns.print(`Rank: ${COLORS.green}${s.rankFormatted}${COLORS.reset}  Stamina: ${s.staminaFormatted} (${s.staminaPercent.toFixed(0)}%)`);
  ns.print(`City: ${s.city}  Chaos: ${s.cityChaosFormatted}  Pop: ${s.cityPopulationFormatted}`);
  ns.print(`SP: ${s.skillPointsFormatted}  Bonus: ${s.bonusTimeFormatted}`);

  const actionColor = s.currentActionType === "operation" ? COLORS.cyan
    : s.currentActionType === "contract" ? COLORS.yellow
    : s.currentActionType === "blackop" ? COLORS.magenta
    : COLORS.dim;
  ns.print(`Action: ${actionColor}${s.currentAction}${COLORS.reset}`);

  if (s.recommendedAction && s.tierName === "automation") {
    ns.print(`Next: ${COLORS.green}${s.recommendedAction}${COLORS.reset}`);
  }
  if (s.focusYielding) {
    ns.print(`${COLORS.yellow}Yielding focus${COLORS.reset}`);
  }

  if (s.nextBlackOp) {
    const bo = s.nextBlackOp;
    const rankColor = bo.rankMet ? COLORS.green : COLORS.red;
    ns.print(`\n${COLORS.magenta}Next BlackOp:${COLORS.reset} ${bo.name}`);
    ns.print(`  Rank: ${rankColor}${bo.rankRequired}${COLORS.reset}  Success: ${bo.successFormatted}`);
  }

  if (s.operations && s.operations.length > 0) {
    ns.print(`\n${COLORS.cyan}Operations:${COLORS.reset}`);
    for (const op of s.operations) {
      if (op.count <= 0) continue;
      ns.print(`  ${op.name}: ${op.successFormatted} (${op.count} left)`);
    }
  }

  if (s.contracts && s.contracts.length > 0) {
    ns.print(`\n${COLORS.yellow}Contracts:${COLORS.reset}`);
    for (const c of s.contracts) {
      if (c.count <= 0) continue;
      ns.print(`  ${c.name}: ${c.successFormatted} (${c.count} left)`);
    }
  }

  if (s.recommendedSkill) {
    ns.print(`\nSkill rec: ${COLORS.green}${s.recommendedSkill.name}${COLORS.reset} (${s.recommendedSkill.costFormatted} SP)`);
  }
}

// === MAIN ===

export async function main(ns: NS): Promise<void> {
  ns.ramOverride(5);
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "blade", {
    interval: "3000",
    operationThreshold: String(DEFAULT_BLADE_CONFIG.operationThreshold),
    blackOpThreshold: String(DEFAULT_BLADE_CONFIG.blackOpThreshold),
    contractThreshold: String(DEFAULT_BLADE_CONFIG.contractThreshold),
    staminaMinPercent: String(DEFAULT_BLADE_CONFIG.staminaMinPercent),
    staminaRestoreTo: String(DEFAULT_BLADE_CONFIG.staminaRestoreTo),
    staminaTrainMax: String(DEFAULT_BLADE_CONFIG.staminaTrainMax),
    chaosMax: String(DEFAULT_BLADE_CONFIG.chaosMax),
    chaosTarget: String(DEFAULT_BLADE_CONFIG.chaosTarget),
    successSpreadMax: String(DEFAULT_BLADE_CONFIG.successSpreadMax),
    populationMin: String(DEFAULT_BLADE_CONFIG.populationMin),
    buySkill: "",
  });

  // Calculate tier RAM costs
  const tierRamCosts = calculateAllTierRamCosts(ns);
  const currentScriptRam = 5;

  // Calculate available RAM
  const potentialRam = calcAvailableAfterKills(ns) + currentScriptRam;

  // Select best tier
  const best = selectBestTier(potentialRam, tierRamCosts);
  let selectedTier = best.tier;
  let requiredRam = best.ramCost;

  // Free RAM if needed
  const currentlyAvailable = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam;
  if (requiredRam > currentlyAvailable) {
    ns.tprint(`INFO: Killing lower-priority scripts for blade ${selectedTier.name} tier`);
    freeRamForTarget(ns, requiredRam);
  }

  // Upgrade RAM allocation to match the selected tier. This must run even for tier 0:
  // monitor mode's own bladeburner calls cost far more than the 5 GB floor set above
  // (BladeburnerApiBase alone is 4 GB per call), so skipping the override for tier 0
  // left the daemon running on a 5 GB allocation it would immediately exceed and get
  // killed for by the game's dynamic RAM check.
  let actual = ns.ramOverride(requiredRam);
  if (actual < requiredRam) {
    ns.tprint(`WARN: Could not allocate ${ns.format.ram(requiredRam)} RAM for blade daemon`);
    if (actual < tierRamCosts[0]) {
      ns.tprint(
        `ERROR: Not enough home RAM for even the monitor tier ` +
        `(need ${ns.format.ram(tierRamCosts[0])}, have ${ns.format.ram(actual)}). Blade daemon exiting.`,
      );
      return;
    }
    const fallback = selectBestTier(actual, tierRamCosts);
    actual = ns.ramOverride(fallback.ramCost);
    requiredRam = fallback.ramCost;
    selectedTier = fallback.tier;
  }

  ns.tprint(`INFO: Blade daemon: ${selectedTier.name} tier (${ns.format.ram(requiredRam)} RAM)`);

  if (selectedTier.tier === 0) {
    await runMonitorMode(ns, requiredRam, tierRamCosts);
  } else if (selectedTier.tier === 1) {
    await runAnalysisMode(ns, requiredRam, tierRamCosts);
  } else {
    await runAutomationMode(ns, requiredRam);
  }
}
