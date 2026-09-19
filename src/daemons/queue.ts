/**
 * Queue Runner Daemon
 *
 * Lightweight daemon (~4.5 GB target) that processes a priority queue
 * of one-shot action scripts. Supports round-robin status checks and
 * user-triggered actions with RAM management via kill tiers.
 *
 * Usage:
 *   run daemons/queue.js
 *   run daemons/queue.js --interval 2000
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { dequeueAction } from "/lib/ports";
import { QueueEntry, PRIORITY } from "/types/ports";
import { walkKillTiers } from "/lib/ram-utils";
import { writeDefaultConfig, getConfigNumber } from "/lib/config";

// === ROUND-ROBIN STATUS CHECKS ===

const STATUS_CHECKS: QueueEntry[] = [
  {
    script: "actions/check-work.js",
    args: [],
    priority: PRIORITY.STATUS_CHECK,
    mode: "queue",
    timestamp: 0,
    requester: "queue-runner",
  },
  {
    script: "actions/check-darkweb.js",
    args: [],
    priority: PRIORITY.STATUS_CHECK,
    mode: "queue",
    timestamp: 0,
    requester: "queue-runner",
  },
  {
    script: "actions/check-factions.js",
    args: [],
    priority: PRIORITY.STATUS_CHECK,
    mode: "queue",
    timestamp: 0,
    requester: "queue-runner",
  },
  {
    script: "actions/check-territory.js",
    args: ["--all"],
    priority: PRIORITY.STATUS_CHECK,
    mode: "queue",
    timestamp: 0,
    requester: "queue-runner",
  },
];

/**
 * Collect all pending queue entries, sorted by priority (highest first)
 */
function drainQueue(ns: NS): QueueEntry[] {
  const entries: QueueEntry[] = [];
  let entry = dequeueAction(ns);
  while (entry !== null) {
    entries.push(entry);
    entry = dequeueAction(ns);
  }
  // Sort by priority descending (highest priority first)
  entries.sort((a, b) => b.priority - a.priority);
  return entries;
}

/**
 * Get available RAM on home server
 */
function getAvailableRam(ns: NS): number {
  const maxRam = ns.getServerMaxRam("home");
  const usedRam = ns.getServerUsedRam("home");
  return maxRam - usedRam;
}

/**
 * Walk kill tiers to free enough RAM for a script.
 * Returns the list of scripts that were killed (for potential relaunch).
 */
function freeRamByKillTiers(
  ns: NS,
  neededRam: number,
): { hostname: string; script: string; args: (string | number | boolean)[] }[] {
  const { killed } = walkKillTiers(ns, neededRam, { excludeDashboard: false });

  for (const k of killed) {
    ns.print(`${COLORS.yellow}Killing ${k.filename} (pid ${k.pid}) to free RAM${COLORS.reset}`);
  }

  return killed.map((k) => ({
    hostname: "home",
    script: k.filename,
    args: k.args,
  }));
}

/**
 * Wait for a script to finish running
 */
async function waitForScript(ns: NS, pid: number, timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();
  while (ns.isRunning(pid)) {
    if (Date.now() - startTime > timeoutMs) {
      ns.print(`${COLORS.yellow}Script pid ${pid} timed out after ${timeoutMs / 1000}s${COLORS.reset}`);
      return false;
    }
    await ns.sleep(500);
  }
  return true;
}

/**
 * Attempt to run a queue entry. Returns true if successfully executed.
 */
