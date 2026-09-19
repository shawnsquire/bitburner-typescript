/**
 * Simple "Shotgun" Hacker - Deploy and Forget
 *
 * Uses all available RAM across all servers to attack a single target.
 *
 * Run: run hack/shotgun.js [target]
 *      run hack/shotgun.js auto
 *      run hack/shotgun.js --one-shot --target n00dles
 */
import { NS } from "@ns";
import { COLORS, getAllServers, scoreTarget, HackAction } from "/lib/utils";

// === TYPES ===

export interface ShotgunConfig {
  oneShot: boolean;
  target: string;
  homeReserve: number;
  moneyThreshold: number;
  securityBuffer: number;
}

export interface ShotgunStatus {
  target: string;
  action: HackAction;
  threadsLaunched: number;
  serversUsed: number;
  moneyAvailable: number;
  moneyMax: number;
  security: number;
  minSecurity: number;
  waitTime: number;
}

// === WORKER SCRIPTS ===

const SCRIPTS: Record<HackAction, string> = {
  hack: "/workers/hack.js",
  grow: "/workers/grow.js",
  weaken: "/workers/weaken.js",
};

// === CORE LOGIC ===

/**
 * Find the best target based on scoring
 */
export function findBestTarget(ns: NS): string | null {
  const player = ns.getPlayer();
  let best: string | null = null;
  let bestScore = 0;

  for (const hostname of getAllServers(ns)) {
    const server = ns.getServer(hostname);
    if (!server.hasAdminRights) continue;
    if ((server.requiredHackingSkill ?? 0) > player.skills.hacking) continue;
    if ((server.moneyMax ?? 0) === 0) continue;
    if (hostname.startsWith("pserv-") || hostname === "home") continue;

    const score = scoreTarget(ns, hostname);
    if (score > bestScore) {
      bestScore = score;
      best = hostname;
    }
  }
  return best;
}

/**
 * Deploy worker scripts to all servers
 */
export async function deployWorkers(ns: NS): Promise<void> {
  const workers = Object.values(SCRIPTS);
  for (const server of getAllServers(ns)) {
    if (ns.getServer(server).maxRam > 0 && ns.hasRootAccess(server)) {
      await ns.scp(workers, server, "home");
    }
  }
}

/**
 * Determine what action to take on a target
 */
export function determineActionForTarget(
  ns: NS,
  target: string,
  config: Pick<ShotgunConfig, "moneyThreshold" | "securityBuffer">
): { action: HackAction; threads: number } {
  const server = ns.getServer(target);
  const minDifficulty = server.minDifficulty ?? 0;
  const hackDifficulty = server.hackDifficulty ?? 0;
  const moneyMax = server.moneyMax ?? 0;
  const moneyAvailable = server.moneyAvailable ?? 0;
  const securityThresh = minDifficulty + config.securityBuffer;
  const moneyThresh = moneyMax * config.moneyThreshold;

  if (hackDifficulty > securityThresh) {
    const needed = Math.ceil((hackDifficulty - minDifficulty) / 0.05);
    return { action: "weaken", threads: needed };
  } else if (moneyAvailable < moneyThresh) {
    const mult = moneyMax / Math.max(moneyAvailable, 1);
    const threads = Math.ceil(ns.growthAnalyze(target, mult));
    return { action: "grow", threads };
  } else {
    const hackAnalyze = ns.hackAnalyze(target);
    const threads = Math.max(1, Math.floor((1 - config.moneyThreshold) / hackAnalyze));
    return { action: "hack", threads };
  }
}

/**
 * Execute action across all available servers
 */
