/**
 * Hacknet Server Daemon (Tiered)
 *
 * Manages Hacknet Servers (BN9 / SF9 unlocked) — purchases, upgrades, and hash spending.
 * Each ns.hacknet.* function costs 0.5 GB (v3.0+), so tiers gate both features and RAM.
 *
 *   Tier 0 (monitor):      ~8 GB   - Reads stats, publishes status, evaluates upgrade ROI
 *   Tier 1 (auto-buy):     ~11 GB  - Purchases nodes & upgrades via budget
 *   Tier 2 (hash-spender): ~12 GB  - Auto-spends hashes per strategy
 *
 * Usage:
 *   run daemons/hacknet.js
 */
import { NS, NodeStats } from "@ns";
import { COLORS } from "/lib/utils";
import { publishStatus, peekStatus } from "/lib/ports";
import { writeDefaultConfig, getConfigNumber, getConfigBool, getConfigString } from "/lib/config";
import { STATUS_PORTS, HacknetStatus, HacknetServerInfo, HackStatus, HashSpendStrategy } from "/types/ports";
import { getBudgetBalance, notifyPurchase, reportCap, getPaybackHorizon } from "/lib/budget";
import {
  isHashSpendStrategy,
  resolveHashSpend,
  SERVER_TARGET_STRATEGIES,
  HASH_SELL_MONEY,
  MONEY_PER_HASH,
  paybackSeconds,
  estimateNodeMoneyRate,
  estimateServerHashRate,
  partitionByPayback,
} from "/controllers/hacknet";
import { formatTime } from "/lib/utils";

const C = COLORS;

// === TIER DEFINITIONS ===

const BASE_SCRIPT_COST = 1.6;
const RAM_BUFFER_PERCENT = 0.05;

interface HacknetTierConfig {
  tier: number;
  name: "monitor" | "auto-buy" | "hash-spender";
  functions: string[];
  features: string[];
}

const HACKNET_TIERS: HacknetTierConfig[] = [
  {
    tier: 0,
    name: "monitor",
    functions: [
      "hacknet.numNodes",
      "hacknet.maxNumNodes",
      "hacknet.numHashes",
      "hacknet.hashCapacity",
      "hacknet.getNodeStats",
      "hacknet.getPurchaseNodeCost",
      "hacknet.getLevelUpgradeCost",
      "hacknet.getRamUpgradeCost",
      "hacknet.getCoreUpgradeCost",
      "hacknet.getCacheUpgradeCost",
      // Both cost 0 GB; listed so a future RAM table change is caught by the tier check.
      "formulas.hacknetServers.hashGainRate",
      "formulas.hacknetNodes.moneyGainRate",
    ],
    features: ["server stats", "hash tracking", "upgrade costs"],
  },
  {
    tier: 1,
    name: "auto-buy",
    functions: [
      "hacknet.purchaseNode",
      "hacknet.upgradeLevel",
      "hacknet.upgradeRam",
      "hacknet.upgradeCore",
      "hacknet.upgradeCache",
    ],
    features: ["auto-purchase nodes", "auto-upgrade nodes", "ROI optimization"],
  },
  {
    tier: 2,
    name: "hash-spender",
    functions: [
      "hacknet.hashCost",
      "hacknet.spendHashes",
    ],
    features: ["auto-spend hashes per strategy"],
  },
];

const BASE_FUNCTIONS = [
  "getServerMaxRam",
  "getServerUsedRam",
  "getPlayer",
  "getPortHandle",
  "fileExists",
];

// === TIER SELECTION ===

function calculateTierRam(ns: NS, tierIndex: number): number {
  let ram = BASE_SCRIPT_COST;
  for (const fn of BASE_FUNCTIONS) {
    ram += ns.getFunctionRamCost(fn);
  }
  for (let i = 0; i <= tierIndex; i++) {
    for (const fn of HACKNET_TIERS[i].functions) {
      ram += ns.getFunctionRamCost(fn);
    }
  }
  ram *= (1 + RAM_BUFFER_PERCENT);
  return Math.ceil(ram * 10) / 10;
}

