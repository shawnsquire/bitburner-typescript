/**
 * Budget Controller (Pure Logic)
 *
 * Snapshot-based "allowance" model: each tick computes fresh spending limits
 * from current wealth. No accumulated state to drift out of sync.
 *
 * Two consumer classes:
 *   Holders (stocks, corp) — allowance = max(0, netWorth * weight% - currentHolding)
 *   Spenders (everything else) — allowance = cash * weight%
 *
 * Zero NS imports — safe to import without RAM cost.
 *
 * Import with: import { computeAllowances, ... } from "/controllers/budget";
 */

// === HOLDER BUCKETS ===

export const HOLDER_BUCKETS = new Set(["stocks", "corp"]);

// === DEFAULT WEIGHTS ===

export const DEFAULT_WEIGHTS: Record<string, number> = {
  stocks: 30,
  servers: 25,
  corp: 22,
  home: 15,
  gang: 10,
  hacknet: 5,
  programs: 5,
  "wse-access": 5,
};

// === STOCKS WEIGHT WITH 4S DATA ===

/**
 * Once the stocks daemon has the 4S TIX API its trades are near-certain positive
 * drift and positions liquidate in one tick for the cost of the spread, so the
 * measured return scales almost linearly with the share of net worth deployed
 * (sim/stocks/exp-4s: 0.016 at the 30% default vs 0.047 all in). Default: hold
 * up to 80% of net worth in stocks with 4S.
 */
export const DEFAULT_STOCKS_WEIGHT_4S = 80;

/**
 * Raise the stocks bucket weight to `weight4S` while 4S data is owned. Only lifts a
 * weight that is already above zero, so a frozen or manually zeroed bucket stays
 * zero, and never lowers a weight the user set higher. Pure; returns a new map.
 */
export function applyStocks4SWeight(
  weights: Record<string, number>,
  has4S: boolean,
  weight4S: number = DEFAULT_STOCKS_WEIGHT_4S,
): Record<string, number> {
  const base = weights.stocks ?? 0;
  if (!has4S || !(weight4S > 0) || !(base > 0) || base >= weight4S) return { ...weights };
  return { ...weights, stocks: weight4S };
}

// === WSE ACCESS CARVE-OUT ===

/** Game constants (StockMarketConstants in the game source); base prices before BitNode multipliers. */
export const WSE_TIX_API_COST = 5_000_000_000;
export const WSE_4S_TIX_API_COST = 25_000_000_000;

/** Bucket the stocks daemon charges API purchases to. */
export const WSE_ACCESS_BUCKET = "wse-access";

/**
 * Price of the next stock API the stocks daemon will try to buy, or 0 when it owns both.
 * Order mirrors daemons/stocks.ts: TIX API first, then the 4S Market Data TIX API.
 */
export function nextWseApiCost(hasTIX: boolean, has4S: boolean): number {
  if (!hasTIX) return WSE_TIX_API_COST;
  if (!has4S) return WSE_4S_TIX_API_COST;
  return 0;
}

/** Dashboard label for the next stock API, or null when both are owned. Mirrors nextWseApiCost. */
export function nextWseApiLabel(hasTIX: boolean, has4S: boolean): string | null {
  if (!hasTIX) return "TIX API";
  if (!has4S) return "4S Market Data TIX API";
  return null;
}

// === SAVINGS GOAL ===

/**
 * Spender allowances are caps on current cash, so an item priced far above a bucket's
 * share could never be bought while the continuous spenders keep cash from growing. A
 * consumer reports the price of its next purchase; the budget daemon picks the cheapest
 * pending item as the goal, hides a reserve toward it from every other spender, and grants
 * the full price once the reserve covers it. See docs/systems/budget.md "Savings goal".
 */

/** Percent of cash the reserve may lock. The grant fires at cost / share (2x the price at 50). */
export const DEFAULT_RESERVE_SHARE = 50;

/** Seconds a hacknet upgrade may take to pay for itself (published for the hacknet daemon). 0 disables. */
export const DEFAULT_PAYBACK_HORIZON = 3600;

