/**
 * Distributed Multi-Target Hacker
 *
 * Intelligently spreads your RAM across multiple targets simultaneously,
 * calculating optimal thread counts per target to maximize income.
 *
 * Supports both legacy parallel mode and HWGW batch mode.
 *
 * Run: run hack/distributed.js
 *      run hack/distributed.js --one-shot
 *      run hack/distributed.js --interval 500 --max-targets 50
 */
import { NS  } from "@ns";
import { COLORS, determineAction, HackAction } from "/lib/utils";
import { getCachedServers } from "/lib/server-cache";
import {
  scoreTarget as batchScoreTarget,
  calculatePrepPlan,
  calculateBatchThreads,
  calculateBatchDelays,
  isTargetPrepped,
  BATCH_WINDOW,
  type TargetScore,
  type BatchOp,
  type CyclePlan,
  type AllocatedOp,
} from "/lib/batch";
import { BatchTargetState } from "/types/ports";

// === TYPES ===

export interface DistributedConfig {
  oneShot: boolean;
  interval: number;
  homeReserve: number;
  maxTargets: number;
  moneyThreshold: number;
  securityBuffer: number;
  hackPercent: number;
}

export interface ServerInfo {
  hostname: string;
  maxRam: number;
  availableRam: number;
}

export interface TargetInfo {
  hostname: string;
  value: number;
  moneyMax: number;
}

export interface TargetAssignment {
  hostname: string;
  action: HackAction;
  optimalThreads: number;
  script: string;
  scriptRam: number;
  value: number;
  assignedThreads: number;
  assignedServers: { hostname: string; threads: number }[];
}

export interface DistributedResult {
  assignments: TargetAssignment[];
  totalRam: number;
  serverCount: number;
  totalThreads: number;
  activeTargets: number;
  shortestWait: number;
  longestWait: number;
}

// === WORKER SCRIPTS ===

export const SCRIPTS = {
  hack: "/workers/hack.js",
  grow: "/workers/grow.js",
  weaken: "/workers/weaken.js",
} as const;

// === CORE LOGIC ===

/**
 * Get all servers with available RAM, sorted by RAM descending.
 * Set excludeHacknet to filter out hacknet-server-* hosts (preserves hash production).
 */
export function getUsableServers(ns: NS, homeReserve: number, excludeHacknet = false): ServerInfo[] {
  const servers: ServerInfo[] = [];

  for (const hostname of getCachedServers(ns)) {
    let server;
    try { server = ns.getServer(hostname); } catch { continue; }
    if (!server.hasAdminRights) continue;
    if (server.maxRam === 0) continue;
    if (excludeHacknet && hostname.startsWith("hacknet-")) continue;

    const reserved = hostname === "home" ? homeReserve : 0;
    const available = server.maxRam - server.ramUsed - reserved;

    if (available > 0) {
      servers.push({
        hostname,
        maxRam: server.maxRam,
        availableRam: available,
      });
    }
  }

  return servers.sort((a, b) => b.availableRam - a.availableRam);
}

/**
 * Get ranked list of hackable targets
 */
export function getTargets(ns: NS, maxTargets: number): TargetInfo[] {
  const player = ns.getPlayer();
  const targets: TargetInfo[] = [];

  for (const hostname of getCachedServers(ns)) {
    let server;
    try { server = ns.getServer(hostname); } catch { continue; }

    if (!server.hasAdminRights) continue;
    if ((server.requiredHackingSkill ?? 0) > player.skills.hacking) continue;
    if ((server.moneyMax ?? 0) === 0) continue;
    if (hostname.startsWith("pserv-") || hostname === "home") continue;

    const hackTime = ns.getHackTime(hostname);
    const moneyMax = server.moneyMax ?? 0;
    const hackChance = ns.hackAnalyzeChance(hostname);
    const value = (moneyMax * hackChance) / hackTime;

    targets.push({ hostname, value, moneyMax });
  }

  return targets.sort((a, b) => b.value - a.value).slice(0, maxTargets);
}

/**
 * Calculate optimal threads for an action on a target
 */