async function executeEntry(ns: NS, entry: QueueEntry): Promise<boolean> {
  const scriptRam = ns.getScriptRam(entry.script);

  // Script doesn't exist
  if (scriptRam === 0) {
    ns.print(`${COLORS.red}Script not found: ${entry.script}${COLORS.reset}`);
    return false;
  }

  // Check if script is already running
  if (ns.isRunning(entry.script, "home", ...entry.args)) {
    ns.print(`${COLORS.dim}Already running: ${entry.script}${COLORS.reset}`);
    return true; // Consider it handled
  }

  let availableRam = getAvailableRam(ns);
  let killed: { hostname: string; script: string; args: (string | number | boolean)[] }[] = [];

  // Not enough RAM - handle based on mode
  if (availableRam < scriptRam) {
    if (entry.mode === "force") {
      // Walk kill tiers to free RAM
      ns.print(`${COLORS.yellow}Force mode: freeing RAM for ${entry.script} (need ${ns.format.ram(scriptRam)})${COLORS.reset}`);
      killed = freeRamByKillTiers(ns, scriptRam);

      // Brief pause to let processes fully terminate
      await ns.sleep(200);
      availableRam = getAvailableRam(ns);

      if (availableRam < scriptRam) {
        // Still not enough even after killing everything
        ns.print(`${COLORS.red}Cannot free enough RAM for ${entry.script} (need ${ns.format.ram(scriptRam)}, have ${ns.format.ram(availableRam)})${COLORS.reset}`);

        if (entry.manualFallback) {
          ns.tprint(`${COLORS.yellow}Manual fallback: ${entry.manualFallback}${COLORS.reset}`);
        }
        return false;
      }
    } else {
      // Queue mode - skip if not enough RAM
      ns.print(`${COLORS.dim}Skipping ${entry.script}: need ${ns.format.ram(scriptRam)}, have ${ns.format.ram(availableRam)}${COLORS.reset}`);
      return false;
    }
  }

  // Execute the script
  const pid = ns.exec(entry.script, "home", 1, ...entry.args);
  if (pid === 0) {
    ns.print(`${COLORS.red}Failed to exec ${entry.script}${COLORS.reset}`);
    return false;
  }

  ns.print(`${COLORS.green}Running ${entry.script} (pid ${pid})${COLORS.reset}`);

  // Wait for the script to complete
  const scriptTimeout = getConfigNumber(ns, "queue", "scriptTimeout", 30000);
  const completed = await waitForScript(ns, pid, scriptTimeout);

  if (!completed) {
    ns.print(`${COLORS.yellow}Script ${entry.script} did not complete in time${COLORS.reset}`);
  }

  // Relaunch any killed scripts
  if (killed.length > 0) {
    ns.print(`${COLORS.dim}Relaunching ${killed.length} killed script(s)...${COLORS.reset}`);
    await ns.sleep(200);

    for (const k of killed) {
      // Only relaunch if there's enough RAM and it's not already running
      const relaunchRam = ns.getScriptRam(k.script);
      if (relaunchRam === 0) continue; // Script doesn't exist anymore

      if (ns.isRunning(k.script, k.hostname, ...k.args)) {
        ns.print(`${COLORS.dim}Already running: ${k.script}${COLORS.reset}`);
        continue;
      }

      if (getAvailableRam(ns) >= relaunchRam) {
        const relaunchPid = ns.exec(k.script, k.hostname, 1, ...k.args);
        if (relaunchPid > 0) {
          ns.print(`${COLORS.green}Relaunched ${k.script} (pid ${relaunchPid})${COLORS.reset}`);
        } else {
          ns.print(`${COLORS.yellow}Failed to relaunch ${k.script}${COLORS.reset}`);
        }
      } else {
        ns.print(`${COLORS.yellow}Not enough RAM to relaunch ${k.script} (need ${ns.format.ram(relaunchRam)})${COLORS.reset}`);
      }
    }
  }

  return completed;
}

/**
 * Print queue runner status
 */
function printStatus(
  ns: NS,
  lastAction: string,
  roundRobinIndex: number,
  queueDepth: number,
): void {
  const C = COLORS;
  ns.print(`${C.cyan}=== Queue Runner ===${C.reset}`);
  ns.print(`${C.dim}Last:${C.reset} ${lastAction}`);
  ns.print(
    `${C.dim}Queue depth:${C.reset} ${queueDepth}` +
    `  ${C.dim}|${C.reset}  ` +
    `${C.dim}Round-robin:${C.reset} ${roundRobinIndex + 1}/${STATUS_CHECKS.length}`
  );
  ns.print(
    `${C.dim}Available RAM:${C.reset} ${ns.format.ram(getAvailableRam(ns))}` +
    ` / ${ns.format.ram(ns.getServerMaxRam("home"))}`
  );
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "queue", {
    interval: "2000",
    scriptTimeout: "30000",
  });

  let roundRobinIndex = 0;
  let lastAction = "Starting up...";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const interval = getConfigNumber(ns, "queue", "interval", 2000);
    ns.clearLog();

    // Drain all user-triggered queue entries (higher priority first)
    const userEntries = drainQueue(ns);

    if (userEntries.length > 0) {
      // Process user-triggered entries
      for (const entry of userEntries) {
        lastAction = `[${entry.requester}] ${entry.script}`;
        ns.print(
          `${COLORS.white}Processing: ${entry.script}${COLORS.reset}` +
          ` ${COLORS.dim}(priority: ${entry.priority}, mode: ${entry.mode})${COLORS.reset}`
        );

        const success = await executeEntry(ns, entry);
        if (success) {
          lastAction += ` ${COLORS.green}OK${COLORS.reset}`;
        } else {
          lastAction += ` ${COLORS.red}FAIL${COLORS.reset}`;
        }
      }
    } else {
      // No user entries - run next round-robin status check
      const statusCheck = STATUS_CHECKS[roundRobinIndex];

      // Update timestamp for this check
      statusCheck.timestamp = Date.now();

      lastAction = `[round-robin] ${statusCheck.script}`;

      const success = await executeEntry(ns, statusCheck);
      if (success) {
        lastAction += ` ${COLORS.green}OK${COLORS.reset}`;
      } else {
        lastAction += ` ${COLORS.dim}skip${COLORS.reset}`;
      }

      // Advance round-robin index
      roundRobinIndex = (roundRobinIndex + 1) % STATUS_CHECKS.length;
    }

    // Print status
    printStatus(ns, lastAction, roundRobinIndex, userEntries.length);

    ns.print(`\n${COLORS.dim}Next check in ${interval / 1000}s...${COLORS.reset}`);
    await ns.sleep(interval);
  }
}
