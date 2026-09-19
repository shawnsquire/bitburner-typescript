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
import { writeDefaultConfig, getConfigNumber, readConfig } from "/lib/config";
import {
  STATUS_PORTS,
  BUDGET_CONTROL_PORT,
  BudgetStatus,
  BucketState,
  BudgetControlMessage,
  StocksStatus,
  CorpStatus,
  HackStatus,
  GangStatus,
  HacknetStatus,
  BudgetIncomeSource,
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
  nextWseApiCost,
  nextWseApiLabel,
  DEFAULT_STOCKS_WEIGHT_4S,
  applyStocks4SWeight,
  computeEffectiveWeights,
  PendingItem,
  DEFAULT_RESERVE_SHARE,
  DEFAULT_PAYBACK_HORIZON,
  prunePending,
  selectGoal,
  computeReserve,
  isGranted,
  HOLDER_BUCKETS,
  DEFAULT_GOAL_HORIZON,
  sumProducerIncome,
  updateCashTrend,
} from "/controllers/budget";
import { formatTime } from "/lib/utils";

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
/** Next purchase per bucket (reportNext). Memory only: consumers re-report every cycle. */
let pending: Record<string, PendingItem> = {};
/** Cash-trend income estimate (EMA, $/s), the fallback when no producer publishes a rate. */
let cashTrend: number | null = null;
let lastTickAt = 0;

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

/**
 * Drain control port, returning spending from "purchased" messages: `total` for aug-reset
 * detection, `spenders` (holders excluded) for the cash-trend income estimate.
 */
function drainControlPort(ns: NS): { total: number; spenders: number } {
  let total = 0;
  let spenders = 0;
  const port = ns.getPortHandle(BUDGET_CONTROL_PORT);
  while (!port.empty()) {
    const data = port.read();
    if (data === "NULL PORT DATA") break;
    try {
      const msg = JSON.parse(data as string) as BudgetControlMessage;
      if (msg.action === "purchased" && msg.amount && msg.amount > 0) {
        total += msg.amount;
        if (!HOLDER_BUCKETS.has(msg.bucket)) spenders += msg.amount;
      }
      handleMessage(ns, msg);
    } catch {
      // Invalid message, skip
    }
  }
  return { total, spenders };
}

/**
 * Cash income per second for goal feasibility: the sum of what the producer daemons
 * publish (hack, hacknet, gang, stocks), or the cash-trend EMA when none is publishing.
 */