export function calculateOptimalThreads(
  ns: NS,
  hostname: string,
  action: HackAction,
  hackPercent: number
): number {
  const server = ns.getServer(hostname);

  if (action === "weaken") {
    const hackDifficulty = server.hackDifficulty ?? 0;
    const minDifficulty = server.minDifficulty ?? 0;
    const needed = (hackDifficulty - minDifficulty) / 0.05;
    return Math.ceil(needed);
  } else if (action === "grow") {
    const moneyMax = server.moneyMax ?? 0;
    const moneyAvailable = server.moneyAvailable ?? 0;
    const growthNeeded = moneyMax / Math.max(moneyAvailable, 1);
    return Math.ceil(ns.growthAnalyze(hostname, growthNeeded));
  } else {
    const hackAnalysis = ns.hackAnalyze(hostname);
    if (hackAnalysis === 0) return 1;
    return Math.max(1, Math.floor(hackPercent / hackAnalysis));
  }
}

/**
 * Create assignments for all targets
 */
export function createAssignments(
  ns: NS,
  targets: TargetInfo[],
  config: Pick<DistributedConfig, "moneyThreshold" | "securityBuffer" | "hackPercent">
): TargetAssignment[] {
  const assignments: TargetAssignment[] = [];

  for (const target of targets) {
    const server = ns.getServer(target.hostname);
    const action = determineAction(server, config.moneyThreshold, config.securityBuffer);
    const optimalThreads = calculateOptimalThreads(ns, target.hostname, action, config.hackPercent);
    const script = SCRIPTS[action];

    assignments.push({
      hostname: target.hostname,
      action,
      optimalThreads,
      script,
      scriptRam: ns.getScriptRam(script),
      value: target.value,
      assignedThreads: 0,
      assignedServers: [],
    });
  }

  return assignments;
}

/**
 * Distribute servers to targets based on priority
 */
export function assignServersToTargets(
  servers: ServerInfo[],
  assignments: TargetAssignment[]
): void {
  let serverIndex = 0;
  let allSaturated = false;

  while (serverIndex < servers.length && !allSaturated) {
    allSaturated = true;

    for (const assignment of assignments) {
      if (serverIndex >= servers.length) break;

      if (assignment.assignedThreads >= assignment.optimalThreads) continue;

      allSaturated = false;
      const srv = servers[serverIndex];
      const threadsCanRun = Math.floor(srv.availableRam / assignment.scriptRam);

      if (threadsCanRun > 0) {
        const threadsToAssign = Math.min(
          threadsCanRun,
          assignment.optimalThreads - assignment.assignedThreads
        );

        assignment.assignedServers.push({
          hostname: srv.hostname,
          threads: threadsToAssign,
        });
        assignment.assignedThreads += threadsToAssign;

        srv.availableRam -= threadsToAssign * assignment.scriptRam;

        if (srv.availableRam < assignment.scriptRam) {
          serverIndex++;
        }
      }
    }

    // Prevent locking up if trying to assign to full server
    const srv = servers[serverIndex];
    const unsaturated = assignments.filter((a) => a.assignedThreads < a.optimalThreads);
    if (unsaturated.length > 0 && srv) {
      const smallestRam = Math.min(...unsaturated.map((a) => a.scriptRam));
      if (srv.availableRam < smallestRam) {
        serverIndex++;
      }
    }
  }

  // Overflow remaining RAM to best target
  if (serverIndex < servers.length && assignments.length > 0) {
    const bestTarget = assignments[0];
    while (serverIndex < servers.length) {
      const srv = servers[serverIndex];
      const threadsCanRun = Math.floor(srv.availableRam / bestTarget.scriptRam);

      if (threadsCanRun > 0) {
        bestTarget.assignedServers.push({
          hostname: srv.hostname,
          threads: threadsCanRun,
        });
        bestTarget.assignedThreads += threadsCanRun;
      }
      serverIndex++;
    }
  }
}

/**
 * Deploy worker scripts to all servers
 */
export async function deployWorkers(ns: NS, servers: ServerInfo[]): Promise<void> {
  const workers = Object.values(SCRIPTS);
  for (const server of servers) {
    if (
      !(
        ns.fileExists(SCRIPTS.hack, server.hostname) &&
        ns.fileExists(SCRIPTS.weaken, server.hostname) &&
        ns.fileExists(SCRIPTS.grow, server.hostname)
      )
    ) {
      await ns.scp(workers, server.hostname, "home");
    }
  }
}

/**
 * Execute all assignments and return wait times
 */
