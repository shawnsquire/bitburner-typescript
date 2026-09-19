/**
 * Hacknet Controller
 *
 * Pure logic for the hacknet daemon: maps a hash-spend strategy to the game's
 * upgrade name and resolves the target the upgrade needs. No ns calls.
 * Import with: import { resolveHashSpend, HASH_STRATEGY_MAP } from "/controllers/hacknet";
 */
import type { HacknetServerHashUpgrade } from "@ns";
import type { HashSpendStrategy, TargetAssignment } from "/types/ports";

// === STRATEGY TABLE ===

/**
 * Strategy -> upgrade name. Names are the exact HashUpgradeEnum strings from the
 * game (src/Hacknet/Enums.ts); spendHashes rejects anything else.
 */
export const HASH_STRATEGY_MAP: Record<HashSpendStrategy, HacknetServerHashUpgrade> = {
  "money": "Sell for Money",
  "corp-funds": "Sell for Corporation Funds",
  "corp-research": "Exchange for Corporation Research",
  "study": "Improve Studying",
  "gym": "Improve Gym Training",
  "bladeburner-rank": "Exchange for Bladeburner Rank",
  "bladeburner-sp": "Exchange for Bladeburner SP",
  "coding-contract": "Generate Coding Contract",
  "reduce-security": "Reduce Minimum Security",
  "increase-money": "Increase Maximum Money",
  "company-favor": "Company Favor",
};

/** Strategies whose upgrade acts on a single foreign server (hasTargetServer in the game). */
export const SERVER_TARGET_STRATEGIES: ReadonlySet<HashSpendStrategy> = new Set<HashSpendStrategy>([
  "reduce-security",
  "increase-money",
]);

/** Strategies whose upgrade acts on a company (hasTargetCompany in the game). */
export const COMPANY_TARGET_STRATEGIES: ReadonlySet<HashSpendStrategy> = new Set<HashSpendStrategy>([
  "company-favor",
]);

export function isHashSpendStrategy(value: string): value is HashSpendStrategy {
  return Object.prototype.hasOwnProperty.call(HASH_STRATEGY_MAP, value);
}

// === TARGET RESOLUTION ===

export interface HashSpendPlan {
  strategy: HashSpendStrategy;
  /** Exact upgrade name to pass to ns.hacknet.spendHashes. */
  upgrade: HacknetServerHashUpgrade;
  /** Resolved target (server or company), or null when the upgrade takes none. */
  target: string | null;
  /** Where the target came from. */
  targetSource: "config" | "hack-daemon" | null;
  /** False when the strategy needs a target and none could be resolved. */
  isValid: boolean;
  /** Human-readable reason when isValid is false. */
  reason: string | null;
}

/**
 * Lowest-rank hack target, or null. Ranks are 1-based and not guaranteed to be
 * published in order, so pick by rank rather than by index.
 */
export function primaryHackTarget(targets: TargetAssignment[] | null | undefined): string | null {
  if (!targets || targets.length === 0) return null;
  let best: TargetAssignment | null = null;
  for (const t of targets) {
    if (!t.hostname) continue;
    if (best === null || t.rank < best.rank) best = t;
  }
  return best ? best.hostname : null;
}

/**
 * Resolve what spendHashes should be called with for a strategy.
 *
 * - Upgrades without a target: always valid, target null.
 * - reduce-security / increase-money: `spendTarget` if set, otherwise the hack
 *   daemon's primary target; invalid when neither is available.
 * - company-favor: `spendTarget` only (a company name); invalid without it.
 */
