/**
 * Terminal Status Viewer
 *
 * One-shot script that reads status ports and prints a formatted overview.
 * Reads only from ports — no controller or Singularity imports.
 * Target RAM: ~0.5 GB
 *
 * Usage:
 *   run views/status.js           # Overview of all tools
 *   run views/status.js hack      # Detailed hack info
 *   run views/status.js nuke      # Detailed nuke info
 *   run views/status.js pserv     # Detailed pserv info
 *   run views/status.js share     # Detailed share info
 *   run views/status.js rep       # Detailed rep info
 *   run views/status.js work      # Detailed work info
 *   run views/status.js darkweb   # Detailed darkweb info
 *   run views/status.js --live    # Auto-refreshing tail window
 */
import { NS, ProcessInfo } from "@ns";
import { COLORS } from "/lib/utils";
import { peekStatus } from "/lib/ports";
import {
  ToolName,
  TOOL_SCRIPTS,
  STATUS_PORTS,
  NukeStatus,
  HackStatus,
  PservStatus,
  ShareStatus,
  RepStatus,
  WorkStatus,
  DarkwebStatus,
  BitnodeStatus,
  FactionStatus,
  GangStatus,
} from "/types/ports";

const C = COLORS;

type Log = (msg: string) => void;

// === DAEMON DOCS ===

const DAEMON_DOCS: Record<ToolName, { start: string; stop: string; flags: string | null }> = {
  nuke:    { start: "run daemons/nuke.js",    stop: "kill daemons/nuke.js",
             flags: "config: /config/nuke.txt (interval, oneShot)" },
  // hack.ts has no ns.flags() — strategy/batches/reserve are config-only, set via the dashboard.
  hack:    { start: "run daemons/hack.js",    stop: "kill daemons/hack.js",
             flags: "config: /config/hack.txt (oneShot, interval, homeReserve, maxTargets, maxBatches [0=legacy, 1+=HWGW batch], strategy [money|xp|drain|stocks], moneyThreshold, securityBuffer, hackPercent)" },
  pserv:   { start: "run daemons/pserv.js",   stop: "kill daemons/pserv.js",
             flags: "config: /config/pserv.txt (prefix, minRam, maxRam [0=game max], reserve, oneShot, interval, autoBuy)" },
  // --tier is an internal self-respawn flag (monitor/active); targetPercent is config-only.
  share:   { start: "run daemons/share.js",   stop: "kill daemons/share.js",
             flags: "--tier monitor|active (internal; auto-selected: active when rep daemon holds focus) | config: /config/share.txt (minFree, homeReserve, interval, oneShot, targetPercent [0=greedy, 1-100=% of capacity])" },
  rep:     { start: "run daemons/rep.js",      stop: "kill daemons/rep.js",
             flags: "--tier <name> (internal self-upgrade flag) | config: /config/rep.txt (faction, noWork, noKill, interval, oneShot)" },
  darkweb: { start: "run daemons/darkweb.js",  stop: "kill daemons/darkweb.js",
             flags: "config: /config/darkweb.txt (interval, oneShot)" },
  // work.ts has no ns.flags() — focus is config-only, set via actions/set-work-focus.js or the dashboard.
  work:    { start: "run daemons/work.js",     stop: "kill daemons/work.js",
             flags: "config: /config/work.txt (focus [strength, defense, dexterity, agility, hacking, charisma, balance-combat, balance-all, crime-money, crime-stats, crime-karma, crime-kills, none], interval, oneShot)" },
  // faction.ts has no --preferred-city flag — preferredCity is config-only.
  faction: { start: "run daemons/faction.js", stop: "kill daemons/faction.js",
             flags: "--tier <name> (internal self-upgrade flag) | config: /config/faction.txt (interval, oneShot, preferredCity [Sector-12, Aevum, Chongqing, New Tokyo, Ishima, Volhaven], noKill)" },
  infiltration: { start: "run daemons/infiltration.js", stop: "kill daemons/infiltration.js",
             flags: "config: /config/infiltration.txt (rewardMode [rep|money|manual])" },
  // gang.ts has no ns.flags() — strategy/noKill are config-only; CLI args are ignored.
  gang: { start: "run daemons/gang.js", stop: "kill daemons/gang.js",
             flags: "config: /config/gang.txt (strategy [respect|money|territory|balanced|grow], noKill)" },
  // augments.ts has no ns.flags() — interval/oneShot are config-only.
  augments: { start: "run daemons/augments.js", stop: "kill daemons/augments.js",
             flags: "config: /config/augments.txt (interval, oneShot)" },
  advisor: { start: "run daemons/advisor.js", stop: "kill daemons/advisor.js",
             flags: "config: /config/advisor.txt (interval)" },
  // contracts.ts has no ns.flags() — interval/oneShot/minTries are config-only.
  contracts: { start: "run daemons/contracts.js", stop: "kill daemons/contracts.js",
             flags: "config: /config/contracts.txt (interval, oneShot, minTries)" },
  budget: { start: "run daemons/budget.js", stop: "kill daemons/budget.js",
             flags: "config: /config/budget.txt (interval)" },
  stocks: { start: "run daemons/stocks.js", stop: "kill daemons/stocks.js",
             flags: "config: /config/stocks.txt (enabled, pollInterval, smartMode, minForecastDeviation, sellForecastDeviation, preThreshold, tickWindow, maxPositions, stopLossPercent, trailingStopPercent, maxHoldTicks, sellCooldownTicks, commissionPerTrade, scrapeMaxAge)" },
  casino: { start: "run casino.js", stop: "kill casino.js", flags: null },
  home: { start: "run daemons/home.js", stop: "kill daemons/home.js", flags: "config: /config/home.txt (interval, autoBuy)" },
  corp: { start: "run daemons/corp.js", stop: "kill daemons/corp.js", flags: "config: /config/corp.txt (interval, tier, directive, pinDirective, countdownSeconds, dividendRate, productInvestPct, corpName, autoTea, enabled)" },
  blade: { start: "run daemons/blade.js", stop: "kill daemons/blade.js", flags: "config: /config/blade.txt (interval, operationThreshold, blackOpThreshold, contractThreshold, staminaMinPercent, staminaRestoreTo, staminaTrainMax, chaosMax, chaosTarget, successSpreadMax, populationMin, buySkill)" },
  hacknet: { start: "run daemons/hacknet.js", stop: "kill daemons/hacknet.js", flags: "config: /config/hacknet.txt (interval, autoBuy, maxServers, spendThreshold, reserveHashes, allowWorkers, spendStrategy)" },
  focus: { start: "run daemons/focus.js", stop: "kill daemons/focus.js", flags: "config: /config/focus.txt (holder, sleeveHolder, default, simulacrum)" },
};

