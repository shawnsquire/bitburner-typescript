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
