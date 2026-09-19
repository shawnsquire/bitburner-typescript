/**
 * Share Daemon (Tiered Architecture)
 *
 * Long-running daemon that fills spare RAM with share() threads to boost
 * faction reputation gains, and publishes ShareStatus to the status port
 * for the dashboard.
 *
 * Operates in two tiers based on focus priority:
 *   Tier 0 (Monitor): ~5GB  - Watches for rep focus, publishes paused status
 *   Tier 1 (Active):  Full  - Deploys share threads across fleet
 *
 * Share only activates when the rep daemon holds focus (i.e., the player is
 * grinding faction rep). Otherwise it stays in low-RAM monitor mode.
 *
 * Usage:
 *   run daemons/share.js                 # Auto-select tier based on focus
 *   run daemons/share.js --tier active   # Force active mode
 *   run daemons/share.js --tier monitor  # Force monitor mode
 *   run daemons/share.js --one-shot
 *   run daemons/share.js --min-free 16
 *   run daemons/share.js --home-reserve 64
 *   run daemons/share.js --interval 5000
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { getShareStatus, DEFAULT_SHARE_SCRIPT, ShareConfig, deployShareScript, launchShareThreads } from "/controllers/share";
import { publishStatus, peekStatus } from "/lib/ports";
import { STATUS_PORTS, ShareStatus, FleetAllocation } from "/types/ports";
import { writeDefaultConfig, getConfigNumber, getConfigBool, getConfigString } from "/lib/config";

// === TIER DEFINITIONS ===

type ShareTierName = "monitor" | "active";

const BASE_SCRIPT_COST = 1.6; // GB - base cost of running any script

// Functions used by monitor tier (base NS only)
const MONITOR_FUNCTIONS = [
  "getPortHandle",
  "sleep",
  "spawn",
];

// Additional functions needed by the active tier
const ACTIVE_FUNCTIONS = [
  "scan",
  "scp",
  "exec",
  "ps",
  "getServer",
  "getScriptRam",
  "getSharePower",
  "getServerMaxRam",
  "getServerUsedRam",
  "format.ram",
  "format.number",
];

const RAM_BUFFER_PERCENT = 0.05; // 5% safety margin

function calculateTierRam(ns: NS, tier: ShareTierName): number {
  let ram = BASE_SCRIPT_COST;

  for (const fn of MONITOR_FUNCTIONS) {
    ram += ns.getFunctionRamCost(fn);
  }

  if (tier === "active") {
    for (const fn of ACTIVE_FUNCTIONS) {
      ram += ns.getFunctionRamCost(fn);
    }
  }

  ram *= (1 + RAM_BUFFER_PERCENT);
  return Math.ceil(ram * 10) / 10;
}

// === MODULE-LEVEL CYCLE TRACKING ===

let lastKnownThreads = 0;
let lastSeenTime = 0;

/**
 * Build a ShareStatus object with formatted values for the dashboard.
 * Handles the ephemeral nature of share threads with cycle-aware state.
 */
function computeShareStatus(ns: NS, targetPercent = 0, interval = 10000): ShareStatus {
  const raw = getShareStatus(ns, DEFAULT_SHARE_SCRIPT);
  const now = Date.now();
  const gracePeriodMs = interval + 2000;

  let cycleStatus: ShareStatus["cycleStatus"];
  let displayThreads: number;

  if (raw.totalThreads > 0) {
    cycleStatus = "active";
    displayThreads = raw.totalThreads;
    lastKnownThreads = raw.totalThreads;
    lastSeenTime = now;
  } else if (now - lastSeenTime < gracePeriodMs && lastKnownThreads > 0) {
    cycleStatus = "cycle";
    displayThreads = lastKnownThreads;
  } else {
    cycleStatus = "idle";
    displayThreads = 0;
  }

  const serverStats = raw.serverStats.map((s) => ({
    hostname: s.hostname,
    threads: s.threads.toLocaleString(),
  }));

  return {
    totalThreads: displayThreads.toLocaleString(),
    sharePower: `${raw.sharePower.toFixed(3)}x`,
    shareRam: ns.format.ram(raw.shareRam),
    serversWithShare: raw.serversWithShare,
    serverStats,
    cycleStatus,
    lastKnownThreads: lastKnownThreads.toLocaleString(),
    targetPercent: targetPercent > 0 ? targetPercent : undefined,
    interval,
  };
}