export function resolveHashSpend(
  strategy: HashSpendStrategy,
  spendTarget: string,
  hackTargets: TargetAssignment[] | null | undefined,
): HashSpendPlan {
  const upgrade = HASH_STRATEGY_MAP[strategy];
  const configured = spendTarget.trim();
  const base = { strategy, upgrade };

  if (SERVER_TARGET_STRATEGIES.has(strategy)) {
    if (configured) {
      return { ...base, target: configured, targetSource: "config", isValid: true, reason: null };
    }
    const fallback = primaryHackTarget(hackTargets);
    if (fallback) {
      return { ...base, target: fallback, targetSource: "hack-daemon", isValid: true, reason: null };
    }
    return {
      ...base,
      target: null,
      targetSource: null,
      isValid: false,
      reason: `${strategy} needs a server: set spendTarget or run the hack daemon`,
    };
  }

  if (COMPANY_TARGET_STRATEGIES.has(strategy)) {
    if (configured) {
      return { ...base, target: configured, targetSource: "config", isValid: true, reason: null };
    }
    return {
      ...base,
      target: null,
      targetSource: null,
      isValid: false,
      reason: `${strategy} needs a company: set spendTarget to a company name`,
    };
  }

  return { ...base, target: null, targetSource: null, isValid: true, reason: null };
}

// === PAYBACK ===

/** "Sell for Money" hash upgrade: 4 hashes for $1m (game source src/Hacknet/data/HashUpgradesMetadata.tsx). */
export const HASH_SELL_HASHES = 4;
export const HASH_SELL_MONEY = 1_000_000;
/** Dollar value of one hash at the sell rate; hashes are fungible, so every strategy is valued at this. */
export const MONEY_PER_HASH = HASH_SELL_MONEY / HASH_SELL_HASHES;
/** Cache upgrades are exempt from the payback ceiling above this hash utilisation (0..1). */
export const CACHE_EXEMPT_UTILISATION = 0.9;

export type HacknetCandidateType = "new" | "level" | "ram" | "cores" | "cache";

export interface PaybackCandidate {
  type: HacknetCandidateType;
  cost: number;
  /** Seconds for the purchase to pay for itself; Infinity when it adds no income. */
  paybackSec: number;
}

/** Seconds until `cost` is earned back at `marginalMoneyPerSec`; Infinity when the rate is not positive. */
export function paybackSeconds(cost: number, marginalMoneyPerSec: number): number {
  if (!(marginalMoneyPerSec > 0) || !(cost >= 0)) return Infinity;
  return cost / marginalMoneyPerSec;
}

/**
 * Money per second of a plain hacknet node without Formulas.exe
 * (src/Hacknet/formulas/HacknetNodes.ts calculateMoneyGainRate, BitNode multiplier ignored).
 */
export function estimateNodeMoneyRate(level: number, ram: number, cores: number, mult: number): number {
  return level * 1.5 * Math.pow(1.035, ram - 1) * ((cores + 5) / 6) * mult;
}

/** Rough hashes per second of a hacknet server without Formulas.exe. */
export function estimateServerHashRate(level: number, ramUsed: number, ram: number, cores: number, mult: number): number {
  const freeRam = Math.max(0, ram - ramUsed);
  return level * 0.001 * freeRam * (1 + (cores - 1) / 5) * mult;
}

/** The first node is always bought; a cache upgrade is exempt while hashes are about to overflow. */
export function isExemptFromHorizon(c: PaybackCandidate, hashUtilization: number, numNodes: number): boolean {
  if (c.type === "new" && numNodes === 0) return true;
  if (c.type === "cache" && hashUtilization > CACHE_EXEMPT_UTILISATION) return true;
  return false;
}

/**
 * Split candidates into those the payback ceiling allows and a count of those it skips.
 * Strictly greater than the horizon is skipped, so with the horizon at Infinity nothing is
 * (an Infinity payback is not greater than Infinity). Order is preserved.
 */
export function partitionByPayback<T extends PaybackCandidate>(
  candidates: T[],
  horizon: number,
  hashUtilization: number,
  numNodes: number,
): { eligible: T[]; skipped: number; bestSkippedSec: number | null } {
  const eligible: T[] = [];
  let skipped = 0;
  let bestSkippedSec: number | null = null;
  for (const c of candidates) {
    if (!isExemptFromHorizon(c, hashUtilization, numNodes) && c.paybackSec > horizon) {
      skipped++;
      if (isFinite(c.paybackSec) && (bestSkippedSec === null || c.paybackSec < bestSkippedSec)) {
        bestSkippedSec = c.paybackSec;
      }
      continue;
    }
    eligible.push(c);
  }
  return { eligible, skipped, bestSkippedSec };
}
