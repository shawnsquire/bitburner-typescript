/**
 * Darknet Tool Plugin
 *
 * Displays darknet swarm cracker status: agent counts, the depth ladder,
 * stasis links, lab progress, income and the config editor.
 */
import React from "lib/react";
import { ToolPlugin, FormattedDarknetStatus, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { DarknetCell, DarknetCellState } from "/types/ports";
import { sendDarknetSetConfig, sendDarknetStasis, sendDarknetStorm } from "views/dashboard/state-store";

// === HELPERS ===

function formatMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}b`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

const STATE_COLORS: Record<DarknetCellState, string> = {
  unknown: "#1a1a1a",
  frontier: "#665500",
  cracking: "#0055aa",
  admin: "#006600",
  agent: "#00aaaa",
  anchor: "#aa00aa",
  offline: "#550000",
};

// 11 keys from docs/design/2026-09-19-darknet.md section 8 / /config/darknet.txt.
const CONFIG_KEYS = [
  "heartbleed",
  "harvest",
  "phish",
  "phishMaxThreads",
  "harvestKarmaFloor",
  "stasisMode",
  "storm",
  "lab",
  "gapPatienceMs",
  "agentIntervalMs",
  "maxAttempts",
];

// === STYLES ===

const pinButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: "1px",
  right: "1px",
  width: "11px",
  height: "11px",
  lineHeight: "9px",
  padding: 0,
  border: "none",
  borderRadius: "2px",
  fontSize: "8px",
  backgroundColor: "rgba(0,0,0,0.45)",
  color: "#fff",
  cursor: "pointer",
};

const stormButtonStyle: React.CSSProperties = {
  backgroundColor: "#440022",
  color: "#ff44aa",
  border: "1px solid #880044",
  borderRadius: "3px",
  padding: "3px 10px",
  fontSize: "11px",
  fontFamily: "inherit",
  cursor: "pointer",
};

const configInputStyle: React.CSSProperties = {
  backgroundColor: "#1a1a1a",
  color: "#00ff00",
  border: "1px solid #333",
  borderRadius: "3px",
  padding: "1px 4px",
  fontSize: "11px",
  fontFamily: "inherit",
  width: "110px",
  textAlign: "right",
};

// === COMPONENTS ===

function DarknetOverviewCard({ status, running, toolId, error, pid }: OverviewCardProps<FormattedDarknetStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>DARKNET</span>
        <ToolControl tool={toolId} running={running} error={!!error} pid={pid} />
      </div>
      {error ? (
        <div style={{ color: "#ffaa00", fontSize: "11px" }}>{error}</div>
      ) : !status ? (
        <div style={{ color: "#888" }}>Waiting for status...</div>
      ) : status.access === "none" ? (
        <div style={{ color: "#ffaa00", fontSize: "11px" }}>Need DarkscapeNavigator.exe</div>
      ) : (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Agents</span>
            <span style={status.counts.agents > 0 ? styles.statHighlight : styles.statValue}>
              {status.counts.agents}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Admin</span>
            <span style={styles.statValue}>{status.counts.admin}/{status.counts.seen}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Deepest</span>
            <span style={styles.statValue}>{status.deepestAdmin}/{status.netDepth}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Timeout</span>
            <span style={status.instability.authenticationTimeoutChance > 0.1 ? { color: "#ff4444" } : styles.statValue}>
              {formatPct(status.instability.authenticationTimeoutChance)}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Cha gate</span>
            <span style={styles.statValue}>{status.charismaNeed ? status.charismaNeed.target : "—"}</span>
          </div>
        </>
      )}
    </div>
  );
}

interface DepthCellProps {
  cell: DarknetCell;
  isPinned: boolean;
}

function DepthCell({ cell, isPinned }: DepthCellProps): React.ReactElement {
  const bg = STATE_COLORS[cell.state] ?? STATE_COLORS.unknown;
  return (
    <div
      style={{
        ...styles.serverCell,
        backgroundColor: bg,
        border: isPinned ? "1px solid #fff" : styles.serverCell.border,
      }}
      title={`${cell.host}\n${cell.model} (diff ${cell.difficulty.toFixed(0)}, cha ${cell.cha})\n${cell.state}`}
    >
      <span style={{ fontSize: "8px", fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis" }}>
        {cell.host.slice(0, 4)}
      </span>
      <button
        style={pinButtonStyle}
        onClick={(e) => {
          e.stopPropagation();
          sendDarknetStasis(cell.host, !isPinned);
        }}
        title={isPinned ? "Unpin from stasis" : "Pin to stasis"}
      >
        {isPinned ? "●" : "○"}
      </button>
    </div>
  );
}

function ConfigInput({ configKey, value }: { configKey: string; value: string }): React.ReactElement {
  return (
    <div style={{ ...styles.stat, alignItems: "center" }}>
      <span style={styles.statLabel}>{configKey}</span>
      <input
        type="text"
        style={configInputStyle}
        defaultValue={value}
        key={value}
        onBlur={(e) => {
          const v = (e.target as HTMLInputElement).value;
          if (v !== value) sendDarknetSetConfig(configKey, v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = (e.target as HTMLInputElement).value;
            if (v !== value) sendDarknetSetConfig(configKey, v);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

function DarknetDetailPanel({ status, running, toolId, error, pid }: DetailPanelProps<FormattedDarknetStatus>): React.ReactElement {
  if (error) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft} />
          <ToolControl tool={toolId} running={running} error={true} pid={pid} />
        </div>
        <div style={{ color: "#ffaa00", marginTop: "12px" }}>{error}</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={{ color: "#888" }}>Waiting for status...</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
      </div>
    );
  }

  if (status.access === "none") {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={{ color: "#ffaa00" }}>Need DarkscapeNavigator.exe</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
      </div>
    );
  }

  const stasisHosts = new Set(status.stasis.hosts);

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span>
            <span style={styles.statLabel}>Access: </span>
            <span style={styles.statHighlight}>{status.access.toUpperCase()}</span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Heartbleed: </span>
            <span style={status.heartbleedAllowed ? styles.statHighlight : { color: "#ff4444" }}>
              {status.heartbleedAllowed ? "ALLOWED" : "BLOCKED"}
            </span>
            {status.heartbleedUsedThisNode && (
              <span style={{ color: "#ffaa00", marginLeft: "6px", fontSize: "10px" }}>used this node</span>
            )}
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Depth ladder */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>DEPTH LADDER</div>
        {status.map.rows.map((row, depth) => (
          <div
            key={depth}
            style={{ ...styles.serverGrid, gridTemplateColumns: `repeat(${Math.max(row.length, 1)}, 32px)` }}
          >
            {row.map(cell => (
              <DepthCell key={cell.host} cell={cell} isPinned={stasisHosts.has(cell.host)} />
            ))}
          </div>
        ))}
        <div style={styles.legend}>
          {(Object.keys(STATE_COLORS) as DarknetCellState[]).map(state => (
            <div key={state} style={styles.legendItem}>
              <div style={{ ...styles.legendSwatch, backgroundColor: STATE_COLORS[state] }} />
              <span>{state}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Stasis / lab / income / storm */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>STASIS</div>
        <div style={styles.card}>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Used</span>
            <span style={styles.statValue}>{status.stasis.used}/{status.stasis.limit}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Mode</span>
            <span style={styles.statValue}>{status.stasis.mode}</span>
          </div>
          <div style={{ ...styles.stat, alignItems: "flex-start" }}>
            <span style={styles.statLabel}>Linked</span>
            <span style={{ ...styles.statValue, textAlign: "right" }}>
              {status.stasis.hosts.length > 0 ? status.stasis.hosts.join(", ") : "—"}
            </span>
          </div>
        </div>

        <div style={styles.sectionTitle}>LAB</div>
        <div style={styles.card}>
          {status.lab ? (
            <>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Name</span>
                <span style={styles.statValue}>{status.lab.name}</span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Cha</span>
                <span style={styles.statValue}>{status.lab.cha}</span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Cleared</span>
                <span style={status.lab.cleared ? styles.statHighlight : styles.statValue}>
                  {status.lab.cleared ? "YES" : "NO"}
                </span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Moves</span>
                <span style={styles.statValue}>{status.lab.moves}</span>
              </div>
            </>
          ) : (
            <div style={{ color: "#888" }}>—</div>
          )}
        </div>

        <div style={styles.sectionTitle}>INCOME</div>
        <div style={styles.card}>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Per hour</span>
            <span style={styles.statHighlight}>{formatMoney(status.income.moneyPerHour)}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Caches opened</span>
            <span style={styles.statValue}>{status.income.cachesOpened}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Contracts found</span>
            <span style={styles.statValue}>{status.income.contractsFound}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Augs awarded</span>
            <span style={styles.statValue}>{status.income.augsAwarded}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
          {status.stormSeedHost && (
            <button style={stormButtonStyle} onClick={() => sendDarknetStorm()}>Trigger Storm</button>
          )}
          {status.stuck && <span style={{ color: "#ff4444", fontSize: "11px" }}>STUCK</span>}
        </div>
      </div>

      {/* Config editor */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>CONFIG</div>
        {CONFIG_KEYS.map(key => (
          <ConfigInput key={key} configKey={key} value={status.config[key] ?? ""} />
        ))}
      </div>
    </div>
  );
}

// === PLUGIN EXPORT ===

export const darknetPlugin: ToolPlugin<FormattedDarknetStatus> = {
  name: "DARKNET",
  id: "darknet",
  script: "daemons/darknet.js",
  OverviewCard: DarknetOverviewCard,
  DetailPanel: DarknetDetailPanel,
};
