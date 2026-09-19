/**
 * Home Upgrade Daemon (Tiered)
 *
 * Two-tier daemon that monitors and auto-upgrades home server RAM and cores.
 *
 *   Tier 0 (monitor): ~3 GB  - Reads home stats, publishes status
 *   Tier 1 (auto):    ~5 GB  - Auto-purchases RAM/core upgrades via budget
 *
 * Usage:
 *   run daemons/home.js
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { publishStatus } from "/lib/ports";
import { writeDefaultConfig, getConfigNumber, getConfigBool } from "/lib/config";
import { STATUS_PORTS, HomeStatus } from "/types/ports";
import { getBudgetBalance, notifyPurchase, reportCap, signalDone } from "/lib/budget";

const C = COLORS;

// === TIER DEFINITIONS ===

const BASE_SCRIPT_COST = 1.6;
const RAM_BUFFER_PERCENT = 0.05;

interface HomeTierConfig {
  tier: number;
  name: "monitor" | "auto";
  functions: string[];
  features: string[];
}

const HOME_TIERS: HomeTierConfig[] = [
  {
    tier: 0,
    name: "monitor",
    functions: [
      "getServer",
      "singularity.getUpgradeHomeRamCost",
      "singularity.getUpgradeHomeCoresCost",
    ],
    features: ["home stats", "upgrade costs"],
  },
  {
    tier: 1,
    name: "auto",
    functions: [
      "singularity.upgradeHomeRam",
      "singularity.upgradeHomeCores",
    ],
    features: ["auto-purchase RAM", "auto-purchase cores"],
  },
];

// Base functions used by all tiers
const BASE_FUNCTIONS = [
  "getServerMaxRam",
  "getServerUsedRam",
  "getPlayer",
  "getPortHandle",
  "fileExists",
];

const MAX_HOME_RAM = Math.pow(2, 30); // 1 PB — game limit
const MAX_HOME_CORES = 8;

// === TIER SELECTION ===

function calculateTierRam(ns: NS, tierIndex: number): number {
  let ram = BASE_SCRIPT_COST;
  for (const fn of BASE_FUNCTIONS) {
    ram += ns.getFunctionRamCost(fn);
  }
  for (let i = 0; i <= tierIndex; i++) {
    for (const fn of HOME_TIERS[i].functions) {
      ram += ns.getFunctionRamCost(fn);
    }
  }
  ram *= (1 + RAM_BUFFER_PERCENT);
  return Math.ceil(ram * 10) / 10;
}

function selectBestTier(potentialRam: number, tierRamCosts: number[]): { tier: HomeTierConfig; ramCost: number } {
  let bestTierIndex = 0;
  for (let i = HOME_TIERS.length - 1; i >= 0; i--) {
    if (potentialRam >= tierRamCosts[i]) {
      bestTierIndex = i;
      break;
    }
  }
  return { tier: HOME_TIERS[bestTierIndex], ramCost: tierRamCosts[bestTierIndex] };
}

function getAvailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = 0; i <= tier; i++) {
    features.push(...HOME_TIERS[i].features);
  }
  return features;
}

function getUnavailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = tier + 1; i < HOME_TIERS.length; i++) {
    features.push(...HOME_TIERS[i].features);
  }
  return features;
}

// === STATE ===

let ramUpgradesBought = 0;
let coreUpgradesBought = 0;
let totalSpent = 0;

// === DAEMON ===

/** @ram 5 */
export async function main(ns: NS): Promise<void> {
  ns.ramOverride(5);
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "home", {
    interval: "10000",
    autoBuy: "true",
  });

  const tierRamCosts = HOME_TIERS.map((_, i) => calculateTierRam(ns, i));
  const currentScriptRam = 5;
  const potentialRam = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam;
  const { tier, ramCost } = selectBestTier(potentialRam, tierRamCosts);

  // Re-override to actual calculated RAM
  if (ramCost > currentScriptRam) {
    const actual = ns.ramOverride(ramCost);
    if (actual < ramCost) {
      ns.tprint(`WARN: Home daemon could not allocate ${ns.format.ram(ramCost)}, got ${ns.format.ram(actual)}. Running tier 0.`);
      const fallback = selectBestTier(actual, tierRamCosts);
      ns.ramOverride(fallback.ramCost);
    }
  }

  ns.print(`${C.cyan}Home daemon started${C.reset} — Tier ${tier.tier}: ${tier.name} (${ramCost.toFixed(1)}GB)`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const interval = getConfigNumber(ns, "home", "interval", 10000);
    const autoBuy = getConfigBool(ns, "home", "autoBuy", true);

    // Read home server info
    const server = ns.getServer("home");
    const currentRam = server.maxRam;
    const currentCores = server.cpuCores;
    const ramAtMax = currentRam >= MAX_HOME_RAM;
    const coresAtMax = currentCores >= MAX_HOME_CORES;
    const allMaxed = ramAtMax && coresAtMax;

    // Get upgrade costs
    const ramUpgradeCost = ramAtMax ? null : ns.singularity.getUpgradeHomeRamCost();
    const coreUpgradeCost = coresAtMax ? null : ns.singularity.getUpgradeHomeCoresCost();

    // Report remaining cost cap to budget daemon
    if (!allMaxed) {
      let remainingCost = 0;
      if (ramUpgradeCost !== null) remainingCost += ramUpgradeCost;
      if (coreUpgradeCost !== null) remainingCost += coreUpgradeCost;
      if (remainingCost > 0) {
        reportCap(ns, "home", remainingCost);
      }
    }

    // Tier 1: Auto-purchase upgrades
    if (tier.tier >= 1 && autoBuy && !allMaxed) {
      const budget = getBudgetBalance(ns, "home");

      // RAM upgrades first (more impactful)
      if (!ramAtMax && ramUpgradeCost !== null && ramUpgradeCost <= budget) {
        const cash = ns.getPlayer().money;
        if (cash >= ramUpgradeCost) {
          const success = ns.singularity.upgradeHomeRam();
          if (success) {
            notifyPurchase(ns, "home", ramUpgradeCost, `RAM → ${ns.format.ram(currentRam * 2)}`);
            ramUpgradesBought++;
            totalSpent += ramUpgradeCost;
            ns.print(`  ${C.green}BOUGHT${C.reset} RAM upgrade → ${ns.format.ram(currentRam * 2)}`);
          }
        }
      }

      // Core upgrades second
      if (!coresAtMax && coreUpgradeCost !== null) {
        const budgetAfterRam = getBudgetBalance(ns, "home");
        if (coreUpgradeCost <= budgetAfterRam) {
          const cash = ns.getPlayer().money;
          if (cash >= coreUpgradeCost) {
            const success = ns.singularity.upgradeHomeCores();
            if (success) {
              notifyPurchase(ns, "home", coreUpgradeCost, `Cores → ${currentCores + 1}`);
              coreUpgradesBought++;
              totalSpent += coreUpgradeCost;
              ns.print(`  ${C.green}BOUGHT${C.reset} Core upgrade → ${currentCores + 1}`);
            }
          }
        }
      }
    }

    // Re-read after potential purchases
    const updatedServer = ns.getServer("home");
    const updatedRam = updatedServer.maxRam;
    const updatedCores = updatedServer.cpuCores;
    const updatedRamAtMax = updatedRam >= MAX_HOME_RAM;
    const updatedCoresAtMax = updatedCores >= MAX_HOME_CORES;
    const updatedAllMaxed = updatedRamAtMax && updatedCoresAtMax;

    const updatedRamCost = updatedRamAtMax ? null : ns.singularity.getUpgradeHomeRamCost();
    const updatedCoreCost = updatedCoresAtMax ? null : ns.singularity.getUpgradeHomeCoresCost();

    // Next tier RAM
    const nextTierRam = tier.tier < HOME_TIERS.length - 1
      ? tierRamCosts[tier.tier + 1]
      : null;

    // Build status
    const status: HomeStatus = {
      tier: tier.tier,
      tierName: tier.name,
      currentRamUsage: ramCost,
      nextTierRam,
      canUpgrade: nextTierRam !== null && potentialRam < nextTierRam,
      availableFeatures: getAvailableFeatures(tier.tier),
      unavailableFeatures: getUnavailableFeatures(tier.tier),

      currentRam: updatedRam,
      currentRamFormatted: ns.format.ram(updatedRam),
      maxRam: MAX_HOME_RAM,
      currentCores: updatedCores,
      maxCores: MAX_HOME_CORES,

      ramUpgradeCost: updatedRamCost,
      ramUpgradeCostFormatted: updatedRamCost !== null ? ns.format.number(updatedRamCost) : null,
      ramUpgradeTarget: updatedRamAtMax ? null : updatedRam * 2,
      ramUpgradeTargetFormatted: updatedRamAtMax ? null : ns.format.ram(updatedRam * 2),
      coreUpgradeCost: updatedCoreCost,
      coreUpgradeCostFormatted: updatedCoreCost !== null ? ns.format.number(updatedCoreCost) : null,
      ramAtMax: updatedRamAtMax,
      coresAtMax: updatedCoresAtMax,
      allMaxed: updatedAllMaxed,

      autoBuy: autoBuy && tier.tier >= 1,
      ramUpgradesBought,
      coreUpgradesBought,
      totalSpent,
      totalSpentFormatted: ns.format.number(totalSpent),
    };

    publishStatus(ns, STATUS_PORTS.home, status);

    // Print summary
    ns.clearLog();
    const mode = status.autoBuy ? `${C.green}AUTO${C.reset}` : `${C.yellow}MONITOR${C.reset}`;
    ns.print(`${C.cyan}═══ Home Daemon ═══${C.reset}  ${mode}  T${tier.tier}:${tier.name}`);
    ns.print(`  RAM:   ${status.currentRamFormatted}${updatedRamAtMax ? ` ${C.green}MAXED${C.reset}` : ` → ${status.ramUpgradeTargetFormatted} (${status.ramUpgradeCostFormatted})`}`);
    ns.print(`  Cores: ${updatedCores}/${MAX_HOME_CORES}${updatedCoresAtMax ? ` ${C.green}MAXED${C.reset}` : ` (${status.coreUpgradeCostFormatted})`}`);
    if (totalSpent > 0) {
      ns.print(`  Spent: ${status.totalSpentFormatted} (${ramUpgradesBought} RAM, ${coreUpgradesBought} cores)`);
    }

    // Auto-exit when fully maxed
    if (updatedAllMaxed) {
      signalDone(ns, "home");
      ns.print(`\n${C.green}Home server fully maxed! Daemon exiting.${C.reset}`);
      return;
    }

    await ns.sleep(interval);
  }
}
