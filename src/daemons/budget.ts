/**
 * Budget Daemon (Snapshot Allowance Model)
 *
 * Each tick: reads current cash + holdings from status ports, computes fresh
 * allowances per bucket. No accumulated balances to drift out of sync.
 *
 * Usage: run daemons/budget.js
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { publishStatus, peekStatus } from "/lib/ports";
import { writeDefaultConfig, getConfigNumber } from "/lib/config";
import {
  STATUS_PORTS,
  BUDGET_CONTROL_PORT,
  BudgetStatus,
  BucketState,
  BudgetControlMessage,
  StocksStatus,
  CorpStatus,
} from "/types/ports";
import {
  DEFAULT_WEIGHTS,
  PersistedBudgetState,
  createDefaultPersistedState,
  isAugReset,
  computeAllowances,
  handleCompletion,
  HoldingsInfo,
  WSE_ACCESS_BUCKET,
  DEFAULT_WSE_CARVEOUT_MULT,
  nextWseApiCost,
  computeCarveout,
} from "/controllers/budget";

const C = COLORS;
const BALANCE_FILE = "/data/budget-balances.json";
const DONE_MARKER_FILE = "/data/budget-done.txt";

/** @ram 4 */
export function main(ns: NS): Promise<void> {
  ns.ramOverride(4);
  return daemon(ns);
}

// === STATE ===

let state: PersistedBudgetState;
let prevCash = 0;

// === PERSISTENCE ===

function loadState(ns: NS): PersistedBudgetState {
  if (ns.fileExists(BALANCE_FILE)) {
    try {
      const raw = ns.read(BALANCE_FILE);
      const loaded = JSON.parse(raw) as Partial<PersistedBudgetState>;
      const defaults = createDefaultPersistedState();

      // Merge loaded state with defaults (handles new buckets)
      const merged: PersistedBudgetState = {
        lifetimeSpent: { ...defaults.lifetimeSpent, ...loaded.lifetimeSpent },
        weights: { ...defaults.weights, ...loaded.weights },
        activeFlags: { ...defaults.activeFlags, ...loaded.activeFlags },
        caps: { ...defaults.caps, ...loaded.caps },
        rushBucket: loaded.rushBucket ?? null,
        frozenWeights: loaded.frozenWeights ?? {},
      };

      // Clean up phantom buckets with empty keys
      for (const key of Object.keys(merged.weights)) {
        if (!key) {
          delete merged.lifetimeSpent[key];
          delete merged.weights[key];
          delete merged.activeFlags[key];
          delete merged.caps[key];
        }
      }

      return merged;
    } catch {
      // Corrupt file, start fresh
    }
  }
  return createDefaultPersistedState();
}

function saveState(ns: NS): void {
  state.lastCash = prevCash;
  ns.write(BALANCE_FILE, JSON.stringify(state), "w");
}

// === CONTROL PORT ===

/** Drain control port, returning total spending from "purchased" messages. */
function drainControlPort(ns: NS): number {
  let spending = 0;
  const port = ns.getPortHandle(BUDGET_CONTROL_PORT);
  while (!port.empty()) {
    const data = port.read();
    if (data === "NULL PORT DATA") break;
    try {
      const msg = JSON.parse(data as string) as BudgetControlMessage;
      if (msg.action === "purchased" && msg.amount && msg.amount > 0) {
        spending += msg.amount;
      }
      handleMessage(ns, msg);
    } catch {
      // Invalid message, skip
    }
  }
  return spending;
}

