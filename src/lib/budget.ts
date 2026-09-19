/**
 * Budget Consumer Helpers
 *
 * Lightweight functions for daemons that interact with the budget daemon.
 * If the budget daemon isn't running, these functions gracefully degrade
 * (consumers assume unlimited budget).
 *
 * Import with: import { getBudgetBalance, canAfford, notifyPurchase, signalDone, reportCap, reportNext, getPaybackHorizon, setBudgetWeight } from "/lib/budget";
 */
import { NS } from "@ns";
import { peekStatus } from "/lib/ports";
import {
  STATUS_PORTS,
  BUDGET_CONTROL_PORT,
  BudgetStatus,
  BudgetControlMessage,
} from "/types/ports";

/**
 * Get the current balance for a bucket.
 * Returns Infinity if the budget daemon isn't running (unlimited fallback).
 */
export function getBudgetBalance(ns: NS, bucket: string): number {
  const status = peekStatus<BudgetStatus>(ns, STATUS_PORTS.budget, 30_000);
  if (!status) return Infinity;
  const bucketState = status.buckets[bucket];
  if (!bucketState) return Infinity;
  return bucketState.allowance;
}

/**
 * Check if a bucket can afford a given amount.
 * Returns true if budget daemon isn't running (unlimited fallback).
 */
export function canAfford(ns: NS, bucket: string, amount: number): boolean {
  const balance = getBudgetBalance(ns, bucket);
  return balance >= amount;
}

/**
 * Notify the budget daemon that a purchase was completed.
 * Call this AFTER a successful purchase so the daemon can
 * deduct from the bucket's balance and track lifetime spending.
 */
export function notifyPurchase(
  ns: NS,
  bucket: string,
  amount: number,
  reason: string,
): void {
  const port = ns.getPortHandle(BUDGET_CONTROL_PORT);
  const msg: BudgetControlMessage = {
    action: "purchased",
    bucket,
    amount,
    reason,
  };
  port.write(JSON.stringify(msg));
}

/**
 * Signal that a bucket is "done" — no more spending needed.
 * The bucket's weight and remaining balance will be redistributed.
 *
 * Writes a persistent marker file so the signal survives across
 * budget daemon restarts and startup ordering issues.
 */
export function signalDone(ns: NS, bucket: string): void {
  // Write persistent marker (survives budget daemon restart)
  const markerFile = "/data/budget-done.txt";
  const existing = ns.read(markerFile);
  const doneBuckets = existing ? existing.split("\n").filter(Boolean) : [];
  if (!doneBuckets.includes(bucket)) {
    doneBuckets.push(bucket);
    ns.write(markerFile, doneBuckets.join("\n"), "w");
  }

  // Also send port message for immediate processing
  const port = ns.getPortHandle(BUDGET_CONTROL_PORT);
  const msg: BudgetControlMessage = {
    action: "done",
    bucket,
  };
  port.write(JSON.stringify(msg));
}

/**
 * Reactivate a bucket that was previously marked as done.
 * Removes the persistent marker and sends a reactivate message
 * so the budget daemon re-enables the bucket.
 */
export function reactivateBucket(ns: NS, bucket: string): void {
  const markerFile = "/data/budget-done.txt";
  const existing = ns.read(markerFile);
  if (existing) {
    const filtered = existing.split("\n").filter(Boolean).filter(b => b !== bucket);
    ns.write(markerFile, filtered.join("\n"), "w");
  }
  const port = ns.getPortHandle(BUDGET_CONTROL_PORT);
  const msg: BudgetControlMessage = { action: "reactivate", bucket };
  port.write(JSON.stringify(msg));
}

/**
 * Set a bucket's weight. Use 0 to release the allowance (e.g. when pausing).
 */
export function setBudgetWeight(ns: NS, bucket: string, weight: number): void {
  const port = ns.getPortHandle(BUDGET_CONTROL_PORT);
  const msg: BudgetControlMessage = {
    action: "update-weight",
    bucket,
    weight,
  };
  port.write(JSON.stringify(msg));
}

export function reportCap(ns: NS, bucket: string, remainingCost: number): void {
  const port = ns.getPortHandle(BUDGET_CONTROL_PORT);
  const msg: BudgetControlMessage = {
    action: "report-cap",
    bucket,
    cap: remainingCost,
  };
  port.write(JSON.stringify(msg));
}

/**
 * Report the price of the next purchase this bucket wants, so the budget daemon can
 * save toward it (see docs/systems/budget.md "Savings goal"). Call every cycle; the
 * daemon drops an item not refreshed within two minutes. A cost of 0 clears it.
 */
export function reportNext(ns: NS, bucket: string, cost: number, label: string): void {
  const port = ns.getPortHandle(BUDGET_CONTROL_PORT);
  const msg: BudgetControlMessage = {
    action: "report-next",
    bucket,
    amount: cost,
    reason: label,
  };
  port.write(JSON.stringify(msg));
}

/**
 * Max seconds a purchase may take to pay for itself, from the budget config.
 * Returns Infinity when the budget daemon is not publishing or the horizon is disabled.
 */
export function getPaybackHorizon(ns: NS): number {
  const status = peekStatus<BudgetStatus>(ns, STATUS_PORTS.budget, 30_000);
  const horizon = status?.paybackHorizon;
  return typeof horizon === "number" && horizon > 0 ? horizon : Infinity;
}
