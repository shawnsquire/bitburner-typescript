/**
 * Reputation Daemon (Tiered Architecture)
 *
 * Long-running daemon that tracks faction reputation and augmentation progress.
 * Operates in graduated tiers based on available RAM:
 *
 *   Tier 0 (Lite):     ~5GB   - Cached data display only
 *   Tier 1 (Basic):    ~34GB  - Live rep for all factions
 *   Tier 2 (Target):   ~114GB - Rep progress toward target aug
 *   Tier 3 (Analysis): ~194GB - Available augs per faction
 *   Tier 4 (Planning): ~274GB - Filtered purchase plan
 *   Tier 5 (Prereqs):  ~354GB - Full prerequisite checking
 *   Tier 6 (AutoWork): ~415GB - Automatic faction work
 *
 * Usage:
 *   run daemons/rep.js                    # Auto-select best tier
 *   run daemons/rep.js --tier basic       # Force specific tier
 *   run daemons/rep.js --no-kill          # Don't kill other scripts
 *   run daemons/rep.js --faction CyberSec # Target specific faction
 */
import { NS, FactionName } from "@ns";
import { COLORS, makeBar, formatTime } from "/lib/utils";
import { calcAvailableAfterKills, freeRamForTarget } from "/lib/ram-utils";
import { writeDefaultConfig, getConfigString, getConfigNumber, getConfigBool, setConfigValue } from "/lib/config";
import {
  getBasicFactionRep,
  analyzeFactions,
  findNextWorkableAugmentation,
  selectBestWorkType,
  getOwnedAugs,
  getInstalledAugs,
  getNonWorkableFactionProgress,
  getFactionWorkStatus,
  getGangFaction,
} from "/controllers/factions";
import { publishStatus, peekStatus } from "/lib/ports";
import {
  STATUS_PORTS,
  RepStatus,
  BitnodeStatus,
  RepTierConfig,
  RepTierName,
} from "/types/ports";

// === TIER DEFINITIONS ===

// Base functions used by ALL tiers (including tier 0)
// These are NS functions that the daemon always uses
const BASE_FUNCTIONS = [
  "getResetInfo",
  "getServerMaxRam",
  "getServerUsedRam",
  "ps",
  "getScriptRam",
  "getPlayer",
  "getPortHandle",
  "fileExists",
];

const REP_TIERS: RepTierConfig[] = [
  {
    tier: 0,
    name: "lite",
    functions: [], // No additional NS functions beyond base
    features: ["cached-display"],
    description: "Shows cached data only (no Singularity)",
  },
  {
    tier: 1,
    name: "basic",
    functions: [
      "singularity.getFactionRep",
      "singularity.getFactionFavor",
    ],
    features: ["live-rep", "all-factions"],
    description: "Live rep for all joined factions",
  },
  {
    tier: 2,
    name: "target",
    functions: [
      "singularity.getAugmentationRepReq",
      "singularity.getAugmentationPrice",
      "getFavorToDonate", // Used in status computation
      "gang.inGang",
      "gang.getGangInformation",
    ],
    features: ["target-tracking", "eta", "aug-cost"],
    description: "Rep progress toward target augmentation",
  },
  {
    tier: 3,
    name: "analysis",
    functions: [
      "singularity.getAugmentationsFromFaction",
      "getServer", // Used in getPendingBackdoors
    ],
    features: ["faction-augs", "auto-recommend"],
    description: "List available augs per faction",
  },
  {
    tier: 4,
    name: "planning",
    functions: [
      "singularity.getOwnedAugmentations",
    ],
    features: ["purchase-plan", "owned-filter"],
    description: "Full purchase priority list",
  },
  {
    tier: 5,
    name: "prereqs",
    functions: [
      "singularity.getAugmentationPrereq",
    ],
    features: ["prereq-order", "nfg-tracking"],
    description: "Prerequisite-aware aug ordering",
  },
  {
    tier: 6,
    name: "auto-work",
    functions: [
      "singularity.getCurrentWork",
      "singularity.workForFaction",
      "singularity.isFocused",
    ],
    features: ["auto-work", "work-status"],
    description: "Automatic faction work management",
  },
];

// === DYNAMIC RAM CALCULATION ===

const BASE_SCRIPT_COST = 1.6; // GB - base cost of running any script
const RAM_BUFFER_PERCENT = 0.05; // 5% safety margin

/**
 * Calculate the actual RAM cost for a tier at runtime.
 * Uses ns.getFunctionRamCost() to get accurate costs that account for SF4 level.
 */
function calculateTierRam(ns: NS, tierIndex: number): number {
  let ram = BASE_SCRIPT_COST;

  // Add base functions (always needed)
  for (const fn of BASE_FUNCTIONS) {
    ram += ns.getFunctionRamCost(fn);
  }

  // Add functions for this tier and all lower tiers (cumulative)
  for (let i = 0; i <= tierIndex; i++) {
    for (const fn of REP_TIERS[i].functions) {
      ram += ns.getFunctionRamCost(fn);
    }
  }

  // Add safety buffer
  ram *= (1 + RAM_BUFFER_PERCENT);

  // Round up to nearest 0.1 GB
  return Math.ceil(ram * 10) / 10;
}

