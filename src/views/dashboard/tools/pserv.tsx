/**
 * Pserv Tool Plugin
 *
 * Displays purchased server status with 5x5 visual grid.
 */
import React from "lib/react";
import { NS } from "@ns";
import { ToolPlugin, FormattedPservStatus, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { togglePservAutoBuy, setPservMaxRam } from "views/dashboard/state-store";
import { getPservStatus } from "/controllers/pserv";

// === STATUS FORMATTING ===

function formatPservStatus(ns: NS): FormattedPservStatus {
  const raw = getPservStatus(ns);

  // Calculate maxed count
  const servers = raw.servers.map(hostname => {
    const ram = ns.getServerMaxRam(hostname);
    return {
      hostname,
      ram,
      ramFormatted: ns.format.ram(ram),
    };
  });

  const maxedCount = servers.filter(s => s.ram >= raw.maxPossibleRam).length;
  const upgradeProgress = raw.serverCount > 0
    ? `${maxedCount}/${raw.serverCount} at max`
    : "No servers";

  // Calculate next upgrade info
  let nextUpgrade: FormattedPservStatus["nextUpgrade"] = null;
  if (!raw.allMaxed && raw.serverCount > 0) {
    // Find smallest server
    const smallest = servers.reduce((min, s) => s.ram < min.ram ? s : min);
    if (smallest.ram < raw.maxPossibleRam) {
      const nextRam = smallest.ram * 2;
      const cost = ns.cloud.getServerUpgradeCost(smallest.hostname, nextRam);
      const playerMoney = ns.getServerMoneyAvailable("home");
      nextUpgrade = {
        hostname: smallest.hostname,
        currentRam: ns.format.ram(smallest.ram),
        nextRam: ns.format.ram(nextRam),
        cost,
        costFormatted: ns.format.number(cost),
        canAfford: playerMoney >= cost,
      };
    }
  }

  return {
    serverCount: raw.serverCount,
    serverCap: raw.serverCap,
    totalRam: ns.format.ram(raw.totalRam),
    minRam: ns.format.ram(raw.minRam),
    maxRam: ns.format.ram(raw.maxRam),
    maxPossibleRam: ns.format.ram(raw.maxPossibleRam),
    allMaxed: raw.allMaxed,
    autoBuy: true,
    maxPossibleRamNum: raw.maxPossibleRam,
    maxRamCap: 0,
    maxRamCapFormatted: "Game Max",
    effectiveMaxRam: raw.maxPossibleRam,
    servers,
    upgradeProgress,
    nextUpgrade,
  };
}

const controlSelectStyle: React.CSSProperties = {
  backgroundColor: "#1a1a1a",
  color: "#00ff00",
  border: "1px solid #333",
  borderRadius: "3px",
  padding: "1px 4px",
  fontSize: "10px",
  fontFamily: "inherit",
  cursor: "pointer",
};

function generateRamOptions(gameMax: number): number[] {
  const options: number[] = [];
  for (let ram = 8; ram <= gameMax; ram *= 2) {
    options.push(ram);
  }
  return options;
}

// === COMPONENTS ===

function PservOverviewCard({ status, running, toolId, pid }: OverviewCardProps<FormattedPservStatus>): React.ReactElement {
  const completed = !!(status?.allMaxed && status.serverCount >= status.serverCap);
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>PSERV</span>
        <ToolControl tool={toolId} running={running} completed={completed} pid={pid} />
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Servers</span>
        <span style={styles.statHighlight}>
          {status ? `${status.serverCount}/${status.serverCap}` : "—"}
        </span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Total RAM</span>
        <span style={styles.statValue}>{status?.totalRam ?? "—"}</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Status</span>
        <span style={status?.allMaxed ? styles.statHighlight : styles.statValue}>
          {status ? (status.allMaxed ? "ALL MAXED" : status.upgradeProgress) : "—"}
          {status && !status.autoBuy && (
            <span style={{ color: "#ff8800", marginLeft: "6px", fontSize: "10px" }}>MONITOR</span>
          )}
        </span>
      </div>
    </div>
  );
}

interface ServerCellProps {
  server: { hostname: string; ram: number; ramFormatted: string } | null;
  maxRam: number;
  index: number;
}

/**
 * Format RAM in a compact way for display in cells
 */
function formatCompactRam(ram: number): string {
  if (ram >= 1024 * 1024) return `${Math.round(ram / (1024 * 1024))}P`;
  if (ram >= 1024) return `${Math.round(ram / 1024)}T`;
  return `${ram}G`;
}

function ServerCell({ server, maxRam, index }: ServerCellProps): React.ReactElement {
  if (!server) {
    return (
      <div
        style={{ ...styles.serverCell, ...styles.serverCellEmpty }}
        title={`Slot ${index + 1}: Empty`}
      >
        <span style={styles.dim}>-</span>
      </div>
    );
  }

  // Calculate fill percentage using log scale
  const fillPercent = Math.round((Math.log2(server.ram) / Math.log2(maxRam)) * 100);
  const isMaxed = server.ram >= maxRam;
  const compactRam = formatCompactRam(server.ram);

  return (
    <div
      style={styles.serverCell}
      title={`${server.hostname}: ${server.ramFormatted}`}
    >
      {/* Fill bar from bottom */}
      <div style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: `${fillPercent}%`,
        backgroundColor: isMaxed ? "#00aa00" : "#006600",
      }} />
      {/* RAM text or star for maxed servers */}
      <span style={{
        position: "relative",
        zIndex: 1,
        fontSize: "9px",
        fontWeight: "bold",
        textShadow: "0 0 3px #000, 0 0 3px #000",
      }}>
        {isMaxed ? "★" : compactRam}
      </span>
    </div>
  );
}