function selectBestTier(potentialRam: number, tierRamCosts: number[]): { tier: HacknetTierConfig; ramCost: number } {
  let bestTierIndex = 0;
  for (let i = HACKNET_TIERS.length - 1; i >= 0; i--) {
    if (potentialRam >= tierRamCosts[i]) {
      bestTierIndex = i;
      break;
    }
  }
  return { tier: HACKNET_TIERS[bestTierIndex], ramCost: tierRamCosts[bestTierIndex] };
}

function getAvailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = 0; i <= tier; i++) {
    features.push(...HACKNET_TIERS[i].features);
  }
  return features;
}

function getUnavailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = tier + 1; i < HACKNET_TIERS.length; i++) {
    features.push(...HACKNET_TIERS[i].features);
  }
  return features;
}

// === UPGRADE CANDIDATE EVALUATION ===

interface UpgradeCandidate {
  type: "new" | "level" | "ram" | "cores" | "cache";
  serverIndex: number;
  cost: number;
  roi: number; // marginal $/s per $ — higher is better
  marginalMoneyPerSec: number;
  paybackSec: number;
}

function getServerHashRate(ns: NS, level: number, ramUsed: number, ram: number, cores: number, mult: number): number {
  // Use formulas if available, otherwise estimate
  if (ns.fileExists("Formulas.exe", "home")) {
    return ns.formulas.hacknetServers.hashGainRate(level, ramUsed, ram, cores, mult);
  }
  return estimateServerHashRate(level, ramUsed, ram, cores, mult);
}

/**
 * Money per second a node or server configuration produces. Hacknet servers are valued
 * at the hash sell rate whatever the spend strategy; plain nodes (no hacknet servers in
 * this BitNode) produce money directly.
 */
function marginalMoneyRate(
  ns: NS, serverMode: boolean, level: number, ramUsed: number, ram: number, cores: number, mult: number,
): number {
  if (serverMode) return getServerHashRate(ns, level, ramUsed, ram, cores, mult) * MONEY_PER_HASH;
  if (ns.fileExists("Formulas.exe", "home")) {
    return ns.formulas.hacknetNodes.moneyGainRate(level, ram, cores, mult);
  }
  return estimateNodeMoneyRate(level, ram, cores, mult);
}