// === RUNNING STATE ===

function getDaemonRunState(processes: ProcessInfo[]): Record<ToolName, { running: boolean; pid: number }> {
  const state = {} as Record<ToolName, { running: boolean; pid: number }>;
  for (const tool of Object.keys(TOOL_SCRIPTS) as ToolName[]) {
    const script = TOOL_SCRIPTS[tool];
    const proc = processes.find(p => p.filename === script);
    state[tool] = proc ? { running: true, pid: proc.pid } : { running: false, pid: 0 };
  }
  return state;
}

function formatRunState(state: { running: boolean; pid: number }): string {
  return state.running
    ? `${C.green}RUNNING (pid ${state.pid})${C.reset}`
    : `${C.red}STOPPED${C.reset}`;
}

// === PRINT HELPERS ===

function printHeader(log: Log, title: string): void {
  log(`\n${C.cyan}=== ${title} ===${C.reset}`);
}

function printField(log: Log, label: string, value: string | number, color: string = C.white): void {
  log(`  ${C.dim}${label}:${C.reset} ${color}${value}${C.reset}`);
}

function printOffline(log: Log, tool: string): void {
  log(`  ${C.dim}(no data — ${tool} daemon not running?)${C.reset}`);
}

function printCliDocs(log: Log, tool: ToolName): void {
  const docs = DAEMON_DOCS[tool];
  log(`\n  ${C.dim}CLI:${C.reset}`);
  log(`    Start: ${C.cyan}${docs.start}${C.reset}`);
  log(`    Stop:  ${C.cyan}${docs.stop}${C.reset}`);
  if (docs.flags) {
    log(`    Flags: ${C.yellow}${docs.flags}${C.reset}`);
  }
}

