/**
 * Nuke Daemon
 *
 * Long-running daemon that periodically scans for nukable servers,
 * roots them, and publishes NukeStatus to the status port for the dashboard.
 *
 * Usage:
 *   run daemons/nuke.js
 *   run daemons/nuke.js --one-shot
 *   run daemons/nuke.js --interval 60000
 */
import { NS } from "@ns";
import { analyzeNukableServers, countAvailableTools, getNukeStatus } from "/controllers/nuke";
import { COLORS } from "/lib/utils";
import { getCachedServers, invalidateServerCache } from "/lib/server-cache";
import { publishStatus } from "/lib/ports";
import { STATUS_PORTS, NukeStatus } from "/types/ports";
import { writeDefaultConfig, getConfigNumber, getConfigBool } from "/lib/config";

/**
 * Build a NukeStatus object by scanning all servers and categorizing them.
 * This is computed after nuking so the status reflects the current state.
 */
function computeNukeStatus(ns: NS): NukeStatus {
  const raw = getNukeStatus(ns);
  const player = ns.getPlayer();
  const allServers = getCachedServers(ns);

  const ready: NukeStatus["ready"] = [];
  const needHacking: NukeStatus["needHacking"] = [];
  const needPorts: NukeStatus["needPorts"] = [];
  const rooted: string[] = [];

  // Fleet RAM aggregation
  let fleetMaxRam = 0;
  let fleetUsedRam = 0;
  let fleetServerCount = 0;

  for (const hostname of allServers) {
    const server = ns.getServer(hostname);

    if (server.hasAdminRights) {
      rooted.push(hostname);

      // Aggregate fleet RAM for rooted servers with RAM
      if (server.maxRam > 0) {
        fleetMaxRam += server.maxRam;
        fleetUsedRam += server.ramUsed;
        fleetServerCount++;
      }

      continue;
    }

    const requiredPorts = server.numOpenPortsRequired ?? 0;
    const requiredHacking = server.requiredHackingSkill ?? 0;

    if (requiredHacking > player.skills.hacking) {
      needHacking.push({ hostname, required: requiredHacking, current: player.skills.hacking });
    } else if (requiredPorts > raw.toolCount) {
      needPorts.push({ hostname, required: requiredPorts, current: raw.toolCount });
    } else {
      ready.push({ hostname, requiredHacking, requiredPorts });
    }
  }

  ready.sort((a, b) => a.requiredHacking - b.requiredHacking);
  needHacking.sort((a, b) => a.required - b.required);
  needPorts.sort((a, b) => a.required - b.required);

  const fleetFreeRam = fleetMaxRam - fleetUsedRam;
  const fleetUtilization = fleetMaxRam > 0 ? (fleetUsedRam / fleetMaxRam) * 100 : 0;

  return {
    rootedCount: rooted.length,
    totalServers: allServers.length,
    toolCount: raw.toolCount,
    ready,
    needHacking,
    needPorts,
    rooted,
    fleetRam: {
      totalMaxRam: ns.format.ram(fleetMaxRam),
      totalUsedRam: ns.format.ram(fleetUsedRam),
      totalFreeRam: ns.format.ram(fleetFreeRam),
      utilization: Math.round(fleetUtilization),
      serverCount: fleetServerCount,
    },
  };
}

/**
 * Print a formatted nuke status display to the script log.
 */
function printStatus(ns: NS, nukedCount: number, nukedNames: string[], status: NukeStatus): void {
  const C = COLORS;

  ns.print(`${C.cyan}═══ Nuke Daemon ═══${C.reset}`);
  ns.print(
    `${C.dim}Tools: ${status.toolCount}/5 | Servers: ${status.rootedCount}/${status.totalServers} rooted${C.reset}`,
  );
  ns.print("");

  if (nukedCount > 0) {
    ns.print(`${C.green}NUKED THIS CYCLE:${C.reset}`);
    for (const name of nukedNames) {
      ns.print(`  ${C.green}\u2713${C.reset} ${name}`);
    }
    ns.print("");
  }

  if (status.ready.length > 0) {
    ns.print(`${C.green}READY TO NUKE (${status.ready.length}):${C.reset}`);
    for (const s of status.ready) {
      ns.print(`  ${C.green}\u25CF${C.reset} ${s.hostname} ${C.dim}(hack:${s.requiredHacking} ports:${s.requiredPorts})${C.reset}`);
    }
    ns.print("");
  }

  if (status.needPorts.length > 0) {
    ns.print(`${C.yellow}NEED MORE TOOLS (${status.needPorts.length}):${C.reset}`);
    for (const s of status.needPorts) {
      ns.print(`  ${C.yellow}\u25CB${C.reset} ${s.hostname} ${C.dim}(need ${s.required} ports, have ${s.current})${C.reset}`);
    }
    ns.print("");
  }

  if (status.needHacking.length > 0) {
    ns.print(`${C.red}NEED HIGHER HACKING (${status.needHacking.length}):${C.reset}`);
    for (const s of status.needHacking) {
      ns.print(`  ${C.red}\u25CB${C.reset} ${s.hostname} ${C.dim}(need ${s.required}, have ${s.current})${C.reset}`);
    }
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "nuke", {
    interval: "30000",
    oneShot: "false",
  });

  do {
    const interval = getConfigNumber(ns, "nuke", "interval", 30000);
    const oneShot = getConfigBool(ns, "nuke", "oneShot", false);
    ns.clearLog();

    // Nuke any servers that are ready
    const result = analyzeNukableServers(ns);
    const nukedNames = result.nuked.map((r) => r.hostname);

    // Deploy worker scripts to newly-rooted servers and invalidate cache
    if (result.nuked.length > 0) {
      invalidateServerCache();

      const workers = [
        "/workers/hack.js",
        "/workers/grow.js",
        "/workers/weaken.js",
        "/workers/share.js",
      ];
      for (const nuked of result.nuked) {
        const server = ns.getServer(nuked.hostname);
        if (server.maxRam > 0) {
          await ns.scp(workers, nuked.hostname, "home");
        }
      }
    }

    // Compute full status for the dashboard
    const status = computeNukeStatus(ns);

    // Publish status to the port for dashboard consumption
    publishStatus(ns, STATUS_PORTS.nuke, status);

    // Print status to the script log
    printStatus(ns, result.nuked.length, nukedNames, status);

    // Terminal notification when servers are newly nuked
    if (result.nuked.length > 0) {
      ns.tprint(
        `${COLORS.green}Nuked ${result.nuked.length} server(s): ${nukedNames.join(", ")}${COLORS.reset}`,
      );
    }

    if (!oneShot) {
      ns.print(
        `\n${COLORS.dim}Next check in ${interval / 1000}s...${COLORS.reset}`,
      );
      await ns.sleep(interval);
    }
  } while (!getConfigBool(ns, "nuke", "oneShot", false));
}