/**
 * Calculate RAM costs for all tiers.
 * Returns an array where index corresponds to tier number.
 */
function calculateAllTierRamCosts(ns: NS): number[] {
  return REP_TIERS.map((_, i) => calculateTierRam(ns, i));
}

// === BITNODE REQUIREMENTS ===

const BITNODE_REQUIREMENTS = {
  augmentations: 30,
  money: 100_000_000_000,
  hacking: 2500,
};

// === FACTION BACKDOOR SERVERS ===

const FACTION_BACKDOOR_SERVERS: Record<string, string> = {
  CyberSec: "CSEC",
  NiteSec: "avmnite-02h",
  "The Black Hand": "I.I.I.I",
  BitRunners: "run4theh111z",
};

// === HELPER FUNCTIONS ===

/**
 * Get list of faction servers that need backdoors installed
 */
function getPendingBackdoors(ns: NS): string[] {
  const pending: string[] = [];
  for (const [faction, server] of Object.entries(FACTION_BACKDOOR_SERVERS)) {
    try {
      const serverObj = ns.getServer(server);
      if (serverObj.hasAdminRights && !serverObj.backdoorInstalled) {
        pending.push(faction);
      }
    } catch {
      // Server might not exist or not be accessible
    }
  }
  return pending;
}

/**
 * Select the best achievable tier given available RAM and tier RAM costs.
 * @param potentialRam - Available RAM in GB
 * @param sf4Level - Source-File 4 level (0 = no Singularity)
 * @param tierRamCosts - Array of RAM costs per tier (from calculateAllTierRamCosts)
 * @returns Object with selected tier config and its calculated RAM cost
 */
function selectBestTier(
  potentialRam: number,
  sf4Level: number,
  tierRamCosts: number[]
): { tier: RepTierConfig; ramCost: number } {
  if (sf4Level === 0) {
    return { tier: REP_TIERS[0], ramCost: tierRamCosts[0] }; // Lite mode if no SF4
  }

  // Find highest tier we can afford
  let bestTierIndex = 0;
  for (let i = REP_TIERS.length - 1; i >= 0; i--) {
    if (potentialRam >= tierRamCosts[i]) {
      bestTierIndex = i;
      break;
    }
  }

  return { tier: REP_TIERS[bestTierIndex], ramCost: tierRamCosts[bestTierIndex] };
}

/**
 * Get all features available at a given tier
 */
function getAvailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = 0; i <= tier; i++) {
    features.push(...REP_TIERS[i].features);
  }
  return features;
}

/**
 * Get features unavailable at a given tier
 */
function getUnavailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = tier + 1; i < REP_TIERS.length; i++) {
    features.push(...REP_TIERS[i].features);
  }
  return features;
}

/**
 * Compute BitnodeStatus for fl1ght.exe completion tracking
 */
function computeBitnodeStatus(ns: NS, installedAugsCount?: number): BitnodeStatus {
  const player = ns.getPlayer();
  // Use provided count if available (avoids extra Singularity call)
  const installedAugs = installedAugsCount ?? 0;

  const augsComplete = installedAugs >= BITNODE_REQUIREMENTS.augmentations;
  const moneyComplete = player.money >= BITNODE_REQUIREMENTS.money;
  const hackingComplete = player.skills.hacking >= BITNODE_REQUIREMENTS.hacking;

  return {
    augmentations: installedAugs,
    augmentationsRequired: BITNODE_REQUIREMENTS.augmentations,
    money: player.money,
    moneyRequired: BITNODE_REQUIREMENTS.money,
    moneyFormatted: ns.format.number(player.money),
    moneyRequiredFormatted: ns.format.number(BITNODE_REQUIREMENTS.money),
    hacking: player.skills.hacking,
    hackingRequired: BITNODE_REQUIREMENTS.hacking,
    augsComplete,
    moneyComplete,
    hackingComplete,
    allComplete: augsComplete && moneyComplete && hackingComplete,
  };
}

// === TIER-SPECIFIC STATUS COMPUTATION ===

/**
 * Compute RepStatus for Tier 0 (Lite mode)
 */
function computeTier0Status(ns: NS, currentRam: number, nextTierRam?: number): RepStatus {
  const cached = peekStatus<RepStatus>(ns, STATUS_PORTS.rep);

  return {
    tier: 0,
    tierName: "lite",
    availableFeatures: getAvailableFeatures(0),
    unavailableFeatures: getUnavailableFeatures(0),
    currentRamUsage: currentRam,
    nextTierRam: nextTierRam ?? null,
    canUpgrade: false,
    // Include cached data if available
    ...(cached && {
      allFactions: cached.allFactions,
      targetFaction: cached.targetFaction,
      installedAugs: cached.installedAugs,
    }),
  };
}

/**
 * Compute RepStatus for Tier 1 (Basic rep)
 */
