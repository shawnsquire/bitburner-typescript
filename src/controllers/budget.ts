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

/** Cash must be at least this many times the pending API price before the carve-out applies. */
export const DEFAULT_WSE_CARVEOUT_MULT = 2;

/**
 * Price of the next stock API the stocks daemon will try to buy, or 0 when it owns both.
 * Order mirrors daemons/stocks.ts: TIX API first, then the 4S Market Data TIX API.
 */
export function nextWseApiCost(hasTIX: boolean, has4S: boolean): number {
  if (!hasTIX) return WSE_TIX_API_COST;
  if (!has4S) return WSE_4S_TIX_API_COST;
  return 0;
}

/**
 * One-off carve-out: when cash covers `mult` times the pending price, grant the full price
 * for this cycle regardless of the bucket's weight. Returns 0 when nothing is pending or
 * cash is below the threshold. Pure; the caller feeds the result into computeAllowances.
 */
export function computeCarveout(cash: number, pendingCost: number, mult: number = DEFAULT_WSE_CARVEOUT_MULT): number {
  if (!(pendingCost > 0) || !(mult > 0)) return 0;
  return cash >= pendingCost * mult ? pendingCost : 0;
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
 * Spenders: allowance = cash * weight%
 *
 * `carveouts` (bucket -> amount) lifts a bucket's allowance up to that amount for this
 * cycle. It only applies while the bucket's effective weight is above zero, so a bucket
 * that is done, frozen, set to 0, or sidelined by another bucket's rush gets nothing.
 * Weights are independent caps on cash, so a carve-out never reduces another bucket.
 */
export function computeAllowances(
  cash: number,
  holdings: HoldingsInfo,
  weights: Record<string, number>,
  activeFlags: Record<string, boolean>,
  rushBucket: string | null,
  carveouts: Record<string, number> = {},
): Record<string, AllowanceResult> {
  const netWorth = cash + holdings.portfolioValue + holdings.corpFunds;
  const effectiveWeights = computeEffectiveWeights(weights, activeFlags, rushBucket);
  const results: Record<string, AllowanceResult> = {};

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
      // Spenders: percentage of cash
      maxAllocation = cash * ew;
      allowance = maxAllocation;
    }

    const carveout = carveouts[bucket] ?? 0;
    if (ew > 0 && carveout > 0) {
      allowance = Math.max(allowance, carveout);
      maxAllocation = Math.max(maxAllocation, carveout);
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
