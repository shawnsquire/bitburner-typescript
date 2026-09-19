/**
 * Casino Tool Plugin
 *
 * Simple launcher panel with two buttons:
 * 1. Travel to Aevum (casino city)
 * 2. Start blackjack automation
 */
import React from "lib/react";
import { ToolPlugin, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { CasinoStatus } from "/types/ports";
import { runScript } from "views/dashboard/state-store";

// === BUTTON STYLE ===

const actionButtonStyle: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #00ff00",
  color: "#00ff00",
  cursor: "pointer",
  padding: "8px 16px",
  fontSize: "13px",
  fontFamily: "inherit",
  borderRadius: "3px",
  width: "100%",
};

// === OVERVIEW CARD ===

function CasinoOverviewCard({ running, toolId, pid }: OverviewCardProps<CasinoStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>CASINO</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Status</span>
        <span style={running ? styles.statHighlight : styles.statValue}>
          {running ? "Running" : "Idle"}
        </span>
      </div>
    </div>
  );
}

// === DETAIL PANEL ===

function CasinoDetailPanel({ running, toolId, pid }: DetailPanelProps<CasinoStatus>): React.ReactElement {
  return (
    <div style={styles.panel}>
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>Casino</span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
        <button
          style={actionButtonStyle}
          onClick={() => runScript("casino", "actions/travel-to-casino.js")}
        >
          Travel to Aevum
        </button>
        <button
          style={{ ...actionButtonStyle, borderColor: "#ffff00", color: "#ffff00" }}
          onClick={() => runScript("casino", "casino.js")}
        >
          Start Blackjack
        </button>
      </div>
    </div>
  );
}

// === PLUGIN EXPORT ===

export const casinoPlugin: ToolPlugin<CasinoStatus> = {
  name: "CASINO",
  id: "casino",
  script: "casino.js",
  OverviewCard: CasinoOverviewCard,
  DetailPanel: CasinoDetailPanel,
};
