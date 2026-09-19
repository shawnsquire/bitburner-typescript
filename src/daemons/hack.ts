/**
 * Hack Daemon
 *
 * Long-running daemon with three modes selected via /config/hack.txt:
 *
 * **Batch mode** (default, maxBatches=0): Full HWGW batching with precise timing,
 * shotgun batching, profitability scoring, auto-optimized hack percentages,
 * and desync detection with automatic re-prep. maxBatches=0 auto-detects
 * optimal batch count from fleet RAM (requires >= 256 GB). Set maxBatches
 * to a specific number for manual override.
 *
 * **Legacy mode**: Simple parallel hacking — falls back automatically when
 * fleet RAM is below 256 GB and maxBatches=0.
 *
 * **XP mode** (strategy=xp): Pure weaken spam for hacking XP.
 */
import { NS } from "@ns";
import {
  runDistributedCycle,
  formatDistributedStatus,
  getUsableServers,
  getTargets,
  DistributedConfig,
  selectBatchTargets,
  planBatchCycle,
  allocateServersToBatchOps,
  executeBatchOps,
  deployWorkers,
  BatchConfig,
  type ServerSlot,
} from "/controllers/hack";
import { publishStatus, peekStatus } from "/lib/ports";
import {
  STATUS_PORTS,
  HackStatus,
  HackStrategy,
  ShareStatus,
  FleetAllocation,
  StocksStatus,
  TargetAssignment as FormattedTarget,
  BatchTargetState,
  BatchTargetStatus,
} from "/types/ports";
import { getServerForSymbol } from "/controllers/stocks";
import { COLORS, HackAction } from "/lib/utils";
import { getCachedServers } from "/lib/server-cache";
import { writeDefaultConfig, getConfigNumber, getConfigBool, getConfigString } from "/lib/config";
import {
  IncomeTracker,
  isTargetPrepped,
  detectDesync,
  getPrepProgress,
  selectXpTarget,
  DESYNC_GRACE_MS,
  BATCH_WINDOW,
} from "/lib/batch";

// === CONFIG ===

const DEFAULT_CONFIG: Pick<
  DistributedConfig,
  "moneyThreshold" | "securityBuffer" | "hackPercent"
> = {
  moneyThreshold: 0.8,
  securityBuffer: 5,
  hackPercent: 0.25,
};

// === SHARE PERCENT AUTO-DETECTION ===

/**
 * Read share target percent from the share status port.
 * Returns 0 if share daemon is not running or has no target percent set.
 */
function getSharePercentFromPort(ns: NS): number {
  const shareStatus = peekStatus<ShareStatus>(ns, STATUS_PORTS.share);
  if (!shareStatus) return 0;
  return shareStatus.targetPercent ?? 0;
}

// === FLEET ALLOCATION ===

interface FleetServer {
  hostname: string;
  maxRam: number;
}

function computeFleetAllocation(
  servers: FleetServer[],
  hackStrategy: HackStrategy,
  sharePercent: number,
): FleetAllocation {
  const totalFleetRam = servers.reduce((sum, s) => sum + s.maxRam, 0);

  if (sharePercent <= 0) {
    return {
      hackServers: servers.map(s => s.hostname),
      shareServers: [],
      hackStrategy, sharePercent,
      totalFleetRam, hackFleetRam: totalFleetRam, shareFleetRam: 0,
      timestamp: Date.now(),
    };
  }

  const shareTarget = totalFleetRam * (sharePercent / 100);

  // Dedicate smallest servers (by maxRam) to share — they contribute least to batching/XP
  const sorted = [...servers].sort((a, b) => a.maxRam - b.maxRam);
  let shareAccumulated = 0;
  const shareSet = new Set<string>();

  for (const s of sorted) {
    if (shareAccumulated >= shareTarget) break;
    if (s.hostname === "home") continue; // Never dedicate home
    shareSet.add(s.hostname);
    shareAccumulated += s.maxRam;
  }

  return {
    hackServers: servers.filter(s => !shareSet.has(s.hostname)).map(s => s.hostname),
    shareServers: servers.filter(s => shareSet.has(s.hostname)).map(s => s.hostname),
    hackStrategy, sharePercent,
    totalFleetRam,
    hackFleetRam: totalFleetRam - shareAccumulated,
    shareFleetRam: shareAccumulated,
    timestamp: Date.now(),
  };
}

// === AUTO-MODE DETECTION ===

/**
 * Determine optimal max-batches based on total fleet RAM.
 * Returns 0 for legacy mode when fleet is too small for batching.
 */
function computeOptimalBatches(totalFleetRam: number): number {
  if (totalFleetRam < 256) return 0;
  return 256; // Arbitrary limit for when it feels like too much for the game perf
}

/** Resolve maxBatches: 0 means auto-detect from fleet RAM, >0 is a manual override. */
function resolveMaxBatches(configValue: number, totalFleetRam: number): number {
  if (configValue > 0) return configValue;
  return computeOptimalBatches(totalFleetRam);
}

/** Read all hack daemon config values from /config/hack.txt */
function readHackConfig(ns: NS) {
  return {
    oneShot: getConfigBool(ns, "hack", "oneShot", false),
    interval: getConfigNumber(ns, "hack", "interval", 200),
    homeReserve: getConfigNumber(ns, "hack", "homeReserve", 32),
    maxTargets: getConfigNumber(ns, "hack", "maxTargets", 100),
    maxBatches: getConfigNumber(ns, "hack", "maxBatches", 0),
    strategy: getConfigString(ns, "hack", "strategy", "money") as HackStrategy,
    moneyThreshold: getConfigNumber(ns, "hack", "moneyThreshold", 0.8),
    securityBuffer: getConfigNumber(ns, "hack", "securityBuffer", 5),
    hackPercent: getConfigNumber(ns, "hack", "hackPercent", 0.25),
    excludeHacknet: !getConfigBool(ns, "hacknet", "allowWorkers", false),
  };
}

// === TIME FORMATTING ===

