/**
 * Hack Tool Plugin
 *
 * Displays distributed hacking status with target assignments, thread allocation,
 * and saturation status.
 */
import React from "lib/react";
import { NS } from "@ns";
import {
  ToolPlugin,
  FormattedHackStatus,
  FormattedTargetAssignment,
  OverviewCardProps,
  DetailPanelProps,
} from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import {
  getUsableServers,
  getTargets,
  DistributedConfig,
} from "/controllers/hack";
import { getAllServers, HackAction } from "lib/utils";
import {
  restartHackDaemon,
  getPluginUIState,
  setPluginUIState,
} from "views/dashboard/state-store";
import { HackStrategy } from "/types/ports";

// === CONFIG ===

const DEFAULT_CONFIG: Pick<DistributedConfig, "homeReserve" | "maxTargets" | "moneyThreshold" | "securityBuffer" | "hackPercent"> = {
  homeReserve: 640,
  maxTargets: 100,
  moneyThreshold: 0.8,
  securityBuffer: 5,
  hackPercent: 0.25,
};

// === ACTION COLORS ===

const ACTION_COLORS: Record<HackAction, string> = {
  hack: "#00ff00",
  grow: "#ffff00",
  weaken: "#0088ff",
};

// === TIME FORMATTING ===

/**
 * Format milliseconds as condensed MM:SS or HH:MM:SS
 */
