import { NS } from "@ns";
import { COLORS, getAllServers, makeBar } from "/lib/utils";

interface JobCounts {
  hack: number;
  grow: number;
  weaken: number;
  earliestCompletion: number | null;
  expectedMoney: number;
}

interface RamStats {
  total: number;
  used: number;
  activeServers: number;
  totalServers: number;
}

interface ServerJobEntry {
  hostname: string;
  threads: number;
}

interface RowResult {
  hack: number;
  grow: number;
  weaken: number;
  expected: number;
  idle: boolean;
}

export async function main(ns: NS): Promise<void> {
  const REFRESH_RATE = 1000;

  const { red, green, yellow, blue, cyan, white, dim, reset } = COLORS;

  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.ui.resizeTail(820, 650);

  const startTime = Date.now();
  let lastMoney = ns.getPlayer().money;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    ns.clearLog();

    const player = ns.getPlayer();
    const uptime = Date.now() - startTime;
    const moneyGained = player.money - lastMoney;

    // === HEADER ===
    const TITLE = "NETWORK DASHBOARD";
    const HEADER_WIDTH = 50;
    ns.print(`${cyan}${"═".repeat(50)}${reset}`);
    ns.print(`${" ".repeat((HEADER_WIDTH - TITLE.length) / 2)}${white}${TITLE}${reset}`);
    ns.print(`${cyan}${"═".repeat(50)}${reset}`);
    ns.print(`${dim}Uptime: ${ns.format.time(uptime)} | Money: ${ns.format.number(player.money)} (${moneyGained >= 0 ? green + "+" : red}${ns.format.number(moneyGained)}${reset}${dim}/s)${reset}`);

    // === RAM USAGE ===
    const ramStats = getRamStats(ns);
    const ramPercent = ((ramStats.used / ramStats.total) * 100).toFixed(1);
    const ramBar = makeBar(ramStats.used / ramStats.total, 20);
    ns.print(`\n${white}RAM Usage:${reset} ${ramBar} ${ramPercent}% (${ns.format.ram(ramStats.used)}/${ns.format.ram(ramStats.total)})`);
    ns.print(`${dim}Servers: ${ramStats.activeServers}/${ramStats.totalServers} active${reset}`);

    // === CATEGORIZE SERVERS ===
    const jobs = getRunningJobs(ns);
    const allServers = getHackableServers(ns);
    const playerHacking = player.skills.hacking;

    const needHigherLevel: string[] = [];
    const needPorts: string[] = [];
    const canHack: string[] = [];

    for (const hostname of allServers) {
      const server = ns.getServer(hostname);
      if (server.hasAdminRights) {
        canHack.push(hostname);
      } else if ((server.requiredHackingSkill ?? 0) > playerHacking) {
        needHigherLevel.push(hostname);
      } else {
        needPorts.push(hostname);
      }
    }

    canHack.sort((a, b) => (ns.getServer(b).moneyMax ?? 0) - (ns.getServer(a).moneyMax ?? 0));
    const top10 = canHack.slice(0, 10);
    const remaining = canHack.slice(10);

    // Header row
    ns.print(`\n${dim}${"Target".padEnd(18)} ${"$%".padStart(5)} ${"Sec".padStart(5)} ${"Hack".padStart(7)} ${"Grow".padStart(7)} ${"Wkn".padStart(7)}   ${"Expected"}${reset}`);
    ns.print(`${dim}${"─".repeat(78)}${reset}`);

    let totalHack = 0, totalGrow = 0, totalWeaken = 0, totalExpected = 0;
    let idleCount = 0;

    for (const hostname of top10) {
      const result = renderServerRow(ns, hostname, jobs[hostname]);
      totalHack += result.hack;
      totalGrow += result.grow;
      totalWeaken += result.weaken;
      totalExpected += result.expected;
      if (result.idle) idleCount++;
    }

    for (const hostname of needPorts) {
      const server = ns.getServer(hostname);
      const portsHave = server.openPortCount;
      const portsNeeded = server.numOpenPortsRequired;
      ns.print(`${dim}${hostname.padEnd(18)}${reset} ${yellow}🔒${reset} ${dim}${portsHave}/${portsNeeded} ports${reset}`);
    }

    let remainingActive = 0;
    let remainingExpected = 0;

    for (const hostname of remaining) {
      const actions = jobs[hostname] || { hack: 0, grow: 0, weaken: 0 };
      const isActive = (actions.hack + actions.grow + actions.weaken) > 0;

      if (isActive) {
        remainingActive++;
        totalHack += actions.hack;
        totalGrow += actions.grow;
        totalWeaken += actions.weaken;
        const exp = calcExpectedMoney(ns, hostname, actions.hack);
        totalExpected += exp;
        remainingExpected += exp;
      } else {
        idleCount++;
      }
    }

    if (remainingActive > 0) {
      ns.print(`${dim}... +${remainingActive} more active${reset} ${" ".repeat(38)} ${green}$${ns.format.number(remainingExpected)}${reset}`);
    }

    // Totals
    ns.print(`${dim}${"─".repeat(78)}${reset}`);
    ns.print(`${white}${"TOTAL".padEnd(18)}${reset} ${" ".repeat(12)} ${green}${totalHack.toLocaleString().padStart(7)}${reset} ${yellow}${totalGrow.toLocaleString().padStart(7)}${reset} ${blue}${totalWeaken.toLocaleString().padStart(7)}${reset}   ${green}$${ns.format.number(totalExpected)}${reset}`);

    // Summary footer
    const summaryParts: string[] = [];
    if (idleCount > 0) summaryParts.push(`${yellow}${idleCount} idle${reset}`);
    if (needHigherLevel.length > 0) {
      const nextLevel = Math.min(...needHigherLevel.map(h => ns.getServer(h).requiredHackingSkill ?? 0));
      summaryParts.push(`${red}${needHigherLevel.length} need higher hack${reset} ${dim}(next: ${nextLevel})${reset}`);
    }
    if (summaryParts.length > 0) {
      ns.print(`${dim}${summaryParts.join(" | ")}${reset}`)
    }

    // === SERVER BREAKDOWN ===
    const serverJobs = getServerJobCounts(ns);
    const topServers = serverJobs.slice(0, 5);

    if (topServers.length > 0) {
      ns.print(`\n${white}Busiest Servers:${reset}`);
      for (const srv of topServers) {
        const bar = makeBar(srv.threads / (topServers[0].threads || 1), 10);
        ns.print(`  ${dim}${srv.hostname.padEnd(20)}${reset} ${bar} ${srv.threads.toLocaleString()} threads`);
      }
    }

    lastMoney = player.money;
    await ns.sleep(REFRESH_RATE);
  }
}