function PservDetailPanel({ status, running, toolId, pid }: DetailPanelProps<FormattedPservStatus>): React.ReactElement {
  const completed = !!(status?.allMaxed && status.serverCount >= status.serverCap);
  // Create 25 slots (5x5 grid)
  const slots: (FormattedPservStatus["servers"][0] | null)[] = [];
  for (let i = 0; i < 25; i++) {
    slots.push(status?.servers[i] ?? null);
  }

  return (
    <div style={styles.panel}>
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span>
            <span style={styles.statLabel}>Servers: </span>
            <span style={styles.statHighlight}>
              {status ? `${status.serverCount}/${status.serverCap}` : "—"}
            </span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Total RAM: </span>
            <span style={styles.statHighlight}>{status?.totalRam ?? "—"}</span>
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {status && (
            <button
              style={{
                backgroundColor: "#1a1a1a",
                color: status.autoBuy ? "#00ff00" : "#ff8800",
                border: `1px solid ${status.autoBuy ? "#00ff00" : "#ff8800"}`,
                borderRadius: "3px",
                padding: "1px 6px",
                fontSize: "10px",
                fontFamily: "inherit",
                cursor: "pointer",
              }}
              onClick={() => togglePservAutoBuy(!status.autoBuy)}
            >
              {status.autoBuy ? "AUTO" : "MONITOR"}
            </button>
          )}
          {status && (
            <select
              style={controlSelectStyle}
              value={status.maxRamCap}
              onChange={(e) => setPservMaxRam(parseInt((e.target as HTMLSelectElement).value, 10))}
            >
              <option value={0}>Cap: Max</option>
              {generateRamOptions(status.maxPossibleRamNum).map(ram => (
                <option key={ram} value={ram}>Cap: {formatCompactRam(ram)}</option>
              ))}
            </select>
          )}
          <ToolControl tool={toolId} running={running} completed={completed} pid={pid} />
        </div>
      </div>

      {/* 5x5 Server Grid */}
      <div style={styles.serverGrid}>
        {slots.map((server, i) => (
          <ServerCell
            key={i}
            server={server}
            maxRam={status?.effectiveMaxRam ?? 1048576}
            index={i}
          />
        ))}
      </div>

      {/* Legend */}
      <div style={styles.legend}>
        <div style={styles.legendItem}>
          <div style={{ ...styles.legendSwatch, backgroundColor: "#1a1a1a" }} />
          <span>Empty</span>
        </div>
        <div style={styles.legendItem}>
          <div style={{
            ...styles.legendSwatch,
            background: "linear-gradient(to top, #006600 50%, #1a1a1a 50%)"
          }} />
          <span>Partial</span>
        </div>
        <div style={styles.legendItem}>
          <div style={{ ...styles.legendSwatch, backgroundColor: "#00aa00" }} />
          <span>Max ★</span>
        </div>
      </div>

      {/* Stats Cards */}
      <div style={{ ...styles.grid, marginTop: "12px" }}>
        <div style={styles.card}>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Min RAM</span>
            <span style={styles.statValue}>{status?.minRam ?? "—"}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Max RAM</span>
            <span style={styles.statValue}>{status?.maxRam ?? "—"}</span>
          </div>
        </div>
        <div style={styles.card}>
          <div style={styles.stat}>
            <span style={styles.statLabel}>{status?.maxRamCap ? "RAM Cap" : "Max Possible"}</span>
            <span style={styles.statValue}>
              {status ? (status.maxRamCap > 0 ? status.maxRamCapFormatted : status.maxPossibleRam) : "—"}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Status</span>
            <span style={status?.allMaxed ? styles.statHighlight : styles.statValue}>
              {status ? (status.allMaxed ? "ALL MAXED" : status.upgradeProgress) : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Next Upgrade Info */}
      {status?.nextUpgrade && (
        <div style={styles.card}>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Next Upgrade</span>
            <span style={styles.statValue}>
              {status.nextUpgrade.hostname}: {status.nextUpgrade.currentRam} → {status.nextUpgrade.nextRam}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Cost</span>
            <span style={status.nextUpgrade.canAfford ? styles.statHighlight : { color: "#ff4444" }}>
              {status.nextUpgrade.canAfford ? "✓" : "✗"} ${status.nextUpgrade.costFormatted}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// === PLUGIN EXPORT ===

export const pservPlugin: ToolPlugin<FormattedPservStatus> = {
  name: "PSERV",
  id: "pserv",
  script: "daemons/pserv.js",
  getFormattedStatus: formatPservStatus,
  OverviewCard: PservOverviewCard,
  DetailPanel: PservDetailPanel,
};
