/**
 * Home Server Tool Plugin
 *
 * OverviewCard shows RAM, cores, auto-buy status.
 * DetailPanel shows upgrade costs, auto-buy toggle, purchase history.
 */
import React from "lib/react";
import {
  ToolPlugin,
  FormattedHomeStatus,
  OverviewCardProps,
  DetailPanelProps,
} from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { TierFooter } from "views/dashboard/components/TierFooter";
import { toggleHomeAutoBuy } from "views/dashboard/state-store";

// === OVERVIEW CARD ===

function HomeOverviewCard({
  status,
  running,
  toolId,
  pid,
}: OverviewCardProps<FormattedHomeStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>HOME</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      {status ? (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>RAM</span>
            <span style={styles.statValue}>{status.currentRamFormatted}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Cores</span>
            <span style={styles.statValue}>{status.currentCores}/{status.maxCores}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Mode</span>
            {status.allMaxed ? (
              <span style={{ color: "#00ff00" }}>ALL MAXED</span>
            ) : (
              <span style={{ color: status.autoBuy ? "#00ff00" : "#ff8800" }}>
                {status.autoBuy ? "AUTO" : "MONITOR"}
              </span>
            )}
          </div>
        </>
      ) : (
        <div style={styles.stat}>
          <span style={styles.statLabel}>Status</span>
          <span style={styles.dim}>{running ? "Starting..." : "Stopped"}</span>
        </div>
      )}
    </div>
  );
}

// === DETAIL PANEL ===

function HomeDetailPanel({
  status,
  running,
  toolId,
  pid,
}: DetailPanelProps<FormattedHomeStatus>): React.ReactElement {
  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={styles.statLabel}>Home Server</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        <div style={{ marginTop: "12px", color: "#ffaa00" }}>
          {running ? "Waiting for first update..." : "Home daemon not running."}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>Home Server</span>
          {status.allMaxed && (
            <>
              <span style={styles.dim}>|</span>
              <span style={{ color: "#00ff00" }}>ALL MAXED</span>
            </>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {!status.allMaxed && (
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
              onClick={() => { if (running) toggleHomeAutoBuy(!status.autoBuy); }}
            >
              {status.autoBuy ? "AUTO" : "MONITOR"}
            </button>
          )}
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
      </div>

      {/* RAM Info */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>RAM</div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Current</span>
          <span style={styles.statValue}>{status.currentRamFormatted}</span>
        </div>
        {status.ramAtMax ? (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Status</span>
            <span style={{ color: "#00ff00" }}>MAXED</span>
          </div>
        ) : (
          <>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Next Upgrade</span>
              <span style={styles.statValue}>
                {status.ramUpgradeTargetFormatted}
              </span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>Cost</span>
              <span style={{ color: "#ffaa00" }}>{status.ramUpgradeCostFormatted}</span>
            </div>
          </>
        )}
      </div>

      {/* Cores Info */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>CORES</div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Current</span>
          <span style={styles.statValue}>{status.currentCores} / {status.maxCores}</span>
        </div>
        {status.coresAtMax ? (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Status</span>
            <span style={{ color: "#00ff00" }}>MAXED</span>
          </div>
        ) : (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Upgrade Cost</span>
            <span style={{ color: "#ffaa00" }}>{status.coreUpgradeCostFormatted}</span>
          </div>
        )}
      </div>

      {/* Purchase History */}
      {status.totalSpent > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>PURCHASES</div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>RAM Upgrades</span>
            <span style={styles.statValue}>{status.ramUpgradesBought}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Core Upgrades</span>
            <span style={styles.statValue}>{status.coreUpgradesBought}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Total Spent</span>
            <span style={{ color: "#ff8800" }}>{status.totalSpentFormatted}</span>
          </div>
        </div>
      )}

      {/* Tier Footer */}
      <TierFooter
        tier={status.tier}
        tierName={status.tierName}
        currentRamUsage={status.currentRamUsage}
        nextTierRam={status.nextTierRam}
        canUpgrade={status.canUpgrade}
      />
    </div>
  );
}

// === PLUGIN EXPORT ===

export const homePlugin: ToolPlugin<FormattedHomeStatus> = {
  name: "HOME",
  id: "home",
  script: "daemons/home.js",
  OverviewCard: HomeOverviewCard,
  DetailPanel: HomeDetailPanel,
};