export function executeAssignments(
  ns: NS,
  assignments: TargetAssignment[]
): { shortest: number; longest: number } {
  let longestWait = 0;
  let shortestWait = Number.MAX_SAFE_INTEGER;

  for (const assignment of assignments) {
    if (assignment.assignedThreads === 0) continue;

    for (const srv of assignment.assignedServers) {
      ns.exec(assignment.script, srv.hostname, srv.threads, assignment.hostname, 0, Date.now());
    }

    let waitTime: number;
    if (assignment.action === "weaken") waitTime = ns.getWeakenTime(assignment.hostname);
    else if (assignment.action === "grow") waitTime = ns.getGrowTime(assignment.hostname);
    else waitTime = ns.getHackTime(assignment.hostname);

    longestWait = Math.max(longestWait, waitTime);
    shortestWait = Math.min(shortestWait, waitTime);
  }

  return {
    shortest: shortestWait === Number.MAX_SAFE_INTEGER ? 0 : shortestWait,
    longest: longestWait,
  };
}

/**
 * Run one distributed hacking cycle
 */
export async function runDistributedCycle(
  ns: NS,
  config: DistributedConfig,
  allowedServers?: Set<string>,
): Promise<DistributedResult> {
  let servers = getUsableServers(ns, config.homeReserve);
  if (allowedServers) {
    servers = servers.filter(s => allowedServers.has(s.hostname));
  }
  const totalRam = servers.reduce((sum, s) => sum + s.availableRam, 0);

  await deployWorkers(ns, servers);

  const targets = getTargets(ns, config.maxTargets);

  const assignments = createAssignments(ns, targets, config);
  assignServersToTargets(servers, assignments);

  const waitTimes = executeAssignments(ns, assignments);

  const totalThreads = assignments.reduce((sum, a) => sum + a.assignedThreads, 0);
  const activeTargets = assignments.filter((a) => a.assignedThreads > 0).length;

  return {
    assignments,
    totalRam,
    serverCount: servers.length,
    totalThreads,
    activeTargets,
    shortestWait: waitTimes.shortest,
    longestWait: waitTimes.longest,
  };
}

// === DISPLAY ===

/**
 * Format distributed cycle result for display
 */
export function formatDistributedStatus(ns: NS, result: DistributedResult): string[] {
  const C = COLORS;
  const lines: string[] = [];
  const actionColors: Record<HackAction, string> = {
    hack: C.green,
    grow: C.yellow,
    weaken: C.blue,
  };

  lines.push(`${C.cyan}════════════════════════════════════════${C.reset}`);
  lines.push(`${C.cyan}  DISTRIBUTED HACKER - ${new Date().toLocaleTimeString()}${C.reset}`);
  lines.push(`${C.cyan}════════════════════════════════════════${C.reset}`);
  lines.push(
    `${C.white}Total RAM: ${ns.format.ram(result.totalRam)} across ${result.serverCount} servers${C.reset}`
  );
  lines.push("");
  lines.push(`${C.white}Target Assignments:${C.reset}`);

  for (const assignment of result.assignments) {
    if (assignment.assignedThreads === 0) continue;

    const color = actionColors[assignment.action];
    const server = ns.getServer(assignment.hostname);
    const money = ns.format.number(server.moneyAvailable ?? 0);
    const maxMoney = ns.format.number(server.moneyMax ?? 0);
    const sec = (server.hackDifficulty ?? 0).toFixed(1);
    const minSec = (server.minDifficulty ?? 0).toFixed(1);
    const saturated = assignment.assignedThreads >= assignment.optimalThreads;
    const satMark = saturated ? `${C.green}✓${C.reset}` : `${C.yellow}~${C.reset}`;

    lines.push(
      `  ${color}${assignment.action.toUpperCase().padEnd(6)}${C.reset} → ${C.cyan}${assignment.hostname.padEnd(15)}${C.reset} | ${satMark} ${assignment.assignedThreads.toLocaleString().padStart(10)} threads | $${money}/${maxMoney} | Sec ${sec}/${minSec}`
    );
  }

  lines.push("");
  lines.push(
    `${C.magenta}Summary: ${result.totalThreads.toLocaleString()} threads across ${result.activeTargets} targets${C.reset}`
  );

  return lines;
}

// === BATCH MODE: TARGET SELECTION ===

export interface BatchConfig {
  homeReserve: number;
  maxTargets: number;
  maxBatches: number;
}