function computeTier1Status(ns: NS, currentRam: number, nextTierRam: number): RepStatus {
  const player = ns.getPlayer();
  const basicData = getBasicFactionRep(ns, player);

  return {
    tier: 1,
    tierName: "basic",
    availableFeatures: getAvailableFeatures(1),
    unavailableFeatures: getUnavailableFeatures(1),
    currentRamUsage: currentRam,
    nextTierRam: nextTierRam,
    canUpgrade: true,
    allFactions: basicData.map((f) => ({
      name: f.name,
      currentRep: f.currentRep,
      currentRepFormatted: ns.format.number(f.currentRep),
      favor: f.favor,
    })),
  };
}

/**
 * Compute RepStatus for Tier 2 (Target tracking)
 */
function computeTier2Status(
  ns: NS,
  currentRam: number,
  nextTierRam: number,
  targetFactionOverride: string,
  repGainRate: number
): RepStatus {
  const player = ns.getPlayer();
  const basicData = getBasicFactionRep(ns, player);

  // Detect gang faction to exclude from auto-targeting
  const gangFaction = getGangFaction(ns);

  // Find target faction and aug (skip gang faction in auto mode)
  let autoFallback = basicData[0]?.name || "None";
  if (gangFaction && autoFallback === gangFaction) {
    autoFallback = basicData.find(f => f.name !== gangFaction)?.name || "None";
  }
  const targetFaction = targetFactionOverride || autoFallback;
  const targetAug: string | null = null;
  const repRequired = 0;
  const augPrice = 0;

  // Try to find the lowest rep aug we don't have rep for yet
  // This is a heuristic without full aug list access
  const factionData = basicData.find((f) => f.name === targetFaction);
  const currentRep = factionData?.currentRep ?? 0;
  const favor = factionData?.favor ?? 0;

  // Without getAugmentationsFromFaction, we can't auto-find augs
  // User must specify target or we just show faction rep

  const repGap = Math.max(0, repRequired - currentRep);
  const repProgress = repRequired > 0 ? Math.min(1, currentRep / repRequired) : 1;

  let eta = "???";
  if (repGap > 0 && repGainRate > 0) {
    eta = formatTime(repGap / repGainRate);
  } else if (repGap <= 0) {
    eta = "Ready";
  }

  const favorToUnlock = ns.getFavorToDonate();

  return {
    tier: 2,
    tierName: "target",
    availableFeatures: getAvailableFeatures(2),
    unavailableFeatures: getUnavailableFeatures(2),
    currentRamUsage: currentRam,
    nextTierRam: nextTierRam,
    canUpgrade: true,
    allFactions: basicData.map((f) => ({
      name: f.name,
      currentRep: f.currentRep,
      currentRepFormatted: ns.format.number(f.currentRep),
      favor: f.favor,
    })),
    ...(targetFactionOverride ? { focusedFaction: targetFactionOverride } : {}),
    targetFaction,
    nextAugName: targetAug,
    repRequired,
    repRequiredFormatted: ns.format.number(repRequired),
    currentRep,
    currentRepFormatted: ns.format.number(currentRep),
    repGap,
    repGapFormatted: ns.format.number(repGap),
    repGapPositive: repGap > 0,
    repProgress,
    nextAugCost: augPrice,
    nextAugCostFormatted: ns.format.number(augPrice),
    canAffordNextAug: player.money >= augPrice,
    favor,
    favorToUnlock,
    repGainRate,
    eta,
  };
}

/**
 * Compute RepStatus for Tier 3+ (Analysis and higher)
 * Uses the original full computation for tiers 3-6
 */
