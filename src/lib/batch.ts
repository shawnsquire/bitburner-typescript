/**
 * HWGW Batch Hacking Engine
 *
 * Pure-logic functions for batch scheduling, thread calculation, target scoring,
 * prep detection, desync detection, and income tracking.
 *
 * Import with: import { ... } from "/lib/batch";
 */
import { NS } from "@ns";
import { getCachedServers } from "/lib/server-cache";

// === CONSTANTS ===

export const BATCH_SPACER = 200;  // ms between ops landing in a batch
export const BATCH_WINDOW = BATCH_SPACER * 4;  // 800ms total landing window
export const SECURITY_PER_HACK = 0.002;
export const SECURITY_PER_GROW = 0.004;
export const SECURITY_PER_WEAKEN = 0.05;
export const PREP_SEC_TOLERANCE = 0.5;
export const PREP_MONEY_TOLERANCE = 0.999;  // 99.9% of max
export const DESYNC_GRACE_MS = 500;

// === TYPES ===

export interface PrepPlan {
  weakenThreads: number;
  growThreads: number;
  compensateWeakenThreads: number;
  totalThreads: number;
  estimatedTime: number;  // ms (weaken time, the longest op)
}

export interface BatchThreads {
  hackThreads: number;
  weaken1Threads: number;
  growThreads: number;
  weaken2Threads: number;
  totalThreads: number;
  ramPerBatch: number;
}

export interface BatchDelays {
  hackDelay: number;
  weaken1Delay: number;
  growDelay: number;
  weaken2Delay: number;
}

/** Per-thread RAM cost of each worker script. hack.js, grow.js and weaken.js
 *  have different RAM costs (ns.hack/ns.grow/ns.weaken cost 0.1/0.15/0.15 GB
 *  respectively), so batch math must not assume a single shared cost. */
export interface WorkerRamCosts {
  hack: number;
  grow: number;
  weaken: number;
}

export interface TargetScore {
  hostname: string;
  score: number;
  hackPercent: number;
  batchThreads: BatchThreads;
  cycleTime: number;
}

export interface BatchOp {
  type: "hack" | "grow" | "weaken";
  target: string;
  threads: number;
  delay: number;
  tag: string;  // "prep" or "b-{id}"
}

export interface CyclePlan {
  prepOps: BatchOp[];
  newBatches: { target: string; ops: BatchOp[]; expectedEnd: number }[];
  abortTargets: string[];
  ramCosts: WorkerRamCosts;
}

export interface AllocatedOp extends BatchOp {
  server: string;
}

// === XP TARGET SELECTION ===

export function selectXpTarget(ns: NS): string | null {
  const player = ns.getPlayer();
  let bestHost: string | null = null;
  let bestMinSec = Infinity;

  for (const hostname of getCachedServers(ns)) {
    if (hostname === "home" || hostname.startsWith("pserv-")) continue;
    let server;
    try { server = ns.getServer(hostname); } catch { continue; }
    if (!server.hasAdminRights) continue;
    if ((server.moneyMax ?? 0) === 0) continue;
    if ((server.requiredHackingSkill ?? 0) > player.skills.hacking) continue;

    const minSec = server.minDifficulty ?? Infinity;
    if (minSec < bestMinSec) {
      bestMinSec = minSec;
      bestHost = hostname;
    }
  }

  return bestHost;
}

// === PREP DETECTION ===

export function isTargetPrepped(ns: NS, hostname: string): boolean {
  const server = ns.getServer(hostname);
  const minSec = server.minDifficulty ?? 0;
  const curSec = server.hackDifficulty ?? 0;
  const maxMoney = server.moneyMax ?? 0;
  const curMoney = server.moneyAvailable ?? 0;

  return (curSec - minSec) <= PREP_SEC_TOLERANCE
      && curMoney >= maxMoney * PREP_MONEY_TOLERANCE;
}

export function getPrepProgress(ns: NS, hostname: string): number {
  const server = ns.getServer(hostname);
  const minSec = server.minDifficulty ?? 0;
  const curSec = server.hackDifficulty ?? 0;
  const maxMoney = server.moneyMax ?? 0;
  const curMoney = server.moneyAvailable ?? 0;

  // Security progress: how close to min (1.0 = at min)
  const secRange = Math.max(curSec - minSec, 0);
  const secProgress = secRange <= PREP_SEC_TOLERANCE ? 1.0 : Math.max(0, 1 - secRange / 100);

  // Money progress: how close to max
  const moneyProgress = maxMoney > 0 ? curMoney / maxMoney : 1.0;

  return (secProgress + moneyProgress) / 2;
}

// === PREP PLANNING ===

