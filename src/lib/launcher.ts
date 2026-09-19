/**
 * RAM-Aware Launcher
 *
 * Frees RAM by killing low-priority processes before launching a script.
 * Kill tiers defined in types/ports.ts (single source of truth):
 *   Tier 1: Ephemeral workers (share, hack, grow, weaken)
 *   Tier 2: daemons/share
 *   Tier 3: daemons/hack
 *   Tier 4: dashboard (last resort, relaunches after)
 *
 * NS functions used: getScriptRam, getServerMaxRam, getServerUsedRam, ps, kill, exec
 * Estimated RAM cost: ~3.8 GB (2.2 GB API + 1.6 GB base)
 */
import { NS } from "@ns";
import { QUEUE_PORT, PRIORITY } from "/types/ports";
import type { QueueEntry } from "/types/ports";
import { walkKillTiers } from "/lib/ram-utils";

/**
 * Launch a script, freeing RAM by killing lower-priority processes if needed.
 *
 * @returns pid of the launched script, or 0 if it could not be launched.
 */
export function ensureRamAndExec(
  ns: NS,
  scriptPath: string,
  host: string,
  threads = 1,
  ...args: (string | number | boolean)[]
): number {
  const requiredRam = ns.getScriptRam(scriptPath, host) * threads;
  if (requiredRam <= 0) {
    ns.tprint(`ERROR: Could not determine RAM for ${scriptPath}`);
    return 0;
  }

  // Check if we already have enough RAM
  let available = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
  if (available >= requiredRam) {
    return ns.exec(scriptPath, host, threads, ...args);
  }

  // Need to free RAM — walk through all kill tiers (including dashboard)
  const { killed, sufficient } = walkKillTiers(ns, requiredRam, {
    host,
    excludeDashboard: false,
  });

  if (killed.length > 0) {
    const summary = killed.map((k) => `${k.filename} (pid ${k.pid}, ${ns.format.ram(k.ram)})`);
    ns.tprint(`INFO: Killed ${killed.length} process(es) to free RAM: ${summary.join(", ")}`);
  }

  if (!sufficient) {
    available = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    ns.tprint(`ERROR: Could not free enough RAM for ${scriptPath} (need ${ns.format.ram(requiredRam)}, have ${ns.format.ram(available)})`);
    return 0;
  }

  return ns.exec(scriptPath, host, threads, ...args);
}

/**
 * Dry-run version: reports what would be killed without actually killing anything.
 *
 * @returns List of processes that would be killed, or empty array if no kills needed.
 */
export function dryRunEnsureRamAndExec(
  ns: NS,
  scriptPath: string,
  host: string,
  threads = 1,
): { wouldKill: { filename: string; pid: number; ram: number }[]; sufficient: boolean } {
  const requiredRam = ns.getScriptRam(scriptPath, host) * threads;
  if (requiredRam <= 0) {
    return { wouldKill: [], sufficient: false };
  }

  const available = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
  if (available >= requiredRam) {
    return { wouldKill: [], sufficient: true };
  }

  const { killed, sufficient } = walkKillTiers(ns, requiredRam, {
    host,
    dryRun: true,
    excludeDashboard: false,
  });

  return {
    wouldKill: killed.map((k) => ({ filename: k.filename, pid: k.pid, ram: k.ram })),
    sufficient,
  };
}

/**
 * Enqueue a script for the queue runner to execute.
 * The queue runner (daemons/queue.ts) processes entries by priority.
 *
 * @param mode "force" kills lower-priority scripts, "queue" waits for free RAM
 */
export function queueExec(
  ns: NS,
  scriptPath: string,
  args: (string | number | boolean)[] = [],
  priority: number = PRIORITY.USER_ACTION,
  mode: "force" | "queue" = "queue",
  requester = "launcher",
  manualFallback?: string,
): void {
  const entry: QueueEntry = {
    script: scriptPath,
    args,
    priority,
    mode,
    timestamp: Date.now(),
    requester,
    manualFallback,
  };
  const handle = ns.getPortHandle(QUEUE_PORT);
  handle.write(JSON.stringify(entry));
}
