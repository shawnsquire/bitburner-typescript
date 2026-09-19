/**
 * Pserv Daemon
 *
 * Long-running daemon that purchases and upgrades personal servers,
 * then publishes PservStatus to the status port for the dashboard.
 *
 * Usage:
 *   run daemons/pserv.js
 *   run daemons/pserv.js --one-shot
 *   run daemons/pserv.js --min-ram 64
 *   run daemons/pserv.js --reserve 1000000
 *   run daemons/pserv.js --interval 5000
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { getPservStatus, PservConfig, PservCallbacks, runPservCycle } from "/controllers/pserv";
import { publishStatus } from "/lib/ports";
import { STATUS_PORTS, PservStatus } from "/types/ports";
import { writeDefaultConfig, getConfigString, getConfigNumber, getConfigBool } from "/lib/config";
import { getBudgetBalance, notifyPurchase, reportCap, reactivateBucket, setBudgetWeight, signalDone } from "/lib/budget";
import { DEFAULT_WEIGHTS } from "/controllers/budget";

/**
 * Build a PservStatus object with formatted values for the dashboard.
 * Bridges raw controller data to the port type expected by the UI.
 */
function computePservStatus(ns: NS, reserve: number, autoBuy: boolean, maxRamCap: number): PservStatus {
  const raw = getPservStatus(ns);
  const maxPossibleRam = ns.cloud.getRamLimit();
  const effectiveMaxRam = maxRamCap > 0 ? maxRamCap : maxPossibleRam;

  // Map servers to formatted entries
  const servers = raw.servers.map((hostname) => {
    const ram = ns.getServerMaxRam(hostname);
    return {
      hostname,
      ram,
      ramFormatted: ns.format.ram(ram),
    };
  });

  // Count how many servers are at effective max RAM (respects cap)
  const maxedCount = servers.filter((s) => s.ram >= effectiveMaxRam).length;
  const allMaxed = raw.serverCount > 0 && raw.minRam >= effectiveMaxRam;

  // Upgrade progress: percentage of servers at max
  const upgradeProgress =
    raw.serverCount > 0
      ? `${maxedCount}/${raw.serverCount} (${((maxedCount / raw.serverCount) * 100).toFixed(0)}%)`
      : "0/0";

  // Find next upgrade: locate smallest server and check if we can afford its next tier
  let nextUpgrade: PservStatus["nextUpgrade"] = null;
  if (raw.serverCount > 0 && !allMaxed) {
    const smallest = servers.reduce((min, s) => (s.ram < min.ram ? s : min));
    if (smallest.ram < effectiveMaxRam) {
      const nextRam = Math.min(smallest.ram * 2, effectiveMaxRam);
      const cost = ns.cloud.getServerUpgradeCost(smallest.hostname, nextRam);
      const budget = ns.getServerMoneyAvailable("home") - reserve;

      nextUpgrade = {
        hostname: smallest.hostname,
        currentRam: ns.format.ram(smallest.ram),
        nextRam: ns.format.ram(nextRam),
        cost,
        costFormatted: ns.format.number(cost),
        canAfford: cost <= budget,
      };
    }
  }

  return {
    serverCount: raw.serverCount,
    serverCap: raw.serverCap,
    totalRam: ns.format.ram(raw.totalRam),
    minRam: ns.format.ram(raw.minRam),
    maxRam: ns.format.ram(raw.maxRam),
    maxPossibleRam: ns.format.ram(maxPossibleRam),
    maxPossibleRamNum: maxPossibleRam,
    maxRamCap,
    maxRamCapFormatted: maxRamCap > 0 ? ns.format.ram(maxRamCap) : "Game Max",
    effectiveMaxRam,
    allMaxed,
    autoBuy,
    servers,
    upgradeProgress,
    nextUpgrade,
  };
}

/**
 * Print formatted pserv status to the script log.
 */