function formatTimeCondensed(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// === RUNNING JOBS SCANNING ===

interface RunningJobInfo {
  hack: number;
  grow: number;
  weaken: number;
  earliestCompletion: number | null;
  batchTags: Set<string>;
}

function getRunningJobs(ns: NS): Record<string, RunningJobInfo> {
  const jobs: Record<string, RunningJobInfo> = {};

  for (const hostname of getCachedServers(ns)) {
    let procs;
    try { procs = ns.ps(hostname); } catch { continue; }
    for (const proc of procs) {
      if (!proc.filename.includes("workers/")) continue;

      const target = proc.args[0] as string;
      if (!target) continue;

      const action = proc.filename.split("/").pop()?.replace(".js", "") as
        | "hack"
        | "grow"
        | "weaken";
      if (!["hack", "grow", "weaken"].includes(action)) continue;

      const delay = (proc.args[1] as number) || 0;
      const launchTime = proc.args[2] as number;
      const batchTag = proc.args[3] as string | undefined;

      if (!jobs[target]) {
        jobs[target] = { hack: 0, grow: 0, weaken: 0, earliestCompletion: null, batchTags: new Set() };
      }
      jobs[target][action] += proc.threads;

      if (batchTag) {
        jobs[target].batchTags.add(batchTag);
      }

      if (launchTime) {
        let duration: number;
        if (action === "hack") duration = ns.getHackTime(target);
        else if (action === "grow") duration = ns.getGrowTime(target);
        else duration = ns.getWeakenTime(target);

        const completionTime = launchTime + delay + duration;
        const currentEarliest = jobs[target].earliestCompletion;
        if (currentEarliest === null || completionTime < currentEarliest) {
          jobs[target].earliestCompletion = completionTime;
        }
      }
    }
  }

  return jobs;
}

// === EXPECTED MONEY CALCULATION ===

function calcExpectedMoney(ns: NS, target: string, hackThreads: number): number {
  if (hackThreads <= 0) return 0;

  const server = ns.getServer(target);
  const moneyAvailable = server.moneyAvailable ?? 0;

  if (ns.fileExists("Formulas.exe", "home")) {
    const player = ns.getPlayer();
    const hackPercent = ns.formulas.hacking.hackPercent(server, player);
    const hackChance = ns.formulas.hacking.hackChance(server, player);
    return moneyAvailable * Math.min(hackPercent * hackThreads, 1) * hackChance;
  }

  const hackPercent = ns.hackAnalyze(target) * hackThreads;
  const hackChance = ns.hackAnalyzeChance(target);
  return moneyAvailable * Math.min(hackPercent, 1) * hackChance;
}

// === LEGACY MODE: DISPLAY ACTION ===

function determineDisplayAction(
  jobs: { hack: number; grow: number; weaken: number },
  server: {
    hackDifficulty?: number;
    minDifficulty?: number;
    moneyAvailable?: number;
    moneyMax?: number;
  },
): HackAction {
  const totalJobs = jobs.hack + jobs.grow + jobs.weaken;
  if (totalJobs > 0) {
    if (jobs.hack >= jobs.grow && jobs.hack >= jobs.weaken) return "hack";
    if (jobs.grow >= jobs.weaken) return "grow";
    return "weaken";
  }

  const securityThresh = (server.minDifficulty ?? 0) + DEFAULT_CONFIG.securityBuffer;
  const moneyThresh = (server.moneyMax ?? 0) * DEFAULT_CONFIG.moneyThreshold;

  if ((server.hackDifficulty ?? 0) > securityThresh) return "weaken";
  if ((server.moneyAvailable ?? 0) < moneyThresh) return "grow";
  return "hack";
}

// === LEGACY MODE: STATUS COMPUTATION ===

function computeLegacyHackStatus(ns: NS, homeReserve: number, maxTargets: number, excludeHacknet = false): HackStatus | null {
  const player = ns.getPlayer();
  const playerHacking = player.skills.hacking;

  const servers = getUsableServers(ns, homeReserve, excludeHacknet);
  const totalRam = servers.reduce((sum, s) => sum + s.availableRam, 0);

  const targets = getTargets(ns, maxTargets);
  if (targets.length === 0) return null;

  const runningJobs = getRunningJobs(ns);

  let needHigherLevel: { count: number; nextLevel: number } | null = null;
  let lowestRequiredAbovePlayer = Number.MAX_SAFE_INTEGER;
  let countNeedHigher = 0;

  for (const hostname of getCachedServers(ns)) {
    let server;
    try { server = ns.getServer(hostname); } catch { continue; }
    if ((server.moneyMax ?? 0) === 0) continue;
    if (hostname.startsWith("pserv-") || hostname === "home") continue;

    const required = server.requiredHackingSkill ?? 0;
    if (required > playerHacking) {
      countNeedHigher++;
      if (required < lowestRequiredAbovePlayer) {
        lowestRequiredAbovePlayer = required;
      }
    }
  }

  if (countNeedHigher > 0 && lowestRequiredAbovePlayer < Number.MAX_SAFE_INTEGER) {
    needHigherLevel = { count: countNeedHigher, nextLevel: lowestRequiredAbovePlayer };
  }

  let hackingCount = 0;
  let growingCount = 0;
  let weakeningCount = 0;
  let totalExpectedMoney = 0;
  let totalThreadsCount = 0;
  let shortestWait = Number.MAX_SAFE_INTEGER;
  let longestWait = 0;

  const formattedTargets: FormattedTarget[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const jobs = runningJobs[target.hostname] || {
      hack: 0, grow: 0, weaken: 0, earliestCompletion: null, batchTags: new Set(),
    };
    const server = ns.getServer(target.hostname);

    const totalThreads = jobs.hack + jobs.grow + jobs.weaken;
    totalThreadsCount += totalThreads;

    const action = determineDisplayAction(jobs, server);

    if (totalThreads > 0) {
      if (jobs.hack >= jobs.grow && jobs.hack >= jobs.weaken) hackingCount++;
      else if (jobs.grow >= jobs.weaken) growingCount++;
      else weakeningCount++;
    }

    const expectedMoney = calcExpectedMoney(ns, target.hostname, jobs.hack);
    totalExpectedMoney += expectedMoney;

    let waitTime: number;
    if (action === "weaken") waitTime = ns.getWeakenTime(target.hostname);
    else if (action === "grow") waitTime = ns.getGrowTime(target.hostname);
    else waitTime = ns.getHackTime(target.hostname);

    if (totalThreads > 0) {
      shortestWait = Math.min(shortestWait, waitTime);
      longestWait = Math.max(longestWait, waitTime);
    }

    let completionEta: string | null = null;
    if (jobs.earliestCompletion !== null) {
      const msRemaining = jobs.earliestCompletion - Date.now();
      completionEta = msRemaining > 0 ? formatTimeCondensed(msRemaining) : "now";
    }

    const moneyAvailable = server.moneyAvailable ?? 0;
    const moneyMax = server.moneyMax ?? 1;
    const moneyPercent = (moneyAvailable / moneyMax) * 100;

    const hackDifficulty = server.hackDifficulty ?? 0;
    const minDifficulty = server.minDifficulty ?? 0;
    const securityDelta = hackDifficulty - minDifficulty;

    formattedTargets.push({
      rank: i + 1,
      hostname: target.hostname,
      action,
      assignedThreads: totalThreads,
      optimalThreads: 0,
      threadsSaturated: totalThreads > 0,
      moneyPercent,
      moneyDisplay: `${ns.format.number(moneyAvailable)} / ${ns.format.number(moneyMax)}`,
      securityDelta: securityDelta > 0 ? `+${securityDelta.toFixed(1)}` : "0",
      securityClean: securityDelta <= 2,
      eta: formatTimeCondensed(waitTime),
      expectedMoney,
      expectedMoneyFormatted: expectedMoney > 0 ? `$${ns.format.number(expectedMoney)}` : "-",
      totalThreads,
      completionEta,
      hackThreads: jobs.hack,
      growThreads: jobs.grow,
      weakenThreads: jobs.weaken,
    });
  }

  const activeTargets = formattedTargets.filter((t) => t.totalThreads > 0).length;
  const saturationPercent = targets.length > 0 ? (activeTargets / targets.length) * 100 : 0;

  return {
    totalRam: ns.format.ram(totalRam),
    serverCount: servers.length,
    totalThreads: ns.format.number(totalThreadsCount),
    activeTargets,
    totalTargets: targets.length,
    saturationPercent,
    shortestWait:
      shortestWait === Number.MAX_SAFE_INTEGER ? "N/A" : formatTimeCondensed(shortestWait),
    longestWait: longestWait === 0 ? "N/A" : formatTimeCondensed(longestWait),
    hackingCount,
    growingCount,
    weakeningCount,
    targets: formattedTargets,
    totalExpectedMoney,
    totalExpectedMoneyFormatted: `$${ns.format.number(totalExpectedMoney)}`,
    needHigherLevel,
    mode: "legacy",
  };
}

// === BATCH MODE: KILL WORKERS FOR TARGET ===

function killTargetWorkers(ns: NS, target: string): number {
  let killed = 0;
  for (const hostname of getCachedServers(ns)) {
    let procs;
    try { procs = ns.ps(hostname); } catch { continue; }
    for (const proc of procs) {
      if (!proc.filename.includes("workers/")) continue;
      if (proc.args[0] !== target) continue;
      ns.kill(proc.pid);
      killed++;
    }
  }
  return killed;
}

// === BATCH MODE: STATUS COMPUTATION ===

function computeBatchHackStatus(
  ns: NS,
  homeReserve: number,
  maxBatches: number,
  targetStates: Map<string, BatchTargetState>,
  incomeTracker: IncomeTracker,
  _activeBatchMap: Map<number, { target: string; expectedEnd: number }>,
  excludeHacknet = false,
): HackStatus {
  const servers = getUsableServers(ns, homeReserve, excludeHacknet);
  const totalRam = servers.reduce((sum, s) => sum + s.availableRam, 0);

  const runningJobs = getRunningJobs(ns);

  // Aggregate counters
  let hackingCount = 0;
  let growingCount = 0;
  let weakeningCount = 0;
  let totalThreadsCount = 0;
  let shortestWait = Number.MAX_SAFE_INTEGER;
  let longestWait = 0;
  let totalExpectedMoney = 0;
  let preppingCount = 0;
  let batchingCount = 0;
  let totalDesyncCount = 0;
  let totalBatchesActive = 0;
  let totalBatchesLanded = 0;
  let totalBatchesFailed = 0;

  const batchTargets: BatchTargetStatus[] = [];
  const formattedTargets: FormattedTarget[] = [];

  let rank = 0;
  for (const [hostname, state] of targetStates) {
    rank++;
    const jobs = runningJobs[hostname] || {
      hack: 0, grow: 0, weaken: 0, earliestCompletion: null, batchTags: new Set(),
    };
    const server = ns.getServer(hostname);

    const totalThreads = jobs.hack + jobs.grow + jobs.weaken;
    totalThreadsCount += totalThreads;

    // Count by action
    if (totalThreads > 0) {
      if (jobs.hack >= jobs.grow && jobs.hack >= jobs.weaken) hackingCount++;
      else if (jobs.grow >= jobs.weaken) growingCount++;
      else weakeningCount++;
    }

    // Phase counting
    if (state.phase === "prep") preppingCount++;
    else if (state.phase === "batch") batchingCount++;

    // Aggregate batch stats
    totalDesyncCount += state.desyncCount;
    totalBatchesActive += state.activeBatches;
    totalBatchesLanded += state.totalLanded;
    totalBatchesFailed += state.totalFailed;

    const expectedMoney = calcExpectedMoney(ns, hostname, jobs.hack);
    totalExpectedMoney += expectedMoney;

    const weakenTime = ns.getWeakenTime(hostname);
    if (totalThreads > 0) {
      shortestWait = Math.min(shortestWait, weakenTime);
      longestWait = Math.max(longestWait, weakenTime);
    }

    let completionEta: string | null = null;
    if (jobs.earliestCompletion !== null) {
      const msRemaining = jobs.earliestCompletion - Date.now();
      completionEta = msRemaining > 0 ? formatTimeCondensed(msRemaining) : "now";
    }

    const moneyAvailable = server.moneyAvailable ?? 0;
    const moneyMax = server.moneyMax ?? 1;
    const moneyPercent = (moneyAvailable / moneyMax) * 100;
    const hackDifficulty = server.hackDifficulty ?? 0;
    const minDifficulty = server.minDifficulty ?? 0;
    const securityDelta = hackDifficulty - minDifficulty;

    // Determine display action for legacy target table
    const action = determineDisplayAction(jobs, server);

    formattedTargets.push({
      rank,
      hostname,
      action,
      assignedThreads: totalThreads,
      optimalThreads: 0,
      threadsSaturated: totalThreads > 0,
      moneyPercent,
      moneyDisplay: `${ns.format.number(moneyAvailable)} / ${ns.format.number(moneyMax)}`,
      securityDelta: securityDelta > 0 ? `+${securityDelta.toFixed(1)}` : "0",
      securityClean: securityDelta <= 2,
      eta: completionEta || formatTimeCondensed(weakenTime),
      expectedMoney,
      expectedMoneyFormatted: expectedMoney > 0 ? `$${ns.format.number(expectedMoney)}` : "-",
      totalThreads,
      completionEta,
      hackThreads: jobs.hack,
      growThreads: jobs.grow,
      weakenThreads: jobs.weaken,
    });

    // Batch-specific target status
    const maxTheoreticalBatches = Math.max(1, Math.floor(weakenTime / BATCH_WINDOW));

    batchTargets.push({
      rank,
      hostname,
      phase: state.phase,
      score: state.score,
      scoreFormatted: `$${ns.format.number(state.score)}/s/GB`,
      hackPercent: state.hackPercent,
      activeBatches: state.activeBatches,
      maxBatches: Math.min(maxBatches, maxTheoreticalBatches),
      totalLanded: state.totalLanded,
      totalFailed: state.totalFailed,
      desyncCount: state.desyncCount,
      prepProgress: state.phase === "prep" ? getPrepProgress(ns, hostname) : 1.0,
      moneyPercent,
      moneyDisplay: `${ns.format.number(moneyAvailable)} / ${ns.format.number(moneyMax)}`,
      securityDelta: securityDelta > 0 ? `+${securityDelta.toFixed(1)}` : "0",
      securityClean: securityDelta <= 2,
      incomeRate: 0, // Will be overridden below if we had per-target tracking
      incomeRateFormatted: "-",
      eta: completionEta || formatTimeCondensed(weakenTime),
      hackThreads: jobs.hack,
      growThreads: jobs.grow,
      weakenThreads: jobs.weaken,
      totalThreads,
    });
  }

  const activeTargets = formattedTargets.filter((t) => t.totalThreads > 0).length;
  const saturationPercent = targetStates.size > 0 ? (activeTargets / targetStates.size) * 100 : 0;

  const incomePerSec = incomeTracker.getIncomePerSec();

  return {
    totalRam: ns.format.ram(totalRam),
    serverCount: servers.length,
    totalThreads: ns.format.number(totalThreadsCount),
    activeTargets,
    totalTargets: targetStates.size,
    saturationPercent,
    shortestWait:
      shortestWait === Number.MAX_SAFE_INTEGER ? "N/A" : formatTimeCondensed(shortestWait),
    longestWait: longestWait === 0 ? "N/A" : formatTimeCondensed(longestWait),
    hackingCount,
    growingCount,
    weakeningCount,
    targets: formattedTargets,
    totalExpectedMoney,
    totalExpectedMoneyFormatted: `$${ns.format.number(totalExpectedMoney)}`,
    needHigherLevel: null,
    // Batch mode fields
    mode: "batch",
    incomePerSec,
    incomePerSecFormatted: `$${ns.format.number(incomePerSec)}/s`,
    totalBatchesActive,
    totalBatchesLanded,
    totalBatchesFailed,
    totalDesyncCount,
    preppingCount,
    batchingCount,
    batchTargets,
  };
}

// === BATCH MODE: TERMINAL DISPLAY ===

function printBatchStatus(
  ns: NS,
  status: HackStatus,
  targetStates: Map<string, BatchTargetState>,
): void {
  const C = COLORS;
  ns.print(`${C.cyan}════════════════════════════════════════════════════${C.reset}`);
  ns.print(`${C.cyan}  HWGW BATCH HACKER - ${new Date().toLocaleTimeString()}${C.reset}`);
  ns.print(`${C.cyan}════════════════════════════════════════════════════${C.reset}`);
  ns.print(
    `${C.white}RAM: ${status.totalRam} | Servers: ${status.serverCount} | Threads: ${status.totalThreads}${C.reset}`
  );
  ns.print(
    `${C.green}Income: ${status.incomePerSecFormatted}${C.reset} | ` +
    `Batches: ${C.cyan}${status.totalBatchesActive}${C.reset} active, ` +
    `${C.green}${status.totalBatchesLanded}${C.reset} landed, ` +
    `${C.red}${status.totalBatchesFailed}${C.reset} failed`
  );
  ns.print(
    `Prep: ${status.preppingCount} | Batch: ${status.batchingCount} | Desyncs: ${status.totalDesyncCount}`
  );
  ns.print("");

  const phaseColors: Record<string, string> = {
    "prep": C.yellow,
    "batch": C.green,
    "desync-recovery": C.red,
  };

  for (const [hostname, state] of targetStates) {
    const phaseColor = phaseColors[state.phase] || C.white;
    const phaseStr = state.phase.toUpperCase().padEnd(8);
    const server = ns.getServer(hostname);
    const moneyPct = ((server.moneyAvailable ?? 0) / (server.moneyMax ?? 1) * 100).toFixed(0);
    const secDelta = ((server.hackDifficulty ?? 0) - (server.minDifficulty ?? 0)).toFixed(1);

    ns.print(
      `  ${phaseColor}${phaseStr}${C.reset} ${C.cyan}${hostname.padEnd(18)}${C.reset} ` +
      `B:${String(state.activeBatches).padStart(2)} ` +
      `H%:${(state.hackPercent * 100).toFixed(0).padStart(3)}% ` +
      `$:${moneyPct.padStart(3)}% ` +
      `Sec:${secDelta.padStart(5)} ` +
      `L:${state.totalLanded} F:${state.totalFailed}`
    );
  }
}

// === BATCH STATE RECONSTRUCTION ===

const INCOME_FILE = "/data/hack-income.txt";

/**
 * Reconstruct activeBatchMap from running worker processes.
 * Called on daemon startup to recover in-flight batches from a previous run.
 */
function reconstructBatchState(
  ns: NS,
  targetStates: Map<string, BatchTargetState>,
  activeBatchMap: Map<number, { target: string; expectedEnd: number }>,
  batchIdCounter: { value: number },
): void {
  const runningJobs = getRunningJobs(ns);
  let maxBatchId = -1;

  for (const [target, jobs] of Object.entries(runningJobs)) {
    const batchTags = [...jobs.batchTags].filter(t => t.startsWith("b-"));
    for (const tag of batchTags) {
      const batchId = parseInt(tag.replace("b-", ""));
      if (isNaN(batchId)) continue;
      maxBatchId = Math.max(maxBatchId, batchId);

      if (!activeBatchMap.has(batchId)) {
        // Conservative estimate: batch may be nearly done, but assume full weakenTime remaining
        const weakenTime = ns.getWeakenTime(target);
        activeBatchMap.set(batchId, {
          target,
          expectedEnd: Date.now() + weakenTime,
        });
      }
    }

    // Update target state active batch count
    const state = targetStates.get(target);
    if (state) {
      state.activeBatches = batchTags.length;
    }
  }

  if (maxBatchId >= 0) {
    batchIdCounter.value = maxBatchId + 1;
  }
}

function loadIncomeState(ns: NS, incomeTracker: IncomeTracker): void {
  if (!ns.fileExists(INCOME_FILE)) return;
  try {
    const raw = ns.read(INCOME_FILE);
    const samples = JSON.parse(raw);
    if (Array.isArray(samples)) {
      incomeTracker.loadSamples(samples);
    }
  } catch { /* ignore corrupt data */ }
}

function saveIncomeState(ns: NS, incomeTracker: IncomeTracker): void {
  ns.write(INCOME_FILE, JSON.stringify(incomeTracker.toJSON()), "w");
}

// === RUNNER ===

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "hack", {
    oneShot: "false",
    interval: "200",
    homeReserve: "32",
    maxTargets: "100",
    maxBatches: "0",
    strategy: "money",
    moneyThreshold: "0.8",
    securityBuffer: "5",
    hackPercent: "0.25",
  });

  const cfg = readHackConfig(ns);

  // Bootstrap fleet allocation immediately so share daemon can start working
  const bootstrapServers = getUsableServers(ns, cfg.homeReserve, cfg.excludeHacknet);
  const bootstrapSharePercent = getSharePercentFromPort(ns);
  const bootstrapAllocation = computeFleetAllocation(bootstrapServers, cfg.strategy, bootstrapSharePercent);
  publishStatus(ns, STATUS_PORTS.fleet, bootstrapAllocation);

  const resolvedBatches = resolveMaxBatches(cfg.maxBatches, bootstrapAllocation.totalFleetRam);

  if (cfg.strategy === "drain") {
    await runDrainMode(ns);
  } else if (cfg.strategy === "xp") {
    await runXpMode(ns);
  } else if (cfg.strategy === "stocks") {
    await runStocksMode(ns);
  } else if (resolvedBatches > 0) {
    await runBatchMode(ns);
  } else {
    await runLegacyMode(ns);
  }
}

