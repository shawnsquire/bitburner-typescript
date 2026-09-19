/**
 * Purchased Server Library
 *
 * Core logic for managing purchased servers.
 * Import with: import { getPservStatus, PservStatus, ... } from '/controllers/pserv';
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";

// === TYPES ===

export interface PservStatus {
  servers: string[];
  serverCount: number;
  serverCap: number;
  totalRam: number;
  minRam: number;
  maxRam: number;
  maxPossibleRam: number;
  allMaxed: boolean;
}

export interface PservConfig {
  prefix: string;
  minRam: number;
  maxRam: number;
  reserve: number;
  oneShot: boolean;
  interval: number;
  autoBuy: boolean;
}

export interface PservCycleResult {
  bought: number;
  upgraded: number;
  waitingFor: string | null;
}

/** Callbacks for budget integration. All optional for backward compatibility. */
export interface PservCallbacks {
  /** Returns the spending budget (may be less than raw money). */
  budgetFn?: () => number;
  /** Called after each purchase/upgrade with cost and description. */
  onPurchase?: (cost: number, desc: string) => void;
}

export interface BatchPurchasePlan {
  ramPerServer: number;
  count: number;
  totalRam: number;
  totalCost: number;
}

/**
 * Calculate the optimal batch of servers to purchase in empty slots.
 * For each RAM tier (minRam..maxRam), compute how many we can afford
 * within budget and empty slots, then pick the combo with highest totalRam.
 */
export function calculateBatchPurchasePlan(
  ns: NS,
  budget: number,
  emptySlots: number,
  minRam: number,
  maxRam: number,
): BatchPurchasePlan | null {
  if (emptySlots <= 0 || budget <= 0) return null;

  let best: BatchPurchasePlan | null = null;

  for (let ram = minRam; ram <= maxRam; ram *= 2) {
    const costPer = ns.cloud.getServerCost(ram);
    if (costPer > budget) break;

    const count = Math.min(emptySlots, Math.floor(budget / costPer));
    if (count <= 0) continue;

    const totalRam = ram * count;
    const totalCost = costPer * count;

    if (!best || totalRam > best.totalRam) {
      best = { ramPerServer: ram, count, totalRam, totalCost };
    }
  }

  return best;
}

// === CORE LOGIC ===

/**
 * Get status of all purchased servers
 */
export function getPservStatus(ns: NS): PservStatus {
  const servers = ns.cloud.getServerNames();
  const serverCap = ns.cloud.getServerLimit();
  const maxPossibleRam = ns.cloud.getRamLimit();

  if (servers.length === 0) {
    return {
      servers: [],
      serverCount: 0,
      serverCap,
      totalRam: 0,
      minRam: 0,
      maxRam: 0,
      maxPossibleRam,
      allMaxed: false,
    };
  }

  const rams = servers.map((h) => ns.getServerMaxRam(h));
  const totalRam = rams.reduce((a, b) => a + b, 0);
  const minRam = Math.min(...rams);
  const maxRam = Math.max(...rams);
  const allMaxed = minRam >= maxPossibleRam;

  return {
    servers,
    serverCount: servers.length,
    serverCap,
    totalRam,
    minRam,
    maxRam,
    maxPossibleRam,
    allMaxed,
  };
}

/**
 * Best RAM we can afford for a new server
 */
export function getBestAffordableRam(
  ns: NS,
  budget: number,
  minRam: number,
  maxRam: number
): number {
  let best = 0;
  for (let ram = minRam; ram <= maxRam; ram *= 2) {
    if (ns.cloud.getServerCost(ram) <= budget) best = ram;
    else break;
  }
  return best;
}

/**
 * Best RAM we can upgrade to
 */
export function getBestAffordableUpgrade(
  ns: NS,
  hostname: string,
  budget: number,
  currentRam: number,
  maxRam: number
): number {
  let best = currentRam;
  for (let ram = currentRam * 2; ram <= maxRam; ram *= 2) {
    if (ns.cloud.getServerUpgradeCost(hostname, ram) <= budget) best = ram;
    else break;
  }
  return best;
}

/**
 * Find the smallest server by RAM
 */
export function findSmallestServer(
  ns: NS
): { hostname: string; ram: number } | null {
  const servers = ns.cloud.getServerNames();
  if (servers.length === 0) return null;

  return servers
    .map((h) => ({ hostname: h, ram: ns.getServerMaxRam(h) }))
    .reduce((min, s) => (s.ram < min.ram ? s : min));
}

/**
 * Get next upgrade info for display
 */
export function getNextUpgradeInfo(ns: NS, reserve: number): string | null {
  const smallest = findSmallestServer(ns);
  if (!smallest) return null;

  const maxRam = ns.cloud.getRamLimit();
  if (smallest.ram >= maxRam) return null;

  const nextRam = smallest.ram * 2;
  const cost = ns.cloud.getServerUpgradeCost(smallest.hostname, nextRam);
  const budget = ns.getServerMoneyAvailable("home") - reserve;

  if (cost <= budget) {
    return `Can upgrade ${smallest.hostname} to ${ns.format.ram(nextRam)}`;
  } else {
    return `Need ${ns.format.number(cost - budget)} more for ${smallest.hostname} → ${ns.format.ram(nextRam)}`;
  }
}