// === OVERVIEW ===

function printOverview(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);

  printHeader(log, "STATUS OVERVIEW");

  // Bitnode
  const bitnode = peekStatus<BitnodeStatus>(ns, STATUS_PORTS.bitnode);
  if (bitnode) {
    const check = (v: boolean) => v ? `${C.green}[x]${C.reset}` : `${C.red}[ ]${C.reset}`;
    log(`  ${C.cyan}FL1GHT.EXE${C.reset}  ${check(bitnode.augsComplete)} Augs: ${bitnode.augmentations}/${bitnode.augmentationsRequired}  ${check(bitnode.moneyComplete)} Money: ${bitnode.moneyFormatted}/${bitnode.moneyRequiredFormatted}  ${check(bitnode.hackingComplete)} Hack: ${bitnode.hacking}/${bitnode.hackingRequired}  ${check(bitnode.worldDaemonComplete)} WD: ${bitnode.hacking}/${Math.ceil(bitnode.worldDaemonRequired)}${bitnode.worldDaemonRequiredLive ? "" : "?"}`);
  }

  // Nuke
  const nuke = peekStatus<NukeStatus>(ns, STATUS_PORTS.nuke);
  log("");
  log(`  ${C.green}NUKE${C.reset}  ${formatRunState(runState.nuke)}`);
  if (nuke) {
    log(`    Rooted: ${nuke.rootedCount}/${nuke.totalServers}  Tools: ${nuke.toolCount}  Ready: ${nuke.ready.length}`);
    if (nuke.fleetRam) {
      log(`    Fleet RAM: ${nuke.fleetRam.totalUsedRam} / ${nuke.fleetRam.totalMaxRam} (${nuke.fleetRam.utilization}%) on ${nuke.fleetRam.serverCount} servers`);
    }
  } else {
    printOffline(log, "nuke");
  }

  // Hack
  const hack = peekStatus<HackStatus>(ns, STATUS_PORTS.hack);
  log(`  ${C.green}HACK${C.reset}  ${formatRunState(runState.hack)}`);
  if (hack) {
    log(`    Targets: ${hack.activeTargets}/${hack.totalTargets}  Threads: ${hack.totalThreads}  Income: ${hack.totalExpectedMoneyFormatted}/s`);
  } else {
    printOffline(log, "hack");
  }

  // Pserv
  const pserv = peekStatus<PservStatus>(ns, STATUS_PORTS.pserv);
  log(`  ${C.green}PSERV${C.reset}  ${formatRunState(runState.pserv)}`);
  if (pserv) {
    log(`    Servers: ${pserv.serverCount}/${pserv.serverCap}  RAM: ${pserv.totalRam}  ${pserv.allMaxed ? C.green + "MAXED" + C.reset : `${pserv.minRam} - ${pserv.maxRam}`}`);
  } else {
    printOffline(log, "pserv");
  }

  // Share
  const share = peekStatus<ShareStatus>(ns, STATUS_PORTS.share);
  log(`  ${C.green}SHARE${C.reset}  ${formatRunState(runState.share)}`);
  if (share) {
    log(`    Power: ${share.sharePower}  Threads: ${share.totalThreads}  Servers: ${share.serversWithShare}`);
  } else {
    printOffline(log, "share");
  }

  // Rep
  const rep = peekStatus<RepStatus>(ns, STATUS_PORTS.rep);
  log(`  ${C.green}REP${C.reset}  ${formatRunState(runState.rep)}`);
  if (rep) {
    log(`    Faction: ${rep.targetFaction ?? "—"}  Rep: ${rep.currentRepFormatted ?? "—"}/${rep.repRequiredFormatted ?? "—"}  Progress: ${((rep.repProgress ?? 0) * 100).toFixed(1)}%`);
  } else {
    printOffline(log, "rep");
  }

  // Work
  const work = peekStatus<WorkStatus>(ns, STATUS_PORTS.work);
  log(`  ${C.green}WORK${C.reset}  ${formatRunState(runState.work)}`);
  if (work) {
    log(`    Focus: ${work.focusLabel}  Activity: ${work.activityDisplay}  City: ${work.playerCity}`);
  } else {
    printOffline(log, "work");
  }

  // Darkweb
  const darkweb = peekStatus<DarkwebStatus>(ns, STATUS_PORTS.darkweb);
  log(`  ${C.green}DARKWEB${C.reset}  ${formatRunState(runState.darkweb)}`);
  if (darkweb) {
    const tor = darkweb.hasTorRouter ? `${C.green}TOR${C.reset}` : `${C.red}NO TOR${C.reset}`;
    log(`    ${tor}  Programs: ${darkweb.ownedCount}/${darkweb.totalPrograms}  ${darkweb.allOwned ? C.green + "ALL OWNED" + C.reset : `Next: ${darkweb.nextProgram?.name || "-"}`}`);
  } else {
    printOffline(log, "darkweb");
  }

  // Faction
  const faction = peekStatus<FactionStatus>(ns, STATUS_PORTS.faction);
  log(`  ${C.green}FACTION${C.reset}  ${formatRunState(runState.faction)}`);
  if (faction) {
    const cityPart = faction.preferredCityFaction && faction.preferredCityFaction !== "None"
      ? `  City: ${faction.preferredCityFaction}`
      : "";
    log(`    Joined: ${faction.joinedCount}/${faction.factions.length}  Invited: ${faction.invitedCount}${cityPart}`);
  } else {
    printOffline(log, "faction");
  }

  // Gang
  const gang = peekStatus<GangStatus>(ns, STATUS_PORTS.gang);
  log(`  ${C.green}GANG${C.reset}  ${formatRunState(runState.gang)}`);
  if (gang) {
    if (!gang.inGang) {
      log(`    ${C.dim}Not in a gang${C.reset}`);
    } else {
      const income = gang.moneyGainRateFormatted ?? "0";
      const territory = gang.territory !== undefined ? `${(gang.territory * 100).toFixed(1)}%` : "?";
      log(`    ${gang.faction} | ${gang.memberCount} members | ${income}/s | Territory: ${territory} | Strategy: ${gang.strategy ?? "—"}`);
    }
  } else {
    printOffline(log, "gang");
  }

  log("");
}

