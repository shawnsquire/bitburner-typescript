/**
 * Faction, Reputation, and Augmentation utilities
 *
 * Requires Singularity API (SF4)
 *
 * Import with: import { analyzeFactions, calculatePurchasePriority, ... } from '/controllers/factions';
 */
import { NS, Player, FactionName } from "@ns";

// === CONSTANTS ===

/** Augmentation cost multiplier after each purchase */
export const AUG_COST_MULT = 1.9;

/** Factions that don't support traditional work (hacking/field/security) */
export const NON_WORKABLE_FACTIONS = new Set([
  "Shadows of Anarchy",  // Infiltration only
  "Bladeburners",        // Bladeburner actions only
  "Church of the Machine God", // Special faction
]);

/**
 * Factions where augs must be purchased one at a time
 * (rep requirement increases after each purchase)
 */
export const SEQUENTIAL_PURCHASE_FACTIONS = new Set([
  "Shadows of Anarchy",
]);

// === TYPES ===

export interface AugmentationInfo {
  name: string;
  repReq: number;
  basePrice: number;
  prereqs: string[];
}

export interface FactionData {
  name: string;
  currentRep: number;
  favor: number;
  availableAugs: AugmentationInfo[];
  nextAugRepGap: number;
}

export interface PurchasePlanItem extends AugmentationInfo {
  faction: string;
  adjustedCost: number;
  multiplier: number;
}

export interface NextTarget {
  aug: AugmentationInfo;
  faction: FactionData;
  repGap: number;
}

// === GANG DETECTION ===

/**
 * Get the player's gang faction, if any.
 * Returns null if not in a gang or Gang API is unavailable.
 */
export function getGangFaction(ns: NS): string | null {
  try {
    if (ns.gang.inGang()) {
      return ns.gang.getGangInformation().faction;
    }
  } catch { /* Gang API unavailable */ }
  return null;
}

// === CORE LOGIC ===

/**
 * Analyze all joined factions and their augmentations
 */
export function analyzeFactions(
  ns: NS,
  player: Player,
  ownedAugs: string[]
): FactionData[] {
  const factions = player.factions;
  const results: FactionData[] = [];

  for (const faction of factions) {
    const allAugs = ns.singularity.getAugmentationsFromFaction(faction);
    const currentRep = ns.singularity.getFactionRep(faction);
    const favor = ns.singularity.getFactionFavor(faction);

    // Filter to unowned augs (excluding NeuroFlux Governor), sorted by rep requirement
    const availableAugs: AugmentationInfo[] = allAugs
      .filter((aug) => !ownedAugs.includes(aug) && aug !== "NeuroFlux Governor")
      .map((aug) => ({
        name: aug,
        repReq: ns.singularity.getAugmentationRepReq(aug),
        basePrice: ns.singularity.getAugmentationPrice(aug),
        prereqs: ns.singularity.getAugmentationPrereq(aug),
      }))
      .filter((aug) => {
        // Check prereqs are met
        const prereqs = aug.prereqs || [];
        return prereqs.every((p) => ownedAugs.includes(p));
      })
      .sort((a, b) => a.repReq - b.repReq);

    results.push({
      name: faction,
      currentRep,
      favor,
      availableAugs,
      nextAugRepGap:
        availableAugs.length > 0
          ? availableAugs[0].repReq - currentRep
          : Infinity,
    });
  }

  return results;
}

/**
 * Find the next augmentation to target (smallest POSITIVE rep gap across all factions)
 * Only considers augs that aren't unlocked yet (gap > 0)
 */
export function findNextAugmentation(factionData: FactionData[]): NextTarget | null {
  let bestAug: AugmentationInfo | null = null;
  let bestFaction: FactionData | null = null;
  let smallestGap = Infinity;

  for (const faction of factionData) {
    for (const aug of faction.availableAugs) {
      const gap = aug.repReq - faction.currentRep;
      // Only consider augs we don't have rep for yet
      if (gap > 0 && gap < smallestGap) {
        smallestGap = gap;
        bestAug = aug;
        bestFaction = faction;
      }
    }
  }

  if (!bestFaction || !bestAug) return null;

  return {
    aug: bestAug,
    faction: bestFaction,
    repGap: smallestGap,
  };
}

/**
 * Find the next augmentation to target from WORKABLE factions only
 * Excludes factions like Shadows of Anarchy that can't be worked for
 */