function handleMessage(ns: NS, msg: BudgetControlMessage): void {
  // Ensure the bucket exists in state (skip empty names)
  if (msg.bucket) ensureBucket(msg.bucket);

  switch (msg.action) {
    case "purchased":
      if (msg.amount !== undefined && msg.amount > 0) {
        state.lifetimeSpent[msg.bucket] = (state.lifetimeSpent[msg.bucket] ?? 0) + msg.amount;
        ns.print(`  ${C.green}BUY${C.reset} ${msg.bucket}: ${ns.format.number(msg.amount)} (${msg.reason ?? ""})`);
      }
      break;

    case "done":
      if (state.activeFlags[msg.bucket]) {
        ns.print(`  ${C.yellow}DONE${C.reset} ${msg.bucket}: closing bucket`);
        handleCompletion(msg.bucket, state.activeFlags);
      }
      break;

    case "report-cap":
      if (msg.cap !== undefined) {
        // Cap = current lifetimeSpent + remaining cost
        state.caps[msg.bucket] = (state.lifetimeSpent[msg.bucket] ?? 0) + msg.cap;
        ns.print(`  ${C.cyan}CAP${C.reset} ${msg.bucket}: ${ns.format.number(msg.cap)} remaining`);
      }
      break;

    case "rush":
      state.rushBucket = msg.bucket;
      ns.print(`  ${C.yellow}RUSH${C.reset} ${msg.bucket}: 100% allowance`);
      break;

    case "cancel-rush":
      state.rushBucket = null;
      ns.print(`  ${C.cyan}RUSH OFF${C.reset}`);
      break;

    case "update-weight":
      if (msg.weight !== undefined && msg.weight >= 0) {
        state.weights[msg.bucket] = msg.weight;
        ns.print(`  ${C.cyan}WEIGHT${C.reset} ${msg.bucket}: ${msg.weight}`);
      }
      break;

    case "reset-weights":
      for (const bucket of Object.keys(state.weights)) {
        state.weights[bucket] = DEFAULT_WEIGHTS[bucket] ?? 10;
      }
      ns.print(`  ${C.cyan}RESET${C.reset} All weights restored to defaults`);
      break;

    case "reactivate":
      if (!state.activeFlags[msg.bucket]) {
        state.activeFlags[msg.bucket] = true;
        ns.print(`  ${C.green}REACTIVATE${C.reset} ${msg.bucket}: bucket re-enabled`);
      }
      break;

    case "freeze":
      if (msg.bucket && state.frozenWeights[msg.bucket] === undefined) {
        state.frozenWeights[msg.bucket] = state.weights[msg.bucket] ?? 0;
        state.weights[msg.bucket] = 0;
        ns.print(`  ${C.cyan}FREEZE${C.reset} ${msg.bucket}: saved weight ${state.frozenWeights[msg.bucket]}, set to 0`);
      }
      break;

    case "unfreeze":
      if (msg.bucket && state.frozenWeights[msg.bucket] !== undefined) {
        state.weights[msg.bucket] = state.frozenWeights[msg.bucket];
        ns.print(`  ${C.green}UNFREEZE${C.reset} ${msg.bucket}: restored weight ${state.weights[msg.bucket]}`);
        delete state.frozenWeights[msg.bucket];
      }
      break;
  }
}

function ensureBucket(bucket: string): void {
  if (!bucket) return;
  if (state.lifetimeSpent[bucket] === undefined) {
    state.lifetimeSpent[bucket] = 0;
    state.weights[bucket] = DEFAULT_WEIGHTS[bucket] ?? 10;
    state.activeFlags[bucket] = true;
    state.caps[bucket] = null;
  }
}

/** Check persistent done markers written by consumer daemons. */
function checkDoneMarkers(ns: NS): void {
  const content = ns.read(DONE_MARKER_FILE);
  if (!content) return;
  const doneBuckets = content.split("\n").filter(Boolean);
  for (const bucket of doneBuckets) {
    ensureBucket(bucket);
    if (state.activeFlags[bucket]) {
      ns.print(`  ${C.yellow}DONE${C.reset} ${bucket}: closing bucket (from marker)`);
      handleCompletion(bucket, state.activeFlags);
    }
  }
}

// === HOLDINGS READERS ===

/** Holdings plus the price of the next stock API the stocks daemon wants (0 = owns both or unknown). */
function readHoldings(ns: NS): HoldingsInfo & { pendingWseCost: number } {
  let portfolioValue = 0;
  let corpFunds = 0;
  let pendingWseCost = 0;

  // Read stocks portfolio value and API ownership from status port
  const stocksStatus = peekStatus<StocksStatus>(ns, STATUS_PORTS.stocks, 30_000);
  if (stocksStatus) {
    portfolioValue = stocksStatus.portfolioValue;
    pendingWseCost = nextWseApiCost(stocksStatus.hasTIX, stocksStatus.has4S);
  }

  // Read corp funds from status port
  const corpStatus = peekStatus<CorpStatus>(ns, STATUS_PORTS.corp, 30_000);
  if (corpStatus && corpStatus.exists) {
    corpFunds = corpStatus.funds;
  }

  return { portfolioValue, corpFunds, pendingWseCost };
}

// === DAEMON LOOP ===