/**
 * Score and rank all hackable targets for batch mode.
 * Returns sorted targets with pre-computed optimal hack%, thread counts, and RAM costs.
 */
export function selectBatchTargets(ns: NS, maxTargets: number): TargetScore[] {
  const player = ns.getPlayer();
  const scores: TargetScore[] = [];

  for (const hostname of getCachedServers(ns)) {
    let server;
    try { server = ns.getServer(hostname); } catch { continue; }

    if (!server.hasAdminRights) continue;
    if ((server.requiredHackingSkill ?? 0) > player.skills.hacking) continue;
    if ((server.moneyMax ?? 0) === 0) continue;
    if (hostname.startsWith("pserv-") || hostname === "home") continue;

    const ts = batchScoreTarget(ns, hostname);
    if (ts.score > 0) {
      scores.push(ts);
    }
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, maxTargets);
}

// === BATCH MODE: CYCLE PLANNING ===

/**
 * Plan a batch cycle: determine which targets need prep, which get new batches,
 * and which need desync recovery.
 */
export function planBatchCycle(
  ns: NS,
  config: BatchConfig,
  targetStates: Map<string, BatchTargetState>,
  batchIdCounter: { value: number },
  preppingTargets: Set<string>,
): CyclePlan {
  const prepOps: BatchOp[] = [];
  const newBatches: { target: string; ops: BatchOp[]; expectedEnd: number }[] = [];
  const abortTargets: string[] = [];

  const scriptRam = ns.getScriptRam("/workers/hack.js");

  // Sort targets by score descending so top-value targets get first crack at RAM
  const sortedTargets = [...targetStates.entries()]
    .sort(([, a], [, b]) => b.score - a.score);

  for (const [hostname, state] of sortedTargets) {
    if (state.phase === "desync-recovery") {
      abortTargets.push(hostname);
      continue;
    }

    if (state.phase === "prep" || !isTargetPrepped(ns, hostname)) {
      // Skip targets that already have prep workers running
      if (preppingTargets.has(hostname)) continue;

      // Need prep work
      const plan = calculatePrepPlan(ns, hostname);
      if (plan.totalThreads === 0) {
        // Already prepped, advance phase
        state.phase = "batch";
        continue;
      }

      // Create prep ops: weaken first, then grow, then compensating weaken
      if (plan.weakenThreads > 0) {
        prepOps.push({
          type: "weaken",
          target: hostname,
          threads: plan.weakenThreads,
          delay: 0,
          tag: "prep",
        });
      }
      if (plan.growThreads > 0) {
        prepOps.push({
          type: "grow",
          target: hostname,
          threads: plan.growThreads,
          delay: 0,
          tag: "prep",
        });
      }
      if (plan.compensateWeakenThreads > 0) {
        prepOps.push({
          type: "weaken",
          target: hostname,
          threads: plan.compensateWeakenThreads,
          delay: 0,
          tag: "prep-cw",
        });
      }
      continue;
    }

    // Target is prepped, launch batches until capacity is full
    const hackTime = ns.getHackTime(hostname);
    const growTime = ns.getGrowTime(hostname);
    const weakenTime = ns.getWeakenTime(hostname);
    const bt = calculateBatchThreads(ns, hostname, state.hackPercent, scriptRam);

    // Cap at theoretical max: how many batches fit in one weaken cycle
    const maxTheoreticalBatches = Math.max(1, Math.floor(weakenTime / BATCH_WINDOW));
    const batchCap = Math.min(config.maxBatches, maxTheoreticalBatches);

    let planned = state.activeBatches;
    while (planned < batchCap) {
      const delays = calculateBatchDelays(hackTime, growTime, weakenTime, planned);

      const batchId = batchIdCounter.value++;
      const tag = `b-${batchId}`;

      const ops: BatchOp[] = [
        { type: "hack", target: hostname, threads: bt.hackThreads, delay: delays.hackDelay, tag },
        { type: "weaken", target: hostname, threads: bt.weaken1Threads, delay: delays.weaken1Delay, tag },
        { type: "grow", target: hostname, threads: bt.growThreads, delay: delays.growDelay, tag },
        { type: "weaken", target: hostname, threads: bt.weaken2Threads, delay: delays.weaken2Delay, tag },
      ];

      const expectedEnd = Date.now() + weakenTime + delays.weaken2Delay;
      newBatches.push({ target: hostname, ops, expectedEnd });
      planned++;
    }
  }

  return { prepOps, newBatches, abortTargets, scriptRam };
}