function formatTimeCondensed(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// === RUNNING JOBS SCANNING ===

interface RunningJobs {
  [target: string]: {
    hack: number;
    grow: number;
    weaken: number;
    earliestCompletion: number | null;
  };
}

/**
 * Scan all servers for actually running worker scripts
 */
function getRunningJobs(ns: NS): RunningJobs {
  const jobs: RunningJobs = {};

  for (const hostname of getAllServers(ns)) {
    for (const proc of ns.ps(hostname)) {
      // Match worker scripts: workers/hack.js, workers/grow.js, workers/weaken.js
      if (!proc.filename.includes("workers/")) continue;

      const target = proc.args[0] as string;
      if (!target) continue;

      const action = proc.filename.split("/").pop()?.replace(".js", "") as "hack" | "grow" | "weaken";
      if (!["hack", "grow", "weaken"].includes(action)) continue;

      const delay = (proc.args[1] as number) || 0;
      const launchTime = proc.args[2] as number;

      if (!jobs[target]) {
        jobs[target] = { hack: 0, grow: 0, weaken: 0, earliestCompletion: null };
      }
      jobs[target][action] += proc.threads;

      // Calculate completion time
      if (launchTime) {
        let duration: number;
        if (action === "hack") duration = ns.getHackTime(target);
        else if (action === "grow") duration = ns.getGrowTime(target);
        else duration = ns.getWeakenTime(target);

        const completionTime = launchTime + delay + duration;
        const currentEarliest = jobs[target].earliestCompletion;
        if (currentEarliest === null || completionTime < currentEarliest) {
          jobs[target].earliestCompletion = completionTime;
        }
      }
    }
  }

  return jobs;
}

/**
 * Calculate expected money from hack threads
 */
function calcExpectedMoney(ns: NS, target: string, hackThreads: number): number {
  if (hackThreads <= 0) return 0;

  const server = ns.getServer(target);
  const moneyAvailable = server.moneyAvailable ?? 0;

  // Use Formulas API if available
  if (ns.fileExists("Formulas.exe", "home")) {
    const player = ns.getPlayer();
    const hackPercent = ns.formulas.hacking.hackPercent(server, player);
    const hackChance = ns.formulas.hacking.hackChance(server, player);
    return moneyAvailable * Math.min(hackPercent * hackThreads, 1) * hackChance;
  }

  // Fallback to standard API
  const hackPercent = ns.hackAnalyze(target) * hackThreads;
  const hackChance = ns.hackAnalyzeChance(target);
  return moneyAvailable * Math.min(hackPercent, 1) * hackChance;
}

/**
 * Determine the display action based on running jobs or server state
 */
function determineDisplayAction(
  jobs: { hack: number; grow: number; weaken: number },
  server: { hackDifficulty?: number; minDifficulty?: number; moneyAvailable?: number; moneyMax?: number }
): HackAction {
  // If there are running jobs, show the dominant action
  const totalJobs = jobs.hack + jobs.grow + jobs.weaken;
  if (totalJobs > 0) {
    if (jobs.hack >= jobs.grow && jobs.hack >= jobs.weaken) return "hack";
    if (jobs.grow >= jobs.weaken) return "grow";
    return "weaken";
  }

  // Otherwise, determine from server state using inline logic
  const securityThresh = (server.minDifficulty ?? 0) + DEFAULT_CONFIG.securityBuffer;
  const moneyThresh = (server.moneyMax ?? 0) * DEFAULT_CONFIG.moneyThreshold;

  if ((server.hackDifficulty ?? 0) > securityThresh) {
    return "weaken";
  } else if ((server.moneyAvailable ?? 0) < moneyThresh) {
    return "grow";
  } else {
    return "hack";
  }
}

// === STATUS FORMATTING ===

function formatHackStatus(ns: NS): FormattedHackStatus | null {
  try {
    const player = ns.getPlayer();
    const playerHacking = player.skills.hacking;

    // Get all servers with available RAM
    const servers = getUsableServers(ns, DEFAULT_CONFIG.homeReserve);
    const totalRam = servers.reduce((sum, s) => sum + s.availableRam, 0);

    // Get all potential targets sorted by value
    const targets = getTargets(ns, DEFAULT_CONFIG.maxTargets);
    if (targets.length === 0) {
      return null;
    }

    // Get actual running jobs from ps()
    const runningJobs = getRunningJobs(ns);

    // Track servers needing higher level
    let needHigherLevel: { count: number; nextLevel: number } | null = null;
    let lowestRequiredAbovePlayer = Number.MAX_SAFE_INTEGER;
    let countNeedHigher = 0;

    // Scan all servers for ones we can't hack yet
    for (const hostname of getAllServers(ns)) {
      const server = ns.getServer(hostname);
      if ((server.moneyMax ?? 0) === 0) continue;
      if (hostname.startsWith("pserv-") || hostname === "home") continue;

      const required = server.requiredHackingSkill ?? 0;
      if (required > playerHacking) {
        countNeedHigher++;
        if (required < lowestRequiredAbovePlayer) {
          lowestRequiredAbovePlayer = required;
        }
      }
    }

    if (countNeedHigher > 0 && lowestRequiredAbovePlayer < Number.MAX_SAFE_INTEGER) {
      needHigherLevel = { count: countNeedHigher, nextLevel: lowestRequiredAbovePlayer };
    }

    // Count by action type and calculate totals
    let hackingCount = 0;
    let growingCount = 0;
    let weakeningCount = 0;
    let totalExpectedMoney = 0;
    let totalThreadsCount = 0;

    // Calculate wait times
    let shortestWait = Number.MAX_SAFE_INTEGER;
    let longestWait = 0;

    const formattedTargets: FormattedTargetAssignment[] = [];

    // Show all targets by value, with their running job info
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const jobs = runningJobs[target.hostname] || { hack: 0, grow: 0, weaken: 0, earliestCompletion: null };
      const server = ns.getServer(target.hostname);

      const totalThreads = jobs.hack + jobs.grow + jobs.weaken;
      totalThreadsCount += totalThreads;

      // Determine action from actual jobs, or from server state
      const action = determineDisplayAction(jobs, server);

      // Count targets with running jobs by dominant action
      if (totalThreads > 0) {
        if (jobs.hack >= jobs.grow && jobs.hack >= jobs.weaken) hackingCount++;
        else if (jobs.grow >= jobs.weaken) growingCount++;
        else weakeningCount++;
      }

      // Calculate expected money for targets with hack threads
      const expectedMoney = calcExpectedMoney(ns, target.hostname, jobs.hack);
      totalExpectedMoney += expectedMoney;

      // Get wait time based on action
      let waitTime: number;
      if (action === "weaken") waitTime = ns.getWeakenTime(target.hostname);
      else if (action === "grow") waitTime = ns.getGrowTime(target.hostname);
      else waitTime = ns.getHackTime(target.hostname);

      if (totalThreads > 0) {
        shortestWait = Math.min(shortestWait, waitTime);
        longestWait = Math.max(longestWait, waitTime);
      }

      // Calculate completion ETA
      let completionEta: string | null = null;
      if (jobs.earliestCompletion !== null) {
        const msRemaining = jobs.earliestCompletion - Date.now();
        if (msRemaining > 0) {
          completionEta = formatTimeCondensed(msRemaining);
        } else {
          completionEta = "now";
        }
      }

      // Get server state
      const moneyAvailable = server.moneyAvailable ?? 0;
      const moneyMax = server.moneyMax ?? 1;
      const moneyPercent = (moneyAvailable / moneyMax) * 100;

      const hackDifficulty = server.hackDifficulty ?? 0;
      const minDifficulty = server.minDifficulty ?? 0;
      const securityDelta = hackDifficulty - minDifficulty;

      formattedTargets.push({
        rank: i + 1,
        hostname: target.hostname,
        action,
        assignedThreads: totalThreads,
        optimalThreads: 0, // Not computing optimal anymore since we're showing actual
        threadsSaturated: totalThreads > 0,
        moneyPercent,
        moneyDisplay: `${ns.format.number(moneyAvailable)} / ${ns.format.number(moneyMax)}`,
        securityDelta: securityDelta > 0 ? `+${securityDelta.toFixed(1)}` : "0",
        securityClean: securityDelta <= 2,
        eta: formatTimeCondensed(waitTime),
        expectedMoney,
        expectedMoneyFormatted: expectedMoney > 0 ? `$${ns.format.number(expectedMoney)}` : "-",
        totalThreads,
        completionEta,
        hackThreads: jobs.hack,
        growThreads: jobs.grow,
        weakenThreads: jobs.weaken,
      });
    }

    // Count active targets (those with running jobs)
    const activeTargets = formattedTargets.filter(t => t.totalThreads > 0).length;

    // Calculate saturation (targets with jobs / total targets)
    const saturationPercent = targets.length > 0 ? (activeTargets / targets.length) * 100 : 0;

    return {
      totalRam: ns.format.ram(totalRam),
      serverCount: servers.length,
      totalThreads: ns.format.number(totalThreadsCount),
      activeTargets,
      totalTargets: targets.length,
      saturationPercent,
      shortestWait: shortestWait === Number.MAX_SAFE_INTEGER ? "N/A" : formatTimeCondensed(shortestWait),
      longestWait: longestWait === 0 ? "N/A" : formatTimeCondensed(longestWait),
      hackingCount,
      growingCount,
      weakeningCount,
      targets: formattedTargets,
      totalExpectedMoney,
      totalExpectedMoneyFormatted: `$${ns.format.number(totalExpectedMoney)}`,
      needHigherLevel,
    };
  } catch {
    return null;
  }
}