// === STOCKS MODE ===

/**
 * Stock manipulation mode: grow servers for long positions, hack for short positions.
 * Reads stock positions from the stocks daemon status port and distributes fleet
 * to push stock prices in the desired direction using {stock: true} flag.
 */
async function runStocksMode(ns: NS): Promise<void> {
  const C = COLORS;
  const GROW_SCRIPT = "scripts/hack/stock-grow.js";
  const HACK_SCRIPT = "scripts/hack/stock-hack.js";
  const GROW_RAM = ns.getScriptRam(GROW_SCRIPT);
  const HACK_RAM = ns.getScriptRam(HACK_SCRIPT);

  ns.print(`${C.cyan}Stocks manipulation mode started${C.reset}`);

  // Track deployed workers to avoid re-deploying every cycle
  const deployedWorkers: Map<string, { server: string; pid: number; target: string; action: string }> = new Map();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cfg = readHackConfig(ns);
    if (cfg.strategy !== "stocks") {
      ns.print(`${C.yellow}Strategy changed from stocks, exiting${C.reset}`);
      return;
    }

    // Read stock positions from stocks daemon
    const stocksStatus = peekStatus<StocksStatus>(ns, STATUS_PORTS.stocks, 30_000);

    // Build target list from stock positions
    interface StockTarget {
      server: string;
      symbol: string;
      action: "grow" | "hack";
      priority: number;
    }
    const targets: StockTarget[] = [];

    if (stocksStatus && stocksStatus.positions) {
      for (const pos of stocksStatus.positions) {
        const server = getServerForSymbol(pos.symbol);
        if (!server) continue;
        if (!ns.hasRootAccess(server)) continue;

        targets.push({
          server,
          symbol: pos.symbol,
          action: pos.direction === "long" ? "grow" : "hack",
          priority: pos.shares * Math.abs(pos.confidence),
        });
      }
    }

    // Sort by priority (largest positions first)
    targets.sort((a, b) => b.priority - a.priority);

    // Get fleet servers
    const fleetServers = getUsableServers(ns, cfg.homeReserve, cfg.excludeHacknet);
    const sharePercent = getSharePercentFromPort(ns);
    const allocation = computeFleetAllocation(fleetServers, "stocks", sharePercent);
    publishStatus(ns, STATUS_PORTS.fleet, allocation);

    // Kill stale workers (targets changed or removed)
    const currentTargetKeys = new Set(targets.map(t => `${t.server}-${t.action}`));
    for (const [key, worker] of deployedWorkers.entries()) {
      if (!currentTargetKeys.has(key)) {
        ns.kill(worker.pid);
        deployedWorkers.delete(key);
      }
    }

    // Distribute fleet RAM across targets
    if (targets.length > 0) {
      const totalPriority = targets.reduce((sum, t) => sum + t.priority, 0);
      if (totalPriority <= 0) { await ns.sleep(cfg.interval); continue; }

      for (const target of targets) {
        const key = `${target.server}-${target.action}`;
        if (deployedWorkers.has(key)) {
          // Check if worker is still running
          const worker = deployedWorkers.get(key)!;
          if (ns.isRunning(worker.pid)) continue;
          deployedWorkers.delete(key);
        }

        const script = target.action === "grow" ? GROW_SCRIPT : HACK_SCRIPT;
        const scriptRam = target.action === "grow" ? GROW_RAM : HACK_RAM;
        const targetRamShare = (target.priority / totalPriority) * allocation.hackFleetRam;
        const desiredThreads = Math.floor(targetRamShare / scriptRam);
        if (desiredThreads <= 0) continue;

        // Find a fleet server with enough RAM
        for (const fleetHost of allocation.hackServers) {
          const available = ns.getServerMaxRam(fleetHost) - ns.getServerUsedRam(fleetHost);
          const threads = Math.min(desiredThreads, Math.floor(available / scriptRam));
          if (threads <= 0) continue;

          const pid = ns.exec(script, fleetHost, threads, target.server);
          if (pid > 0) {
            deployedWorkers.set(key, {
              server: fleetHost,
              pid,
              target: target.server,
              action: target.action,
            });
            break;
          }
        }
      }
    }

    // Build and publish status
    const hackStatus: HackStatus = {
      mode: "stocks",
      strategy: "stocks",
      totalRam: ns.format.ram(allocation.totalFleetRam),
      serverCount: allocation.hackServers.length,
      totalThreads: String(deployedWorkers.size),
      activeTargets: targets.length,
      totalTargets: targets.length,
      saturationPercent: 0,
      shortestWait: "—",
      longestWait: "—",
      hackingCount: targets.filter(t => t.action === "hack").length,
      growingCount: targets.filter(t => t.action === "grow").length,
      weakeningCount: 0,
      targets: targets.map((t, i) => ({
        rank: i + 1,
        hostname: t.server,
        action: t.action as HackAction,
        assignedThreads: deployedWorkers.has(`${t.server}-${t.action}`) ? 1 : 0,
        optimalThreads: 1,
        threadsSaturated: false,
        moneyPercent: 0,
        moneyDisplay: t.symbol,
        securityDelta: "—",
        securityClean: true,
        eta: "—",
        expectedMoney: 0,
        expectedMoneyFormatted: "—",
        totalThreads: 0,
        completionEta: null,
        hackThreads: t.action === "hack" ? 1 : 0,
        growThreads: t.action === "grow" ? 1 : 0,
        weakenThreads: 0,
      })),
      totalExpectedMoney: 0,
      totalExpectedMoneyFormatted: "—",
      needHigherLevel: null,
      sharePercent: allocation.sharePercent,
    };
    publishStatus(ns, STATUS_PORTS.hack, hackStatus);

    ns.print(
      `${C.cyan}=== Stocks Manipulation ===${C.reset} ` +
      `Targets: ${targets.length} | ` +
      `Workers: ${deployedWorkers.size} | ` +
      `Fleet: ${allocation.hackServers.length} servers`
    );
    for (const t of targets) {
      const deployed = deployedWorkers.has(`${t.server}-${t.action}`) ? `${C.green}ACTIVE${C.reset}` : `${C.dim}pending${C.reset}`;
      ns.print(`  ${t.symbol} (${t.server}): ${t.action.toUpperCase()} [${deployed}]`);
    }

    await ns.sleep(10_000); // Re-evaluate every 10 seconds
  }
}