/** A pending item not refreshed within this many ms is dropped (its daemon died or was killed). */
export const PENDING_STALE_MS = 120_000;

export interface PendingItem {
  cost: number;
  label: string;
  /** Date.now() when last reported. */
  at: number;
}

export interface Goal {
  bucket: string;
  label: string;
  cost: number;
}

/** The selected goal and the cash reserved toward it this tick. */
export interface GoalPlan {
  goal: Goal | null;
  reserve: number;
}

/** Drop stale entries and anything without a positive cost. Returns a new map. */
export function prunePending(
  pending: Record<string, PendingItem>,
  now: number,
  staleMs: number = PENDING_STALE_MS,
): Record<string, PendingItem> {
  const kept: Record<string, PendingItem> = {};
  for (const [bucket, item] of Object.entries(pending)) {
    if (!(item.cost > 0)) continue;
    if (now - item.at > staleMs) continue;
    kept[bucket] = item;
  }
  return kept;
}

/**
 * Cheapest pending item among buckets whose effective weight is above zero. Done, frozen,
 * zeroed and rush-sidelined buckets can never be the goal. Ties break by bucket name.
 */
export function selectGoal(
  pending: Record<string, PendingItem>,
  effectiveWeights: Record<string, number>,
): Goal | null {
  let best: Goal | null = null;
  for (const [bucket, item] of Object.entries(pending)) {
    if (!(item.cost > 0)) continue;
    if (!((effectiveWeights[bucket] ?? 0) > 0)) continue;
    if (best === null || item.cost < best.cost || (item.cost === best.cost && bucket < best.bucket)) {
      best = { bucket, label: item.label, cost: item.cost };
    }
  }
  return best;
}

/** Cash locked toward the goal: min(cost, cash * share). 0 without a goal or with share <= 0. */
export function computeReserve(cash: number, goal: Goal | null, reserveShare: number): number {
  if (goal === null || !(reserveShare > 0) || !(cash > 0)) return 0;
  return Math.min(goal.cost, cash * (reserveShare / 100));
}

/** The goal is granted once the reserve covers its full price. */
export function isGranted(goal: Goal | null, reserve: number): boolean {
  return goal !== null && reserve >= goal.cost;
}

// === PERSISTED STATE ===

export interface PersistedBudgetState {
  lifetimeSpent: Record<string, number>;
  weights: Record<string, number>;
  activeFlags: Record<string, boolean>;
  caps: Record<string, number | null>;
  rushBucket: string | null;
  frozenWeights: Record<string, number>;
  lastCash?: number;
}

export function createDefaultPersistedState(): PersistedBudgetState {
  const lifetimeSpent: Record<string, number> = {};
  const activeFlags: Record<string, boolean> = {};
  const caps: Record<string, number | null> = {};

  for (const bucket of Object.keys(DEFAULT_WEIGHTS)) {
    lifetimeSpent[bucket] = 0;
    activeFlags[bucket] = true;
    caps[bucket] = null;
  }

  return {
    lifetimeSpent,
    weights: { ...DEFAULT_WEIGHTS },
    activeFlags,
    caps,
    rushBucket: null,
    frozenWeights: {},
  };
}

// === AUGMENTATION RESET DETECTION ===

/**
 * Detect augmentation reset: cash drops >90% between ticks.
 */
export function isAugReset(prevCash: number, currentCash: number): boolean {
  if (prevCash <= 0) return false;
  return currentCash < prevCash * 0.1;
}

// === EFFECTIVE WEIGHTS ===

/**
 * Compute effective weights considering active flags and rush mode.
 * Rush mode: rushed bucket gets weight 1, others get 0.
 * Normal mode: each bucket's weight / 100 (weights are independent caps, not shares).
 */