function printStatus(ns: NS, status: PservStatus, bought: number, upgraded: number): void {
  const C = COLORS;

  ns.print(`${C.cyan}═══ Pserv Daemon ═══${C.reset}`);
  if (!status.autoBuy) {
    ns.print(`${C.yellow}MONITOR ONLY — auto-buy disabled${C.reset}`);
  }
  ns.print(
    `${C.dim}Servers: ${status.serverCount}/${status.serverCap} | Total RAM: ${status.totalRam}${C.reset}`,
  );
  ns.print("");

  if (status.serverCount > 0) {
    ns.print(
      `${C.white}Range: ${status.minRam} - ${status.maxRam} (max: ${status.maxPossibleRam})${C.reset}`,
    );
    ns.print(`${C.white}Maxed: ${status.upgradeProgress}${C.reset}`);

    if (status.allMaxed) {
      ns.print(`${C.green}All servers at maximum RAM!${C.reset}`);
    } else if (status.nextUpgrade) {
      const u = status.nextUpgrade;
      if (u.canAfford) {
        ns.print(
          `${C.green}Next: ${u.hostname} ${u.currentRam} -> ${u.nextRam} (${u.costFormatted})${C.reset}`,
        );
      } else {
        ns.print(
          `${C.yellow}Next: ${u.hostname} ${u.currentRam} -> ${u.nextRam} (need ${u.costFormatted})${C.reset}`,
        );
      }
    }
  }

  ns.print("");
  ns.print(`${C.dim}This cycle: ${bought} bought, ${upgraded} upgraded${C.reset}`);
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "pserv", {
    prefix: "pserv",
    minRam: "8",
    maxRam: "0",
    reserve: "0",
    oneShot: "false",
    interval: "10000",
    autoBuy: "true",
  });

  let wasMonitorMode = false;

  // On startup, clear stale "done" state if servers aren't actually finished.
  // This handles the case where the daemon exited as done, but the user later
  // changed config (e.g. increased maxRam) and restarted the daemon.
  {
    const startConfig = {
      autoBuy: getConfigBool(ns, "pserv", "autoBuy", true),
      maxRam: getConfigNumber(ns, "pserv", "maxRam", 0),
    };
    if (startConfig.autoBuy) {
      const raw = getPservStatus(ns);
      const effectiveMax = startConfig.maxRam > 0 ? startConfig.maxRam : raw.maxPossibleRam;
      const fullyDone = raw.serverCount >= raw.serverCap && raw.minRam >= effectiveMax;
      if (!fullyDone) {
        reactivateBucket(ns, "servers");
      }
    }
  }

  do {
    const config: PservConfig = {
      prefix: getConfigString(ns, "pserv", "prefix", "pserv"),
      minRam: getConfigNumber(ns, "pserv", "minRam", 8),
      maxRam: getConfigNumber(ns, "pserv", "maxRam", 0),
      reserve: getConfigNumber(ns, "pserv", "reserve", 0),
      oneShot: getConfigBool(ns, "pserv", "oneShot", false),
      interval: getConfigNumber(ns, "pserv", "interval", 10000),
      autoBuy: getConfigBool(ns, "pserv", "autoBuy", true),
    };
    ns.clearLog();

    // Monitor mode: signal budget done and skip purchase cycle
    if (!config.autoBuy) {
      if (!wasMonitorMode) {
        signalDone(ns, "servers");
      }
      wasMonitorMode = true;
    } else {
      if (wasMonitorMode) {
        reactivateBucket(ns, "servers");
      }
      setBudgetWeight(ns, "servers", DEFAULT_WEIGHTS.servers);
      wasMonitorMode = false;
    }

    // Budget integration: constrain spending by balance
    const budgetFn = (): number => {
      const balance = getBudgetBalance(ns, "servers");
      const raw = ns.getServerMoneyAvailable("home") - config.reserve;
      return Math.min(raw, balance);
    };
    const onPurchase = (cost: number, desc: string): void => {
      notifyPurchase(ns, "servers", cost, desc);
    };

    // Report remaining cost cap to budget daemon (only when actively buying)
    if (config.autoBuy) {
      const pstat = getPservStatus(ns);
      const effectiveMax = config.maxRam > 0 ? config.maxRam : pstat.maxPossibleRam;
      const allAtCap = pstat.serverCount > 0 && pstat.minRam >= effectiveMax;
      const isFullyDone = allAtCap && pstat.serverCount >= pstat.serverCap;
      if (!isFullyDone) {
        let totalRemainingCost = 0;
        if (pstat.serverCount < pstat.serverCap) {
          const slotsLeft = pstat.serverCap - pstat.serverCount;
          totalRemainingCost += ns.cloud.getServerCost(config.minRam) * slotsLeft;
          let ram = config.minRam;
          while (ram < effectiveMax) {
            const nextRam = ram * 2;
            totalRemainingCost += ns.cloud.getServerUpgradeCost(`${config.prefix}-0`, nextRam) * slotsLeft;
            ram = nextRam;
          }
        }
        if (pstat.servers.length > 0) {
          for (const hostname of pstat.servers) {
            let ram = ns.getServerMaxRam(hostname);
            while (ram < effectiveMax) {
              const nextRam = ram * 2;
              totalRemainingCost += ns.cloud.getServerUpgradeCost(hostname, nextRam);
              ram = nextRam;
            }
          }
        }
        if (totalRemainingCost > 0) {
          reportCap(ns, "servers", totalRemainingCost);
        }
      }
    }

    const callbacks: PservCallbacks = { budgetFn, onPurchase };

    // Run the purchase/upgrade cycle (or skip if monitor-only)
    const result = config.autoBuy
      ? await runPservCycle(ns, config, callbacks)
      : { bought: 0, upgraded: 0, waitingFor: null };

    // Compute formatted status for the dashboard
    const pservStatus = computePservStatus(ns, config.reserve, config.autoBuy, config.maxRam);

    // Publish to port for dashboard consumption
    publishStatus(ns, STATUS_PORTS.pserv, pservStatus);

    // Print terminal lines
    printStatus(ns, pservStatus, result.bought, result.upgraded);

    // Auto-exit when all servers are purchased and maxed
    if (pservStatus.allMaxed && pservStatus.serverCount >= pservStatus.serverCap) {
      signalDone(ns, "servers");
      ns.tprint("INFO: All personal servers purchased and maxed. Pserv daemon exiting.");
      return;
    }

    if (!config.oneShot) {
      ns.print(
        `\n${COLORS.dim}Next check in ${config.interval / 1000}s...${COLORS.reset}`,
      );
      await ns.sleep(config.interval);
    }
  } while (!getConfigBool(ns, "pserv", "oneShot", false));
}