export function executeAcrossAllServers(
  ns: NS,
  target: string,
  action: HackAction,
  homeReserve: number
): { threadsLaunched: number; serversUsed: number } {
  const script = SCRIPTS[action];
  const scriptRam = ns.getScriptRam(script);
  let threadsLaunched = 0;
  let serversUsed = 0;

  for (const hostname of getAllServers(ns)) {
    const srv = ns.getServer(hostname);
    if (!srv.hasAdminRights || srv.maxRam === 0) continue;

    const reserve = hostname === "home" ? homeReserve : 0;
    const availRam = srv.maxRam - srv.ramUsed - reserve;
    const canRun = Math.floor(availRam / scriptRam);

    if (canRun > 0) {
      const pid = ns.exec(script, hostname, canRun, target, 0, Date.now());
      if (pid > 0) {
        threadsLaunched += canRun;
        serversUsed++;
      }
    }
  }

  return { threadsLaunched, serversUsed };
}

/**
 * Get wait time for an action
 */
export function getActionWaitTime(ns: NS, target: string, action: HackAction): number {
  if (action === "weaken") return ns.getWeakenTime(target);
  if (action === "grow") return ns.getGrowTime(target);
  return ns.getHackTime(target);
}

/**
 * Run one shotgun cycle
 */
export function runShotgunCycle(ns: NS, config: ShotgunConfig): ShotgunStatus | null {
  const target = config.target === "auto" ? findBestTarget(ns) : config.target;

  if (!target) {
    return null;
  }

  const { action } = determineActionForTarget(ns, target, config);
  const { threadsLaunched, serversUsed } = executeAcrossAllServers(
    ns,
    target,
    action,
    config.homeReserve
  );

  const server = ns.getServer(target);
  const waitTime = getActionWaitTime(ns, target, action);

  return {
    target,
    action,
    threadsLaunched,
    serversUsed,
    moneyAvailable: server.moneyAvailable ?? 0,
    moneyMax: server.moneyMax ?? 0,
    security: server.hackDifficulty ?? 0,
    minSecurity: server.minDifficulty ?? 0,
    waitTime,
  };
}

// === DISPLAY ===

/**
 * Format shotgun status for display
 */
export function formatShotgunStatus(ns: NS, status: ShotgunStatus): string[] {
  const C = COLORS;
  const lines: string[] = [];

  const actionColors: Record<HackAction, string> = {
    hack: C.green,
    grow: C.yellow,
    weaken: C.blue,
  };

  const money = ns.format.number(status.moneyAvailable);
  const maxMoney = ns.format.number(status.moneyMax);
  const sec = status.security.toFixed(1);
  const minSec = status.minSecurity.toFixed(1);
  const color = actionColors[status.action];

  lines.push(`${C.cyan}═══ Shotgun Hacker ═══${C.reset}`);
  lines.push(`Using ${status.serversUsed} servers`);
  lines.push(
    `${C.white}${status.target}${C.reset}: $${money}/$${maxMoney} | Sec ${sec}/${minSec} | ${color}${status.action.toUpperCase()}${C.reset} x${status.threadsLaunched}`
  );

  return lines;
}

// === RUNNER ===

export async function main(ns: NS): Promise<void> {
  const flags = ns.flags([
    ["one-shot", false],
    ["target", "auto"],
    ["home-reserve", 32],
  ]) as {
    "one-shot": boolean;
    target: string;
    "home-reserve": number;
    _: string[];
  };

  // Support legacy positional argument
  const targetArg = flags._[0] as string | undefined;

  const config: ShotgunConfig = {
    oneShot: flags["one-shot"],
    target: targetArg ?? flags.target,
    homeReserve: flags["home-reserve"],
    moneyThreshold: 0.8,
    securityBuffer: 5,
  };

  ns.disableLog("ALL");

  if (!config.oneShot) {
    ns.ui.openTail();
  }

  // Deploy workers once at start
  await deployWorkers(ns);

  do {
    ns.clearLog();

    const status = runShotgunCycle(ns, config);

    if (!status) {
      ns.print(`${COLORS.red}ERROR: No valid target${COLORS.reset}`);
      if (!config.oneShot) {
        await ns.sleep(5000);
      }
      continue;
    }

    const lines = formatShotgunStatus(ns, status);
    for (const line of lines) {
      ns.print(line);
    }

    if (!config.oneShot) {
      await ns.sleep(status.waitTime + 500);
    }
  } while (!config.oneShot);
}