function computeHighTierStatus(
  ns: NS,
  tier: RepTierConfig,
  currentRamUsage: number,
  nextTierRam: number | null,
  repGainRate: number,
  noWork: boolean,
  targetFactionOverride = "",
  focusYielding = false,
  focusHolder = "",
  sleeveHolder = "",
): RepStatus {
  const player = ns.getPlayer();
  const ownedAugs = getOwnedAugs(ns);
  const installedAugs = getInstalledAugs(ns);

  const factionData = analyzeFactions(ns, player, ownedAugs);

  // Detect gang faction to exclude from auto-targeting
  const gangFaction = getGangFaction(ns);
  const gangExclude = gangFaction ? new Set([gangFaction]) : undefined;

  // Use workable faction target (excluding gang faction)
  let target = findNextWorkableAugmentation(factionData, gangExclude);

  // Override with specific faction if requested
  if (targetFactionOverride) {
    const forcedFaction = factionData.find(f => f.name === targetFactionOverride);
    if (forcedFaction) {
      const nextAug = forcedFaction.availableAugs.find(a => a.repReq > forcedFaction.currentRep)
        ?? forcedFaction.availableAugs[0]
        ?? null;
      target = nextAug
        ? { aug: nextAug, faction: forcedFaction, repGap: Math.max(0, nextAug.repReq - forcedFaction.currentRep) }
        : null;
    }
  }

  // Get non-workable faction progress (include gang faction)
  const nonWorkableProgress = getNonWorkableFactionProgress(factionData, gangExclude);

  // Determine target faction (for work targeting / NFG fallback)
  let targetFaction: string;
  let targetFactionRep = 0;
  let targetFactionFavor = 0;

  if (target) {
    targetFaction = target.faction.name;
    targetFactionRep = target.faction.currentRep;
    targetFactionFavor = target.faction.favor;
  } else if (targetFactionOverride) {
    // Forced faction with no augs left — still show it as target
    const forcedFaction = factionData.find(f => f.name === targetFactionOverride);
    if (forcedFaction) {
      targetFaction = forcedFaction.name;
      targetFactionRep = forcedFaction.currentRep;
      targetFactionFavor = forcedFaction.favor;
    } else {
      targetFaction = targetFactionOverride;
    }
  } else {
    // Fall back to highest-rep faction for rep grinding
    const best = factionData
      .filter(f => !gangExclude || !gangExclude.has(f.name))
      .sort((a, b) => b.currentRep - a.currentRep)[0];
    if (best) {
      targetFaction = best.name;
      targetFactionRep = best.currentRep;
      targetFactionFavor = best.favor;
    } else {
      targetFaction = "None";
    }
  }

  const repRequired = target?.aug?.repReq ?? 0;
  const currentRep = target?.faction?.currentRep ?? targetFactionRep;
  const repGap = Math.max(0, repRequired - currentRep);
  const repProgress = repRequired > 0 ? Math.min(1, currentRep / repRequired) : 0;

  const favorToUnlock = ns.getFavorToDonate();

  let eta = "???";
  if (repGap > 0 && repGainRate > 0) {
    eta = formatTime(repGap / repGainRate);
  } else if (repGap <= 0) {
    eta = "Ready";
  }

  const nextAugCost = target?.aug?.basePrice ?? 0;
  const pendingBackdoors = getPendingBackdoors(ns);

  // Work status (Tier 6 only)
  const defaultWorkStatus = {
    isWorkingForFaction: false,
    isOptimalWork: false,
    bestWorkType: "hacking" as "hacking" | "field" | "security",
    currentWorkType: null as string | null,
    isWorkable: false,
  };

  const workStatus = tier.tier >= 6 && targetFaction !== "None"
    ? getFactionWorkStatus(ns, player, targetFaction)
    : defaultWorkStatus;

  return {
    tier: tier.tier,
    tierName: tier.name,
    availableFeatures: getAvailableFeatures(tier.tier),
    unavailableFeatures: getUnavailableFeatures(tier.tier),
    currentRamUsage: currentRamUsage,
    nextTierRam: nextTierRam,
    canUpgrade: tier.tier < 6,
    allFactions: factionData.map((f) => ({
      name: f.name,
      currentRep: f.currentRep,
      currentRepFormatted: ns.format.number(f.currentRep),
      favor: f.favor,
    })),
    ...(targetFactionOverride ? { focusedFaction: targetFactionOverride } : {}),
    targetFaction,
    nextAugName: target?.aug?.name ?? null,
    repRequired,
    repRequiredFormatted: ns.format.number(repRequired),
    currentRep,
    currentRepFormatted: ns.format.number(currentRep),
    repGap,
    repGapFormatted: ns.format.number(repGap),
    repGapPositive: repGap > 0,
    repProgress,
    installedAugs: installedAugs.length,
    repGainRate,
    eta,
    nextAugCost,
    nextAugCostFormatted: ns.format.number(nextAugCost),
    canAffordNextAug: player.money >= nextAugCost,
    favor: targetFactionFavor,
    favorToUnlock,
    pendingBackdoors,
    nonWorkableFactions: nonWorkableProgress.map((item) => ({
      factionName: item.faction.name,
      nextAugName: item.nextAug.name,
      progress: item.progress,
      currentRep: ns.format.number(item.faction.currentRep),
      requiredRep: ns.format.number(item.nextAug.repReq),
    })),
    isWorkingForFaction: workStatus.isWorkingForFaction,
    isOptimalWork: workStatus.isOptimalWork,
    bestWorkType: workStatus.bestWorkType,
    currentWorkType: workStatus.currentWorkType,
    isWorkable: workStatus.isWorkable,
    focusYielding,
  };
}

// === PRINT FUNCTIONS ===

/**
 * Print status for low tiers (0-2)
 */