// === LEGACY MODE ===

async function runLegacyMode(ns: NS): Promise<void> {
  let cycleCount = 0;

  do {
    const cfg = readHackConfig(ns);
    const config: DistributedConfig = {
      oneShot: cfg.oneShot,
      interval: cfg.interval,
      homeReserve: cfg.homeReserve,
      maxTargets: cfg.maxTargets,
      moneyThreshold: cfg.moneyThreshold,
      securityBuffer: cfg.securityBuffer,
      hackPercent: cfg.hackPercent,
    };

    ns.clearLog();
    cycleCount++;

    // Compute fleet allocation BEFORE running cycle so we can filter servers
    const legacyServers = getUsableServers(ns, config.homeReserve, cfg.excludeHacknet);
    const legacySharePercent = getSharePercentFromPort(ns);
    const legacyAllocation = computeFleetAllocation(legacyServers, "money", legacySharePercent);
    publishStatus(ns, STATUS_PORTS.fleet, legacyAllocation);

    // Filter to hack-allocated servers only (respects share carve-out)
    const hackServerSet = new Set(legacyAllocation.hackServers);
    const result = await runDistributedCycle(ns, config, hackServerSet);

    if (result.assignments.length === 0) {
      ns.print("ERROR: No valid targets found!");

      const emptyStatus: HackStatus = {
        totalRam: ns.format.ram(0),
        serverCount: 0,
        totalThreads: "0",
        activeTargets: 0,
        totalTargets: 0,
        saturationPercent: 0,
        shortestWait: "N/A",
        longestWait: "N/A",
        hackingCount: 0,
        growingCount: 0,
        weakeningCount: 0,
        targets: [],
        totalExpectedMoney: 0,
        totalExpectedMoneyFormatted: "$0",
        needHigherLevel: null,
        mode: "legacy",
        maxBatches: 0,
      };
      publishStatus(ns, STATUS_PORTS.hack, emptyStatus);

      if (!config.oneShot) {
        await ns.sleep(5000);
      }
      continue;
    }

    const hackStatus = computeLegacyHackStatus(ns, config.homeReserve, config.maxTargets, cfg.excludeHacknet);
    if (hackStatus) {
      hackStatus.strategy = "money";
      hackStatus.sharePercent = legacySharePercent;
      hackStatus.maxBatches = 0;
      publishStatus(ns, STATUS_PORTS.hack, hackStatus);
    }

    const lines = formatDistributedStatus(ns, result);
    for (const line of lines) {
      ns.print(line);
    }

    if (!config.oneShot) {
      const waitTime = Math.max(Math.min(result.shortestWait, 30000), 1000);
      ns.print(`Waiting ${ns.format.time(waitTime)}...`);
      await ns.sleep(config.interval + waitTime);
    }
  } while (!getConfigBool(ns, "hack", "oneShot", false));
}