export function findNextWorkableAugmentation(
  factionData: FactionData[],
  excludeFactions?: Set<string>
): NextTarget | null {
  let bestAug: AugmentationInfo | null = null;
  let bestFaction: FactionData | null = null;
  let smallestGap = Infinity;

  for (const faction of factionData) {
    // Skip non-workable factions
    if (NON_WORKABLE_FACTIONS.has(faction.name)) continue;
    if (excludeFactions?.has(faction.name)) continue;

    for (const aug of faction.availableAugs) {
      const gap = aug.repReq - faction.currentRep;
      // Only consider augs we don't have rep for yet
      if (gap > 0 && gap < smallestGap) {
        smallestGap = gap;
        bestAug = aug;
        bestFaction = faction;
      }
    }
  }

  if (!bestFaction || !bestAug) return null;

  return {
    aug: bestAug,
    faction: bestFaction,
    repGap: smallestGap,
  };
}

/**
 * Get progress info for non-workable factions that have available augs
 */
export function getNonWorkableFactionProgress(
  factionData: FactionData[],
  extraNonWorkable?: Set<string>
): {
  faction: FactionData;
  nextAug: AugmentationInfo;
  progress: number;
}[] {
  const results: { faction: FactionData; nextAug: AugmentationInfo; progress: number }[] = [];

  for (const faction of factionData) {
    if (!NON_WORKABLE_FACTIONS.has(faction.name) && !extraNonWorkable?.has(faction.name)) continue;

    // Find the next aug they need rep for
    const nextAug = faction.availableAugs.find(aug => aug.repReq > faction.currentRep);
    if (nextAug) {
      const progress = Math.min(1, faction.currentRep / nextAug.repReq);
      results.push({ faction, nextAug, progress });
    }
  }

  return results.sort((a, b) => b.progress - a.progress); // Most progress first
}

/**
 * Calculate optimal purchase priority across all factions
 * Only includes augs where we have the required reputation
 * Sorted by base price descending (most expensive first minimizes total cost)
 * Excludes factions that require sequential purchases (like Shadows of Anarchy)
 */
export function calculatePurchasePriority(
  ns: NS,
  factionData: FactionData[]
): PurchasePlanItem[] {
  // Gather all purchasable augs from all factions (only those with rep)
  const allAugs: (AugmentationInfo & { faction: string })[] = [];
  const seen = new Set<string>();

  for (const faction of factionData) {
    // Skip factions that require sequential purchases
    if (SEQUENTIAL_PURCHASE_FACTIONS.has(faction.name)) continue;

    for (const aug of faction.availableAugs) {
      if (seen.has(aug.name)) continue;

      // Only include augs we have rep for
      if (faction.currentRep >= aug.repReq) {
        seen.add(aug.name); // Only mark seen when actually added
        allAugs.push({
          ...aug,
          faction: faction.name,
        });
      }
    }
  }

  // Sort by base price (descending - most expensive first minimizes total cost)
  // Example: $100m + $10m*1.9 = $119m vs $10m + $100m*1.9 = $200m
  allAugs.sort((a, b) => b.basePrice - a.basePrice);

  // Calculate adjusted costs with multiplier
  let multiplier = 1;
  const result: PurchasePlanItem[] = [];

  for (const aug of allAugs) {
    const adjustedCost = Math.round(aug.basePrice * multiplier);
    result.push({
      ...aug,
      adjustedCost,
      multiplier,
    });
    multiplier *= AUG_COST_MULT;
  }

  return result;
}

// Factions that don't support hacking work (gang factions, etc.)
const NO_HACKING_FACTIONS = [
  "Slum Snakes",
  "Tetrads",
  "The Syndicate",
  "The Dark Army",
  "Speakers for the Dead",
];

/**
 * Select best work type based on player skills and faction restrictions
 */
export function selectBestWorkType(
  ns: NS,
  player: Player,
  factionName?: string
): "hacking" | "field" | "security" {
  // Check if faction supports hacking work
  const supportsHacking = !factionName || !NO_HACKING_FACTIONS.includes(factionName);

  // Choose based on best stats
  const hacking = player.skills.hacking;
  const combat =
    (player.skills.strength +
      player.skills.defense +
      player.skills.dexterity +
      player.skills.agility) /
    4;
  const charisma = player.skills.charisma;

  // Hacking is usually best for rep gain if you have high hacking
  if (supportsHacking && hacking > combat && hacking > charisma) {
    return "hacking";
  } else if (combat > charisma) {
    return "field";
  } else {
    return "field"; // Field work uses mixed stats
  }
}