function printLowTierStatus(ns: NS, status: RepStatus): void {
  const C = COLORS;

  ns.print(`${C.cyan}=== Rep Daemon (${status.tierName}) ===${C.reset}`);
  ns.print(
    `${C.dim}Tier ${status.tier} | RAM: ${ns.format.ram(status.currentRamUsage)}${C.reset}`
  );

  if (status.allFactions && status.allFactions.length > 0) {
    ns.print("");
    ns.print(`${C.cyan}JOINED FACTIONS${C.reset}`);
    for (const faction of status.allFactions.slice(0, 10)) {
      ns.print(
        `  ${C.white}${faction.name.padEnd(24)}${C.reset} ` +
          `${C.green}${faction.currentRepFormatted.padStart(10)}${C.reset} rep ` +
          `${C.dim}(${faction.favor.toFixed(0)} favor)${C.reset}`
      );
    }
    if (status.allFactions.length > 10) {
      ns.print(`  ${C.dim}... +${status.allFactions.length - 10} more${C.reset}`);
    }
  } else {
    ns.print("");
    ns.print(`${C.yellow}No faction data available.${C.reset}`);
    ns.print(`${C.dim}Need more RAM for Singularity calls.${C.reset}`);
  }

  if (status.canUpgrade && status.nextTierRam) {
    ns.print("");
    ns.print(
      `${C.yellow}Upgrade available: ${C.reset}` +
        `${C.white}${ns.format.ram(status.nextTierRam)}${C.reset} ${C.dim}for next tier${C.reset}`
    );
  }
}

/**
 * Print status for high tiers (3-6)
 */
function printHighTierStatus(
  ns: NS,
  status: RepStatus,
  bitnodeStatus: BitnodeStatus
): void {
  const C = COLORS;

  ns.print(`${C.cyan}=== Rep Daemon (${status.tierName}) ===${C.reset}`);
  ns.print(
    `${C.dim}Target: ${C.reset}${C.white}${status.targetFaction}${C.reset}` +
      `  ${C.dim}|${C.reset}  ${C.dim}Installed: ${C.reset}${C.green}${status.installedAugs ?? 0}${C.reset}`
  );

  // Next aug progress
  if (status.nextAugName) {
    const progress = status.repProgress ?? 0;
    const bar = makeBar(progress, 30, progress >= 1 ? C.green : C.cyan);
    ns.print("");
    ns.print(
      `${C.cyan}NEXT UNLOCK${C.reset}: ${C.yellow}${status.nextAugName}${C.reset}`
    );
    ns.print(`${bar} ${C.white}${(progress * 100).toFixed(1)}%${C.reset}`);
    ns.print(
      `${C.dim}${status.currentRepFormatted} / ${status.repRequiredFormatted} rep${C.reset}` +
        (status.repGapPositive
          ? `  ${C.dim}(need ${status.repGapFormatted} more)${C.reset}`
          : "")
    );
    ns.print(
      `${C.white}ETA:${C.reset} ${C.cyan}${status.eta}${C.reset}` +
        ((status.repGainRate ?? 0) > 0
          ? ` ${C.dim}@ ${ns.format.number(status.repGainRate ?? 0)}/s${C.reset}`
          : "") +
        `  ${C.dim}|${C.reset}  ` +
        (status.canAffordNextAug
          ? `${C.green}$${status.nextAugCostFormatted}${C.reset}`
          : `${C.red}$${status.nextAugCostFormatted}${C.reset}`)
    );
  } else {
    ns.print("");
    ns.print(`${C.yellow}No faction with available augmentations found.${C.reset}`);
  }

  // Focus yielding indicator
  if (status.focusYielding) {
    ns.print(`${C.yellow}YIELDING: Focus held by another daemon${C.reset}`);
  }

  // Work status (Tier 6)
  if (status.isWorkable !== undefined) {
    const workColor = status.isOptimalWork
      ? C.green
      : status.isWorkingForFaction
        ? C.yellow
        : C.red;
    const workLabel = status.isOptimalWork
      ? `${status.currentWorkType} (optimal)`
      : status.isWorkingForFaction
        ? `${status.currentWorkType} (not optimal, best: ${status.bestWorkType})`
        : `not working (best: ${status.bestWorkType})`;
    ns.print(`${C.dim}Work:${C.reset} ${workColor}${workLabel}${C.reset}`);
  }

  // Bitnode status
  ns.print("");
  ns.print(
    `${C.cyan}BITNODE${C.reset}  ` +
      `${bitnodeStatus.augsComplete ? C.green : C.dim}Augs:${bitnodeStatus.augmentations}/${bitnodeStatus.augmentationsRequired}${C.reset}  ` +
      `${bitnodeStatus.moneyComplete ? C.green : C.dim}$:${bitnodeStatus.moneyFormatted}/${bitnodeStatus.moneyRequiredFormatted}${C.reset}  ` +
      `${bitnodeStatus.hackingComplete ? C.green : C.dim}Hack:${bitnodeStatus.hacking}/${bitnodeStatus.hackingRequired}${C.reset}` +
      (bitnodeStatus.allComplete ? `  ${C.green}READY${C.reset}` : "")
  );
}

// === TIERED RUN FUNCTIONS ===

/**
 * Lite mode: No Singularity (Tier 0)
 */