function evaluateUpgrades(ns: NS, mult: number, maxServers: number): UpgradeCandidate[] {
  const candidates: UpgradeCandidate[] = [];
  const numNodes = ns.hacknet.numNodes();
  // hashCapacity() is 0 without hacknet servers. Re-read here rather than once per tick:
  // the tick-level value is still 0 right after the first server is bought.
  const serverMode = ns.hacknet.hashCapacity() > 0;

  // Evaluate upgrading each existing server
  for (let i = 0; i < numNodes; i++) {
    const stats = ns.hacknet.getNodeStats(i);
    const used = stats.ramUsed ?? 0;
    const currentRate = marginalMoneyRate(ns, serverMode, stats.level, used, stats.ram, stats.cores, mult);

    // Level upgrade
    const levelCost = ns.hacknet.getLevelUpgradeCost(i, 1);
    if (isFinite(levelCost) && levelCost > 0) {
      const newRate = marginalMoneyRate(ns, serverMode, stats.level + 1, used, stats.ram, stats.cores, mult);
      const delta = newRate - currentRate;
      candidates.push({
        type: "level", serverIndex: i, cost: levelCost, roi: delta / levelCost,
        marginalMoneyPerSec: delta, paybackSec: paybackSeconds(levelCost, delta),
      });
    }

    // RAM upgrade (doubles RAM)
    const ramCost = ns.hacknet.getRamUpgradeCost(i, 1);
    if (isFinite(ramCost) && ramCost > 0) {
      const newRate = marginalMoneyRate(ns, serverMode, stats.level, used, stats.ram * 2, stats.cores, mult);
      const delta = newRate - currentRate;
      candidates.push({
        type: "ram", serverIndex: i, cost: ramCost, roi: delta / ramCost,
        marginalMoneyPerSec: delta, paybackSec: paybackSeconds(ramCost, delta),
      });
    }

    // Core upgrade
    const coreCost = ns.hacknet.getCoreUpgradeCost(i, 1);
    if (isFinite(coreCost) && coreCost > 0) {
      const newRate = marginalMoneyRate(ns, serverMode, stats.level, used, stats.ram, stats.cores + 1, mult);
      const delta = newRate - currentRate;
      candidates.push({
        type: "cores", serverIndex: i, cost: coreCost, roi: delta / coreCost,
        marginalMoneyPerSec: delta, paybackSec: paybackSeconds(coreCost, delta),
      });
    }

    // Cache upgrade (no hash rate change, but prevents overflow)
    const cacheCost = ns.hacknet.getCacheUpgradeCost(i, 1);
    if (isFinite(cacheCost) && cacheCost > 0) {
      // Cache has 0 production ROI but gets priority when capacity is tight
      candidates.push({
        type: "cache", serverIndex: i, cost: cacheCost, roi: 0, marginalMoneyPerSec: 0, paybackSec: Infinity,
      });
    }
  }

  // Evaluate buying a new server
  if (numNodes < maxServers) {
    const newNodeCost = ns.hacknet.getPurchaseNodeCost();
    if (isFinite(newNodeCost) && newNodeCost > 0) {
      // New node starts at level 1, 0 used, 1 GB RAM, 1 core
      const newRate = marginalMoneyRate(ns, serverMode, 1, 0, 1, 1, mult);
      candidates.push({
        type: "new", serverIndex: -1, cost: newNodeCost, roi: newRate / newNodeCost,
        marginalMoneyPerSec: newRate, paybackSec: paybackSeconds(newNodeCost, newRate),
      });
    }
  }

  // Sort by ROI descending (cache upgrades sink to bottom unless forced)
  candidates.sort((a, b) => b.roi - a.roi);
  return candidates;
}

// === STATE ===

let nodesBought = 0;
let upgradesBought = 0;
let totalSpent = 0;
let hashesSpentTotal = 0;
let moneyEarnedFromHashes = 0;
/** Hack daemon status older than this is treated as absent when resolving a fallback target. */
const HACK_STATUS_MAX_AGE_MS = 60_000;
/** Last spend-blocked reason printed to the terminal, so the warning fires once per change. */
let lastSpendWarning: string | null = null;

// === DAEMON ===