// === DETAILED VIEWS ===

function printNukeDetail(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);
  const nuke = peekStatus<NukeStatus>(ns, STATUS_PORTS.nuke);
  printHeader(log, "NUKE DETAIL");
  log(`  ${formatRunState(runState.nuke)}`);
  if (!nuke) { printOffline(log, "nuke"); printCliDocs(log, "nuke"); return; }

  printField(log, "Rooted", `${nuke.rootedCount}/${nuke.totalServers}`);
  printField(log, "Tools", String(nuke.toolCount));

  if (nuke.fleetRam) {
    printField(log, "Fleet RAM", `${nuke.fleetRam.totalUsedRam} / ${nuke.fleetRam.totalMaxRam} (${nuke.fleetRam.utilization}%) on ${nuke.fleetRam.serverCount} servers`, C.cyan);
  }

  if (nuke.ready.length > 0) {
    log(`\n  ${C.green}Ready to root:${C.reset}`);
    for (const s of nuke.ready) {
      log(`    ${s.hostname} (hack: ${s.requiredHacking}, ports: ${s.requiredPorts})`);
    }
  }
  if (nuke.needHacking.length > 0) {
    log(`\n  ${C.yellow}Need higher hacking:${C.reset}`);
    for (const s of nuke.needHacking.slice(0, 10)) {
      log(`    ${s.hostname} (need: ${s.required}, have: ${s.current})`);
    }
  }
  if (nuke.needPorts.length > 0) {
    log(`\n  ${C.yellow}Need more port tools:${C.reset}`);
    for (const s of nuke.needPorts.slice(0, 10)) {
      log(`    ${s.hostname} (need: ${s.required}, have: ${s.current})`);
    }
  }
  printCliDocs(log, "nuke");
  log("");
}