/**
 * Build a paused ShareStatus for monitor mode.
 * Preserves lastKnownThreads from cached port data.
 */
function computeMonitorStatus(ns: NS, interval: number): ShareStatus {
  const cached = peekStatus<ShareStatus>(ns, STATUS_PORTS.share);
  return {
    totalThreads: "0",
    sharePower: "1.000x",
    shareRam: "0.00GB",
    serversWithShare: 0,
    serverStats: [],
    cycleStatus: "paused",
    lastKnownThreads: cached?.lastKnownThreads ?? "0",
    interval,
  };
}

/**
 * Print formatted share status to the script log.
 */
function printStatus(ns: NS, status: ShareStatus, launched: number, serversUsed: number): void {
  const C = COLORS;

  ns.print(`${C.cyan}═══ Share Daemon ═══${C.reset}`);
  ns.print(`${C.dim}Share script RAM: ${status.shareRam}${C.reset}`);
  if (status.targetPercent && status.targetPercent > 0) {
    ns.print(`${C.yellow}Target: ${status.targetPercent}% of capacity${C.reset}`);
  }
  ns.print("");

  switch (status.cycleStatus) {
    case "active":
      ns.print(`${C.green}Status: ACTIVE${C.reset}`);
      break;
    case "cycle":
      ns.print(`${C.yellow}Status: CYCLING${C.reset} ${C.dim}(between share rounds)${C.reset}`);
      break;
    case "idle":
      ns.print(`${C.dim}Status: IDLE${C.reset}`);
      break;
  }

  ns.print(`${C.white}Threads: ${C.green}${status.totalThreads}${C.reset}`);
  ns.print(`${C.white}Share Power: ${C.green}${status.sharePower}${C.reset} reputation gain`);
  ns.print(`${C.white}Servers: ${status.serversWithShare}${C.reset}`);

  if (status.serverStats.length > 0) {
    ns.print("");
    ns.print(`${C.dim}Top servers by share threads:${C.reset}`);
    for (const s of status.serverStats.slice(0, 5)) {
      ns.print(`  ${C.dim}${s.hostname.padEnd(20)}${C.reset} ${s.threads} threads`);
    }
    if (status.serverStats.length > 5) {
      ns.print(`  ${C.dim}... +${status.serverStats.length - 5} more${C.reset}`);
    }
  }

  ns.print("");
  ns.print(
    `${C.white}Launched this cycle: ${C.yellow}${launched.toLocaleString()}${C.reset} on ${serversUsed} servers`,
  );
}

/**
 * Print monitor mode status to the script log.
 */
function printMonitorStatus(ns: NS): void {
  const C = COLORS;
  ns.print(`${C.cyan}═══ Share Daemon (Monitor) ═══${C.reset}`);
  ns.print("");
  ns.print(`${C.yellow}PAUSED${C.reset} — Waiting for rep focus`);
  ns.print(`${C.dim}Share activates when the rep daemon claims focus.${C.reset}`);
}

// === TIER RUN FUNCTIONS ===

/**
 * Monitor mode: low-RAM watcher that waits for rep focus.
 */
async function runMonitorMode(ns: NS): Promise<void> {
  let firstRun = true;

  do {
    const interval = getConfigNumber(ns, "share", "interval", 10000);
    const holder = getConfigString(ns, "focus", "holder", "");

    if (holder === "rep") {
      ns.tprint("INFO: Rep focus detected — share daemon upgrading to active tier");
      ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100, ramOverride: 5 });
      return;
    }

    ns.clearLog();
    const status = computeMonitorStatus(ns, interval);
    publishStatus(ns, STATUS_PORTS.share, status);
    printMonitorStatus(ns);

    if (firstRun) {
      ns.tprint("INFO: Share daemon: monitor tier (~5GB RAM) — waiting for rep focus");
      firstRun = false;
    }

    const oneShot = getConfigBool(ns, "share", "oneShot", false);
    if (!oneShot) {
      ns.print(`\n${COLORS.dim}Next check in ${interval / 1000}s...${COLORS.reset}`);
      await ns.sleep(interval);
    }
  } while (!getConfigBool(ns, "share", "oneShot", false));
}

/**
 * Active mode: deploys share threads and checks for focus loss.
 */
