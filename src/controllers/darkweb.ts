/**
 * Darkweb Tools Library
 *
 * Core logic for analyzing and purchasing darkweb programs.
 * Import with: import { analyzeDarkwebPrograms, ProgramPurchaseResult, ... } from '/controllers/darkweb';
 */
import { NS, ProgramName } from "@ns";

// === TYPES ===

export interface DarkwebProgram {
  name: string;
  cost: number;
  owned: boolean;
}

export interface ProgramPurchaseResult {
  purchased: DarkwebProgram[];
  alreadyOwned: DarkwebProgram[];
  cannotAfford: DarkwebProgram[];
  totalPrograms: number;
  ownedCount: number;
  playerMoney: number;
  nextProgram: DarkwebProgram | null;
  moneyUntilNext: number;
  hasTorRouter: boolean;
}

// === CORE LOGIC ===

/**
 * Check if the player has the TOR router
 */
export function hasTorRouter(ns: NS): boolean {
  // getDarkwebPrograms() returns empty array if TOR isn't owned
  try {
    const programs = ns.singularity.getDarkwebPrograms();
    return programs.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get all darkweb programs with their status
 */
export function getDarkwebProgramStatus(ns: NS): DarkwebProgram[] {
  const programNames = ns.singularity.getDarkwebPrograms();

  return programNames.map((name) => ({
    name,
    cost: ns.singularity.getDarkwebProgramCost(name),
    owned: ns.fileExists(name, "home"),
  }));
}

/**
 * Get programs sorted by cost (cheapest first)
 */
export function getProgramsByCost(ns: NS): DarkwebProgram[] {
  return getDarkwebProgramStatus(ns).sort((a, b) => a.cost - b.cost);
}

/**
 * Get the next affordable program (cheapest unowned that we can buy)
 */
export function getNextAffordableProgram(ns: NS): DarkwebProgram | null {
  const money = ns.getServerMoneyAvailable("home");
  const programs = getProgramsByCost(ns);

  return programs.find((p) => !p.owned && p.cost <= money) ?? null;
}

/**
 * Get the next program to save for (cheapest unowned)
 */
export function getNextProgramToSaveFor(ns: NS): DarkwebProgram | null {
  const programs = getProgramsByCost(ns);
  return programs.find((p) => !p.owned) ?? null;
}

/**
 * Analyze darkweb programs and optionally purchase affordable ones.
 * If budgetCheck is provided, each purchase is gated by the callback.
 */
export function analyzeDarkwebPrograms(ns: NS, purchase = true, budgetCheck?: (cost: number, name: string) => boolean): ProgramPurchaseResult {
  const playerMoney = ns.getServerMoneyAvailable("home");
  const hasTor = hasTorRouter(ns);

  if (!hasTor) {
    return {
      purchased: [],
      alreadyOwned: [],
      cannotAfford: [],
      totalPrograms: 0,
      ownedCount: 0,
      playerMoney,
      nextProgram: null,
      moneyUntilNext: 200000, // TOR router cost
      hasTorRouter: false,
    };
  }

  const programs = getProgramsByCost(ns);
  const purchased: DarkwebProgram[] = [];
  const alreadyOwned: DarkwebProgram[] = [];
  const cannotAfford: DarkwebProgram[] = [];

  let currentMoney = playerMoney;

  for (const program of programs) {
    if (program.owned) {
      alreadyOwned.push(program);
      continue;
    }

    if (currentMoney >= program.cost && purchase) {
      if (budgetCheck && !budgetCheck(program.cost, program.name)) {
        cannotAfford.push(program);
        continue;
      }
      const success = ns.singularity.purchaseProgram(program.name as ProgramName);
      if (success) {
        purchased.push(program);
        currentMoney -= program.cost;
      } else {
        cannotAfford.push(program);
      }
    } else {
      cannotAfford.push(program);
    }
  }

  // Find next program to save for
  const nextProgram = cannotAfford.length > 0 ? cannotAfford[0] : null;
  const moneyUntilNext = nextProgram ? Math.max(0, nextProgram.cost - currentMoney) : 0;

  return {
    purchased,
    alreadyOwned,
    cannotAfford,
    totalPrograms: programs.length,
    ownedCount: alreadyOwned.length + purchased.length,
    playerMoney: currentMoney,
    nextProgram,
    moneyUntilNext,
    hasTorRouter: true,
  };
}

/**
 * Get status without purchasing anything (for UI display)
 */
export function getDarkwebStatus(ns: NS): ProgramPurchaseResult {
  return analyzeDarkwebPrograms(ns, false);
}

/**
 * Try to purchase the TOR router.
 * If budgetCheck is provided, the purchase is gated by the callback.
 */
export function purchaseTorRouter(ns: NS, budgetCheck?: (cost: number, name: string) => boolean): boolean {
  if (budgetCheck && !budgetCheck(200_000, "TOR Router")) return false;
  // ns.singularity.* throws when Source-File 4 isn't available; treat that as "can't buy it".
  try {
    return ns.singularity.purchaseTor();
  } catch {
    return false;
  }
}

/**
 * Format money for display
 */
export function formatMoney(amount: number): string {
  if (amount >= 1e12) return `$${(amount / 1e12).toFixed(2)}t`;
  if (amount >= 1e9) return `$${(amount / 1e9).toFixed(2)}b`;
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}m`;
  if (amount >= 1e3) return `$${(amount / 1e3).toFixed(2)}k`;
  return `$${amount.toFixed(0)}`;
}