// === BATCH MODE ===

async function runBatchMode(ns: NS): Promise<void> {
  // Daemon state
  const targetStates = new Map<string, BatchTargetState>();
  const incomeTracker = new IncomeTracker();
  loadIncomeState(ns, incomeTracker);
  const batchIdCounter = { value: 0 };
  const activeBatchMap = new Map<number, { target: string; expectedEnd: number }>();
  let cycleCount = 0;
  let batchStateReconstructed = false;
  const RESCORE_INTERVAL = 10; // Re-score targets every N cycles

  do {
    const cfg = readHackConfig(ns);
    ns.clearLog();
    cycleCount++;

    // Fleet allocation FIRST so we can resolve maxBatches
    const allServers = getUsableServers(ns, cfg.homeReserve, cfg.excludeHacknet);
    const sharePercent = getSharePercentFromPort(ns);
    const allocation = computeFleetAllocation(allServers, "money", sharePercent);
    publishStatus(ns, STATUS_PORTS.fleet, allocation);

    const batchConfig: BatchConfig = {
      homeReserve: cfg.homeReserve,
      maxTargets: cfg.maxTargets,
      maxBatches: resolveMaxBatches(cfg.maxBatches, allocation.totalFleetRam),
    };

    // 1. Re-score targets periodically
    if (cycleCount === 1 || cycleCount % RESCORE_INTERVAL === 0) {
      const scored = selectBatchTargets(ns, batchConfig.maxTargets);

      // Update or add target states
      const scoredSet = new Set(scored.map(s => s.hostname));
      for (const ts of scored) {
        const existing = targetStates.get(ts.hostname);
        if (existing) {
          existing.score = ts.score;
          existing.hackPercent = ts.hackPercent;
        } else {
          targetStates.set(ts.hostname, {
            hostname: ts.hostname,
            phase: isTargetPrepped(ns, ts.hostname) ? "batch" : "prep",
            score: ts.score,
            hackPercent: ts.hackPercent,
            activeBatches: 0,
            totalLanded: 0,
            totalFailed: 0,
            desyncCount: 0,
            prepProgress: 0,
            lastBatchLandTime: null,
          });
        }
      }

      // Remove targets no longer in scoring (unless they have active batches)
      for (const [hostname, state] of targetStates) {
        if (!scoredSet.has(hostname) && state.activeBatches === 0) {
          targetStates.delete(hostname);
        }
      }
    }

    // Reconstruct batch state from running workers on first cycle (survives daemon restart)
    if (!batchStateReconstructed) {
      reconstructBatchState(ns, targetStates, activeBatchMap, batchIdCounter);
      batchStateReconstructed = true;
    }

    if (targetStates.size === 0) {
      ns.print("ERROR: No valid targets found for batch mode!");
      publishStatus(ns, STATUS_PORTS.hack, {
        totalRam: ns.format.ram(0), serverCount: 0, totalThreads: "0",
        activeTargets: 0, totalTargets: 0, saturationPercent: 0,
        shortestWait: "N/A", longestWait: "N/A",
        hackingCount: 0, growingCount: 0, weakeningCount: 0,
        targets: [], totalExpectedMoney: 0, totalExpectedMoneyFormatted: "$0",
        needHigherLevel: null, mode: "batch",
        incomePerSec: 0, incomePerSecFormatted: "$0/s",
        totalBatchesActive: 0, totalBatchesLanded: 0, totalBatchesFailed: 0,
        totalDesyncCount: 0, preppingCount: 0, batchingCount: 0, batchTargets: [],
      });
      if (!cfg.oneShot) await ns.sleep(5000);
      continue;
    }

    // 2. Check for landed/failed batches
    const now = Date.now();
    for (const [batchId, batch] of activeBatchMap) {
      if (now < batch.expectedEnd + DESYNC_GRACE_MS) continue;

      const state = targetStates.get(batch.target);
      if (!state) {
        activeBatchMap.delete(batchId);
        continue;
      }

      // Batch should have landed by now — check target state
      if (state.phase === "batch" && detectDesync(ns, batch.target)) {
        state.totalFailed++;
        state.desyncCount++;
        state.phase = "desync-recovery";
      } else {
        state.totalLanded++;
        state.lastBatchLandTime = now;

        // Record income estimate
        const server = ns.getServer(batch.target);
        const moneyMax = server.moneyMax ?? 0;
        const estimated = moneyMax * state.hackPercent;
        incomeTracker.record(estimated);
      }

      state.activeBatches = Math.max(0, state.activeBatches - 1);
      activeBatchMap.delete(batchId);
    }

    // 3. Handle desync recovery: kill workers and transition to prep
    for (const [hostname, state] of targetStates) {
      if (state.phase !== "desync-recovery") continue;

      killTargetWorkers(ns, hostname);
      state.phase = "prep";
      state.activeBatches = 0;

      // Remove all active batches for this target
      for (const [batchId, batch] of activeBatchMap) {
        if (batch.target === hostname) {
          activeBatchMap.delete(batchId);
        }
      }
    }

    // 4. Update active batch counts from running processes
    const runningJobs = getRunningJobs(ns);
    for (const [hostname, state] of targetStates) {
      const jobs = runningJobs[hostname];
      if (jobs) {
        // Count active batches from batch tags (b-N format)
        const batchTags = [...jobs.batchTags].filter(t => t.startsWith("b-"));
        state.activeBatches = batchTags.length;
      } else if (state.activeBatches > 0) {
        // No running jobs but we thought there were batches — they finished
        state.activeBatches = 0;
      }

      // Update prep progress
      if (state.phase === "prep") {
        state.prepProgress = getPrepProgress(ns, hostname);
        // Check if prep is complete
        if (isTargetPrepped(ns, hostname)) {
          const jobs2 = runningJobs[hostname];
          const hasPrepJobs = jobs2 && (jobs2.batchTags.has("prep") || jobs2.batchTags.has("prep-cw"));
          if (!hasPrepJobs) {
            state.phase = "batch";
          }
        }
      }
    }

    // 5. Compute which targets already have prep workers in-flight
    const preppingTargets = new Set<string>();
    for (const [hostname, jobs] of Object.entries(runningJobs)) {
      if (jobs.batchTags.has("prep") || jobs.batchTags.has("prep-cw")) {
        preppingTargets.add(hostname);
      }
    }

    // 6. Get usable servers and deploy workers
    const hackServerSet = new Set(allocation.hackServers);
    const servers = allServers.filter(s => hackServerSet.has(s.hostname));
    await deployWorkers(ns, allServers);

    // 7. Plan next cycle
    const plan = planBatchCycle(ns, batchConfig, targetStates, batchIdCounter, preppingTargets);

    // 8. Allocate servers to ops
    const serverSlots: ServerSlot[] = servers.map(s => ({
      hostname: s.hostname,
      availableRam: s.availableRam,
    }));
    const allocated = allocateServersToBatchOps(serverSlots, plan);

    // 9. Execute allocated ops
    executeBatchOps(ns, allocated);

    // 10. Track newly launched batches
    for (const batch of plan.newBatches) {
      // Check if this batch was actually allocated (all ops present)
      const batchTag = batch.ops[0]?.tag;
      const wasAllocated = allocated.some(op => op.tag === batchTag);
      if (wasAllocated) {
        const batchId = parseInt(batchTag.replace("b-", ""));
        activeBatchMap.set(batchId, {
          target: batch.target,
          expectedEnd: batch.expectedEnd,
        });
        const state = targetStates.get(batch.target);
        if (state) {
          state.activeBatches++;
        }
      }
    }

    // 11. Compute and publish status
    const hackStatus = computeBatchHackStatus(
      ns, batchConfig.homeReserve, batchConfig.maxBatches,
      targetStates, incomeTracker, activeBatchMap, cfg.excludeHacknet,
    );
    hackStatus.strategy = "money";
    hackStatus.sharePercent = sharePercent;
    hackStatus.maxBatches = batchConfig.maxBatches;
    publishStatus(ns, STATUS_PORTS.hack, hackStatus);
    saveIncomeState(ns, incomeTracker);

    // 12. Print terminal status
    printBatchStatus(ns, hackStatus, targetStates);

    // 13. Sleep
    if (!cfg.oneShot) {
      await ns.sleep(1000 + cfg.interval);
    }
  } while (!getConfigBool(ns, "hack", "oneShot", false));
}