export function calculatePrepPlan(ns: NS, hostname: string): PrepPlan {
  const server = ns.getServer(hostname);
  const minSec = server.minDifficulty ?? 0;
  const curSec = server.hackDifficulty ?? 0;
  const maxMoney = server.moneyMax ?? 0;
  const curMoney = server.moneyAvailable ?? 0;

  // Weaken to min security
  const secDelta = curSec - minSec;
  const weakenThreads = secDelta > PREP_SEC_TOLERANCE
    ? Math.ceil(secDelta / SECURITY_PER_WEAKEN)
    : 0;

  // Grow to max money
  let growThreads = 0;
  if (curMoney < maxMoney * PREP_MONEY_TOLERANCE) {
    const growthNeeded = maxMoney / Math.max(curMoney, 1);
    growThreads = Math.ceil(ns.growthAnalyze(hostname, growthNeeded));
  }

  // Compensating weaken for grow security
  const compensateWeakenThreads = growThreads > 0
    ? Math.ceil(growThreads * SECURITY_PER_GROW / SECURITY_PER_WEAKEN)
    : 0;

  const totalThreads = weakenThreads + growThreads + compensateWeakenThreads;
  const estimatedTime = ns.getWeakenTime(hostname);

  return { weakenThreads, growThreads, compensateWeakenThreads, totalThreads, estimatedTime };
}

// === WORKER RAM COSTS ===

/**
 * Get the per-thread RAM cost of each HWGW worker script.
 * hack.js/grow.js/weaken.js have different base RAM costs (different ns
 * calls), so callers must not assume they're interchangeable.
 */
export function getWorkerRamCosts(ns: NS): WorkerRamCosts {
  return {
    hack: ns.getScriptRam("/workers/hack.js"),
    grow: ns.getScriptRam("/workers/grow.js"),
    weaken: ns.getScriptRam("/workers/weaken.js"),
  };
}

// === BATCH THREAD CALCULATION ===

export function calculateBatchThreads(
  ns: NS,
  hostname: string,
  hackPercent: number,
  ramCosts: WorkerRamCosts,
): BatchThreads {
  const server = ns.getServer(hostname);

  let hackThreads: number;
  let growThreads: number;

  if (ns.fileExists("Formulas.exe", "home")) {
    const player = ns.getPlayer();

    // Simulate prepped server for accurate calculations
    const preppedServer = { ...server };
    preppedServer.hackDifficulty = preppedServer.minDifficulty;
    preppedServer.moneyAvailable = preppedServer.moneyMax;

    const hackPerThread = ns.formulas.hacking.hackPercent(preppedServer, player);
    hackThreads = hackPerThread > 0 ? Math.ceil(hackPercent / hackPerThread) : 1;

    // Simulate post-hack money for grow calculation
    const postHackServer = { ...preppedServer };
    const actualStolen = Math.min(hackPerThread * hackThreads, 1);
    postHackServer.moneyAvailable = (preppedServer.moneyMax ?? 0) * (1 - actualStolen);
    postHackServer.moneyAvailable = Math.max(postHackServer.moneyAvailable, 0);

    // Grow needs to restore from post-hack money (not current/prepped money) to max
    if (postHackServer.moneyAvailable > 0) {
      growThreads = ns.formulas.hacking.growThreads(
        postHackServer,
        player,
        (preppedServer.moneyMax ?? 0),
        1, // cores (fleet workers run on 1-core servers)
      );
    } else {
      // Money is 0 after hack, need heavy grow
      const growthNeeded = (preppedServer.moneyMax ?? 0) / Math.max(postHackServer.moneyAvailable, 1);
      growThreads = Math.ceil(ns.growthAnalyze(hostname, growthNeeded));
    }
  } else {
    // Fallback: standard API (uses current server state, less accurate)
    const hackAnalysis = ns.hackAnalyze(hostname);
    hackThreads = hackAnalysis > 0 ? Math.ceil(hackPercent / hackAnalysis) : 1;

    const growthNeeded = 1 / (1 - Math.min(hackPercent, 0.99));
    growThreads = Math.ceil(ns.growthAnalyze(hostname, growthNeeded));
  }

  hackThreads = Math.max(hackThreads, 1);
  growThreads = Math.max(growThreads, 1);

  const weaken1Threads = Math.max(1, Math.ceil(hackThreads * SECURITY_PER_HACK / SECURITY_PER_WEAKEN));
  const weaken2Threads = Math.max(1, Math.ceil(growThreads * SECURITY_PER_GROW / SECURITY_PER_WEAKEN));

  const totalThreads = hackThreads + weaken1Threads + growThreads + weaken2Threads;
  const ramPerBatch =
    hackThreads * ramCosts.hack +
    (weaken1Threads + weaken2Threads) * ramCosts.weaken +
    growThreads * ramCosts.grow;

  return { hackThreads, weaken1Threads, growThreads, weaken2Threads, totalThreads, ramPerBatch };
}

// === BATCH DELAY CALCULATION ===