/** @ram 8 */
export async function main(ns: NS): Promise<void> {
  ns.ramOverride(8);
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "hacknet", {
    interval: "5000",
    autoBuy: "true",
    maxServers: "20",
    spendThreshold: "0.5",
    reserveHashes: "0",
    allowWorkers: "false",
    spendStrategy: "money",
    spendTarget: "",
  });

  const tierRamCosts = HACKNET_TIERS.map((_, i) => calculateTierRam(ns, i));
  // Must match the literal ns.ramOverride(8) call above — that's what the game's static
  // analyzer actually reserved for this script at launch (see the syntactic-override rule:
  // a literal ns.ramOverride() as the first statement of main() pins the launch RAM cost).
  const currentScriptRam = 8;
  let { tier, ramCost } = selectBestTier(
    ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam,
    tierRamCosts,
  );

  if (ramCost > currentScriptRam) {
    const actual = ns.ramOverride(ramCost);
    if (actual < ramCost) {
      ns.tprint(`WARN: Hacknet daemon could not allocate ${ns.format.ram(ramCost)}, got ${ns.format.ram(actual)}. Running tier 0.`);
      const fallback = selectBestTier(actual, tierRamCosts);
      ns.ramOverride(fallback.ramCost);
      tier = fallback.tier;
      ramCost = fallback.ramCost;
    }
  }

  ns.print(`${C.cyan}Hacknet daemon started${C.reset} — Tier ${tier.tier}: ${tier.name} (${ramCost.toFixed(1)}GB)`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const interval = getConfigNumber(ns, "hacknet", "interval", 5000);
    const autoBuy = getConfigBool(ns, "hacknet", "autoBuy", true);
    const maxServers = getConfigNumber(ns, "hacknet", "maxServers", 20);
    const spendThreshold = getConfigNumber(ns, "hacknet", "spendThreshold", 0.5);
    const reserveHashes = getConfigNumber(ns, "hacknet", "reserveHashes", 0);
    const rawStrategy = getConfigString(ns, "hacknet", "spendStrategy", "money");
    const spendStrategy: HashSpendStrategy = isHashSpendStrategy(rawStrategy) ? rawStrategy : "money";
    const spendTargetConfig = getConfigString(ns, "hacknet", "spendTarget", "");

    // Read hacknet state
    const numNodes = ns.hacknet.numNodes();
    const maxNodes = ns.hacknet.maxNumNodes();
    const currentHashes = ns.hacknet.numHashes();
    const hashCapacity = ns.hacknet.hashCapacity();
    const hashUtilization = hashCapacity > 0 ? currentHashes / hashCapacity : 0;
    const player = ns.getPlayer();
    const hacknetMult = player.mults.hacknet_node_money;

    // Gather per-server stats
    const servers: HacknetServerInfo[] = [];
    let totalHashRate = 0;
    let totalProduction = 0;
    for (let i = 0; i < numNodes; i++) {
      const stats: NodeStats = ns.hacknet.getNodeStats(i);
      const hashRate = getServerHashRate(ns, stats.level, stats.ramUsed ?? 0, stats.ram, stats.cores, hacknetMult);
      totalHashRate += hashRate;
      totalProduction += stats.totalProduction;
      servers.push({
        index: i,
        level: stats.level,
        ram: stats.ram,
        cores: stats.cores,
        cache: stats.cache ?? 0,
        hashRate,
        hashRateFormatted: ns.format.number(hashRate, 3) + " h/s",
        production: stats.totalProduction,
        productionFormatted: ns.format.number(stats.totalProduction),
      });
    }

    // Next node cost
    const nextNodeCost = numNodes < maxNodes ? ns.hacknet.getPurchaseNodeCost() : null;

    // Payback ceiling from the budget daemon (Infinity when it is absent or disabled).
    const horizon = getPaybackHorizon(ns);

    // Tier 1: Auto-buy — batch purchase upgrades within budget and the payback ceiling
    let purchasesThisTick = 0;
    if (tier.tier >= 1 && autoBuy) {
      let keepBuying = true;
      while (keepBuying && purchasesThisTick < 100) {
        const currentNodes = ns.hacknet.numNodes();
        if (currentNodes === 0) {
          // No nodes yet — buy the first one
          const cost = ns.hacknet.getPurchaseNodeCost();
          const budget = getBudgetBalance(ns, "hacknet");
          if (cost <= budget && cost <= ns.getPlayer().money) {
            const result = ns.hacknet.purchaseNode();
            if (result !== -1) {
              notifyPurchase(ns, "hacknet", cost, "First hacknet server");
              totalSpent += cost;
              nodesBought++;
              purchasesThisTick++;
              ns.print(`  ${C.green}BOUGHT${C.reset} First hacknet server (${ns.format.number(cost)})`);
              continue; // Re-evaluate with the new node
            }
          }
          break; // Can't afford first node
        }

        // Re-evaluate candidates each iteration (costs change after purchases)
        const currentCandidates = evaluateUpgrades(ns, hacknetMult, maxServers);
        if (currentCandidates.length === 0) break;

        // If hash utilization > 90%, prioritize cache upgrades
        if (hashUtilization > 0.9) {
          const cacheIdx = currentCandidates.findIndex(c => c.type === "cache");
          if (cacheIdx > 0) {
            const [cacheUpgrade] = currentCandidates.splice(cacheIdx, 1);
            currentCandidates.unshift(cacheUpgrade);
          }
        }

        const budget = getBudgetBalance(ns, "hacknet");
        keepBuying = false;

        const { eligible } = partitionByPayback(currentCandidates, horizon, hashUtilization, currentNodes);
        for (const candidate of eligible) {
          if (candidate.cost > budget) continue;
          if (candidate.cost > ns.getPlayer().money) continue;

          let success = false;
          let reason = "";
          switch (candidate.type) {
            case "new":
              success = ns.hacknet.purchaseNode() !== -1;
              reason = `New server #${currentNodes}`;
              if (success) nodesBought++;
              break;
            case "level":
              success = ns.hacknet.upgradeLevel(candidate.serverIndex, 1);
              reason = `Level +1 on #${candidate.serverIndex}`;
              if (success) upgradesBought++;
              break;
            case "ram":
              success = ns.hacknet.upgradeRam(candidate.serverIndex, 1);
              reason = `RAM x2 on #${candidate.serverIndex}`;
              if (success) upgradesBought++;
              break;
            case "cores":
              success = ns.hacknet.upgradeCore(candidate.serverIndex, 1);
              reason = `Core +1 on #${candidate.serverIndex}`;
              if (success) upgradesBought++;
              break;
            case "cache":
              success = ns.hacknet.upgradeCache(candidate.serverIndex, 1);
              reason = `Cache +1 on #${candidate.serverIndex}`;
              if (success) upgradesBought++;
              break;
          }
          if (success) {
            notifyPurchase(ns, "hacknet", candidate.cost, reason);
            totalSpent += candidate.cost;
            purchasesThisTick++;
            keepBuying = true; // Try again with remaining budget
            break; // Re-evaluate candidates since costs changed
          }
        }
        if (keepBuying) await ns.sleep(5); // Yield between purchases
      }
      if (purchasesThisTick > 1) {
        ns.print(`  ${C.green}BOUGHT${C.reset} ${purchasesThisTick} upgrades this tick (${ns.format.number(totalSpent)})`);
      }
    }

    // Evaluate remaining candidates for next target + cheapest upgrade display
    const remainingCandidates = ns.hacknet.numNodes() > 0 ? evaluateUpgrades(ns, hacknetMult, maxServers) : [];

    let cheapestUpgrade: HacknetStatus["cheapestUpgrade"] = null;
    const upgradeOnly = remainingCandidates.filter(c => c.type !== "new" && isFinite(c.cost));
    if (upgradeOnly.length > 0) {
      const cheapest = upgradeOnly.reduce((a, b) => a.cost < b.cost ? a : b);
      cheapestUpgrade = {
        type: cheapest.type,
        serverIndex: cheapest.serverIndex,
        cost: cheapest.cost,
        costFormatted: ns.format.number(cheapest.cost),
      };
    }

    // Best remaining candidate the ceiling allows = next target
    const payback = partitionByPayback(remainingCandidates, horizon, hashUtilization, ns.hacknet.numNodes());
    const bestRemaining = payback.eligible.length > 0 ? payback.eligible[0] : null;
    const nextTarget: HacknetStatus["nextTarget"] = bestRemaining ? {
      type: bestRemaining.type,
      serverIndex: bestRemaining.serverIndex,
      cost: bestRemaining.cost,
      costFormatted: ns.format.number(bestRemaining.cost),
      canAfford: bestRemaining.cost <= getBudgetBalance(ns, "hacknet") && bestRemaining.cost <= ns.getPlayer().money,
      roi: bestRemaining.roi,
    } : null;

    // Report remaining costs to budget
    if (tier.tier >= 1) {
      if (remainingCandidates.length > 0) {
        const totalRemainingCost = remainingCandidates.reduce((sum, c) => sum + (isFinite(c.cost) ? c.cost : 0), 0);
        if (totalRemainingCost > 0) {
          reportCap(ns, "hacknet", totalRemainingCost);
        }
      } else if (nextNodeCost !== null) {
        reportCap(ns, "hacknet", nextNodeCost);
      }
    }

    // Tier 2: Hash spending — spend hashes using configured strategy
    // "money" strategy always sells immediately; others wait for spendThreshold.
    // Server upgrades (reduce-security, increase-money) fall back to the hack daemon's
    // primary target when spendTarget is empty; company-favor needs spendTarget.
    const needsFallback = SERVER_TARGET_STRATEGIES.has(spendStrategy) && spendTargetConfig.trim() === "";
    const hackStatus = needsFallback ? peekStatus<HackStatus>(ns, STATUS_PORTS.hack, HACK_STATUS_MAX_AGE_MS) : null;
    const spendPlan = resolveHashSpend(spendStrategy, spendTargetConfig, hackStatus?.targets);
    let spendBlocked: string | null = spendPlan.reason;
    if (tier.tier >= 2 && hashCapacity > 0 && spendPlan.isValid) {
      const currentH = ns.hacknet.numHashes(); // Re-read after potential purchases
      const shouldSpend = spendStrategy === "money" || currentH / hashCapacity >= spendThreshold;
      if (shouldSpend) {
        // Most upgrades (all but "Sell for Money") scale in cost with each purchase
        // (costPerLevel), so hashCost must be re-read after every successful spend —
        // otherwise hashesSpentTotal undercounts and the loop's own affordability check
        // goes stale.
        let hashCost = ns.hacknet.hashCost(spendPlan.upgrade);
        while (ns.hacknet.numHashes() >= hashCost + reserveHashes) {
          if (ns.hacknet.spendHashes(spendPlan.upgrade, spendPlan.target ?? undefined)) {
            hashesSpentTotal += hashCost;
            if (spendStrategy === "money") {
              moneyEarnedFromHashes += HASH_SELL_MONEY;
            }
            hashCost = ns.hacknet.hashCost(spendPlan.upgrade);
          } else {
            // The game refused: bad target (not a foreign server / not a company), no
            // corporation, not in Bladeburner, ... The reason is in the script log.
            if (spendPlan.target !== null) {
              spendBlocked = `game rejected ${spendPlan.upgrade} on '${spendPlan.target}'`;
            } else {
              spendBlocked = `game rejected ${spendPlan.upgrade}`;
            }
            break;
          }
        }
      }
    }
    if (spendBlocked !== null && spendBlocked !== lastSpendWarning) {
      ns.tprint(`WARN: Hacknet hash spending skipped: ${spendBlocked}`);
    }
    lastSpendWarning = spendBlocked;

    // Next tier RAM
    const nextTierRam = tier.tier < HACKNET_TIERS.length - 1
      ? tierRamCosts[tier.tier + 1]
      : null;
    const currentPotentialRam = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + ramCost;

    // Re-read post-purchase state
    const updatedNodeCount = ns.hacknet.numNodes();
    const updatedHashes = ns.hacknet.numHashes();
    const updatedNextNodeCost = updatedNodeCount < maxNodes ? ns.hacknet.getPurchaseNodeCost() : null;

    // Build status
    const status: HacknetStatus = {
      tier: tier.tier,
      tierName: tier.name,
      currentRamUsage: ramCost,
      nextTierRam,
      canUpgrade: nextTierRam !== null && currentPotentialRam < nextTierRam,
      availableFeatures: getAvailableFeatures(tier.tier),
      unavailableFeatures: getUnavailableFeatures(tier.tier),

      serverCount: updatedNodeCount,
      maxServers: maxNodes,
      totalHashRate,
      totalHashRateFormatted: ns.format.number(totalHashRate, 3) + " h/s",
      currentHashes: updatedHashes,
      hashCapacity,
      hashUtilization: hashCapacity > 0 ? updatedHashes / hashCapacity : 0,
      totalProduction,
      cashPerSec: spendStrategy === "money" ? totalHashRate * MONEY_PER_HASH : 0,
      totalProductionFormatted: ns.format.number(totalProduction),

      nextNodeCost: updatedNextNodeCost,
      nextNodeCostFormatted: updatedNextNodeCost !== null ? ns.format.number(updatedNextNodeCost) : null,
      cheapestUpgrade,

      hashesSpentTotal,
      moneyEarnedFromHashes,
      moneyEarnedFormatted: ns.format.number(moneyEarnedFromHashes),
      spendStrategy,
      spendUpgrade: spendPlan.upgrade,
      spendTarget: spendPlan.target,
      spendTargetSource: spendPlan.targetSource,
      spendBlocked,
      autoBuy: autoBuy && tier.tier >= 1,

      nextTarget,
      purchasesThisTick,
      skippedForPayback: payback.skipped,
      bestPaybackSec: payback.bestSkippedSec,
      paybackHorizon: isFinite(horizon) ? horizon : null,

      servers,

      nodesBought,
      upgradesBought,
      totalSpent,
      totalSpentFormatted: ns.format.number(totalSpent),
    };

    publishStatus(ns, STATUS_PORTS.hacknet, status);

    // Print summary
    ns.clearLog();
    const mode = status.autoBuy ? `${C.green}AUTO${C.reset}` : `${C.yellow}MONITOR${C.reset}`;
    ns.print(`${C.cyan}═══ Hacknet Daemon ═══${C.reset}  ${mode}  T${tier.tier}:${tier.name}`);
    ns.print(`  Servers: ${status.serverCount}/${maxNodes}`);
    ns.print(`  Hash Rate: ${C.green}${status.totalHashRateFormatted}${C.reset}`);
    if (hashCapacity > 0) {
      const pct = (status.hashUtilization * 100).toFixed(0);
      const hashColor = status.hashUtilization > 0.9 ? C.red : status.hashUtilization > 0.5 ? C.yellow : C.green;
      ns.print(`  Hashes: ${hashColor}${ns.format.number(status.currentHashes)}/${ns.format.number(hashCapacity)} (${pct}%)${C.reset}`);
    }
    if (tier.tier >= 2 && moneyEarnedFromHashes > 0) {
      ns.print(`  Earned: ${C.green}$${status.moneyEarnedFormatted}${C.reset} from hashes`);
    }
    if (tier.tier >= 2) {
      const targetNote = spendPlan.target !== null
        ? ` -> ${spendPlan.target}${spendPlan.targetSource === "hack-daemon" ? " (hack daemon)" : ""}`
        : "";
      ns.print(`  Spend: ${spendStrategy} (${spendPlan.upgrade})${targetNote}`);
      if (spendBlocked !== null) {
        ns.print(`  ${C.yellow}Spending skipped: ${spendBlocked}${C.reset}`);
      }
    }
    if (nextNodeCost !== null) {
      ns.print(`  Next Node: ${C.yellow}${ns.format.number(nextNodeCost)}${C.reset}`);
    }
    if (payback.skipped > 0 && purchasesThisTick === 0) {
      const best = payback.bestSkippedSec !== null ? formatTime(payback.bestSkippedSec) : "n/a";
      ns.print(`  ${C.yellow}Payback: ${payback.skipped} over horizon (best ${best} > ${formatTime(horizon)})${C.reset}`);
    }
    if (totalSpent > 0) {
      ns.print(`  Spent: ${ns.format.number(totalSpent)} (${nodesBought} nodes, ${upgradesBought} upgrades)`);
    }

    // Per-server breakdown (compact)
    if (servers.length > 0 && servers.length <= 10) {
      ns.print(`\n  ${C.dim}#   Lvl   RAM     Cores  Cache  Rate${C.reset}`);
      for (const s of servers) {
        ns.print(`  ${String(s.index).padStart(2)}  ${String(s.level).padStart(4)}  ${ns.format.ram(s.ram).padStart(6)}  ${String(s.cores).padStart(5)}  ${String(s.cache).padStart(5)}  ${s.hashRateFormatted}`);
      }
    } else if (servers.length > 10) {
      ns.print(`\n  ${C.dim}${servers.length} servers (showing top 5 by hash rate)${C.reset}`);
      const top = [...servers].sort((a, b) => b.hashRate - a.hashRate).slice(0, 5);
      ns.print(`  ${C.dim}#   Lvl   RAM     Cores  Cache  Rate${C.reset}`);
      for (const s of top) {
        ns.print(`  ${String(s.index).padStart(2)}  ${String(s.level).padStart(4)}  ${ns.format.ram(s.ram).padStart(6)}  ${String(s.cores).padStart(5)}  ${String(s.cache).padStart(5)}  ${s.hashRateFormatted}`);
      }
    }

    await ns.sleep(interval);
  }
}
