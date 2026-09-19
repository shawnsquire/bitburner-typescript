/**
 * Home Upgrade Daemon (Tiered)
 *
 * Two-tier daemon that monitors and auto-upgrades home server RAM and cores.
 * Both tiers use ns.singularity.* functions, whose RAM cost is 16x normal
 * below Source-File 4 level 3 (4x at level 2, 1x at level 3 or inside
 * BitNode 4) — see `npm run ram -- --sf4 <level> daemons/home.js` for the
 * real cost at a given level; it ranges roughly 8-15GB at SF4 level 3 up to
 * 55-150GB at level 0-1.
 *
 *   Tier 0 (monitor): reads home stats and upgrade costs, publishes status
 *   Tier 1 (auto):     also auto-purchases RAM/core upgrades via budget
 *
 * Without Source-File 4 at all, the daemon runs a third, much cheaper
 * (~5.5GB) read-only mode that never touches ns.singularity.* — see
 * NO_SINGULARITY_TIER.
 *
 * Usage:
 *   run daemons/home.js
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { publishStatus } from "/lib/ports";
import { writeDefaultConfig, getConfigNumber, getConfigBool } from "/lib/config";
import { STATUS_PORTS, HomeStatus } from "/types/ports";
import { getBudgetBalance, notifyPurchase, reportCap, reportNext, signalDone } from "/lib/budget";

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
  "getResetInfo",
];

const MAX_HOME_RAM = Math.pow(2, 30); // 1 EB (2^30 GB) — game limit, ServerConstants.HomeComputerMaxRam
const MAX_HOME_CORES = 8;

// Under the "restrictHomePCUpgrade" BitNode option the caps are much lower
// (see BitNodeBooleanOptions doc comment in NetscriptDefinitions.d.ts).
const RESTRICTED_MAX_HOME_RAM = 128;
const RESTRICTED_MAX_HOME_CORES = 1;

// Used when Source-File 4 is unavailable. We deliberately never call any
// ns.singularity.* function in this mode: the game charges/RAM-checks a
// function's cost before its body runs (even one that's about to throw for
// missing access), so budgeting as if tier 0 applied (which includes two
// singularity cost lookups, ~48GB combined at the 16x pre-SF4-3 multiplier)
// could RAM-crash the daemon instead of just running read-only.
const NO_SINGULARITY_TIER: HomeTierConfig = {
  tier: 0,
  name: "monitor",
  functions: ["getServer"],
  features: ["home stats"],
};

/**
 * Run a singularity call defensively. Every ns.singularity.* function throws
 * if the player lacks Source-File 4 (and isn't inside BitNode 4); this lets
 * the daemon degrade to read-only monitoring instead of crashing.
 */
function trySingularity<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

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