async function runLiteMode(
  ns: NS,
  currentRam: number
): Promise<void> {
  const C = COLORS;
  let firstRun = true;

  do {
    ns.clearLog();
    const status = computeTier0Status(ns, currentRam);
    publishStatus(ns, STATUS_PORTS.rep, status);

    ns.print(`${C.yellow}=== Rep Daemon (Lite Mode) ===${C.reset}`);
    ns.print(`${C.dim}Singularity API not available (need SF4)${C.reset}`);

    if (status.allFactions && status.allFactions.length > 0) {
      ns.print("");
      ns.print(`${C.dim}Showing cached data:${C.reset}`);
      for (const faction of status.allFactions.slice(0, 5)) {
        ns.print(
          `  ${C.white}${faction.name}${C.reset}: ${faction.currentRepFormatted} rep`
        );
      }
    } else {
      ns.print("");
      ns.print(`${C.dim}No cached data available.${C.reset}`);
    }

    if (firstRun) {
      ns.tprint(
        `INFO: Rep daemon running in lite mode (no Singularity). ` +
          `Use terminal: singularity.workForFaction("FactionName", "hacking", true)`
      );
      firstRun = false;
    }

    const oneShot = getConfigBool(ns, "rep", "oneShot", false);
    const interval = getConfigNumber(ns, "rep", "interval", 2000);
    if (!oneShot) await ns.sleep(interval);
  } while (!getConfigBool(ns, "rep", "oneShot", false));
}

/**
 * Basic mode: Live rep only (Tier 1-2)
 */
async function runBasicMode(
  ns: NS,
  tier: RepTierConfig,
  currentTierRam: number,
  tierRamCosts: number[],
  spawnArgs: string[]
): Promise<void> {
  let repGainRate = 0;
  let lastRep = 0;
  let lastRepTime = Date.now();
  let lastTargetFaction = "";
  let cyclesSinceUpgradeCheck = 0;
  const UPGRADE_CHECK_INTERVAL = 10;

  do {
    const targetFactionOverride = getConfigString(ns, "rep", "faction", "");
    const oneShot = getConfigBool(ns, "rep", "oneShot", false);
    const interval = getConfigNumber(ns, "rep", "interval", 2000);

    ns.clearLog();

    // Compute status based on tier
    const nextTierRam = tierRamCosts[tier.tier + 1];
    let status: RepStatus;
    if (tier.tier === 1) {
      status = computeTier1Status(ns, currentTierRam, nextTierRam);
    } else {
      status = computeTier2Status(
        ns,
        currentTierRam,
        nextTierRam,
        targetFactionOverride,
        repGainRate
      );
    }

    // Track rep gain rate
    if (status.targetFaction && status.currentRep !== undefined) {
      const now = Date.now();
      if (lastRep > 0 && lastTargetFaction === status.targetFaction) {
        const timeDelta = (now - lastRepTime) / 1000;
        if (timeDelta > 0) {
          const repDelta = status.currentRep - lastRep;
          repGainRate = repGainRate * 0.7 + (repDelta / timeDelta) * 0.3;
        }
      }
      lastRep = status.currentRep;
      lastRepTime = now;
      lastTargetFaction = status.targetFaction;
    }

    publishStatus(ns, STATUS_PORTS.rep, status);

    // Publish bitnode status (without installed augs count at low tiers)
    const bitnodeStatus = computeBitnodeStatus(ns);
    publishStatus(ns, STATUS_PORTS.bitnode, bitnodeStatus);

    printLowTierStatus(ns, status);

    // Check for upgrade opportunity
    cyclesSinceUpgradeCheck++;
    if (cyclesSinceUpgradeCheck >= UPGRADE_CHECK_INTERVAL) {
      cyclesSinceUpgradeCheck = 0;
      const potentialRam = calcAvailableAfterKills(ns) + currentTierRam;

      // Check if we can afford a higher tier
      for (let i = REP_TIERS.length - 1; i > tier.tier; i--) {
        if (potentialRam >= tierRamCosts[i]) {
          ns.tprint(
            `INFO: Upgrading rep daemon from ${tier.name} to ${REP_TIERS[i].name}`
          );
          ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 }, ...spawnArgs);
          return;
        }
      }
    }

    if (!oneShot) {
      ns.print(
        `\n${COLORS.dim}Next check in ${interval / 1000}s...${COLORS.reset}`
      );
      await ns.sleep(interval);
    }
  } while (!getConfigBool(ns, "rep", "oneShot", false));
}

/**
 * Full mode: All features (Tier 3-6)
 */