async function daemon(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "budget", {
    interval: "2000",
    wseCarveoutMult: String(DEFAULT_WSE_CARVEOUT_MULT),
  });

  const interval = getConfigNumber(ns, "budget", "interval", 2000);

  // Load persisted state
  state = loadState(ns);
  const currentCash = ns.getPlayer().money;

  // Use persisted lastCash for aug-reset detection across daemon restarts.
  // Without this, prevCash = currentCash on first tick and the reset is missed.
  prevCash = state.lastCash ?? currentCash;

  // Drain any pending purchases before aug-reset check — spending that happened
  // while we were down explains the cash drop and shouldn't trigger a false reset.
  const startupSpending = drainControlPort(ns);

  if (isAugReset(prevCash, currentCash + startupSpending)) {
    ns.print(`  ${C.yellow}AUG RESET DETECTED (startup)${C.reset} — zeroing lifetime spent`);
    for (const bucket of Object.keys(state.weights)) {
      state.lifetimeSpent[bucket] = 0;
      state.activeFlags[bucket] = true;
      state.caps[bucket] = null;
    }
    state.rushBucket = null;
    ns.write(DONE_MARKER_FILE, "", "w");
    prevCash = currentCash;
    saveState(ns);
  }

  ns.print(`${C.cyan}Budget daemon started${C.reset} (interval: ${interval}ms, snapshot-allowance)`);
  ns.print(`  Loaded ${Object.keys(state.weights).length} buckets from disk`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 1. Drain control port + check persistent done markers
    const tickSpending = drainControlPort(ns);
    checkDoneMarkers(ns);

    // 2. Get current cash
    const currentCash = ns.getPlayer().money;

    // 3. Check aug reset (cash drops >90%)
    // Add back known spending from port messages — daemon purchases explain the
    // cash drop and shouldn't trigger a false reset. In a real aug reset the
    // game clears all ports, so tickSpending is 0 and the check still fires.
    if (isAugReset(prevCash, currentCash + tickSpending)) {
      ns.print(`  ${C.yellow}AUG RESET DETECTED${C.reset} — zeroing lifetime spent`);
      for (const bucket of Object.keys(state.weights)) {
        state.lifetimeSpent[bucket] = 0;
        state.activeFlags[bucket] = true;
        state.caps[bucket] = null;
      }
      state.rushBucket = null;
      prevCash = currentCash;
      ns.write(DONE_MARKER_FILE, "", "w");
      saveState(ns);
      await ns.sleep(interval);
      continue;
    }

    // 4. Read holdings from other daemon status ports
    const holdings = readHoldings(ns);

    // 5. Compute allowances. The wse-access carve-out grants the full price of the next
    //    stock API once cash covers wseCarveoutMult times that price (see docs/systems/budget.md).
    const wseCarveoutMult = getConfigNumber(ns, "budget", "wseCarveoutMult", DEFAULT_WSE_CARVEOUT_MULT);
    const carveouts = {
      [WSE_ACCESS_BUCKET]: computeCarveout(currentCash, holdings.pendingWseCost, wseCarveoutMult),
    };
    const allowances = computeAllowances(
      currentCash, holdings, state.weights, state.activeFlags, state.rushBucket, carveouts,
    );

    // 6. If rush bucket is no longer active, cancel rush
    if (state.rushBucket && !state.activeFlags[state.rushBucket]) {
      state.rushBucket = null;
    }

    // 7. Build & publish BudgetStatus
    const netWorth = currentCash + holdings.portfolioValue + holdings.corpFunds;
    const buckets: Record<string, BucketState> = {};
    for (const bucket of Object.keys(state.weights)) {
      const lifetime = state.lifetimeSpent[bucket] ?? 0;
      const a = allowances[bucket];
      const cap = state.caps[bucket] ?? null;

      buckets[bucket] = {
        bucket,
        allowance: a.allowance,
        allowanceFormatted: ns.format.number(a.allowance),
        weight: state.weights[bucket] ?? 0,
        effectiveWeight: (state.activeFlags[bucket] ? state.weights[bucket] : 0) / 100,
        lifetimeSpent: lifetime,
        lifetimeSpentFormatted: ns.format.number(lifetime),
        isHolder: a.isHolder,
        currentHolding: a.currentHolding,
        currentHoldingFormatted: ns.format.number(a.currentHolding),
        maxAllocation: a.maxAllocation,
        maxAllocationFormatted: ns.format.number(a.maxAllocation),
        active: state.activeFlags[bucket] ?? false,
        frozen: state.frozenWeights[bucket] !== undefined,
        cap,
        capFormatted: cap !== null ? ns.format.number(cap) : null,
      };
    }

    const status: BudgetStatus = {
      totalCash: currentCash,
      totalCashFormatted: ns.format.number(currentCash),
      netWorth,
      netWorthFormatted: ns.format.number(netWorth),
      portfolioValue: holdings.portfolioValue,
      portfolioValueFormatted: ns.format.number(holdings.portfolioValue),
      corpFunds: holdings.corpFunds,
      corpFundsFormatted: ns.format.number(holdings.corpFunds),
      buckets,
      rushBucket: state.rushBucket,
      lastUpdated: Date.now(),
    };

    publishStatus(ns, STATUS_PORTS.budget, status);

    // 8. Save state to disk
    saveState(ns);

    // 9. Update prevCash
    prevCash = currentCash;

    // Print summary
    const activeCount = Object.values(state.activeFlags).filter(v => v).length;
    const totalBuckets = Object.keys(state.weights).length;
    const rushLabel = state.rushBucket ? ` ${C.yellow}RUSH:${state.rushBucket}${C.reset}` : "";
    ns.print(
      `${C.cyan}=== Budget ===${C.reset} ` +
      `Cash: ${ns.format.number(currentCash)} | ` +
      `NW: ${ns.format.number(netWorth)} | ` +
      `Active: ${activeCount}/${totalBuckets}${rushLabel}`
    );

    for (const bucket of Object.keys(buckets)) {
      const b = buckets[bucket];
      if (!b.active) continue;
      ns.print(
        `  ${C.cyan}${bucket.padEnd(12)}${C.reset} ` +
        `allow: ${b.allowanceFormatted.padStart(8)} | ` +
        `w: ${String(b.weight).padStart(3)}% | ` +
        `spent: ${b.lifetimeSpentFormatted}`
      );
    }

    await ns.sleep(interval);
  }
}