function renderServerRow(ns: NS, hostname: string, actions?: Partial<JobCounts>): RowResult {
  const { red, green, yellow, blue, cyan, dim, reset } = COLORS;
  const gray = COLORS.gray;

  const a = {
    hack: actions?.hack ?? 0,
    grow: actions?.grow ?? 0,
    weaken: actions?.weaken ?? 0,
    earliestCompletion: actions?.earliestCompletion ?? null,
  };
  const server = ns.getServer(hostname);
  const isActive = (a.hack + a.grow + a.weaken) > 0;

  const expectedMoney = calcExpectedMoney(ns, hostname, a.hack);

  const moneyMax = server.moneyMax ?? 0;
  const moneyAvail = server.moneyAvailable ?? 0;
  const moneyPct = moneyMax > 0 ? (moneyAvail / moneyMax) * 100 : 0;
  const moneyColor = moneyPct >= 80 ? green : moneyPct >= 50 ? yellow : red;
  const moneyStr = `${moneyColor}${moneyPct.toFixed(0).padStart(4)}%${reset}`;

  const secDiff = (server.hackDifficulty ?? 0) - (server.minDifficulty ?? 0);
  const secColor = secDiff <= 2 ? green : secDiff <= 5 ? yellow : red;
  const secStr = `${secColor}${"+" + secDiff.toFixed(0)}${reset}`.padStart(5);

  const hackStr = a.hack > 0
    ? `${green}${a.hack.toLocaleString().padStart(7)}${reset}`
    : `${gray}${a.hack.toLocaleString().padStart(7)}${reset}`;
  const growStr = a.grow > 0
    ? `${yellow}${a.grow.toLocaleString().padStart(7)}${reset}`
    : `${gray}${a.grow.toLocaleString().padStart(7)}${reset}`;
  const weakenStr = a.weaken > 0
    ? `${blue}${a.weaken.toLocaleString().padStart(7)}${reset}`
    : `${gray}${a.weaken.toLocaleString().padStart(7)}${reset}`;

  const expectedStr = formatExpected(ns, expectedMoney, a.earliestCompletion);

  const nameColor = isActive ? cyan : gray;
  ns.print(`${nameColor}${hostname.padEnd(18)}${reset} ${moneyStr} ${secStr} ${hackStr} ${growStr} ${weakenStr}   ${expectedStr}`);

  return {
    hack: a.hack,
    grow: a.grow,
    weaken: a.weaken,
    expected: expectedMoney,
    idle: !isActive,
  };
}