// === PHASE COLORS ===

const PHASE_COLORS: Record<string, string> = {
  prep: "#ffaa00",
  batch: "#00ff00",
  "desync-recovery": "#ff4444",
};

// === CONTROL STYLES ===

const controlSelectStyle: React.CSSProperties = {
  backgroundColor: "#1a1a1a",
  color: "#00ff00",
  border: "1px solid #333",
  borderRadius: "3px",
  padding: "1px 4px",
  fontSize: "12px",
  fontFamily: "inherit",
  cursor: "pointer",
};

const controlInputStyle: React.CSSProperties = {
  backgroundColor: "#1a1a1a",
  color: "#00ff00",
  border: "1px solid #333",
  borderRadius: "3px",
  padding: "1px 4px",
  fontSize: "12px",
  fontFamily: "inherit",
  width: "50px",
  textAlign: "right",
};

// === HACK CONTROLS ===

function HackControls({ running, sharePercent }: { running: boolean; sharePercent?: number }): React.ReactElement {
  const strategy = getPluginUIState<HackStrategy>("hack", "strategy", "money");
  const maxBatches = getPluginUIState<number>("hack", "maxBatches", 1);
  const homeReserve = getPluginUIState<number>("hack", "homeReserve", 640);

  const applySettings = (
    newStrategy?: HackStrategy,
    newBatches?: number,
    newReserve?: number,
  ) => {
    const s = newStrategy ?? strategy;
    const b = newBatches ?? maxBatches;
    const hr = newReserve ?? homeReserve;
    if (running) {
      restartHackDaemon(s, b, hr);
    }
  };

  return (
    <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px", padding: "4px 6px", backgroundColor: "#111", borderRadius: "3px", border: "1px solid #222" }}>
      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <span style={{ ...styles.statLabel, fontSize: "11px" }}>Strategy</span>
        <select
          style={controlSelectStyle}
          value={strategy}
          onChange={(e) => {
            const val = (e.target as HTMLSelectElement).value as HackStrategy;
            setPluginUIState("hack", "strategy", val);
            applySettings(val);
          }}
        >
          <option value="money">Money</option>
          <option value="xp">XP</option>
          <option value="drain">Drain</option>
          <option value="stocks">Stocks</option>
        </select>
      </span>
      {strategy !== "xp" && strategy !== "drain" && strategy !== "stocks" && (
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ ...styles.statLabel, fontSize: "11px" }}>Batches</span>
          <input
            type="number"
            min={0}
            max={100}
            style={controlInputStyle}
            value={maxBatches}
            onChange={(e) => {
              const val = Math.max(0, parseInt((e.target as HTMLInputElement).value) || 0);
              setPluginUIState("hack", "maxBatches", val);
            }}
            onBlur={() => applySettings()}
            onKeyDown={(e) => {
              if ((e as unknown as KeyboardEvent).key === "Enter") applySettings();
            }}
          />
        </span>
      )}
      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <span style={{ ...styles.statLabel, fontSize: "11px" }} title="RAM reserved on home for dashboard and other scripts (GB)">Reserve</span>
        <input
          type="number"
          min={0}
          step={64}
          style={controlInputStyle}
          value={homeReserve}
          onChange={(e) => {
            const val = Math.max(0, parseInt((e.target as HTMLInputElement).value) || 0);
            setPluginUIState("hack", "homeReserve", val);
          }}
          onBlur={() => applySettings()}
          onKeyDown={(e) => {
            if ((e as unknown as KeyboardEvent).key === "Enter") applySettings();
          }}
        />
      </span>
      {(sharePercent ?? 0) > 0 && (
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ ...styles.statLabel, fontSize: "11px", color: "#ffaa00" }}>Share</span>
          <span style={{ color: "#ffaa00", fontSize: "12px" }}>{sharePercent}%</span>
        </span>
      )}
    </div>
  );
}

