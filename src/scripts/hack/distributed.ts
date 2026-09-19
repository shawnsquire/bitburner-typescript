/**
 * Distributed Hacking Script
 *
 * Runs the legacy distributed hacking mode using the hack controller.
 * Cycles through targets, assigns servers, and executes workers.
 *
 * Usage: run scripts/hack/distributed.js [--one-shot] [--interval 200]
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import {
  runDistributedCycle,
  formatDistributedStatus,
  DistributedConfig,
} from "/controllers/hack";

export async function main(ns: NS): Promise<void> {
  const flags = ns.flags([
    ["one-shot", false],
    ["interval", 200],
    ["home-reserve", 32],
    ["max-targets", 100],
  ]) as {
    "one-shot": boolean;
    interval: number;
    "home-reserve": number;
    "max-targets": number;
    _: string[];
  };

  const config: DistributedConfig = {
    oneShot: flags["one-shot"],
    interval: flags.interval,
    homeReserve: flags["home-reserve"],
    maxTargets: flags["max-targets"],
    moneyThreshold: 0.8,
    securityBuffer: 5,
    hackPercent: 0.25,
  };

  do {
    ns.clearLog();

    const result = await runDistributedCycle(ns, config);

    if (result.assignments.length === 0) {
      ns.print(`${COLORS.red}ERROR: No valid targets found!${COLORS.reset}`);
      if (!config.oneShot) {
        await ns.sleep(5000);
      }
      continue;
    }

    const lines = formatDistributedStatus(ns, result);
    for (const line of lines) {
      ns.print(line);
    }

    if (!config.oneShot) {
      const waitTime = Math.max(Math.min(result.shortestWait, 30000), 1000);
      ns.print(`${COLORS.white}Waiting ${ns.format.time(waitTime)}...${COLORS.reset}`);
      await ns.sleep(config.interval + waitTime);
    }
  } while (!config.oneShot);
}