// === XP MODE ===

async function runXpMode(ns: NS): Promise<void> {
  const C = COLORS;
  const startTime = Date.now();
  const startXp = ns.getPlayer().exp.hacking;
  let lastDeployTime = 0;
  let lastTargetSelectTime = 0;
  let xpTarget: string | null = null;

  const DEPLOY_INTERVAL = 30_000; // re-deploy workers every 30s
  const TARGET_INTERVAL = 30_000; // re-select target every 30s

  do {
    const cfg = readHackConfig(ns);
    const tickInterval = getConfigNumber(ns, "hack", "xpInterval", 2000);
    ns.clearLog();

    const now = Date.now();

    // 1. Re-select XP target periodically (catches hacking level-ups)
    if (!xpTarget || now - lastTargetSelectTime >= TARGET_INTERVAL) {
      xpTarget = selectXpTarget(ns);
      lastTargetSelectTime = now;
    }

    if (!xpTarget) {
      ns.print("ERROR: No valid XP targets found!");
      const emptyStatus: HackStatus = {
        totalRam: ns.format.ram(0), serverCount: 0, totalThreads: "0",
        activeTargets: 0, totalTargets: 0, saturationPercent: 0,
        shortestWait: "N/A", longestWait: "N/A",
        hackingCount: 0, growingCount: 0, weakeningCount: 0,
        targets: [], totalExpectedMoney: 0, totalExpectedMoneyFormatted: "$0",
        needHigherLevel: null, strategy: "xp", sharePercent: 0,
      };
      publishStatus(ns, STATUS_PORTS.hack, emptyStatus);
      if (!cfg.oneShot) await ns.sleep(5000);
      continue;
    }

    // 2. Get usable servers — force share to 0 (XP mode uses everything)
    const allServers = getUsableServers(ns, cfg.homeReserve, cfg.excludeHacknet);
    const allocation = computeFleetAllocation(allServers, "xp", 0);
    publishStatus(ns, STATUS_PORTS.fleet, allocation);
    const hackServerSet = new Set(allocation.hackServers);
    const servers = allServers.filter(s => hackServerSet.has(s.hostname));

    // 3. Deploy workers periodically (not every tick)
    if (now - lastDeployTime >= DEPLOY_INTERVAL) {
      await deployWorkers(ns, allServers);
      lastDeployTime = now;
    }

    // 4. Launch hack on all AVAILABLE RAM (previous waves that finished free up RAM)
    const hackRam = ns.getScriptRam("/workers/hack.js");
    let launchedThreads = 0;
    let totalFleetRam = 0;
    let usedRam = 0;

    for (const server of servers) {
      const sObj = ns.getServer(server.hostname);
      const avail = sObj.maxRam - sObj.ramUsed;
      totalFleetRam += sObj.maxRam;
      usedRam += sObj.ramUsed;

      if (avail < hackRam) continue;
      const threads = Math.floor(avail / hackRam);
      if (threads <= 0) continue;

      const pid = ns.exec(
        "/workers/hack.js", server.hostname, threads,
        xpTarget, 0, Date.now(), "xp",
      );
      if (pid > 0) {
        launchedThreads += threads;
        usedRam += threads * hackRam;
      }
    }

    // 5. Compute real XP rate from actual player XP
    const currentXp = ns.getPlayer().exp.hacking;
    const xpGained = currentXp - startXp;
    const elapsed = Math.max(now - startTime, 1000);
    const xpRate = xpGained / (elapsed / 1000);

    const hackTime = ns.getHackTime(xpTarget);
    const utilization = totalFleetRam > 0 ? (usedRam / totalFleetRam) * 100 : 0;

    // 6. Publish status
    const hackStatus: HackStatus = {
      totalRam: ns.format.ram(totalFleetRam),
      serverCount: servers.length,
      totalThreads: ns.format.number(launchedThreads),
      activeTargets: 1,
      totalTargets: 1,
      saturationPercent: Math.round(utilization),
      shortestWait: formatTimeCondensed(hackTime),
      longestWait: formatTimeCondensed(hackTime),
      hackingCount: launchedThreads,
      growingCount: 0,
      weakeningCount: 0,
      targets: [],
      totalExpectedMoney: 0,
      totalExpectedMoneyFormatted: "$0",
      needHigherLevel: null,
      strategy: "xp",
      sharePercent: 0,
      xpTarget,
      xpThreads: launchedThreads,
      xpRate,
      xpRateFormatted: `${ns.format.number(xpRate)} XP/s`,
    };
    publishStatus(ns, STATUS_PORTS.hack, hackStatus);

    // 7. Print terminal status
    ns.print(`${C.cyan}════════════════════════════════════════════════════${C.reset}`);
    ns.print(`${C.cyan}  XP MODE - ${new Date().toLocaleTimeString()}${C.reset}`);
    ns.print(`${C.cyan}════════════════════════════════════════════════════${C.reset}`);
    ns.print(`${C.white}Target: ${C.cyan}${xpTarget}${C.reset} (min sec: ${ns.getServer(xpTarget).minDifficulty?.toFixed(1)})`);
    ns.print(`${C.white}Launched: ${C.green}${ns.format.number(launchedThreads)}${C.reset} threads this tick | Servers: ${servers.length}`);
    ns.print(`${C.white}Fleet RAM: ${ns.format.ram(totalFleetRam)} | Utilization: ${C.green}${utilization.toFixed(0)}%${C.reset}`);
    ns.print(`${C.white}Hack Time: ${formatTimeCondensed(hackTime)}${C.reset}`);
    ns.print(`${C.white}XP Rate: ${C.green}${ns.format.number(xpRate)} XP/s${C.reset} (${ns.format.number(xpGained)} total)`);

    // 8. Sleep for tick interval (short — waves pipeline automatically)
    if (!cfg.oneShot) {
      await ns.sleep(tickInterval);
    }
  } while (!getConfigBool(ns, "hack", "oneShot", false));
}