async function runFullMode(
  ns: NS,
  tier: RepTierConfig,
  currentTierRam: number,
  tierRamCosts: number[],
  spawnArgs: string[]
): Promise<void> {
  let repGainRate = 0;
  let lastRep = 0;
  let lastRepTime = Date.now();
  let lastTargetFaction = "";
  let lastNotifiedFaction = "";
  let cyclesSinceUpgradeCheck = 0;
  const UPGRADE_CHECK_INTERVAL = 10;

  do {
    const targetFactionOverride = getConfigString(ns, "rep", "faction", "");
    const noWork = getConfigBool(ns, "rep", "noWork", false);
    const oneShot = getConfigBool(ns, "rep", "oneShot", false);
    const interval = getConfigNumber(ns, "rep", "interval", 2000);

    // Check focus priority
    const focusHolder = getConfigString(ns, "focus", "holder", "");
    const sleeveHolder = getConfigString(ns, "focus", "sleeveHolder", "");
    const focusYielding = focusHolder !== "" && focusHolder !== "rep" && sleeveHolder !== "rep";

    ns.clearLog();

    const player = ns.getPlayer();
    const ownedAugs = getOwnedAugs(ns);
    const factionData = analyzeFactions(ns, player, ownedAugs);

    // Detect gang faction to exclude from auto-targeting
    const gangFaction = getGangFaction(ns);
    const gangExclude = gangFaction ? new Set([gangFaction]) : undefined;

    // Find next workable augmentation target (excluding gang faction)
    let workTarget = findNextWorkableAugmentation(factionData, gangExclude);

    // Override with specific faction if requested
    if (targetFactionOverride) {
      const forcedFaction = factionData.find(
        (f) => f.name === targetFactionOverride
      );
      if (forcedFaction) {
        const nextAug = forcedFaction.availableAugs.find(a => a.repReq > forcedFaction.currentRep)
          ?? forcedFaction.availableAugs[0]
          ?? null;
        workTarget = nextAug
          ? { aug: nextAug, faction: forcedFaction, repGap: nextAug.repReq - forcedFaction.currentRep }
          : null;
      }
    }

    // Determine work target
    let workTargetFaction: string | null = null;
    let workTargetRep = 0;

    if (workTarget) {
      workTargetFaction = workTarget.faction.name;
      workTargetRep = workTarget.faction.currentRep;
    } else if (targetFactionOverride) {
      // Forced faction with no augs left — still grind rep there
      const forcedFaction = factionData.find(f => f.name === targetFactionOverride);
      if (forcedFaction) {
        workTargetFaction = forcedFaction.name;
        workTargetRep = forcedFaction.currentRep;
      }
    } else {
      // Fall back to highest-rep faction (skip gang faction)
      const best = factionData
        .filter(f => !gangExclude || !gangExclude.has(f.name))
        .sort((a, b) => b.currentRep - a.currentRep)[0];
      if (best) {
        workTargetFaction = best.name;
        workTargetRep = best.currentRep;
      }
    }

    // Track rep gain rate
    if (workTargetFaction) {
      const now = Date.now();

      if (lastRep > 0 && lastTargetFaction === workTargetFaction) {
        const timeDelta = (now - lastRepTime) / 1000;
        if (timeDelta > 0) {
          const repDelta = workTargetRep - lastRep;
          const newRate = repDelta / timeDelta;
          repGainRate = repGainRate * 0.7 + newRate * 0.3;
        }
      }

      lastRep = workTargetRep;
      lastRepTime = now;
      lastTargetFaction = workTargetFaction;

      // Terminal notification when target changes
      if (workTargetFaction !== lastNotifiedFaction) {
        const bestWork = selectBestWorkType(ns, player, workTargetFaction);
        ns.tprint(`INFO: >>> Work for ${workTargetFaction} (${bestWork}) <<<`);
        lastNotifiedFaction = workTargetFaction;
      }

      // Auto-work (Tier 6 only, skip when yielding focus to work daemon)
      if (!noWork && !focusYielding && tier.tier >= 6) {
        const nextAug = workTarget?.aug;
        const needsWork = !nextAug || nextAug.repReq > workTargetRep || !workTarget;

        if (needsWork) {
          const bestWork = selectBestWorkType(ns, player, workTargetFaction);
          const currentWork = ns.singularity.getCurrentWork();
          const currentlyWorking =
            currentWork?.type === "FACTION" &&
            currentWork?.factionName === workTargetFaction;

          if (
            (!currentlyWorking ||
              (currentWork as { factionWorkType?: string }).factionWorkType !==
                bestWork) &&
            currentWork?.type !== "CLASS" // Don't interrupt gym/university training
          ) {
            ns.singularity.workForFaction(
              workTargetFaction as FactionName,
              bestWork,
              ns.singularity.isFocused()
            );
          }
        }
      }
    }

    // Compute and publish RepStatus
    // Calculate next tier RAM for display
    const nextTierRam = tier.tier < 6 ? tierRamCosts[tier.tier + 1] : null;
    const repStatus = computeHighTierStatus(ns, tier, currentTierRam, nextTierRam, repGainRate, noWork, targetFactionOverride, focusYielding, focusHolder, sleeveHolder);
    publishStatus(ns, STATUS_PORTS.rep, repStatus);

    // Compute and publish BitnodeStatus
    const bitnodeStatus = computeBitnodeStatus(
      ns,
      repStatus.installedAugs
    );
    publishStatus(ns, STATUS_PORTS.bitnode, bitnodeStatus);

    // Print status
    printHighTierStatus(ns, repStatus, bitnodeStatus);

    // Check for upgrade opportunity
    cyclesSinceUpgradeCheck++;
    if (cyclesSinceUpgradeCheck >= UPGRADE_CHECK_INTERVAL) {
      cyclesSinceUpgradeCheck = 0;
      const potentialRam = calcAvailableAfterKills(ns) + currentTierRam;

      // Check if we can afford a higher tier
      for (let i = REP_TIERS.length - 1; i > tier.tier; i--) {
        if (potentialRam >= tierRamCosts[i]) {
          ns.tprint(
            `INFO: Upgrading rep daemon from ${tier.name} to ${REP_TIERS[i].name}`
          );
          ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 }, ...spawnArgs);
          return;
        }
      }
    }

    if (!oneShot) {
      ns.print(
        `\n${COLORS.dim}Next check in ${interval / 1000}s...${COLORS.reset}`
      );
      await ns.sleep(interval);
    }
  } while (!getConfigBool(ns, "rep", "oneShot", false));
}

