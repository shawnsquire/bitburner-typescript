/**
 * Task Prioritizer
 *
 * One-shot script that analyzes game state and suggests what to do next.
 * Reads from status ports and basic NS functions — no Singularity.
 * Target RAM: ~3 GB
 *
 * Usage: run tools/prioritize.js
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { peekStatus } from "/lib/ports";
import {
  STATUS_PORTS,
  TOOL_SCRIPTS,
  ToolName,
  NukeStatus,
  HackStatus,
  PservStatus,
  DarkwebStatus,
} from "/types/ports";

const C = COLORS;

interface Suggestion {
  priority: number;
  category: string;
  message: string;
  action?: string;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const suggestions: Suggestion[] = [];
  const homeRam = ns.getServerMaxRam("home");
  const homeUsed = ns.getServerUsedRam("home");
  const homeFree = homeRam - homeUsed;
  const processes = ns.ps("home");

  // Check which daemons are running
  const running = new Set<string>();
  for (const proc of processes) {
    running.add(proc.filename);
  }

  const isDaemonRunning = (tool: ToolName) => running.has(TOOL_SCRIPTS[tool]);

  // 1. Core daemons not running
  if (!isDaemonRunning("nuke")) {
    suggestions.push({
      priority: 9,
      category: "DAEMON",
      message: "Nuke daemon not running — servers won't be rooted",
      action: "run daemons/nuke.js",
    });
  }

  if (!isDaemonRunning("hack")) {
    suggestions.push({
      priority: 9,
      category: "DAEMON",
      message: "Hack daemon not running — no income from hacking",
      action: "run daemons/hack.js",
    });
  }

  if (!running.has("daemons/queue.js")) {
    suggestions.push({
      priority: 8,
      category: "DAEMON",
      message: "Queue runner not running — actions won't be processed",
      action: "run daemons/queue.js",
    });
  }

  // 2. Check nuke status
  const nuke = peekStatus<NukeStatus>(ns, STATUS_PORTS.nuke);
  if (nuke && nuke.ready.length > 0) {
    suggestions.push({
      priority: 7,
      category: "NUKE",
      message: `${nuke.ready.length} server(s) ready to root`,
    });
  }

  // 3. Check darkweb status
  const darkweb = peekStatus<DarkwebStatus>(ns, STATUS_PORTS.darkweb);
  if (darkweb) {
    if (!darkweb.hasTorRouter) {
      suggestions.push({
        priority: 6,
        category: "DARKWEB",
        message: "TOR router not purchased — buy for $200k",
        action: "run actions/buy-tor.js",
      });
    } else if (darkweb.canAffordNext && darkweb.nextProgram) {
      suggestions.push({
        priority: 6,
        category: "DARKWEB",
        message: `Can afford ${darkweb.nextProgram.name} (${darkweb.nextProgram.costFormatted})`,
        action: `run actions/buy-program.js --program ${darkweb.nextProgram.name}`,
      });
    }
  }

  // 4. Check pserv status
  const pserv = peekStatus<PservStatus>(ns, STATUS_PORTS.pserv);
  if (pserv) {
    if (pserv.serverCount < pserv.serverCap) {
      suggestions.push({
        priority: 5,
        category: "PSERV",
        message: `Only ${pserv.serverCount}/${pserv.serverCap} servers purchased`,
        action: "run daemons/pserv.js",
      });
    } else if (!pserv.allMaxed && pserv.nextUpgrade?.canAfford) {
      suggestions.push({
        priority: 4,
        category: "PSERV",
        message: `Can upgrade ${pserv.nextUpgrade.hostname}: ${pserv.nextUpgrade.currentRam} → ${pserv.nextUpgrade.nextRam}`,
        action: "run daemons/pserv.js",
      });
    }

    if (!isDaemonRunning("pserv") && !pserv.allMaxed) {
      suggestions.push({
        priority: 5,
        category: "DAEMON",
        message: "Pserv daemon not running — servers won't auto-upgrade",
        action: "run daemons/pserv.js",
      });
    }
  }

  // 5. Check hack status
  const hack = peekStatus<HackStatus>(ns, STATUS_PORTS.hack);
  if (hack) {
    if (hack.saturationPercent < 50) {
      suggestions.push({
        priority: 4,
        category: "HACK",
        message: `Low thread saturation (${hack.saturationPercent.toFixed(0)}%) — need more servers or RAM`,
      });
    }
    if (hack.needHigherLevel) {
      suggestions.push({
        priority: 3,
        category: "HACK",
        message: `${hack.needHigherLevel.count} target(s) need hacking level ${hack.needHigherLevel.nextLevel}+`,
      });
    }
  }

  // 6. Share not running
  if (!isDaemonRunning("share")) {
    suggestions.push({
      priority: 2,
      category: "DAEMON",
      message: "Share daemon not running — no faction rep bonus",
      action: "run daemons/share.js",
    });
  }

  // 7. RAM info
  suggestions.push({
    priority: 1,
    category: "INFO",
    message: `Home RAM: ${ns.format.ram(homeFree)} free / ${ns.format.ram(homeRam)} total`,
  });

  // Sort by priority descending
  suggestions.sort((a, b) => b.priority - a.priority);

  // Print
  ns.tprint(`\n${C.cyan}=== TASK PRIORITIZER ===${C.reset}`);
  ns.tprint(`${C.dim}Home RAM: ${ns.format.ram(homeFree)} free / ${ns.format.ram(homeRam)} total${C.reset}`);
  ns.tprint(`${C.dim}Processes: ${processes.length} running${C.reset}\n`);

  if (suggestions.length === 0) {
    ns.tprint(`  ${C.green}Everything looks good!${C.reset}`);
  } else {
    for (const s of suggestions) {
      const priorityColor = s.priority >= 8 ? C.red : s.priority >= 5 ? C.yellow : C.dim;
      const priorityStr = `[${s.priority}]`.padEnd(4);
      ns.tprint(`  ${priorityColor}${priorityStr}${C.reset} ${C.white}[${s.category}]${C.reset} ${s.message}`);
      if (s.action) {
        ns.tprint(`       ${C.dim}→ ${s.action}${C.reset}`);
      }
    }
  }

  ns.tprint("");
}