/**
 * Get all owned augmentations (including pending)
 */
export function getOwnedAugs(ns: NS): string[] {
  return ns.singularity.getOwnedAugmentations(true);
}

/**
 * Get installed augmentations only
 */
export function getInstalledAugs(ns: NS): string[] {
  return ns.singularity.getOwnedAugmentations(false);
}

/**
 * Get pending augmentations (purchased but not installed)
 */
export function getPendingAugs(ns: NS): string[] {
  const owned = getOwnedAugs(ns);
  const installed = getInstalledAugs(ns);

  // Build count map of installed augs to handle duplicates (e.g. NFG)
  const installedCounts = new Map<string, number>();
  for (const a of installed) {
    installedCounts.set(a, (installedCounts.get(a) ?? 0) + 1);
  }

  // For each owned aug, subtract from installed count; remaining are pending
  const pending: string[] = [];
  for (const a of owned) {
    const count = installedCounts.get(a) ?? 0;
    if (count > 0) {
      installedCounts.set(a, count - 1);
    } else {
      pending.push(a);
    }
  }

  return pending;
}

/**
 * Calculate how many augs from a purchase plan can be afforded
 */
export function getAffordableAugs(
  purchasePlan: PurchasePlanItem[],
  availableMoney: number
): (PurchasePlanItem & { runningTotal: number })[] {
  let runningTotal = 0;
  const affordable: (PurchasePlanItem & { runningTotal: number })[] = [];

  for (const aug of purchasePlan) {
    runningTotal += aug.adjustedCost;
    if (runningTotal <= availableMoney) {
      affordable.push({ ...aug, runningTotal });
    } else {
      break;
    }
  }

  return affordable;
}

// === SEQUENTIAL PURCHASE FACTIONS (e.g., Shadows of Anarchy) ===

export interface SequentialAugInfo {
  faction: string;
  aug: AugmentationInfo;
  canAfford: boolean;
}

/**
 * Get available augs from sequential-purchase factions (one at a time only)
 * Returns only the NEXT aug that can be purchased from each such faction
 */
export function getSequentialPurchaseAugs(
  ns: NS,
  factionData: FactionData[],
  playerMoney: number
): SequentialAugInfo[] {
  const results: SequentialAugInfo[] = [];

  for (const faction of factionData) {
    if (!SEQUENTIAL_PURCHASE_FACTIONS.has(faction.name)) continue;

    // Find the first aug we have rep for (they're sorted by rep requirement)
    const nextAug = faction.availableAugs.find(
      (aug) => faction.currentRep >= aug.repReq
    );

    if (nextAug) {
      results.push({
        faction: faction.name,
        aug: nextAug,
        canAfford: playerMoney >= nextAug.basePrice,
      });
    }
  }

  return results;
}

// === WORK STATUS ===

export interface FactionWorkStatus {
  /** Whether we're currently working for the target faction */
  isWorkingForFaction: boolean;
  /** Whether we're doing the optimal work type */
  isOptimalWork: boolean;
  /** The best work type for our stats */
  bestWorkType: "hacking" | "field" | "security";
  /** Current work type if working for faction, null otherwise */
  currentWorkType: string | null;
  /** Whether the target faction is workable (not infiltration-only etc) */
  isWorkable: boolean;
}

/**
 * Get the current work status for a target faction
 * Returns info about whether we're doing optimal work and what we should be doing
 */
export function getFactionWorkStatus(
  ns: NS,
  player: Player,
  targetFaction: string
): FactionWorkStatus {
  const isWorkable = !NON_WORKABLE_FACTIONS.has(targetFaction);
  const bestWorkType = selectBestWorkType(ns, player, targetFaction);
  const currentWork = ns.singularity.getCurrentWork();

  const isWorkingForFaction =
    currentWork?.type === "FACTION" &&
    currentWork?.factionName === targetFaction;

  const currentWorkType = isWorkingForFaction
    ? (currentWork as { factionWorkType?: string }).factionWorkType ?? null
    : null;

  const isOptimalWork = isWorkingForFaction && currentWorkType === bestWorkType;

  return {
    isWorkingForFaction,
    isOptimalWork,
    bestWorkType,
    currentWorkType,
    isWorkable,
  };
}

