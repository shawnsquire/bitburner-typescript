/**
 * RAM Calculation Utilities
 *
 * Unified kill-tier logic for calculating available RAM and freeing RAM
 * by killing lower-priority scripts.
 *
 * Import with: import { walkKillTiers, freeRamForTarget, calcAvailableAfterKills } from '/lib/ram-utils';
 */
import { NS } from "@ns";
import { KILL_TIERS } from "/types/ports";

// === TYPES ===

export interface KillResult {
  pid: number;
  filename: string;
  ram: number;
  args: (string | number | boolean)[];
}

// === CORE: UNIFIED KILL-TIER WALKER ===

/**
 * Walk kill tiers to find (and optionally kill) processes to free RAM.
 *
 * This is the single source of truth for kill-tier logic. All callers
 * that need to free RAM or estimate freeable RAM should use this function.
 *
 * @param ns - NetScript context
 * @param targetRam - Amount of RAM needed
 * @param options.host - Server to check (default: "home")
 * @param options.dryRun - If true, don't actually kill processes (default: false)
 * @param options.excludeDashboard - If true, skip last tier (default: true)
 * @returns List of killed/would-kill processes and whether target was met
 */
export function walkKillTiers(
  ns: NS,
  targetRam: number,
  options?: {
    host?: string;
    dryRun?: boolean;
    excludeDashboard?: boolean;
  },
): { killed: KillResult[]; sufficient: boolean } {
  const host = options?.host ?? "home";
  const dryRun = options?.dryRun ?? false;
  const excludeDashboard = options?.excludeDashboard ?? true;

  let available = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);

  if (available >= targetRam) {
    return { killed: [], sufficient: true };
  }

  const tiers = excludeDashboard ? KILL_TIERS.slice(0, -1) : KILL_TIERS;
  const killed: KillResult[] = [];

  for (const tierScripts of tiers) {
    if (available >= targetRam) break;

    // Get processes matching this tier, sorted by RAM descending (kill fewest to free most)
    const processes = ns.ps(host);
    const tierProcs = processes
      .filter((p) => tierScripts.includes(p.filename))
      .map((p) => ({
        pid: p.pid,
        filename: p.filename,
        ram: ns.getScriptRam(p.filename, host) * p.threads,
        args: p.args,
      }))
      .sort((a, b) => b.ram - a.ram);

    for (const proc of tierProcs) {
      if (available >= targetRam) break;
      if (!dryRun) {
        ns.kill(proc.pid);
      }
      killed.push(proc);
      available += proc.ram;
    }
  }

  return { killed, sufficient: available >= targetRam };
}

// === CONVENIENCE WRAPPERS ===

/**
 * Calculate total RAM available after hypothetically killing lower-tier scripts.
 * This includes currently available RAM plus RAM used by killable scripts.
 */
export function calcAvailableAfterKills(
  ns: NS,
  host = "home",
  excludeDashboard = true,
): number {
  const available = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
  const { killed } = walkKillTiers(ns, Infinity, { host, dryRun: true, excludeDashboard });
  return available + killed.reduce((sum, k) => sum + k.ram, 0);
}

/**
 * Free RAM by killing lower-tier scripts until target RAM is available.
 * Prints a summary of killed processes.
 */
export function freeRamForTarget(
  ns: NS,
  targetRam: number,
  host = "home",
  excludeDashboard = true,
): boolean {
  const { killed, sufficient } = walkKillTiers(ns, targetRam, { host, excludeDashboard });

  if (killed.length > 0) {
    const summary = killed.map((k) => `${k.filename} (${ns.format.ram(k.ram)})`);
    ns.tprint(`INFO: Killed ${killed.length} process(es) to free RAM: ${summary.join(", ")}`);
  }

  return sufficient;
}

/**
 * Get a breakdown of RAM used by each kill tier.
 * Useful for debugging and understanding RAM usage.
 */
export function getKillTierBreakdown(
  ns: NS,
  host = "home",
): { tier: number; scripts: string[]; totalRam: number; processes: number }[] {
  const processes = ns.ps(host);
  const breakdown: { tier: number; scripts: string[]; totalRam: number; processes: number }[] = [];

  for (let i = 0; i < KILL_TIERS.length; i++) {
    const tierScripts = KILL_TIERS[i];
    let totalRam = 0;
    let processCount = 0;

    for (const script of tierScripts) {
      const procs = processes.filter((p) => p.filename === script);
      for (const proc of procs) {
        totalRam += ns.getScriptRam(proc.filename, host) * proc.threads;
        processCount++;
      }
    }

    breakdown.push({
      tier: i,
      scripts: tierScripts,
      totalRam,
      processes: processCount,
    });
  }

  return breakdown;
}
