/**
 * Share Tool Plugin
 *
 * Displays share power status and thread distribution.
 */
import React from "lib/react";
import { ToolPlugin, FormattedShareStatus, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import {
  restartShareDaemon,
  getPluginUIState,
  setPluginUIState,
  getFleetAllocation,
} from "views/dashboard/state-store";

// === RAM FORMATTING ===

function formatRam(gb: number): string {
  if (gb >= 1e6) return `${(gb / 1e6).toFixed(1)}PB`;
  if (gb >= 1e3) return `${(gb / 1e3).toFixed(1)}TB`;
  return `${gb.toFixed(0)}GB`;
}

// === COMPONENTS ===

function ShareOverviewCard({ status, running, toolId, pid }: OverviewCardProps<FormattedShareStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>SHARE</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Threads</span>
        <span style={styles.statHighlight}>
          {status?.totalThreads ?? "—"}
          {status?.cycleStatus === "cycle" && (
            <span style={{ color: "#ffaa00", marginLeft: "4px" }}>(cycle)</span>
          )}
          {status?.cycleStatus === "paused" && (
            <span style={{ color: "#ffaa00", marginLeft: "4px" }}>(paused)</span>
          )}
        </span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Share Power</span>
        <span style={styles.statValue}>{status?.sharePower ?? "—"}</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Servers</span>
        <span style={styles.statValue}>{status?.serversWithShare ?? "—"}</span>
      </div>
    </div>
  );
}

function ShareDetailPanel({ status, running, toolId, pid }: DetailPanelProps<FormattedShareStatus>): React.ReactElement {
  const targetPercent = getPluginUIState<number>("share", "targetPercent", 0);
  const alloc = getFleetAllocation();

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

  const applyTargetPercent = () => {
    if (running) {
      restartShareDaemon(targetPercent);
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span>
            <span style={styles.statLabel}>Threads: </span>
            <span style={styles.statHighlight}>
              {status?.totalThreads ?? "—"}
              {status?.cycleStatus === "cycle" && (
                <span style={{ color: "#ffaa00", marginLeft: "4px" }}>(cycle)</span>
              )}
              {status?.cycleStatus === "paused" && (
                <span style={{ color: "#ffaa00", marginLeft: "4px" }}>(paused)</span>
              )}
            </span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Share Power: </span>
            <span style={styles.statHighlight}>{status?.sharePower ?? "—"}</span>
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Paused Banner */}
      {status?.cycleStatus === "paused" && (
        <div style={{ padding: "6px 8px", marginBottom: "6px", backgroundColor: "#2a1f00", borderRadius: "3px", border: "1px solid #ffaa00" }}>
          <div style={{ color: "#ffaa00", fontWeight: "bold", fontSize: "12px" }}>PAUSED — Waiting for Rep Focus</div>
          <div style={{ color: "#888", fontSize: "11px", marginTop: "2px" }}>Share activates automatically when Rep daemon claims focus.</div>
        </div>
      )}

      {/* Target % Control */}
      <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "6px", padding: "4px 6px", backgroundColor: "#111", borderRadius: "3px", border: "1px solid #222" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ ...styles.statLabel, fontSize: "11px" }} title="% of fleet RAM capacity to allocate to share (0 = greedy/all available)">Target %</span>
          <input
            type="number"
            min={0}
            max={100}
            style={controlInputStyle}
            value={targetPercent}
            onChange={(e) => {
              const val = Math.max(0, Math.min(100, parseInt((e.target as HTMLInputElement).value) || 0));
              setPluginUIState("share", "targetPercent", val);
            }}
            onBlur={applyTargetPercent}
            onKeyDown={(e) => {
              if ((e as unknown as KeyboardEvent).key === "Enter") applyTargetPercent();
            }}
          />
        </span>
        <span style={{ ...styles.dim, fontSize: "11px" }}>
          {targetPercent === 0 ? "(greedy — uses all spare RAM)" : `(hack auto-yields ${targetPercent}% RAM)`}
        </span>
      </div>

      {alloc && alloc.shareServers.length > 0 && (
        <div style={{ ...styles.card, borderColor: "#333" }}>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Fleet Allocation</span>
            <span style={{ color: "#00ffff", fontSize: "11px" }}>
              {alloc.shareServers.length} dedicated servers ({formatRam(alloc.shareFleetRam)})
            </span>
          </div>
          <div style={{ ...styles.dim, fontSize: "11px" }}>
            Assigned by hack daemon — share uses only these servers
          </div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Script RAM</span>
          <span style={styles.statValue}>{status?.shareRam ?? "—"}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Servers with share</span>
          <span style={styles.statValue}>{status?.serversWithShare ?? "—"}</span>
        </div>
      </div>

      {status?.serverStats && status.serverStats.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Top Servers by Threads</div>
          <ul style={styles.list}>
            {status.serverStats.slice(0, 10).map((s, i) => (
              <li key={i} style={styles.listItem}>
                <span style={{ color: "#fff" }}>{s.hostname.padEnd(20)}</span>
                <span style={styles.statHighlight}>{s.threads} threads</span>
              </li>
            ))}
            {status.serverStats.length > 10 && (
              <li style={{ ...styles.listItem, ...styles.dim }}>
                ... +{status.serverStats.length - 10} more
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// === PLUGIN EXPORT ===

export const sharePlugin: ToolPlugin<FormattedShareStatus> = {
  name: "SHARE",
  id: "share",
  script: "daemons/share.js",
  OverviewCard: ShareOverviewCard,
  DetailPanel: ShareDetailPanel,
};