function printHackDetail(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);
  const hack = peekStatus<HackStatus>(ns, STATUS_PORTS.hack);
  printHeader(log, "HACK DETAIL");
  log(`  ${formatRunState(runState.hack)}`);
  if (!hack) { printOffline(log, "hack"); printCliDocs(log, "hack"); return; }

  printField(log, "Total RAM", hack.totalRam);
  printField(log, "Servers", String(hack.serverCount));
  printField(log, "Threads", hack.totalThreads);
  printField(log, "Income", hack.totalExpectedMoneyFormatted + "/s");
  printField(log, "Saturation", `${hack.saturationPercent.toFixed(1)}%`);
  printField(log, "Targets", `${hack.activeTargets}/${hack.totalTargets}`);

  if (hack.targets.length > 0) {
    log(`\n  ${C.dim}${"Host".padEnd(20)} ${"Action".padEnd(8)} ${"Threads".padEnd(10)} ${"Money%".padEnd(8)} ${"Security".padEnd(10)} ${"Income".padEnd(12)}${C.reset}`);
    for (const t of hack.targets.slice(0, 15)) {
      const actionColor = t.action === "hack" ? C.green : t.action === "grow" ? C.cyan : C.yellow;
      log(`  ${t.hostname.padEnd(20)} ${actionColor}${t.action.padEnd(8)}${C.reset} ${String(t.assignedThreads).padEnd(10)} ${t.moneyDisplay.padEnd(8)} ${t.securityDelta.padEnd(10)} ${t.expectedMoneyFormatted.padEnd(12)}`);
    }
  }
  printCliDocs(log, "hack");
  log("");
}

function printPservDetail(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);
  const pserv = peekStatus<PservStatus>(ns, STATUS_PORTS.pserv);
  printHeader(log, "PSERV DETAIL");
  log(`  ${formatRunState(runState.pserv)}`);
  if (!pserv) { printOffline(log, "pserv"); printCliDocs(log, "pserv"); return; }

  printField(log, "Servers", `${pserv.serverCount}/${pserv.serverCap}`);
  printField(log, "Total RAM", pserv.totalRam);
  printField(log, "Range", `${pserv.minRam} - ${pserv.maxRam}`);
  printField(log, "Max Possible", pserv.maxPossibleRam);
  printField(log, "All Maxed", pserv.allMaxed ? "Yes" : "No", pserv.allMaxed ? C.green : C.yellow);

  if (pserv.nextUpgrade) {
    log(`\n  ${C.cyan}Next upgrade:${C.reset}`);
    log(`    ${pserv.nextUpgrade.hostname}: ${pserv.nextUpgrade.currentRam} → ${pserv.nextUpgrade.nextRam} (${pserv.nextUpgrade.costFormatted})  ${pserv.nextUpgrade.canAfford ? C.green + "CAN AFFORD" + C.reset : C.red + "NEED MORE" + C.reset}`);
  }

  if (pserv.servers.length > 0) {
    log(`\n  ${C.dim}${"Server".padEnd(20)} RAM${C.reset}`);
    for (const s of pserv.servers) {
      log(`  ${s.hostname.padEnd(20)} ${s.ramFormatted}`);
    }
  }
  printCliDocs(log, "pserv");
  log("");
}

function printShareDetail(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);
  const share = peekStatus<ShareStatus>(ns, STATUS_PORTS.share);
  printHeader(log, "SHARE DETAIL");
  log(`  ${formatRunState(runState.share)}`);
  if (!share) { printOffline(log, "share"); printCliDocs(log, "share"); return; }

  printField(log, "Power", share.sharePower);
  printField(log, "Threads", share.totalThreads);
  printField(log, "RAM per Thread", share.shareRam);
  printField(log, "Servers", String(share.serversWithShare));

  if (share.serverStats.length > 0) {
    log(`\n  ${C.dim}${"Server".padEnd(20)} Threads${C.reset}`);
    for (const s of share.serverStats) {
      log(`  ${s.hostname.padEnd(20)} ${s.threads}`);
    }
  }
  printCliDocs(log, "share");
  log("");
}