function formatExpected(ns: NS, expectedMoney: number, earliestCompletion: number | null): string {
  const { green, yellow, cyan, dim, reset } = COLORS;

  if (expectedMoney <= 0) {
    if (earliestCompletion && earliestCompletion > Date.now()) {
      const timeStr = ns.format.time(earliestCompletion - Date.now(), false);
      return `${dim}prep${reset} ${yellow}${timeStr}${reset}`;
    }
    return `${dim}preparing...${reset}`;
  }

  const moneyStr = `${green}$${ns.format.number(expectedMoney)}${reset}`;

  if (earliestCompletion && earliestCompletion > Date.now()) {
    const timeRemaining = earliestCompletion - Date.now();
    const timeStr = ns.format.time(timeRemaining, false);
    const timeColor = timeRemaining < 5000 ? cyan : timeRemaining < 30000 ? yellow : dim;
    return `${moneyStr} ${dim}→${reset} ${timeColor}${timeStr}${reset}`;
  }

  return `${moneyStr} ${dim}→ soon${reset}`;
}

function getHackableServers(ns: NS): string[] {
  const servers: string[] = [];

  for (const hostname of getAllServers(ns)) {
    if (hostname === "home" || hostname.startsWith("pserv-")) continue;
    const server = ns.getServer(hostname);
    if (server.moneyMax === 0) continue;
    servers.push(hostname);
  }

  return servers.sort((a, b) => a.localeCompare(b));
}

function calcExpectedMoney(ns: NS, target: string, hackThreads: number): number {
  if (hackThreads <= 0) return 0;

  const server = ns.getServer(target);
  const hackPercent = ns.hackAnalyze(target) * hackThreads;
  const hackChance = ns.hackAnalyzeChance(target);
  return (server.moneyAvailable ?? 0) * Math.min(hackPercent, 1) * hackChance;
}

function getRunningJobs(ns: NS): Record<string, JobCounts> {
  const jobs: Record<string, JobCounts> = {};

  for (const hostname of getAllServers(ns)) {
    for (const proc of ns.ps(hostname)) {
      if (!["workers/hack.js", "workers/grow.js", "workers/weaken.js"].includes(proc.filename)) continue;

      const target = proc.args[0] as string;
      if (!target) continue;

      const action = proc.filename.split("/").pop()!.replace(".js", "") as "hack" | "grow" | "weaken";
      const delay = (proc.args[1] as number) || 0;
      const launchTime = proc.args[2] as number | undefined;

      if (!jobs[target]) {
        jobs[target] = { hack: 0, grow: 0, weaken: 0, earliestCompletion: null, expectedMoney: 0 };
      }
      jobs[target][action] += proc.threads;

      if (launchTime && typeof launchTime === "number") {
        let duration: number;
        if (action === "hack") duration = ns.getHackTime(target);
        else if (action === "grow") duration = ns.getGrowTime(target);
        else duration = ns.getWeakenTime(target);

        const completionTime = launchTime + delay + duration;

        if (jobs[target].earliestCompletion === null || completionTime < jobs[target].earliestCompletion!) {
          jobs[target].earliestCompletion = completionTime;
        }
      }
    }
  }

  return jobs;
}

function getServerJobCounts(ns: NS): ServerJobEntry[] {
  const servers: ServerJobEntry[] = [];

  for (const hostname of getAllServers(ns)) {
    let threads = 0;
    for (const proc of ns.ps(hostname)) {
      if (proc.filename.includes("/workers/")) {
        threads += proc.threads;
      }
    }
    if (threads > 0) {
      servers.push({ hostname, threads });
    }
  }

  return servers.sort((a, b) => b.threads - a.threads);
}

function getRamStats(ns: NS): RamStats {
  let total = 0;
  let used = 0;
  let activeServers = 0;
  let totalServers = 0;

  for (const hostname of getAllServers(ns)) {
    const server = ns.getServer(hostname);
    if (!server.hasAdminRights || server.maxRam === 0) continue;

    totalServers++;
    total += server.maxRam;
    used += server.ramUsed;

    if (server.ramUsed > 0) activeServers++;
  }

  return { total, used, activeServers, totalServers };
}