/**
 * Start optimal faction work with focus
 */
export function startOptimalFactionWork(
  ns: NS,
  player: Player,
  factionName: string
): boolean {
  if (NON_WORKABLE_FACTIONS.has(factionName)) {
    return false;
  }
  const bestWork = selectBestWorkType(ns, player, factionName);
  return ns.singularity.workForFaction(factionName as FactionName, bestWork, true);
}

// === DONATION CONSTANTS ===

/** Minimum favor required to donate to a faction */
export const DONATION_FAVOR_THRESHOLD = 150;

/** Rep requirement multiplier per NFG purchase (approx) */
export const NFG_REP_MULT = 1.14;

/** Factions that never support donations (regardless of favor) */
export const NON_DONATABLE_FACTIONS = new Set([
  "Bladeburners",
  "Church of the Machine God",
]);

// === DONATION TYPES ===

export interface NFGDonateStep {
  repRequired: number;
  repGap: number;
  donationNeeded: number;
  purchaseCost: number;
  totalStepCost: number;
  runningTotal: number;
}

export interface NFGDonatePurchasePlan {
  faction: string;
  purchases: number;
  totalDonationCost: number;
  totalPurchaseCost: number;
  totalCost: number;
  steps: NFGDonateStep[];
  canExecute: boolean;
}

// === DONATION FUNCTIONS ===

/**
 * Check if player can donate to a faction (has 150+ favor and faction is donatable)
 */
export function canDonateToFaction(ns: NS, faction: string): boolean {
  if (NON_DONATABLE_FACTIONS.has(faction)) {
    return false;
  }
  // Can't donate to your own gang's faction
  if (getGangFaction(ns) === faction) {
    return false;
  }
  const favor = ns.singularity.getFactionFavor(faction as FactionName);
  return favor >= DONATION_FAVOR_THRESHOLD;
}

/**
 * Calculate how much money is needed to donate for a given amount of reputation
 * @param ns - NetScript context
 * @param targetRep - The amount of reputation to gain from donation
 * @returns The donation amount needed
 */
export function calculateDonationForRep(ns: NS, targetRep: number): number {
  if (targetRep <= 0) return 0;

  const player = ns.getPlayer();

  // Try to use formulas if available
  try {
    if (ns.fileExists("Formulas.exe", "home")) {
      // Use the formulas API - this accounts for all multipliers
      return ns.formulas.reputation.repFromDonation(1, player) > 0
        ? Math.ceil(targetRep / ns.formulas.reputation.repFromDonation(1, player))
        : targetRep * 1e6;
    }
  } catch {
    // Formulas not available, use fallback
  }

  // Fallback formula: donation * faction_rep_mult / 1e6 = rep
  // So: donation = rep * 1e6 / faction_rep_mult
  const repMult = player.mults.faction_rep ?? 1;
  return Math.ceil(targetRep * 1e6 / repMult);
}

/**
 * Calculate a complete donate-and-purchase plan for NeuroFlux Governor
 * This allows purchasing more NFG by donating money for rep when short
 *
 * @param ns - NetScript context
 * @param availableMoney - Money available for both donations and purchases
 * @param faction - Optional faction to use (defaults to best NFG faction with donation capability)
 * @returns Plan detailing how many NFG can be purchased with donations
 */