async function runActiveMode(ns: NS): Promise<void> {
  // Deploy share script to all servers on startup
  await deployShareScript(ns, DEFAULT_SHARE_SCRIPT);

  // Verify share script exists
  const shareRam = ns.getScriptRam(DEFAULT_SHARE_SCRIPT);
  if (shareRam === 0) {
    ns.tprint(`${COLORS.red}ERROR: Could not find ${DEFAULT_SHARE_SCRIPT}${COLORS.reset}`);
    return;
  }

  // Wait for fleet allocation from hack daemon (up to 10s)
  {
    const POLL_MS = 500;
    const MAX_WAIT = 10_000;
    let waited = 0;
    while (waited < MAX_WAIT) {
      if (peekStatus<FleetAllocation>(ns, STATUS_PORTS.fleet)) break;
      await ns.sleep(POLL_MS);
      waited += POLL_MS;
    }
  }

  do {
    const config: ShareConfig = {
      minFree: getConfigNumber(ns, "share", "minFree", 4),
      homeReserve: getConfigNumber(ns, "share", "homeReserve", 32),
      interval: getConfigNumber(ns, "share", "interval", 10000),
      oneShot: getConfigBool(ns, "share", "oneShot", false),
      shareScript: DEFAULT_SHARE_SCRIPT,
      targetPercent: getConfigNumber(ns, "share", "targetPercent", 0),
    };

    // Check focus — if rep no longer holds focus, drop to monitor
    const holder = getConfigString(ns, "focus", "holder", "");
    if (holder !== "rep") {
      ns.tprint("INFO: Rep focus lost — share daemon downgrading to monitor tier");
      ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100, ramOverride: 5 }, "--tier", "monitor");
      return;
    }

    ns.clearLog();

    // Read fleet allocation from hack daemon (if running)
    const fleetAllocation = peekStatus<FleetAllocation>(ns, STATUS_PORTS.fleet);
    const allowedServers = fleetAllocation?.shareServers
      ? new Set(fleetAllocation.shareServers)
      : undefined;

    // Launch share threads on available/assigned servers
    const cycleResult = launchShareThreads(ns, config, allowedServers);

    // Compute formatted status for the dashboard
    const shareStatus = computeShareStatus(ns, config.targetPercent, config.interval);

    // Publish to port for dashboard consumption
    publishStatus(ns, STATUS_PORTS.share, shareStatus);

    // Print terminal lines
    printStatus(ns, shareStatus, cycleResult.launchedThreads, cycleResult.serversUsed);

    if (!config.oneShot) {
      ns.print(
        `\n${COLORS.dim}Next check in ${config.interval / 1000}s...${COLORS.reset}`,
      );
      await ns.sleep(config.interval);
    }
  } while (!getConfigBool(ns, "share", "oneShot", false));
}

// === MAIN ===

export async function main(ns: NS): Promise<void> {
  ns.ramOverride(5); // Start cheap so we can always launch
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "share", {
    minFree: "4",
    homeReserve: "32",
    interval: "10000",
    oneShot: "false",
    targetPercent: "0",
  });

  const flags = ns.flags([
    ["tier", ""],
  ]) as {
    tier: string;
    _: string[];
  };

  const forcedTier = flags.tier as ShareTierName | "";

  // Calculate tier RAM costs
  const monitorRam = calculateTierRam(ns, "monitor");
  const activeRam = calculateTierRam(ns, "active");

  // Determine tier: forced or auto-select based on focus config
  let selectedTier: ShareTierName;
  if (forcedTier === "monitor" || forcedTier === "active") {
    selectedTier = forcedTier;
    ns.tprint(`INFO: Share daemon: forced ${selectedTier} tier`);
  } else {
    const holder = getConfigString(ns, "focus", "holder", "");
    selectedTier = holder === "rep" ? "active" : "monitor";
  }

  // If active, upgrade RAM allocation
  if (selectedTier === "active") {
    const actual = ns.ramOverride(activeRam);
    if (actual < activeRam) {
      ns.tprint(
        `WARN: Could not allocate ${ns.format.ram(activeRam)} for active tier, ` +
        `falling back to monitor (got ${ns.format.ram(actual)})`
      );
      selectedTier = "monitor";
      ns.ramOverride(monitorRam);
    }
  }

  ns.tprint(
    `INFO: Share daemon: ${selectedTier} tier (${ns.format.ram(selectedTier === "active" ? activeRam : monitorRam)} RAM)`
  );

  if (selectedTier === "monitor") {
    await runMonitorMode(ns);
  } else {
    await runActiveMode(ns);
  }
}