function printRepDetail(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);
  const rep = peekStatus<RepStatus>(ns, STATUS_PORTS.rep);
  printHeader(log, "REP DETAIL");
  log(`  ${formatRunState(runState.rep)}`);
  if (!rep) { printOffline(log, "rep"); printCliDocs(log, "rep"); return; }

  printField(log, "Target Faction", rep.targetFaction ?? "—");
  printField(log, "Next Aug", rep.nextAugName || "None");
  printField(log, "Rep", `${rep.currentRepFormatted ?? "—"} / ${rep.repRequiredFormatted ?? "—"}`);
  printField(log, "Progress", `${((rep.repProgress ?? 0) * 100).toFixed(1)}%`);
  printField(log, "ETA", rep.eta ?? "—");
  printField(log, "Favor", `${rep.favor ?? 0} / ${rep.favorToUnlock ?? 150}`);
  printField(log, "Installed Augs", String(rep.installedAugs ?? 0));
  printCliDocs(log, "rep");
  log("");
}

function printWorkDetail(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);
  const work = peekStatus<WorkStatus>(ns, STATUS_PORTS.work);
  printHeader(log, "WORK DETAIL");
  log(`  ${formatRunState(runState.work)}`);
  if (!work) { printOffline(log, "work"); printCliDocs(log, "work"); return; }

  printField(log, "Focus", `${work.focusLabel} (${work.currentFocus})`);
  printField(log, "Activity", work.activityDisplay);
  printField(log, "City", work.playerCity);
  printField(log, "Money", work.playerMoneyFormatted);

  log(`\n  ${C.cyan}Skills:${C.reset}`);
  printField(log, "  Hacking", work.skills.hackingFormatted);
  printField(log, "  Strength", work.skills.strengthFormatted);
  printField(log, "  Defense", work.skills.defenseFormatted);
  printField(log, "  Dexterity", work.skills.dexterityFormatted);
  printField(log, "  Agility", work.skills.agilityFormatted);
  printField(log, "  Charisma", work.skills.charismaFormatted);

  printField(log, "Combat Balance", `${(work.combatBalance * 100).toFixed(1)}%`);

  if (work.recommendation) {
    log(`\n  ${C.cyan}Recommendation:${C.reset}`);
    log(`    ${work.recommendation.type}: ${work.recommendation.location} in ${work.recommendation.city}`);
    log(`    Skill: ${work.recommendation.skillDisplay} (${work.recommendation.expMultFormatted}x exp)`);
    if (work.recommendation.needsTravel) {
      log(`    ${C.yellow}Needs travel (${work.recommendation.travelCostFormatted})${C.reset}`);
    }
  }
  printCliDocs(log, "work");
  log("");
}

function printDarkwebDetail(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);
  const darkweb = peekStatus<DarkwebStatus>(ns, STATUS_PORTS.darkweb);
  printHeader(log, "DARKWEB DETAIL");
  log(`  ${formatRunState(runState.darkweb)}`);
  if (!darkweb) { printOffline(log, "darkweb"); printCliDocs(log, "darkweb"); return; }

  printField(log, "TOR Router", darkweb.hasTorRouter ? "Owned" : "Not owned", darkweb.hasTorRouter ? C.green : C.red);
  printField(log, "Programs", `${darkweb.ownedCount}/${darkweb.totalPrograms}`);

  if (darkweb.programs.length > 0) {
    log("");
    for (const p of darkweb.programs) {
      const status = p.owned ? `${C.green}[x]${C.reset}` : `${C.red}[ ]${C.reset}`;
      log(`    ${status} ${p.name.padEnd(20)} ${p.costFormatted}`);
    }
  }

  if (darkweb.nextProgram && !darkweb.allOwned) {
    log(`\n  ${C.cyan}Next:${C.reset} ${darkweb.nextProgram.name} (${darkweb.nextProgram.costFormatted})`);
    if (darkweb.moneyUntilNext > 0) {
      log(`  ${C.yellow}Need ${darkweb.moneyUntilNextFormatted} more${C.reset}`);
    } else {
      log(`  ${C.green}Can afford!${C.reset}`);
    }
  }
  printCliDocs(log, "darkweb");
  log("");
}