// === MAIN ===

/** Build args array for respawning — only structural flags that affect RAM */
function buildSpawnArgs(tier: string): string[] {
  const args: string[] = [];
  if (tier) args.push("--tier", tier);
  return args;
}

export async function main(ns: NS): Promise<void> {
  ns.ramOverride(5); // Start cheap so we can always launch
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "rep", {
    faction: "",
    noWork: "false",
    noKill: "false",
    interval: "2000",
    oneShot: "false",
  });

  const flags = ns.flags([
    ["tier", ""],
  ]) as {
    tier: string;
    _: string[];
  };

  const targetFactionOverride = getConfigString(ns, "rep", "faction", "");
  const noWork = getConfigBool(ns, "rep", "noWork", false);
  const noKill = getConfigBool(ns, "rep", "noKill", false);
  const forcedTierName = flags.tier as RepTierName | "";
  const interval = getConfigNumber(ns, "rep", "interval", 2000);
  const oneShot = getConfigBool(ns, "rep", "oneShot", false);
  const spawnArgs = buildSpawnArgs(flags.tier);

  // Check SF4 level
  const sf4Level = ns.getResetInfo().ownedSF.get(4) ?? 0;

  // Calculate actual RAM cost for each tier dynamically
  const tierRamCosts = calculateAllTierRamCosts(ns);

  // Calculate potential RAM (current script + killable scripts)
  const currentScriptRam = 5; // Our bootstrap RAM
  let potentialRam: number;

  if (noKill) {
    // Only use currently available RAM
    potentialRam =
      ns.getServerMaxRam("home") -
      ns.getServerUsedRam("home") +
      currentScriptRam;
  } else {
    // Include RAM from killable scripts
    potentialRam = calcAvailableAfterKills(ns) + currentScriptRam;
  }

  // Select tier (forced or auto)
  let selectedTier: RepTierConfig;
  let requiredRam: number;

  if (forcedTierName) {
    const forcedIndex = REP_TIERS.findIndex((t) => t.name === forcedTierName);
    if (forcedIndex >= 0) {
      selectedTier = REP_TIERS[forcedIndex];
      requiredRam = tierRamCosts[forcedIndex];
      ns.tprint(`INFO: Rep daemon: forced ${selectedTier.name} tier`);
    } else {
      ns.tprint(`WARN: Unknown tier "${forcedTierName}", using auto-select`);
      const result = selectBestTier(potentialRam, sf4Level, tierRamCosts);
      selectedTier = result.tier;
      requiredRam = result.ramCost;
    }
  } else {
    const result = selectBestTier(potentialRam, sf4Level, tierRamCosts);
    selectedTier = result.tier;
    requiredRam = result.ramCost;
  }

  // Free RAM if needed (unless --no-kill)
  const currentlyAvailable =
    ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam;

  if (requiredRam > currentlyAvailable && !noKill) {
    ns.tprint(
      `INFO: Killing lower-priority scripts to reach ${selectedTier.name} tier`
    );
    freeRamForTarget(ns, requiredRam);
  }

  // Upgrade RAM allocation
  if (selectedTier.tier > 0) {
    const actual = ns.ramOverride(requiredRam);
    if (actual < requiredRam) {
      ns.tprint(
        `WARN: Could not allocate ${ns.format.ram(requiredRam)} RAM, ` +
          `got ${ns.format.ram(actual)}. Downgrading tier.`
      );
      // Find the tier we can actually run
      const result = selectBestTier(actual, sf4Level, tierRamCosts);
      selectedTier = result.tier;
      requiredRam = result.ramCost;
      ns.ramOverride(requiredRam);
    }
  }

  ns.tprint(
    `INFO: Rep daemon: ${selectedTier.name} tier (${ns.format.ram(requiredRam)} RAM)`
  );

  // Run appropriate mode
  if (selectedTier.tier === 0) {
    await runLiteMode(ns, requiredRam);
  } else if (selectedTier.tier <= 2) {
    await runBasicMode(
      ns,
      selectedTier,
      requiredRam,
      tierRamCosts,
      spawnArgs
    );
  } else {
    await runFullMode(
      ns,
      selectedTier,
      requiredRam,
      tierRamCosts,
      spawnArgs
    );
  }
}