// === COMPONENTS ===

function HackOverviewCard({ status, running, toolId, pid }: OverviewCardProps<FormattedHackStatus>): React.ReactElement {
  const isBatch = status?.mode === "batch";
  const isXp = status?.strategy === "xp";
  const isDrain = status?.strategy === "drain";
  const isStocks = status?.strategy === "stocks";

  const modeLabel = isStocks ? " (STOCKS)" : isDrain ? " (DRAIN)" : isXp ? " (XP)" : isBatch ? " (HWGW)" : "";

  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>HACK{modeLabel}</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      {status ? (
        isDrain ? (
          <>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Targets</span>
              <span style={styles.statValue}>{status.activeTargets} servers</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Threads</span>
              <span style={styles.statValue}>{status.totalThreads}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Available</span>
              <span style={{ color: status.totalExpectedMoney > 0 ? "#ff6600" : "#666" }}>
                {status.totalExpectedMoneyFormatted}
              </span>
            </div>
          </>
        ) : isXp ? (
          <>
            <div style={styles.stat}>
              <span style={styles.statLabel}>XP Target</span>
              <span style={{ color: "#00ffff" }}>{status.xpTarget ?? "none"}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Threads</span>
              <span style={styles.statValue}>{status.totalThreads}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>XP Rate</span>
              <span style={{ color: "#00ff00" }}>{status.xpRateFormatted ?? "0 XP/s"}</span>
            </div>
          </>
        ) : isBatch ? (
          <>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Income</span>
              <span style={{ color: (status.incomePerSec ?? 0) > 0 ? "#00ff00" : "#666" }}>
                {status.incomePerSecFormatted}
              </span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Batches</span>
              <span style={styles.statValue}>{status.totalBatchesActive} active</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Targets</span>
              <span style={styles.statValue}>
                {status.preppingCount}P / {status.batchingCount}B
              </span>
            </div>
          </>
        ) : (
          <>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Targets</span>
              <span style={styles.statValue}>{status.activeTargets}/{status.totalTargets}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Threads</span>
              <span style={styles.statValue}>{status.totalThreads}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Expected</span>
              <span style={{ color: status.totalExpectedMoney > 0 ? "#00ff00" : "#666" }}>
                {status.totalExpectedMoneyFormatted}
              </span>
            </div>
          </>
        )
      ) : (
        <div style={styles.dim}>No targets</div>
      )}
    </div>
  );
}