function printFactionDetail(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);
  const faction = peekStatus<FactionStatus>(ns, STATUS_PORTS.faction);
  printHeader(log, "FACTION DETAIL");
  log(`  ${formatRunState(runState.faction)}`);
  if (!faction) { printOffline(log, "faction"); printCliDocs(log, "faction"); return; }

  printField(log, "Tier", `${faction.tier} (${faction.tierName})`);
  printField(log, "Joined", `${faction.joinedCount}/${faction.factions.length}`);
  printField(log, "Invited", String(faction.invitedCount));
  printField(log, "Remaining", String(faction.notInvitedCount));

  // Player stats (tier 2+)
  if (faction.playerHacking !== undefined) {
    log(`\n  ${C.cyan}Player Stats:${C.reset}`);
    printField(log, "  Hacking", String(faction.playerHacking));
    printField(log, "  Strength", String(faction.playerStrength ?? 0));
    printField(log, "  Defense", String(faction.playerDefense ?? 0));
    printField(log, "  Dexterity", String(faction.playerDexterity ?? 0));
    printField(log, "  Agility", String(faction.playerAgility ?? 0));
    if (faction.playerAugsInstalled !== undefined) {
      printField(log, "  Augs Installed", String(faction.playerAugsInstalled));
    }
  }

  // Invited factions
  const invited = faction.factions.filter(f => f.status === "invited");
  if (invited.length > 0) {
    log(`\n  ${C.yellow}Invited:${C.reset}`);
    for (const f of invited) {
      const augPart = f.availableAugCount !== undefined ? ` (${f.availableAugCount} augs)` : "";
      log(`    ${f.name} ${C.dim}${f.type}${C.reset}${augPart}`);
    }
  }

  // Joined factions
  const joined = faction.factions.filter(f => f.status === "joined");
  if (joined.length > 0) {
    log(`\n  ${C.green}Joined:${C.reset}`);
    for (const f of joined) {
      const augPart = f.availableAugCount !== undefined ? ` (${f.availableAugCount} augs left)` : "";
      log(`    ${f.name} ${C.dim}${f.type}${C.reset}${augPart}`);
    }
  }

  // Not invited — split by eligible/ineligible
  const notInvited = faction.factions.filter(f => f.status === "not-invited");
  if (notInvited.length > 0) {
    const eligible = notInvited.filter(f => f.eligible !== false);
    const ineligible = notInvited.filter(f => f.eligible === false);

    if (eligible.length > 0) {
      log(`\n  ${C.cyan}Not Invited (eligible):${C.reset}`);
      for (const f of eligible) {
        const augPart = f.availableAugCount !== undefined ? ` (${f.availableAugCount} augs)` : "";
        const reqSummary = f.requirements
          ? " — " + f.requirements.map(r => {
              const icon = !r.verifiable ? "?" : r.met ? "+" : "-";
              return `[${icon}] ${r.label}`;
            }).join(", ")
          : "";
        log(`    ${f.name} ${C.dim}${f.type}${C.reset}${augPart}${C.dim}${reqSummary}${C.reset}`);
      }
    }

    if (ineligible.length > 0) {
      log(`\n  ${C.dim}Not Invited (not eligible):${C.reset}`);
      for (const f of ineligible) {
        const unmet = f.requirements?.filter(r => r.verifiable && !r.met).map(r => r.label) ?? [];
        const unmetStr = unmet.length > 0 ? ` — need: ${unmet.join(", ")}` : "";
        log(`    ${C.dim}${f.name} ${f.type}${unmetStr}${C.reset}`);
      }
    }
  }

  // Pending backdoors
  if (faction.pendingBackdoors && faction.pendingBackdoors.length > 0) {
    log(`\n  ${C.cyan}Pending Backdoors:${C.reset}`);
    for (const b of faction.pendingBackdoors) {
      const status = b.rooted && b.haveHacking
        ? `${C.green}READY${C.reset}`
        : !b.rooted
          ? `${C.red}need root${C.reset}`
          : `${C.yellow}need hacking${C.reset}`;
      log(`    ${b.faction} (${b.server}) — ${status}`);
    }
  }

  // Last action (tier 3)
  if (faction.lastAction) {
    log(`\n  ${C.green}Last Action:${C.reset} ${faction.lastAction}`);
  }

  printCliDocs(log, "faction");
  log("");
}

