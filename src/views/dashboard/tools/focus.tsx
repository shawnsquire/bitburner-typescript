/**
 * Focus Tool Plugin
 *
 * OverviewCard shows active focus holder, sleeve assignment, Simulacrum status.
 * DetailPanel provides dropdowns to change focus holder and sleeve assignments.
 * FocusStickyHeader is a compact version rendered above sub-tabs.
 */
import React from "lib/react";
import {
  ToolPlugin,
  OverviewCardProps,
  DetailPanelProps,
} from "views/dashboard/types";
import { FocusStatus, FocusDaemon } from "/types/ports";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { claimFocus, claimSleeveFocus } from "views/dashboard/state-store";

type FormattedFocusStatus = FocusStatus;

const selectStyle: React.CSSProperties = {
  backgroundColor: "#1a1a1a",
  color: "#00ff00",
  border: "1px solid #333",
  padding: "3px 8px",
  fontSize: "12px",
  fontFamily: "inherit",
  borderRadius: "3px",
  cursor: "pointer",
};

const sleeveSelectStyle: React.CSSProperties = {
  ...selectStyle,
  color: "#44ccff",
};

const ALL_DAEMONS: { value: FocusDaemon; label: string }[] = [
  { value: "work", label: "Work" },
  { value: "rep", label: "Rep" },
  { value: "blade", label: "Blade" },
];

// === OVERVIEW CARD ===

function FocusOverviewCard({
  status,
  running,
  toolId,
  pid,
}: OverviewCardProps<FormattedFocusStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>FOCUS</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      {status ? (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Active</span>
            <span style={{ color: status.holder === "none" ? "#ffaa00" : "#00ff00" }}>
              {status.holder === "none" ? "None" : status.holder.charAt(0).toUpperCase() + status.holder.slice(1)}
            </span>
          </div>
          {status.numSleeves > 0 && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Sleeve</span>
              <span style={{ color: "#44ccff" }}>
                {status.sleeves.length > 0
                  ? status.sleeves.map(s => s.daemon.charAt(0).toUpperCase() + s.daemon.slice(1)).join(", ")
                  : "None"}
              </span>
            </div>
          )}
          {status.simulacrum && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Simulacrum</span>
              <span style={{ color: "#cc66ff" }}>Active</span>
            </div>
          )}
        </>
      ) : (
        <div style={{ color: "#666", fontSize: "11px" }}>
          {running ? "Starting..." : "Stopped"}
        </div>
      )}
    </div>
  );
}

// === DETAIL PANEL ===

function FocusDetailPanel({
  status,
  running,
  toolId,
  pid,
}: DetailPanelProps<FormattedFocusStatus>): React.ReactElement {
  const handleHolderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    claimFocus(e.target.value as FocusDaemon);
  };

  const handleSleeveChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    claimSleeveFocus(e.target.value as FocusDaemon);
  };

  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <span style={styles.title}>Focus Control</span>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        <div style={styles.card}>
          <span style={{ color: "#666", fontSize: "11px" }}>
            {running ? "Waiting for first status..." : "Focus daemon not running"}
          </span>
        </div>
      </div>
    );
  }

  const currentSleeve = status.sleeves.length > 0 ? status.sleeves[0].daemon : "none";

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.title}>Focus Control</span>
          <span style={{ color: "#666", fontSize: "11px", marginLeft: "8px" }}>
            {status.runningDaemons.length} daemons active
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Primary Focus */}
      <div style={styles.card}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          marginBottom: "8px",
        }}>
          <span style={{ ...styles.statLabel, minWidth: "80px" }}>Active Focus</span>
          <select value={status.holder} onChange={handleHolderChange} style={selectStyle}>
            <option value="work">Work</option>
            <option value="rep">Rep</option>
            <option value="blade">Blade</option>
            <option value="none">None (all yield)</option>
          </select>
        </div>

        {/* Sleeve Assignment — auto-hidden when no sleeves */}
        {status.numSleeves > 0 && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            marginBottom: "8px",
          }}>
            <span style={{ ...styles.statLabel, minWidth: "80px", color: "#44ccff" }}>Sleeve #0</span>
            <select value={currentSleeve} onChange={handleSleeveChange} style={sleeveSelectStyle}>
              <option value="none">None</option>
              {ALL_DAEMONS
                .filter(d => d.value !== status.holder)
                .map(d => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
            </select>
          </div>
        )}
      </div>

      {/* Simulacrum Banner */}
      {status.simulacrum && (
        <div style={{
          backgroundColor: "rgba(204, 102, 255, 0.1)",
          border: "1px solid #cc66ff",
          borderRadius: "4px",
          padding: "8px 12px",
          marginBottom: "8px",
        }}>
          <span style={{ color: "#cc66ff", fontSize: "12px" }}>
            Simulacrum active — Blade is exempt from focus (auto-running)
          </span>
        </div>
      )}

      {/* Status Info */}
      <div style={styles.card}>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Running daemons</span>
          <span style={{ color: "#888", fontSize: "11px" }}>
            {status.runningDaemons.length > 0
              ? status.runningDaemons.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(", ")
              : "none"}
          </span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Boot default</span>
          <span style={{ color: "#666", fontSize: "11px" }}>
            {status.defaultHolder.charAt(0).toUpperCase() + status.defaultHolder.slice(1)}
          </span>
        </div>
        {status.numSleeves > 0 && (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Sleeves available</span>
            <span style={{ color: "#44ccff", fontSize: "11px" }}>{status.numSleeves}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// === STICKY HEADER (compact version for Focus group sub-tabs) ===

interface StickyHeaderProps {
  status: FocusStatus | null;
}

export function FocusStickyHeader({ status }: StickyHeaderProps): React.ReactElement {
  if (!status) {
    return <div />;
  }

  const handleHolderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    claimFocus(e.target.value as FocusDaemon);
  };

  const handleSleeveChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    claimSleeveFocus(e.target.value as FocusDaemon);
  };

  const currentSleeve = status.sleeves.length > 0 ? status.sleeves[0].daemon : "none";

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "4px 8px",
      marginBottom: "6px",
    }}>
      <span style={{ ...styles.statLabel, fontSize: "11px" }}>Active:</span>
      <select value={status.holder} onChange={handleHolderChange} style={selectStyle}>
        <option value="work">Work</option>
        <option value="rep">Rep</option>
        <option value="blade">Blade</option>
        <option value="none">None</option>
      </select>
      {status.numSleeves > 0 && (
        <>
          <span style={{ ...styles.statLabel, fontSize: "11px", color: "#44ccff" }}>Sleeve:</span>
          <select value={currentSleeve} onChange={handleSleeveChange} style={sleeveSelectStyle}>
            <option value="none">None</option>
            {ALL_DAEMONS
              .filter(d => d.value !== status.holder)
              .map(d => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
          </select>
        </>
      )}
      {status.simulacrum && (
        <span style={{ color: "#cc66ff", fontSize: "10px" }}>Simulacrum</span>
      )}
    </div>
  );
}

// === PLUGIN EXPORT ===

export const focusPlugin: ToolPlugin<FormattedFocusStatus> = {
  name: "FOCUS",
  id: "focus",
  script: "daemons/focus.js",
  OverviewCard: FocusOverviewCard,
  DetailPanel: FocusDetailPanel,
};