function HackDetailPanel({ status, running, toolId, pid }: DetailPanelProps<FormattedHackStatus>): React.ReactElement {
  if (!status) {
    return (
      <div style={styles.panel}>
        <ToolControl tool={toolId} running={running} pid={pid} />
        <HackControls running={running} sharePercent={0} />
        <div style={{ ...styles.dim, marginTop: "12px" }}>No hackable targets found</div>
      </div>
    );
  }

  const isBatch = status.mode === "batch";
  const isXp = status.strategy === "xp";
  const isDrain = status.strategy === "drain";

  // Color helpers
  const getMoneyColor = (percent: number): string => {
    if (percent >= 80) return "#00ff00";
    if (percent >= 50) return "#ffff00";
    return "#ff4444";
  };

  const getSecurityColor = (clean: boolean, delta: string): string => {
    if (clean) return "#00ff00";
    const val = parseFloat(delta);
    if (val <= 5) return "#ffff00";
    return "#ff4444";
  };

  // === DRAIN MODE DETAIL PANEL ===
  if (isDrain) {
    return (
      <div style={styles.panel}>
        {/* Header */}
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span>
              <span style={styles.statLabel}>RAM: </span>
              <span style={styles.statValue}>{status.totalRam}</span>
            </span>
            <span style={styles.dim}>|</span>
            <span>
              <span style={styles.statLabel}>Servers: </span>
              <span style={styles.statValue}>{status.serverCount}</span>
            </span>
            <span style={styles.dim}>|</span>
            <span style={{ color: "#ff6600", fontSize: "11px" }}>DRAIN MODE</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>

        {/* Controls */}
        <HackControls running={running} />

        {/* Summary */}
        <div style={styles.grid}>
          <div style={styles.card}>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Drain Targets</span>
              <span style={styles.statHighlight}>{status.activeTargets}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Hack Threads</span>
              <span style={styles.statValue}>{status.totalThreads}</span>
            </div>
          </div>
          <div style={styles.card}>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Money Available</span>
              <span style={{ color: "#ff6600", fontWeight: "bold" }}>{status.totalExpectedMoneyFormatted}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Hack Time</span>
              <span style={styles.etaDisplay}>{status.shortestWait} - {status.longestWait}</span>
            </div>
          </div>
        </div>

        {/* Target Table */}
        {status.targets.length > 0 && (
          <div style={styles.section}>
            <div style={styles.sectionTitle}>
              DRAIN TARGETS
              <span style={{ ...styles.dim, marginLeft: "8px", fontWeight: "normal" }}>
                {status.activeTargets} draining | {status.totalTargets} total
              </span>
            </div>
            <div style={{ maxHeight: "300px", overflowY: "auto" }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.tableHeader, width: "24px" }} title="Rank by money available">#</th>
                    <th style={styles.tableHeader} title="Target server hostname">Target</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "80px" }} title="Money currently on server">Available</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "60px" }} title="Hack threads allocated">Threads</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "55px" }} title="Hack completion time">Time</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "55px" }} title="Chance of successful hack">Chance</th>
                  </tr>
                </thead>
                <tbody>
                  {status.targets.map((target, i) => {
                    const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                    const hasThreads = target.totalThreads > 0;

                    return (
                      <tr key={target.hostname} style={rowStyle}>
                        <td style={{ ...styles.tableCell, color: "#888" }}>{target.rank}</td>
                        <td style={{ ...styles.tableCell, color: hasThreads ? "#00ffff" : "#666" }}>
                          {target.hostname.substring(0, 16)}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right", color: "#ff6600" }}>
                          {target.moneyDisplay}
                        </td>
                        <td style={{
                          ...styles.tableCell,
                          textAlign: "right",
                          color: hasThreads ? (target.threadsSaturated ? "#00ff00" : "#ffff00") : "#666",
                        }}>
                          {hasThreads ? target.hackThreads.toLocaleString() : "-"}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right", color: "#888" }}>
                          {target.eta}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right", color: "#888" }}>
                          {target.expectedMoney > 0 ? target.expectedMoneyFormatted : "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  // === XP MODE DETAIL PANEL ===
  if (isXp) {
    return (
      <div style={styles.panel}>
        {/* Header */}
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span>
              <span style={styles.statLabel}>RAM: </span>
              <span style={styles.statValue}>{status.totalRam}</span>
            </span>
            <span style={styles.dim}>|</span>
            <span>
              <span style={styles.statLabel}>Servers: </span>
              <span style={styles.statValue}>{status.serverCount}</span>
            </span>
            <span style={styles.dim}>|</span>
            <span style={{ color: "#ff00ff", fontSize: "11px" }}>XP MODE</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>

        {/* Controls */}
        <HackControls running={running} sharePercent={status.sharePercent} />

        {/* XP Info */}
        <div style={styles.grid}>
          <div style={styles.card}>
            <div style={styles.stat}>
              <span style={styles.statLabel}>XP Target</span>
              <span style={{ color: "#00ffff", fontWeight: "bold" }}>{status.xpTarget ?? "none"}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Hack Threads</span>
              <span style={styles.statValue}>{status.xpThreads ?? 0}</span>
            </div>
          </div>
          <div style={styles.card}>
            <div style={styles.stat}>
              <span style={styles.statLabel}>XP Rate</span>
              <span style={{ color: "#00ff00", fontWeight: "bold" }}>{status.xpRateFormatted ?? "0 XP/s"}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Weaken Time</span>
              <span style={styles.etaDisplay}>{status.shortestWait}</span>
            </div>
          </div>
        </div>

      </div>
    );
  }

  if (isBatch) {
    return (
      <div style={styles.panel}>
        {/* Header */}
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span>
              <span style={styles.statLabel}>RAM: </span>
              <span style={styles.statValue}>{status.totalRam}</span>
            </span>
            <span style={styles.dim}>|</span>
            <span>
              <span style={styles.statLabel}>Servers: </span>
              <span style={styles.statValue}>{status.serverCount}</span>
            </span>
            <span style={styles.dim}>|</span>
            <span style={{ color: "#00ffff", fontSize: "11px" }}>HWGW BATCH</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>

        {/* Controls */}
        <HackControls running={running} sharePercent={status.sharePercent} />

        {/* Batch Summary */}
        <div style={styles.grid}>
          <div style={styles.card}>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Income/sec</span>
              <span style={{ color: (status.incomePerSec ?? 0) > 0 ? "#00ff00" : "#666", fontWeight: "bold" }}>
                {status.incomePerSecFormatted}
              </span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Running Threads</span>
              <span style={styles.statValue}>{status.totalThreads}</span>
            </div>
          </div>
          <div style={styles.card}>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Active Batches</span>
              <span style={styles.statHighlight}>{status.totalBatchesActive}</span>
            </div>
            <div style={styles.stat}>
              <span style={{ color: "#00ff00" }}>Landed</span>
              <span style={styles.statValue}>{status.totalBatchesLanded}</span>
            </div>
            <div style={styles.stat}>
              <span style={{ color: "#ff4444" }}>Failed</span>
              <span style={styles.statValue}>{status.totalBatchesFailed}</span>
            </div>
          </div>
        </div>

        {/* Phase Counts */}
        <div style={styles.card}>
          <div style={styles.stat}>
            <span style={{ color: PHASE_COLORS.prep }}>Prepping</span>
            <span style={styles.statValue}>{status.preppingCount}</span>
          </div>
          <div style={styles.stat}>
            <span style={{ color: PHASE_COLORS.batch }}>Batching</span>
            <span style={styles.statValue}>{status.batchingCount}</span>
          </div>
          <div style={styles.stat}>
            <span style={{ color: "#ff4444" }}>Desyncs</span>
            <span style={styles.statValue}>{status.totalDesyncCount}</span>
          </div>
        </div>

        {/* Batch Target Table */}
        {status.batchTargets && status.batchTargets.length > 0 && (
          <div style={styles.section}>
            <div style={styles.sectionTitle}>
              TARGETS BY SCORE
              <span style={{ ...styles.dim, marginLeft: "8px", fontWeight: "normal" }}>
                {status.batchTargets.length} targets
              </span>
            </div>
            <div style={{ maxHeight: "300px", overflowY: "auto" }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.tableHeader, width: "24px" }} title="Rank by profitability score">#</th>
                    <th style={styles.tableHeader} title="Target server hostname">Target</th>
                    <th style={{ ...styles.tableHeader, width: "55px" }} title="Current phase: Prep (weakening/growing to ideal state), Batch (running HWGW batches), or Desync-Recovery">Phase</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "40px" }} title="Active batches / max batches allowed">B</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "40px" }} title="Hack percentage per batch (how much money stolen)">H%</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "50px" }} title="Current money as % of maximum">Money</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "50px" }} title="Security level above minimum (+0 is ideal)">Sec</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "55px" }} title="Estimated time until next batch completes">ETA</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "35px" }} title="Total batches landed successfully">L</th>
                    <th style={{ ...styles.tableHeader, textAlign: "right", width: "30px" }} title="Total batches failed (desync)">F</th>
                  </tr>
                </thead>
                <tbody>
                  {status.batchTargets.map((bt, i) => {
                    const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                    const phaseColor = PHASE_COLORS[bt.phase] || "#888";

                    return (
                      <tr key={bt.hostname} style={rowStyle}>
                        <td style={{ ...styles.tableCell, color: "#888" }}>{bt.rank}</td>
                        <td style={{ ...styles.tableCell, color: "#00ffff" }}>
                          {bt.hostname.substring(0, 16)}
                        </td>
                        <td style={{ ...styles.tableCell, color: phaseColor, fontSize: "10px" }}>
                          {bt.phase === "prep"
                            ? `PREP ${(bt.prepProgress * 100).toFixed(0)}%`
                            : bt.phase.toUpperCase()}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right" }}>
                          {bt.activeBatches}/{bt.maxBatches}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right" }}>
                          {(bt.hackPercent * 100).toFixed(0)}%
                        </td>
                        <td style={{
                          ...styles.tableCell,
                          textAlign: "right",
                          color: getMoneyColor(bt.moneyPercent),
                        }}>
                          {bt.moneyPercent.toFixed(0)}%
                        </td>
                        <td style={{
                          ...styles.tableCell,
                          textAlign: "right",
                          color: getSecurityColor(bt.securityClean, bt.securityDelta),
                        }}>
                          {bt.securityDelta}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right", color: "#888" }}>
                          {bt.eta}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right", color: "#00ff00" }}>
                          {bt.totalLanded}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right", color: bt.totalFailed > 0 ? "#ff4444" : "#666" }}>
                          {bt.totalFailed}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={styles.legend}>
          <div style={styles.legendItem}>
            <div style={{ ...styles.legendSwatch, backgroundColor: PHASE_COLORS.prep }} />
            <span>Prep</span>
          </div>
          <div style={styles.legendItem}>
            <div style={{ ...styles.legendSwatch, backgroundColor: PHASE_COLORS.batch }} />
            <span>Batch</span>
          </div>
          <div style={styles.legendItem}>
            <div style={{ ...styles.legendSwatch, backgroundColor: "#ff4444" }} />
            <span>Desync</span>
          </div>
        </div>
      </div>
    );
  }

  // === LEGACY MODE DETAIL PANEL ===
  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span>
            <span style={styles.statLabel}>RAM: </span>
            <span style={styles.statValue}>{status.totalRam}</span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Servers: </span>
            <span style={styles.statValue}>{status.serverCount}</span>
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Controls */}
      <HackControls running={running} sharePercent={status.sharePercent} />

      {/* Expected Money Display */}
      <div style={styles.card}>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Expected Income (per cycle)</span>
          <span style={{ color: status.totalExpectedMoney > 0 ? "#00ff00" : "#666", fontWeight: "bold" }}>
            {status.totalExpectedMoneyFormatted}
          </span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Running Threads</span>
          <span style={styles.statValue}>{status.totalThreads}</span>
        </div>
      </div>

      {/* Action Breakdown */}
      <div style={styles.grid}>
        <div style={styles.card}>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Active Targets</span>
            <span style={styles.statHighlight}>{status.activeTargets}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Next Completion</span>
            <span style={styles.etaDisplay}>{status.shortestWait}</span>
          </div>
        </div>
        <div style={styles.card}>
          <div style={styles.stat}>
            <span style={{ color: ACTION_COLORS.hack }}>HACK</span>
            <span style={styles.statValue}>{status.hackingCount}</span>
          </div>
          <div style={styles.stat}>
            <span style={{ color: ACTION_COLORS.grow }}>GROW</span>
            <span style={styles.statValue}>{status.growingCount}</span>
          </div>
          <div style={styles.stat}>
            <span style={{ color: ACTION_COLORS.weaken }}>WEAKEN</span>
            <span style={styles.statValue}>{status.weakeningCount}</span>
          </div>
        </div>
      </div>

      {/* Target Table */}
      {status.targets.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            TARGETS BY VALUE
            <span style={{ ...styles.dim, marginLeft: "8px", fontWeight: "normal" }}>
              {status.activeTargets} active | {status.totalTargets} total
            </span>
          </div>
          <div style={{ maxHeight: "300px", overflowY: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={{ ...styles.tableHeader, width: "24px" }} title="Rank by target value">#</th>
                  <th style={styles.tableHeader} title="Target server hostname">Target</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right", width: "45px", color: ACTION_COLORS.hack }} title="Active hack threads">H</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right", width: "45px", color: ACTION_COLORS.grow }} title="Active grow threads">G</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right", width: "45px", color: ACTION_COLORS.weaken }} title="Active weaken threads">W</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right", width: "80px" }} title="Expected money from current hack threads">Expected</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right", width: "60px" }} title="Current money as % of maximum">Money</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right", width: "50px" }} title="Security level above minimum (+0 is ideal)">Sec</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right", width: "55px" }} title="Time until current operation completes">ETA</th>
                </tr>
              </thead>
              <tbody>
                {status.targets.map((target, i) => {
                  const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                  const hasJobs = target.totalThreads > 0;

                  return (
                    <tr key={target.hostname} style={rowStyle}>
                      <td style={{ ...styles.tableCell, color: "#888" }}>{target.rank}</td>
                      <td style={{ ...styles.tableCell, color: hasJobs ? "#00ffff" : "#666" }}>
                        {target.hostname.substring(0, 16)}
                      </td>
                      <td style={{
                        ...styles.tableCell,
                        textAlign: "right",
                        color: target.hackThreads > 0 ? ACTION_COLORS.hack : "#666",
                      }}>
                        {target.hackThreads > 0 ? target.hackThreads.toLocaleString() : "-"}
                      </td>
                      <td style={{
                        ...styles.tableCell,
                        textAlign: "right",
                        color: target.growThreads > 0 ? ACTION_COLORS.grow : "#666",
                      }}>
                        {target.growThreads > 0 ? target.growThreads.toLocaleString() : "-"}
                      </td>
                      <td style={{
                        ...styles.tableCell,
                        textAlign: "right",
                        color: target.weakenThreads > 0 ? ACTION_COLORS.weaken : "#666",
                      }}>
                        {target.weakenThreads > 0 ? target.weakenThreads.toLocaleString() : "-"}
                      </td>
                      <td style={{
                        ...styles.tableCell,
                        textAlign: "right",
                        color: target.expectedMoney > 0 ? "#00ff00" : "#666",
                      }}>
                        {target.expectedMoneyFormatted}
                      </td>
                      <td style={{
                        ...styles.tableCell,
                        textAlign: "right",
                        color: getMoneyColor(target.moneyPercent),
                      }}>
                        {target.moneyPercent.toFixed(0)}%
                      </td>
                      <td style={{
                        ...styles.tableCell,
                        textAlign: "right",
                        color: getSecurityColor(target.securityClean, target.securityDelta),
                      }}>
                        {target.securityDelta}
                      </td>
                      <td style={{ ...styles.tableCell, textAlign: "right", color: "#888" }}>
                        {target.completionEta || target.eta}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={styles.legend}>
        <div style={styles.legendItem}>
          <div style={{ ...styles.legendSwatch, backgroundColor: ACTION_COLORS.hack }} />
          <span>Hack</span>
        </div>
        <div style={styles.legendItem}>
          <div style={{ ...styles.legendSwatch, backgroundColor: ACTION_COLORS.grow }} />
          <span>Grow</span>
        </div>
        <div style={styles.legendItem}>
          <div style={{ ...styles.legendSwatch, backgroundColor: ACTION_COLORS.weaken }} />
          <span>Weaken</span>
        </div>
        {status.needHigherLevel && (
          <div style={{ ...styles.legendItem, marginLeft: "auto" }}>
            <span style={{ color: "#ffaa00" }}>
              {status.needHigherLevel.count} need higher hack (next: {status.needHigherLevel.nextLevel})
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// === PLUGIN EXPORT ===

export const hackPlugin: ToolPlugin<FormattedHackStatus> = {
  name: "HACK",
  id: "hack",
  script: "daemons/hack.js",
  getFormattedStatus: formatHackStatus,
  OverviewCard: HackOverviewCard,
  DetailPanel: HackDetailPanel,
};