export function calculateNFGDonatePurchasePlan(
  ns: NS,
  availableMoney: number,
  faction?: string
): NFGDonatePurchasePlan {
  const player = ns.getPlayer();

  // Find best faction for donate+buy (must have 150+ favor and support donations)
  let bestFaction: string | null = faction ?? null;
  let bestFactionRep = 0;
  let bestFactionFavor = 0;

  if (!bestFaction) {
    for (const f of player.factions) {
      const factionAugs = ns.singularity.getAugmentationsFromFaction(f);
      if (!factionAugs.includes("NeuroFlux Governor")) continue;
      if (!canDonateToFaction(ns, f)) continue;

      const rep = ns.singularity.getFactionRep(f);
      const favor = ns.singularity.getFactionFavor(f);

      // Prefer faction with highest favor (more efficient donations long-term)
      if (favor > bestFactionFavor || (favor === bestFactionFavor && rep > bestFactionRep)) {
        bestFaction = f;
        bestFactionRep = rep;
        bestFactionFavor = favor;
      }
    }
  } else {
    bestFactionRep = ns.singularity.getFactionRep(bestFaction as FactionName);
  }

  // No eligible faction found
  if (!bestFaction || !canDonateToFaction(ns, bestFaction)) {
    return {
      faction: bestFaction ?? "None",
      purchases: 0,
      totalDonationCost: 0,
      totalPurchaseCost: 0,
      totalCost: 0,
      steps: [],
      canExecute: false,
    };
  }

  // Get current NFG info
  const currentPrice = ns.singularity.getAugmentationPrice("NeuroFlux Governor");
  let currentRepReq = ns.singularity.getAugmentationRepReq("NeuroFlux Governor");
  let currentRep = bestFactionRep;

  const steps: NFGDonateStep[] = [];
  let totalDonationCost = 0;
  let totalPurchaseCost = 0;
  let purchasePrice = currentPrice;
  let runningTotal = 0;
  const running = true;

  // Calculate sequential purchases with donations as needed
  while (running) {
    const repGap = Math.max(0, currentRepReq - currentRep);
    const donationNeeded = repGap > 0 ? calculateDonationForRep(ns, repGap) : 0;
    const totalStepCost = donationNeeded + purchasePrice;

    // Check if we can afford this step
    if (runningTotal + totalStepCost > availableMoney) {
      break; // Can't afford this purchase
    }

    runningTotal += totalStepCost;
    totalDonationCost += donationNeeded;
    totalPurchaseCost += purchasePrice;

    steps.push({
      repRequired: currentRepReq,
      repGap,
      donationNeeded,
      purchaseCost: purchasePrice,
      totalStepCost,
      runningTotal,
    });

    // Update for next iteration
    currentRep = currentRepReq; // After donation, we'll have exactly enough rep
    currentRepReq = Math.ceil(currentRepReq * NFG_REP_MULT);
    purchasePrice = Math.ceil(purchasePrice * AUG_COST_MULT);
  }

  return {
    faction: bestFaction,
    purchases: steps.length,
    totalDonationCost,
    totalPurchaseCost,
    totalCost: totalDonationCost + totalPurchaseCost,
    steps,
    canExecute: steps.length > 0,
  };
}

// === NEUROFLUX GOVERNOR ===

export interface NeuroFluxInfo {
  currentLevel: number;           // How many NFG we own
  bestFaction: string | null;     // Faction with highest rep that has NFG
  bestFactionRep: number;
  repRequired: number;            // Rep requirement for NFG at current level
  hasEnoughRep: boolean;
  currentPrice: number;           // Current price (after global multiplier)
}

export interface NeuroFluxPurchasePlan {
  startLevel: number;
  endLevel: number;
  purchases: number;
  totalCost: number;
  perPurchase: { level: number; cost: number }[];
  repLimited: boolean;
  nextRepRequired: number | null;
  nextRepGap: number | null;
  bestFaction: string | null;
  bestFactionRep: number;
}

/**
 * Get information about NeuroFlux Governor augmentation
 */
export function getNeuroFluxInfo(ns: NS): NeuroFluxInfo {
  const player = ns.getPlayer();
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);

  // Count current NFG level (how many we own)
  const currentLevel = ownedAugs.filter(a => a === "NeuroFlux Governor").length;

  // Find best faction with NFG (highest rep)
  let bestFaction: string | null = null;
  let bestFactionRep = 0;

  for (const faction of player.factions) {
    const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
    if (factionAugs.includes("NeuroFlux Governor")) {
      const rep = ns.singularity.getFactionRep(faction);
      if (rep > bestFactionRep) {
        bestFactionRep = rep;
        bestFaction = faction;
      }
    }
  }

  // Get current price and rep requirement
  const currentPrice = ns.singularity.getAugmentationPrice("NeuroFlux Governor");
  const repRequired = ns.singularity.getAugmentationRepReq("NeuroFlux Governor");
  const hasEnoughRep = bestFactionRep >= repRequired;

  return {
    currentLevel,
    bestFaction,
    bestFactionRep,
    repRequired,
    hasEnoughRep,
    currentPrice,
  };
}

/**
 * Calculate how many NeuroFlux Governor upgrades can be purchased with available money
 * Each purchase multiplies the price by 1.9
 */