export function computeEffectiveWeights(
  weights: Record<string, number>,
  activeFlags: Record<string, boolean>,
  rushBucket: string | null,
): Record<string, number> {
  const effective: Record<string, number> = {};

  if (rushBucket && activeFlags[rushBucket]) {
    for (const bucket of Object.keys(weights)) {
      effective[bucket] = bucket === rushBucket ? 1 : 0;
    }
    return effective;
  }

  for (const bucket of Object.keys(weights)) {
    if (activeFlags[bucket]) {
      effective[bucket] = weights[bucket] / 100;
    } else {
      effective[bucket] = 0;
    }
  }

  return effective;
}

// === ALLOWANCE COMPUTATION ===

export interface AllowanceResult {
  allowance: number;
  maxAllocation: number;
  currentHolding: number;
  isHolder: boolean;
}

export interface HoldingsInfo {
  portfolioValue: number;
  corpFunds: number;
}

/**
 * Compute allowances for all buckets based on current wealth snapshot.
 *
 * Holders: allowance = max(0, netWorth * weight% - currentHoldingValue)
 * Spenders: allowance = (cash - reserve) * weight%
 *
 * `plan` carries the savings goal (selectGoal) and the reserve toward it (computeReserve).
 * Every spender except the goal bucket sees cash minus the reserve; the goal bucket keeps
 * its weighted share of full cash and is lifted to the goal's price once the reserve
 * covers it. Holders are untouched. While a rush is active the plan is ignored: the rushed
 * bucket already gets all cash and everything else is zero.
 */
export function computeAllowances(
  cash: number,
  holdings: HoldingsInfo,
  weights: Record<string, number>,
  activeFlags: Record<string, boolean>,
  rushBucket: string | null,
  plan: GoalPlan = { goal: null, reserve: 0 },
): Record<string, AllowanceResult> {
  const netWorth = cash + holdings.portfolioValue + holdings.corpFunds;
  const effectiveWeights = computeEffectiveWeights(weights, activeFlags, rushBucket);
  const results: Record<string, AllowanceResult> = {};

  const rushActive = rushBucket !== null && !!activeFlags[rushBucket];
  const goal = rushActive ? null : plan.goal;
  const reserve = rushActive || goal === null ? 0 : Math.max(0, plan.reserve);
  const granted = isGranted(goal, reserve);

  for (const bucket of Object.keys(weights)) {
    const ew = effectiveWeights[bucket] ?? 0;
    const isHolder = HOLDER_BUCKETS.has(bucket);

    let currentHolding = 0;
    if (bucket === "stocks") currentHolding = holdings.portfolioValue;
    else if (bucket === "corp") currentHolding = holdings.corpFunds;

    let maxAllocation: number;
    let allowance: number;

    if (isHolder) {
      // Holders: percentage of net worth, minus what they already hold
      maxAllocation = netWorth * ew;
      allowance = Math.max(0, maxAllocation - currentHolding);
    } else {
      // Spenders: percentage of cash, minus the reserve unless this is the goal bucket
      const isGoal = goal !== null && bucket === goal.bucket;
      const base = isGoal ? cash : Math.max(0, cash - reserve);
      maxAllocation = base * ew;
      allowance = maxAllocation;
      if (isGoal && ew > 0 && granted) {
        allowance = Math.max(allowance, goal.cost);
        maxAllocation = Math.max(maxAllocation, goal.cost);
      }
    }

    results[bucket] = { allowance, maxAllocation, currentHolding, isHolder };
  }

  return results;
}

// === COMPLETION HANDLING ===

/**
 * Handle a bucket signaling "done". Simply deactivates the bucket.
 * No balance redistribution needed — other allowances naturally increase
 * since the done bucket's weight is zeroed via activeFlags.
 */
export function handleCompletion(
  bucket: string,
  activeFlags: Record<string, boolean>,
): void {
  activeFlags[bucket] = false;
}

// === CAP CHECKING ===

/**
 * Check if a bucket has reached its reported cost cap.
 */
export function isBucketCapReached(
  lifetimeSpent: number,
  cap: number | null,
): boolean {
  if (cap === null) return false;
  return lifetimeSpent >= cap;
}