// === DRAIN MODE ===

async function runDrainMode(ns: NS): Promise<void> {
  const C = COLORS;

  do {
    const cfg = readHackConfig(ns);
    ns.clearLog();

    // 1. Fleet allocation — 0 share so drain takes 100%
    const allServers = getUsableServers(ns, cfg.homeReserve, cfg.excludeHacknet);
    const allocation = computeFleetAllocation(allServers, "drain", 0);
    publishStatus(ns, STATUS_PORTS.fleet, allocation);

    // 2. Deploy workers
    await deployWorkers(ns, allServers);

    // 3. Get targets with money available, sorted by moneyAvailable desc
    const rawTargets = getTargets(ns, 999);
    const drainCandidates: { hostname: string; moneyAvailable: number; hackTime: number; hackChance: number; hackAnalyze: number }[] = [];

    for (const t of rawTargets) {
      const server = ns.getServer(t.hostname);
      const moneyAvailable = server.moneyAvailable ?? 0;
      if (moneyAvailable <= 0) continue;
      const hackChance = ns.hackAnalyzeChance(t.hostname);
      if (hackChance <= 0) continue;

      drainCandidates.push({
        hostname: t.hostname,
        moneyAvailable,
        hackTime: ns.getHackTime(t.hostname),
        hackChance,
        hackAnalyze: ns.hackAnalyze(t.hostname),
      });
    }

    drainCandidates.sort((a, b) => b.moneyAvailable - a.moneyAvailable);

    // 4. Build server slots sorted by RAM descending
    const hackRam = ns.getScriptRam("/workers/hack.js");
    const slots = allServers
      .map(s => ({ hostname: s.hostname, available: s.availableRam }))
      .sort((a, b) => b.available - a.available);

    // 5. Greedy allocation: richest targets first
    let totalHackThreads = 0;
    let totalMoneyAvailable = 0;
    let shortestHackTime = Number.MAX_SAFE_INTEGER;
    let longestHackTime = 0;
    const drainTargets: FormattedTarget[] = [];

    for (const target of drainCandidates) {
      const threadsNeeded = Math.ceil(1 / Math.max(target.hackAnalyze, 1e-9));
      let threadsAllocated = 0;

      for (let i = 0; i < slots.length && threadsAllocated < threadsNeeded; i++) {
        const slot = slots[i];
        const maxThreads = Math.floor(slot.available / hackRam);
        if (maxThreads <= 0) continue;

        const threads = Math.min(maxThreads, threadsNeeded - threadsAllocated);
        const pid = ns.exec("/workers/hack.js", slot.hostname, threads, target.hostname, 0, Date.now(), "drain");
        if (pid > 0) {
          threadsAllocated += threads;
          slot.available -= threads * hackRam;
        }
      }

      if (threadsAllocated > 0) {
        totalHackThreads += threadsAllocated;
        totalMoneyAvailable += target.moneyAvailable;
        shortestHackTime = Math.min(shortestHackTime, target.hackTime);
        longestHackTime = Math.max(longestHackTime, target.hackTime);
      }

      const expectedMoney = target.moneyAvailable * Math.min(target.hackAnalyze * threadsAllocated, 1) * target.hackChance;

      drainTargets.push({
        rank: drainTargets.length + 1,
        hostname: target.hostname,
        action: "hack",
        assignedThreads: threadsAllocated,
        optimalThreads: threadsNeeded,
        threadsSaturated: threadsAllocated >= threadsNeeded,
        moneyPercent: 100,
        moneyDisplay: `$${ns.format.number(target.moneyAvailable)}`,
        securityDelta: "0",
        securityClean: true,
        eta: formatTimeCondensed(target.hackTime),
        expectedMoney,
        expectedMoneyFormatted: expectedMoney > 0 ? `$${ns.format.number(expectedMoney)}` : "-",
        totalThreads: threadsAllocated,
        completionEta: formatTimeCondensed(target.hackTime),
        hackThreads: threadsAllocated,
        growThreads: 0,
        weakenThreads: 0,
      });
    }

    const totalRam = allServers.reduce((sum, s) => sum + s.availableRam, 0);
    const activeTargets = drainTargets.filter(t => t.totalThreads > 0).length;

    // 6. Publish status
    const hackStatus: HackStatus = {
      totalRam: ns.format.ram(totalRam),
      serverCount: allServers.length,
      totalThreads: ns.format.number(totalHackThreads),
      activeTargets,
      totalTargets: drainTargets.length,
      saturationPercent: drainTargets.length > 0 ? (activeTargets / drainTargets.length) * 100 : 0,
      shortestWait: shortestHackTime === Number.MAX_SAFE_INTEGER ? "N/A" : formatTimeCondensed(shortestHackTime),
      longestWait: longestHackTime === 0 ? "N/A" : formatTimeCondensed(longestHackTime),
      hackingCount: activeTargets,
      growingCount: 0,
      weakeningCount: 0,
      targets: drainTargets,
      totalExpectedMoney: totalMoneyAvailable,
      totalExpectedMoneyFormatted: `$${ns.format.number(totalMoneyAvailable)}`,
      needHigherLevel: null,
      strategy: "drain",
    };
    publishStatus(ns, STATUS_PORTS.hack, hackStatus);

    // 7. Print terminal status
    ns.print(`${C.cyan}════════════════════════════════════════════════════${C.reset}`);
    ns.print(`${C.red}  DRAIN MODE - ${new Date().toLocaleTimeString()}${C.reset}`);
    ns.print(`${C.cyan}════════════════════════════════════════════════════${C.reset}`);
    ns.print(`${C.white}Targets: ${C.cyan}${activeTargets}${C.reset} / ${drainTargets.length} | Threads: ${C.green}${ns.format.number(totalHackThreads)}${C.reset} | RAM: ${ns.format.ram(totalRam)}`);
    ns.print(`${C.white}Money Available: ${C.green}$${ns.format.number(totalMoneyAvailable)}${C.reset}`);
    if (shortestHackTime < Number.MAX_SAFE_INTEGER) {
      ns.print(`${C.white}Hack Time: ${formatTimeCondensed(shortestHackTime)} - ${formatTimeCondensed(longestHackTime)}${C.reset}`);
    }
    ns.print("");

    for (const t of drainTargets.slice(0, 20)) {
      if (t.totalThreads === 0) continue;
      const sat = t.threadsSaturated ? `${C.green}SAT${C.reset}` : `${C.yellow}${t.assignedThreads}/${t.optimalThreads}${C.reset}`;
      ns.print(`  ${C.cyan}${t.hostname.padEnd(18)}${C.reset} ${sat.padEnd(12)} ${t.moneyDisplay.padStart(10)} ${t.eta.padStart(8)}`);
    }

    // 8. Sleep until shortest hack completes, then re-scan
    if (!cfg.oneShot) {
      const sleepTime = shortestHackTime === Number.MAX_SAFE_INTEGER
        ? 5000
        : Math.min(shortestHackTime + 500, 30000);
      ns.print(`\nWaiting ${formatTimeCondensed(sleepTime)}...`);
      await ns.sleep(sleepTime);
    }
  } while (!getConfigBool(ns, "hack", "oneShot", false));
}