export function calculateNeuroFluxPurchasePlan(
  ns: NS,
  availableMoney: number
): NeuroFluxPurchasePlan {
  const info = getNeuroFluxInfo(ns);

  const perPurchase: { level: number; cost: number }[] = [];
  let totalCost = 0;
  let currentPrice = info.currentPrice;
  let currentRepReq = info.repRequired;
  let level = info.currentLevel;
  let repLimited = false;
  let nextRepRequired: number | null = null;
  let nextRepGap: number | null = null;

  // Can only purchase if we have enough rep for the first level
  if (!info.hasEnoughRep || !info.bestFaction) {
    return {
      startLevel: info.currentLevel,
      endLevel: info.currentLevel,
      purchases: 0,
      totalCost: 0,
      perPurchase: [],
      repLimited: !info.hasEnoughRep && info.bestFaction !== null,
      nextRepRequired: !info.hasEnoughRep ? info.repRequired : null,
      nextRepGap: !info.hasEnoughRep ? info.repRequired - info.bestFactionRep : null,
      bestFaction: info.bestFaction,
      bestFactionRep: info.bestFactionRep,
    };
  }

  // Calculate sequential purchases until we run out of money or rep
  while (totalCost + currentPrice <= availableMoney) {
    // Check rep before counting this purchase
    if (info.bestFactionRep < currentRepReq) {
      repLimited = true;
      nextRepRequired = currentRepReq;
      nextRepGap = currentRepReq - info.bestFactionRep;
      break;
    }

    level++;
    perPurchase.push({ level, cost: currentPrice });
    totalCost += currentPrice;
    currentPrice = Math.round(currentPrice * AUG_COST_MULT);
    currentRepReq = Math.ceil(currentRepReq * NFG_REP_MULT);
  }

  return {
    startLevel: info.currentLevel,
    endLevel: level,
    purchases: perPurchase.length,
    totalCost,
    perPurchase,
    repLimited,
    nextRepRequired,
    nextRepGap,
    bestFaction: info.bestFaction,
    bestFactionRep: info.bestFactionRep,
  };
}

// === REP STATUS (absorbed from auto/auto-rep) ===

export interface RepStatusData {
  factionData: FactionData[];
  nextTarget: NextTarget | null;
  purchasePlan: PurchasePlanItem[];
  pendingAugs: string[];
  installedAugs: string[];
}

/**
 * Get full reputation status
 */
export function getRepStatus(ns: NS, player: Player): RepStatusData {
  const ownedAugs = getOwnedAugs(ns);
  const installedAugs = getInstalledAugs(ns);
  const pendingAugs = getPendingAugs(ns);

  const factionData = analyzeFactions(ns, player, ownedAugs);
  const nextTarget = findNextAugmentation(factionData);
  const purchasePlan = calculatePurchasePriority(ns, factionData);

  return {
    factionData,
    nextTarget,
    purchasePlan,
    pendingAugs,
    installedAugs,
  };
}

// === TIERED FACTION FUNCTIONS ===
// These functions use progressively more Singularity API calls,
// allowing the rep daemon to operate at different RAM tiers.

/**
 * Tier 1: Basic faction rep data
 * Uses: getFactionRep, getFactionFavor (~34 GB total with base)
 *
 * Returns basic rep and favor for all joined factions.
 */
export interface BasicFactionData {
  name: string;
  currentRep: number;
  favor: number;
}

export function getBasicFactionRep(ns: NS, player: Player): BasicFactionData[] {
  const results: BasicFactionData[] = [];

  for (const faction of player.factions) {
    results.push({
      name: faction,
      currentRep: ns.singularity.getFactionRep(faction),
      favor: ns.singularity.getFactionFavor(faction),
    });
  }

  return results.sort((a, b) => b.currentRep - a.currentRep);
}

/**
 * Tier 2: Target tracking with aug requirements
 * Uses: + getAugmentationRepReq, getAugmentationPrice (~114 GB total)
 *
 * Returns faction data with target aug rep requirements and prices.
 * Requires a target faction to be specified (or uses first faction).
 */
export interface TargetAugData {
  faction: string;
  factionRep: number;
  factionFavor: number;
  targetAug: string | null;
  repRequired: number;
  repGap: number;
  augPrice: number;
}