function calculateNoSingularityRam(ns: NS): number {
  let ram = BASE_SCRIPT_COST;
  for (const fn of BASE_FUNCTIONS) {
    ram += ns.getFunctionRamCost(fn);
  }
  for (const fn of NO_SINGULARITY_TIER.functions) {
    ram += ns.getFunctionRamCost(fn);
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

  // Detect Source-File 4 access once up front, the same way the game's own
  // checkSingularityAccess() does (canAccessBitNodeFeature(4)): current
  // BitNode is 4, or SF4 is active from a prior run. Without this access
  // every ns.singularity.* call throws, so the daemon must stay in
  // read-only monitor mode rather than attempt the "auto" tier.
  //
  // This must NOT be tested by actually calling a ns.singularity.* function:
  // the game charges/checks that function's RAM cost (at whatever SF4-level
  // multiplier currently applies, up to 16x) before its body even runs, and
  // at this point ramOverride is still the flat 5GB set above — a real probe
  // call could RAM-crash the daemon instead of just detecting no access.
  const resetInfo = ns.getResetInfo();
  const hasSingularity = resetInfo.currentNode === 4 || (resetInfo.ownedSF.get(4) ?? 0) > 0;
  if (!hasSingularity) {
    ns.tprint(
      "INFO: Home daemon: Source-File 4 not available — running in read-only monitor mode (cannot auto-buy RAM/cores).",
    );
  }

  const restrictedUpgrades = resetInfo.bitNodeOptions.restrictHomePCUpgrade;
  const maxHomeRam = restrictedUpgrades ? RESTRICTED_MAX_HOME_RAM : MAX_HOME_RAM;
  const maxHomeCores = restrictedUpgrades ? RESTRICTED_MAX_HOME_CORES : MAX_HOME_CORES;

  const tierRamCosts = HOME_TIERS.map((_, i) => calculateTierRam(ns, i));
  const currentScriptRam = 5;
  const potentialRam = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam;
  const { tier, ramCost } = hasSingularity
    ? selectBestTier(potentialRam, tierRamCosts)
    : { tier: NO_SINGULARITY_TIER, ramCost: calculateNoSingularityRam(ns) };

  // Re-override to actual calculated RAM
  if (ramCost > currentScriptRam) {
    const actual = ns.ramOverride(ramCost);
    if (actual < ramCost) {
      ns.tprint(`WARN: Home daemon could not allocate ${ns.format.ram(ramCost)}, got ${ns.format.ram(actual)}. Running tier 0.`);
      // Fall back further only within the tiers we were already allowed to use.
      if (hasSingularity) {
        const fallback = selectBestTier(actual, tierRamCosts);
        ns.ramOverride(fallback.ramCost);
      }
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
    const ramAtMax = currentRam >= maxHomeRam;
    const coresAtMax = currentCores >= maxHomeCores;
    const allMaxed = ramAtMax && coresAtMax;

    // Get upgrade costs (null when maxed, or when Source-File 4 is unavailable).
    // Only ever call the singularity functions when hasSingularity is true —
    // this daemon's RAM budget in the !hasSingularity case doesn't include them.
    const ramUpgradeCost = (!hasSingularity || ramAtMax) ? null : trySingularity(() => ns.singularity.getUpgradeHomeRamCost());
    const coreUpgradeCost = (!hasSingularity || coresAtMax) ? null : trySingularity(() => ns.singularity.getUpgradeHomeCoresCost());

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
          const success = trySingularity(() => ns.singularity.upgradeHomeRam()) ?? false;
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
            const success = trySingularity(() => ns.singularity.upgradeHomeCores()) ?? false;
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
    const updatedRamAtMax = updatedRam >= maxHomeRam;
    const updatedCoresAtMax = updatedCores >= maxHomeCores;
    const updatedAllMaxed = updatedRamAtMax && updatedCoresAtMax;

    const updatedRamCost = (!hasSingularity || updatedRamAtMax) ? null : trySingularity(() => ns.singularity.getUpgradeHomeRamCost());
    const updatedCoreCost = (!hasSingularity || updatedCoresAtMax) ? null : trySingularity(() => ns.singularity.getUpgradeHomeCoresCost());

    // Tell the budget daemon what we would buy next (RAM before cores, as above) so it
    // can save toward it. Same gate as buying; anything else clears the item.
    if (tier.tier >= 1 && autoBuy && !updatedAllMaxed && !updatedRamAtMax && updatedRamCost !== null) {
      reportNext(ns, "home", updatedRamCost, `Home RAM ${ns.format.ram(updatedRam * 2)}`);
    } else if (tier.tier >= 1 && autoBuy && !updatedAllMaxed && updatedCoreCost !== null) {
      reportNext(ns, "home", updatedCoreCost, `Home cores ${updatedCores + 1}`);
    } else {
      reportNext(ns, "home", 0, "");
    }

    // Next tier RAM. Only meaningful when SF4 is available — without it,
    // buying more home RAM alone will never unlock the "auto" tier.
    const nextTierRam = hasSingularity && tier.tier < HOME_TIERS.length - 1
      ? tierRamCosts[tier.tier + 1]
      : null;

    // Build status
    const status: HomeStatus = {
      tier: tier.tier,
      tierName: tier.name,
      currentRamUsage: ramCost,
      nextTierRam,
      canUpgrade: nextTierRam !== null && potentialRam < nextTierRam,
      availableFeatures: hasSingularity ? getAvailableFeatures(tier.tier) : NO_SINGULARITY_TIER.features,
      unavailableFeatures: hasSingularity
        ? getUnavailableFeatures(tier.tier)
        : HOME_TIERS.flatMap(t => t.features).filter(f => !NO_SINGULARITY_TIER.features.includes(f)),

      currentRam: updatedRam,
      currentRamFormatted: ns.format.ram(updatedRam),
      maxRam: maxHomeRam,
      currentCores: updatedCores,
      maxCores: maxHomeCores,

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
    ns.print(`  Cores: ${updatedCores}/${maxHomeCores}${updatedCoresAtMax ? ` ${C.green}MAXED${C.reset}` : ` (${status.coreUpgradeCostFormatted})`}`);
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