/**
 * Run one cycle of purchase/upgrade logic.
 * If callbacks.budgetFn is provided, it constrains spending.
 * callbacks.onPurchase is called after each successful buy/upgrade.
 */
export async function runPservCycle(
  ns: NS,
  config: PservConfig,
  callbacks?: PservCallbacks,
): Promise<PservCycleResult> {
  const C = COLORS;
  const { prefix, minRam, reserve } = config;
  const MAX_RAM = config.maxRam > 0 ? config.maxRam : ns.cloud.getRamLimit();
  const SERVER_CAP = ns.cloud.getServerLimit();

  const getBudget = () => {
    const raw = ns.getServerMoneyAvailable("home") - reserve;
    if (callbacks?.budgetFn) return Math.min(raw, callbacks.budgetFn());
    return raw;
  };

  let bought = 0;
  let upgraded = 0;
  let waitingFor: string | null = null;

  // === PHASE 1: FILL EMPTY SLOTS (batch) ===
  const emptySlots = SERVER_CAP - ns.cloud.getServerNames().length;
  if (emptySlots > 0) {
    const plan = calculateBatchPurchasePlan(ns, getBudget(), emptySlots, minRam, MAX_RAM);

    if (plan) {
      ns.print(`${C.cyan}BATCH: ${plan.count} servers @ ${ns.format.ram(plan.ramPerServer)} (${ns.format.number(plan.totalCost)} total)${C.reset}`);

      for (let i = 0; i < plan.count; i++) {
        const cost = ns.cloud.getServerCost(plan.ramPerServer);
        const name = `${prefix}-${Date.now().toString(36)}`;

        if (ns.cloud.purchaseServer(name, plan.ramPerServer)) {
          ns.print(
            `${C.green}BOUGHT: ${name} @ ${ns.format.ram(plan.ramPerServer)} for ${ns.format.number(cost)}${C.reset}`
          );
          bought++;
          callbacks?.onPurchase?.(cost, `${name} @ ${ns.format.ram(plan.ramPerServer)}`);
        } else {
          ns.print(`${C.red}FAILED: Could not purchase ${name}${C.reset}`);
          break;
        }
        await ns.sleep(5);
      }
    } else {
      const needed = ns.cloud.getServerCost(minRam);
      waitingFor = `Need ${ns.format.number(needed)} for ${ns.format.ram(minRam)} server`;
      ns.print(`${C.yellow}WAITING: ${waitingFor}${C.reset}`);
    }
  }

  // === PHASE 2: UPGRADE SMALLEST SERVERS ===
  let keepUpgrading = ns.cloud.getServerNames().length >= SERVER_CAP;
  while (keepUpgrading) {
    const budget = getBudget();

    // Find the actual smallest server each iteration
    const servers = ns.cloud.getServerNames();
    if (servers.length === 0) {
      keepUpgrading = false;
      continue;
    }

    const smallest = servers
      .map((h) => ({ hostname: h, ram: ns.getServerMaxRam(h) }))
      .reduce((min, s) => (s.ram < min.ram ? s : min));

    if (smallest.ram >= MAX_RAM) {
      ns.print(`${C.green}ALL MAXED: Every server at ${ns.format.ram(MAX_RAM)}!${C.reset}`);
      keepUpgrading = false;
      continue;
    }

    const targetRam = getBestAffordableUpgrade(
      ns,
      smallest.hostname,
      budget,
      smallest.ram,
      MAX_RAM
    );

    if (targetRam <= smallest.ram) {
      const nextRam = smallest.ram * 2;
      const needed = ns.cloud.getServerUpgradeCost(smallest.hostname, nextRam);
      waitingFor = `Need ${ns.format.number(needed)} to upgrade ${smallest.hostname} (${ns.format.ram(smallest.ram)} → ${ns.format.ram(nextRam)})`;
      ns.print(`${C.yellow}WAITING: ${waitingFor}${C.reset}`);
      keepUpgrading = false;
      continue;
    }

    const cost = ns.cloud.getServerUpgradeCost(smallest.hostname, targetRam);

    if (ns.cloud.upgradeServer(smallest.hostname, targetRam)) {
      ns.print(
        `${C.green}UPGRADED: ${smallest.hostname} ${ns.format.ram(smallest.ram)} → ${ns.format.ram(targetRam)} for ${ns.format.number(cost)}${C.reset}`
      );
      upgraded++;
      callbacks?.onPurchase?.(cost, `upgrade ${smallest.hostname} → ${ns.format.ram(targetRam)}`);
    } else {
      ns.print(`${C.red}FAILED: Could not upgrade ${smallest.hostname}${C.reset}`);
      keepUpgrading = false;
      continue;
    }
    await ns.sleep(5);
  }

  return { bought, upgraded, waitingFor };
}