function readIncome(ns: NS): { incomePerSec: number; source: BudgetIncomeSource } {
  const hack = peekStatus<HackStatus>(ns, STATUS_PORTS.hack, 30_000);
  const hacknet = peekStatus<HacknetStatus>(ns, STATUS_PORTS.hacknet, 30_000);
  const gang = peekStatus<GangStatus>(ns, STATUS_PORTS.gang, 30_000);
  const stocks = peekStatus<StocksStatus>(ns, STATUS_PORTS.stocks, 30_000);
  const producers = sumProducerIncome({
    hack: hack?.incomePerSec,
    hacknet: hacknet?.cashPerSec,
    gang: gang?.moneyGainRate,
    stocks: stocks?.profitPerSec,
  });
  if (producers.sources.length > 0) return { incomePerSec: producers.total, source: "producers" };
  return { incomePerSec: Math.max(0, cashTrend ?? 0), source: "cash-trend" };
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

    case "report-next":
      if (msg.amount !== undefined && msg.amount > 0) {
        const label = msg.reason || msg.bucket;
        const prev = pending[msg.bucket];
        if (!prev || prev.cost !== msg.amount || prev.label !== label) {
          ns.print(`  ${C.cyan}NEXT${C.reset} ${msg.bucket}: ${label} (${ns.format.number(msg.amount)})`);
        }
        pending[msg.bucket] = { cost: msg.amount, label, at: Date.now() };
      } else if (pending[msg.bucket]) {
        delete pending[msg.bucket];
        ns.print(`  ${C.cyan}NEXT${C.reset} ${msg.bucket}: cleared`);
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
function readHoldings(
  ns: NS,
): HoldingsInfo & { pendingWseCost: number; pendingWseLabel: string | null; has4S: boolean } {
  let portfolioValue = 0;
  let corpFunds = 0;
  let pendingWseCost = 0;
  let pendingWseLabel: string | null = null;
  let has4S = false;

  // Read stocks portfolio value and API ownership from status port
  const stocksStatus = peekStatus<StocksStatus>(ns, STATUS_PORTS.stocks, 30_000);
  if (stocksStatus) {
    portfolioValue = stocksStatus.portfolioValue;
    pendingWseCost = nextWseApiCost(stocksStatus.hasTIX, stocksStatus.has4S);
    pendingWseLabel = nextWseApiLabel(stocksStatus.hasTIX, stocksStatus.has4S);
    has4S = stocksStatus.has4S;
  }

  // Read corp funds from status port
  const corpStatus = peekStatus<CorpStatus>(ns, STATUS_PORTS.corp, 30_000);
  if (corpStatus && corpStatus.exists) {
    corpFunds = corpStatus.funds;
  }

  return { portfolioValue, corpFunds, pendingWseCost, pendingWseLabel, has4S };
}

// === DAEMON LOOP ===

async function daemon(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "budget", {
    interval: "2000",
    reserveShare: String(DEFAULT_RESERVE_SHARE),
    paybackHorizon: String(DEFAULT_PAYBACK_HORIZON),
    goalHorizon: String(DEFAULT_GOAL_HORIZON),
    stocksWeight4S: String(DEFAULT_STOCKS_WEIGHT_4S),
  });

  const interval = getConfigNumber(ns, "budget", "interval", 2000);
  if (readConfig(ns, "budget").has("wseCarveoutMult")) {
    ns.print(
      `${C.yellow}wseCarveoutMult is retired and ignored: the wse-access carve-out is now the savings goal (reserveShare).${C.reset}`,
    );
  }

  // Load persisted state
  state = loadState(ns);
  const currentCash = ns.getPlayer().money;

  // Use persisted lastCash for aug-reset detection across daemon restarts.
  // Without this, prevCash = currentCash on first tick and the reset is missed.
  prevCash = state.lastCash ?? currentCash;

  // Drain any pending purchases before aug-reset check — spending that happened
  // while we were down explains the cash drop and shouldn't trigger a false reset.
  const startupSpending = drainControlPort(ns).total;

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
    const spending = drainControlPort(ns);
    const tickSpending = spending.total;
    checkDoneMarkers(ns);

    // 2. Get current cash
    const currentCash = ns.getPlayer().money;

    // 3. Check aug reset (cash drops >90%)
    // Add back known spending from port messages — daemon purchases explain the
    // cash drop and shouldn't trigger a false reset. In a real aug reset the
    // game clears all ports, so tickSpending is 0 and the check still fires.
    if (isAugReset(prevCash, currentCash + tickSpending)) {
      cashTrend = null;
      lastTickAt = 0;
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

    // 5. Savings goal: the cheapest pending next purchase among eligible buckets. The
    //    stocks daemon does not report; its next API is injected here from its status port
    //    into a per-tick copy, so it can never go stale or be cleared by a stray message.
    const now = Date.now();
    pending = prunePending(pending, now);

    //    Income estimate for feasibility. The cash trend is kept warm every tick so the
    //    fallback is ready the moment the producers stop publishing.
    if (lastTickAt > 0) {
      cashTrend = updateCashTrend(cashTrend, currentCash - prevCash, spending.spenders, (now - lastTickAt) / 1000);
    }
    lastTickAt = now;
    const income = readIncome(ns);
    const candidates: Record<string, PendingItem> = { ...pending };
    if (holdings.pendingWseCost > 0) {
      candidates[WSE_ACCESS_BUCKET] = {
        cost: holdings.pendingWseCost,
        label: holdings.pendingWseLabel ?? "stock API",
        at: now,
      };
    } else {
      delete candidates[WSE_ACCESS_BUCKET];
    }
    const reserveShare = getConfigNumber(ns, "budget", "reserveShare", DEFAULT_RESERVE_SHARE);
    const paybackHorizon = getConfigNumber(ns, "budget", "paybackHorizon", DEFAULT_PAYBACK_HORIZON);
    const goalHorizon = getConfigNumber(ns, "budget", "goalHorizon", DEFAULT_GOAL_HORIZON);

    //    With 4S data the stocks bucket is lifted to stocksWeight4S percent of net worth
    //    (applyStocks4SWeight never lowers a weight and leaves a zero/frozen one alone).
    const stocksWeight4S = getConfigNumber(ns, "budget", "stocksWeight4S", DEFAULT_STOCKS_WEIGHT_4S);
    const weights = applyStocks4SWeight(state.weights, holdings.has4S, stocksWeight4S);

    //    Allowances: every other spender sees cash minus the reserve; the goal bucket is
    //    granted the full price once the reserve covers it (see docs/systems/budget.md).
    const effectiveWeights = computeEffectiveWeights(weights, state.activeFlags, state.rushBucket);
    const rushActive = state.rushBucket !== null && !!state.activeFlags[state.rushBucket];
    const goal = rushActive
      ? null
      : selectGoal(candidates, effectiveWeights, {
          cash: currentCash, reserveShare, incomePerSec: income.incomePerSec, goalHorizon,
        });
    const reserve = computeReserve(currentCash, goal, reserveShare);
    const granted = isGranted(goal, reserve);
    const allowances = computeAllowances(
      currentCash, holdings, weights, state.activeFlags, state.rushBucket, { goal, reserve },
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
      const next = candidates[bucket];

      buckets[bucket] = {
        bucket,
        allowance: a.allowance,
        allowanceFormatted: ns.format.number(a.allowance),
        weight: weights[bucket] ?? 0,
        effectiveWeight: effectiveWeights[bucket] ?? 0,
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
        nextCost: next?.cost ?? 0,
        nextCostFormatted: next ? ns.format.number(next.cost) : null,
        nextLabel: next?.label ?? null,
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
      goal: goal
        ? {
            bucket: goal.bucket,
            label: goal.label,
            cost: goal.cost,
            costFormatted: ns.format.number(goal.cost),
            reserved: reserve,
            reservedFormatted: ns.format.number(reserve),
            progress: Math.min(1, reserve / goal.cost),
            granted,
            etaSec: goal.etaSec,
          }
        : null,
      incomePerSec: income.incomePerSec,
      incomePerSecFormatted: `$${ns.format.number(income.incomePerSec)}/s`,
      incomeSource: income.source,
      goalHorizon: goalHorizon > 0 ? goalHorizon : 0,
      paybackHorizon: paybackHorizon > 0 ? paybackHorizon : 0,
      lastUpdated: now,
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
    const goalLabel = goal
      ? ` | ${C.yellow}Goal:${C.reset} ${goal.label} (${goal.bucket}) ` +
        `${ns.format.number(reserve)}/${ns.format.number(goal.cost)}` +
        (granted ? ` ${C.green}GRANTED${C.reset}` : isFinite(goal.etaSec) ? ` ETA ${formatTime(goal.etaSec)}` : "")
      : "";
    const incomeLabel = ` | Income: $${ns.format.number(income.incomePerSec)}/s (${income.source})`;
    ns.print(
      `${C.cyan}=== Budget ===${C.reset} ` +
      `Cash: ${ns.format.number(currentCash)} | ` +
      `NW: ${ns.format.number(netWorth)} | ` +
      `Active: ${activeCount}/${totalBuckets}${rushLabel}${incomeLabel}${goalLabel}`
    );

    for (const bucket of Object.keys(buckets)) {
      const b = buckets[bucket];
      if (!b.active) continue;
      ns.print(
        `  ${C.cyan}${bucket.padEnd(12)}${C.reset} ` +
        `allow: ${b.allowanceFormatted.padStart(8)} | ` +
        `w: ${String(b.weight).padStart(3)}% | ` +
        `spent: ${b.lifetimeSpentFormatted}` +
        (b.nextCost > 0 ? ` | next: ${b.nextLabel} ${b.nextCostFormatted}` : "")
      );
    }

    await ns.sleep(interval);
  }
}