// === BATCH MODE: SERVER ALLOCATION ===

export interface ServerSlot {
  hostname: string;
  availableRam: number;
}

/**
 * Allocate servers to batch operations.
 * Critical: batches are all-or-nothing — if we can't fit all 4 ops, we skip the batch.
 * Prep ops are allocated first (highest priority), then batches by target score.
 */
export function allocateServersToBatchOps(
  servers: ServerSlot[],
  plan: CyclePlan,
): AllocatedOp[] {
  const allocated: AllocatedOp[] = [];
  const scriptRam = plan.scriptRam;

  // Dynamic prep budget: 100% when no batches need RAM, 50% when batches compete
  const totalFleetRam = servers.reduce((s, srv) => s + srv.availableRam, 0);
  const hasBatchOps = plan.newBatches.length > 0;
  const prepBudget = hasBatchOps ? totalFleetRam * 0.5 : totalFleetRam;
  let prepRamUsed = 0;

  // Helper: try to allocate ALL threads for an op (all-or-nothing, for batch ops)
  function tryAllocate(op: BatchOp): AllocatedOp[] | null {
    let remaining = op.threads;
    const result: AllocatedOp[] = [];

    for (const srv of servers) {
      if (remaining <= 0) break;
      const canFit = Math.floor(srv.availableRam / scriptRam);
      if (canFit <= 0) continue;

      const assign = Math.min(canFit, remaining);
      result.push({
        ...op,
        threads: assign,
        server: srv.hostname,
      });
      srv.availableRam -= assign * scriptRam;
      remaining -= assign;
    }

    if (remaining > 0) {
      // Rollback: couldn't allocate all threads
      for (const alloc of result) {
        const srv = servers.find(s => s.hostname === alloc.server);
        if (srv) srv.availableRam += alloc.threads * scriptRam;
      }
      return null;
    }

    return result;
  }

  // Helper: allocate as many threads as possible (partial is OK, for prep ops)
  function tryAllocatePartial(op: BatchOp, ramBudget: number): { ops: AllocatedOp[]; ramUsed: number } {
    let remaining = op.threads;
    let budgetLeft = ramBudget;
    const result: AllocatedOp[] = [];

    for (const srv of servers) {
      if (remaining <= 0 || budgetLeft <= 0) break;
      const canFit = Math.floor(Math.min(srv.availableRam, budgetLeft) / scriptRam);
      if (canFit <= 0) continue;

      const assign = Math.min(canFit, remaining);
      const ramCost = assign * scriptRam;
      result.push({
        ...op,
        threads: assign,
        server: srv.hostname,
      });
      srv.availableRam -= ramCost;
      budgetLeft -= ramCost;
      remaining -= assign;
    }

    const ramUsed = result.reduce((sum, a) => sum + a.threads * scriptRam, 0);
    return { ops: result, ramUsed };
  }

  // 1. Allocate prep ops (capped at prepBudget, partial allocation OK)
  for (const op of plan.prepOps) {
    const budgetRemaining = prepBudget - prepRamUsed;
    if (budgetRemaining < scriptRam) break;
    const { ops, ramUsed } = tryAllocatePartial(op, budgetRemaining);
    prepRamUsed += ramUsed;
    allocated.push(...ops);
  }

  // 2. Allocate batch ops (all-or-nothing per batch)
  for (const batch of plan.newBatches) {
    const batchAllocations: AllocatedOp[] = [];
    let success = true;

    for (const op of batch.ops) {
      const result = tryAllocate(op);
      if (!result) {
        success = false;
        break;
      }
      batchAllocations.push(...result);
    }

    if (success) {
      allocated.push(...batchAllocations);
    } else {
      // Rollback entire batch allocation
      for (const alloc of batchAllocations) {
        const srv = servers.find(s => s.hostname === alloc.server);
        if (srv) srv.availableRam += alloc.threads * scriptRam;
      }
    }
  }

  return allocated;
}

// === BATCH MODE: EXECUTION ===

/**
 * Execute allocated batch operations by launching workers.
 */
export function executeBatchOps(ns: NS, ops: AllocatedOp[]): void {
  for (const op of ops) {
    const script = SCRIPTS[op.type];
    ns.exec(script, op.server, op.threads, op.target, op.delay, Date.now(), op.tag);
  }
}