function printGangDetail(ns: NS, log: Log): void {
  const processes = ns.ps("home");
  const runState = getDaemonRunState(processes);
  const gang = peekStatus<GangStatus>(ns, STATUS_PORTS.gang);
  printHeader(log, "GANG DETAIL");
  log(`  ${formatRunState(runState.gang)}`);
  if (!gang) { printOffline(log, "gang"); printCliDocs(log, "gang"); return; }

  if (!gang.inGang) {
    log(`  ${C.dim}Not in a gang${C.reset}`);
    printCliDocs(log, "gang");
    return;
  }

  printField(log, "Faction", gang.faction ?? "—");
  printField(log, "Tier", `${gang.tier} (${gang.tierName})`);
  printField(log, "Strategy", gang.strategy ?? "—");
  printField(log, "Members", `${gang.memberCount ?? 0}/${gang.maxMembers ?? 12}`);
  printField(log, "Respect", `${gang.respectFormatted ?? "0"} (+${gang.respectGainRateFormatted ?? "0"}/s)`);
  printField(log, "Income", `${gang.moneyGainRateFormatted ?? "0"}/s`);
  printField(log, "Wanted", `${((gang.wantedPenalty ?? 1) * 100).toFixed(1)}%`);
  printField(log, "Territory", `${((gang.territory ?? 0) * 100).toFixed(1)}%`);

  if (gang.members && gang.members.length > 0) {
    log(`\n  ${C.cyan}Members:${C.reset}`);
    for (const m of gang.members) {
      const pin = m.isPinned ? ` ${C.yellow}[PINNED]${C.reset}` : "";
      log(`    ${m.name.padEnd(10)} ${m.task.padEnd(20)} str:${m.str.toFixed(0)} def:${m.def.toFixed(0)} dex:${m.dex.toFixed(0)} agi:${m.agi.toFixed(0)}${pin}`);
    }
  }

  if (gang.ascensionAlerts && gang.ascensionAlerts.length > 0) {
    log(`\n  ${C.yellow}Ascension Alerts:${C.reset}`);
    for (const a of gang.ascensionAlerts) {
      log(`    ${a.memberName}: ${a.bestStat} x${a.bestGain.toFixed(2)}`);
    }
  }

  printCliDocs(log, "gang");
  log("");
}

// === RENDER DISPATCHER ===

function renderStatus(ns: NS, tool: string, log: Log): void {
  switch (tool) {
    case "nuke":    printNukeDetail(ns, log); break;
    case "hack":    printHackDetail(ns, log); break;
    case "pserv":   printPservDetail(ns, log); break;
    case "share":   printShareDetail(ns, log); break;
    case "rep":     printRepDetail(ns, log); break;
    case "work":    printWorkDetail(ns, log); break;
    case "darkweb": printDarkwebDetail(ns, log); break;
    case "faction": printFactionDetail(ns, log); break;
    case "gang":    printGangDetail(ns, log); break;
    default:        printOverview(ns, log); break;
  }
}

// === MAIN ===

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const flags = ns.flags([["live", false]]) as { live: boolean; _: string[] };
  const tool = flags._.length > 0 ? String(flags._[0]).toLowerCase() : "";

  if (flags.live) {
    ns.ui.openTail();
    // eslint-disable-next-line no-constant-condition
    while (flags.live) { // avoids error; never false
      ns.clearLog();
      renderStatus(ns, tool, ns.print.bind(ns));
      await ns.sleep(2000);
    }
  } else {
    renderStatus(ns, tool, ns.tprint.bind(ns));
  }
}