export function getFactionAugTargets(
  ns: NS,
  factions: BasicFactionData[],
  targetAugsByFaction: Map<string, string>
): TargetAugData[] {
  const results: TargetAugData[] = [];

  for (const faction of factions) {
    const targetAug = targetAugsByFaction.get(faction.name) ?? null;

    if (targetAug) {
      const repRequired = ns.singularity.getAugmentationRepReq(targetAug);
      const augPrice = ns.singularity.getAugmentationPrice(targetAug);

      results.push({
        faction: faction.name,
        factionRep: faction.currentRep,
        factionFavor: faction.favor,
        targetAug,
        repRequired,
        repGap: Math.max(0, repRequired - faction.currentRep),
        augPrice,
      });
    } else {
      results.push({
        faction: faction.name,
        factionRep: faction.currentRep,
        factionFavor: faction.favor,
        targetAug: null,
        repRequired: 0,
        repGap: 0,
        augPrice: 0,
      });
    }
  }

  return results;
}

/**
 * Tier 3: Available augs per faction
 * Uses: + getAugmentationsFromFaction (~194 GB total)
 *
 * Returns list of available augs for each faction.
 */
export interface FactionAugList {
  faction: string;
  currentRep: number;
  favor: number;
  augs: {
    name: string;
    repReq: number;
    price: number;
  }[];
}

export function getAvailableAugs(
  ns: NS,
  factions: BasicFactionData[]
): FactionAugList[] {
  const results: FactionAugList[] = [];

  for (const faction of factions) {
    const allAugs = ns.singularity.getAugmentationsFromFaction(faction.name as FactionName);

    // Get rep req and price for each aug
    const augs = allAugs
      .filter((aug) => aug !== "NeuroFlux Governor")
      .map((aug) => ({
        name: aug,
        repReq: ns.singularity.getAugmentationRepReq(aug),
        price: ns.singularity.getAugmentationPrice(aug),
      }))
      .sort((a, b) => a.repReq - b.repReq);

    results.push({
      faction: faction.name,
      currentRep: faction.currentRep,
      favor: faction.favor,
      augs,
    });
  }

  return results;
}

/**
 * Tier 4: Filtered augs (excluding owned)
 * Uses: + getOwnedAugmentations (~274 GB total)
 *
 * Returns augs filtered to exclude already-owned ones.
 */
export interface FilteredFactionAugs {
  faction: string;
  currentRep: number;
  favor: number;
  availableAugs: {
    name: string;
    repReq: number;
    price: number;
    hasRep: boolean;
  }[];
}

export function getFilteredAugs(
  ns: NS,
  factionAugLists: FactionAugList[]
): FilteredFactionAugs[] {
  const ownedAugs = new Set(ns.singularity.getOwnedAugmentations(true));
  const results: FilteredFactionAugs[] = [];

  for (const factionData of factionAugLists) {
    const availableAugs = factionData.augs
      .filter((aug) => !ownedAugs.has(aug.name))
      .map((aug) => ({
        ...aug,
        hasRep: factionData.currentRep >= aug.repReq,
      }));

    results.push({
      faction: factionData.faction,
      currentRep: factionData.currentRep,
      favor: factionData.favor,
      availableAugs,
    });
  }

  return results;
}

/**
 * Tier 5: Ordered augs with prerequisites
 * Uses: + getAugmentationPrereq (~354 GB total)
 *
 * Returns augs ordered by prerequisites, filtering out those
 * whose prereqs aren't met.
 */
export interface OrderedFactionAugs {
  faction: string;
  currentRep: number;
  favor: number;
  orderedAugs: {
    name: string;
    repReq: number;
    price: number;
    hasRep: boolean;
    prereqs: string[];
    prereqsMet: boolean;
  }[];
}

export function getOrderedAugs(
  ns: NS,
  filteredAugLists: FilteredFactionAugs[]
): OrderedFactionAugs[] {
  const ownedAugs = new Set(ns.singularity.getOwnedAugmentations(true));
  const results: OrderedFactionAugs[] = [];

  for (const factionData of filteredAugLists) {
    const orderedAugs = factionData.availableAugs.map((aug) => {
      const prereqs = ns.singularity.getAugmentationPrereq(aug.name);
      const prereqsMet = prereqs.every((p) => ownedAugs.has(p));

      return {
        ...aug,
        prereqs,
        prereqsMet,
      };
    });

    // Sort: prereqs met first, then by rep requirement
    orderedAugs.sort((a, b) => {
      if (a.prereqsMet !== b.prereqsMet) return a.prereqsMet ? -1 : 1;
      return a.repReq - b.repReq;
    });

    results.push({
      faction: factionData.faction,
      currentRep: factionData.currentRep,
      favor: factionData.favor,
      orderedAugs,
    });
  }

  return results;
}