export function calculateBatchDelays(
  hackTime: number,
  growTime: number,
  weakenTime: number,
  batchIndex: number,
): BatchDelays {
  const offset = batchIndex * BATCH_WINDOW;

  // Landing order: Hack, Weaken1, Grow, Weaken2
  // Each 200ms apart. Weaken1 is the baseline (longest op).
  // hackLands    = launchTime + hackDelay + hackTime
  // weaken1Lands = launchTime + weaken1Delay + weakenTime   = hackLands + SPACER
  // growLands    = launchTime + growDelay + growTime         = hackLands + 2*SPACER
  // weaken2Lands = launchTime + weaken2Delay + weakenTime   = hackLands + 3*SPACER

  const hackDelay = weakenTime - hackTime - BATCH_SPACER + offset;
  const weaken1Delay = offset;
  const growDelay = weakenTime - growTime + BATCH_SPACER + offset;
  const weaken2Delay = BATCH_SPACER * 2 + offset;

  return {
    hackDelay: Math.max(0, hackDelay),
    weaken1Delay: Math.max(0, weaken1Delay),
    growDelay: Math.max(0, growDelay),
    weaken2Delay: Math.max(0, weaken2Delay),
  };
}

// === TARGET SCORING ===

export function scoreTarget(ns: NS, hostname: string): TargetScore {
  const { hackPercent, score, cycleTime, batchThreads } = optimizeHackPercent(ns, hostname);
  return { hostname, score, hackPercent, batchThreads, cycleTime };
}

export function optimizeHackPercent(
  ns: NS,
  hostname: string,
): { hackPercent: number; score: number; cycleTime: number; batchThreads: BatchThreads } {
  const server = ns.getServer(hostname);
  const moneyMax = server.moneyMax ?? 0;
  const weakenTime = ns.getWeakenTime(hostname);
  const ramCosts = getWorkerRamCosts(ns);

  let bestScore = -1;
  let bestPercent = 0.05;
  let bestBatch: BatchThreads | null = null;

  // Use Formulas for hack chance if available
  let hackChance = ns.hackAnalyzeChance(hostname);
  if (ns.fileExists("Formulas.exe", "home")) {
    const preppedServer = { ...server };
    preppedServer.hackDifficulty = preppedServer.minDifficulty;
    preppedServer.moneyAvailable = preppedServer.moneyMax;
    hackChance = ns.formulas.hacking.hackChance(preppedServer, ns.getPlayer());
  }

  for (let pct = 0.01; pct <= 0.95; pct += 0.01) {
    const bt = calculateBatchThreads(ns, hostname, pct, ramCosts);
    if (bt.ramPerBatch <= 0) continue;

    const cycleTime = weakenTime + BATCH_WINDOW;
    const moneyPerBatch = moneyMax * pct * hackChance;
    const scoreVal = moneyPerBatch / (cycleTime / 1000) / bt.ramPerBatch;

    if (scoreVal > bestScore) {
      bestScore = scoreVal;
      bestPercent = pct;
      bestBatch = bt;
    }
  }

  // Fallback if nothing scored
  if (!bestBatch) {
    bestBatch = calculateBatchThreads(ns, hostname, 0.05, ramCosts);
  }

  const cycleTime = weakenTime + BATCH_WINDOW;
  return { hackPercent: bestPercent, score: bestScore, cycleTime, batchThreads: bestBatch };
}

// === DESYNC DETECTION ===

export function detectDesync(ns: NS, hostname: string): boolean {
  const server = ns.getServer(hostname);
  const minSec = server.minDifficulty ?? 0;
  const curSec = server.hackDifficulty ?? 0;
  const maxMoney = server.moneyMax ?? 0;
  const curMoney = server.moneyAvailable ?? 0;

  // Security blown = desync
  if ((curSec - minSec) > PREP_SEC_TOLERANCE * 2) return true;

  // Money significantly below max with no operations expected = desync
  if (curMoney < maxMoney * 0.95) return true;

  return false;
}

// === INCOME TRACKER ===

export class IncomeTracker {
  private samples: { time: number; amount: number }[] = [];
  private windowMs: number;

  constructor(windowSeconds = 60) {
    this.windowMs = windowSeconds * 1000;
  }

  record(amount: number): void {
    const now = Date.now();
    this.samples.push({ time: now, amount });
    this.prune(now);
  }

  getIncomePerSec(): number {
    const now = Date.now();
    this.prune(now);
    if (this.samples.length === 0) return 0;

    const totalIncome = this.samples.reduce((sum, s) => sum + s.amount, 0);
    const elapsed = Math.max(now - this.samples[0].time, 1000);
    return totalIncome / (elapsed / 1000);
  }

  /** Serialize samples for persistence */
  toJSON(): { time: number; amount: number }[] {
    this.prune(Date.now());
    return [...this.samples];
  }

  /** Restore samples from persisted data */
  loadSamples(samples: { time: number; amount: number }[]): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.samples = samples.filter(s => s.time >= cutoff);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
  }
}
