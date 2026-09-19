/**
 * Hacknet Server Tool Plugin
 *
 * OverviewCard shows server count, hash rate, capacity.
 * DetailPanel shows per-server breakdown, upgrade costs, spending stats.
 */
import React from "lib/react";
import {
  ToolPlugin,
  OverviewCardProps,
  DetailPanelProps,
} from "views/dashboard/types";
import { HacknetStatus, HashSpendStrategy } from "/types/ports";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { TierFooter } from "views/dashboard/components/TierFooter";
import { setHacknetStrategy } from "views/dashboard/state-store";
import { formatTime } from "lib/utils";

// Re-export type alias for consistency
type FormattedHacknetStatus = HacknetStatus;

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

const STRATEGY_LABELS: Record<HashSpendStrategy, string> = {
  "money": "Sell for Money",
  "corp-funds": "Corporation Funds",
  "corp-research": "Corporation Research",
  "study": "Improve Studying",
  "gym": "Improve Gym Training",
  "bladeburner-rank": "Bladeburner Rank",
  "bladeburner-sp": "Bladeburner SP",
  "coding-contract": "Coding Contract",
  "reduce-security": "Reduce Min Security",
  "increase-money": "Increase Max Money",
  "company-favor": "Company Favor",
};

// === OVERVIEW CARD ===

function HacknetOverviewCard({
  status,
  running,
  toolId,
  pid,
}: OverviewCardProps<FormattedHacknetStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>HACKNET</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      {status ? (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Servers</span>
            <span style={styles.statValue}>{status.serverCount}/{status.maxServers}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Hash Rate</span>
            <span style={{ color: "#00ff00" }}>{status.totalHashRateFormatted}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Hashes</span>
            <span style={{ color: status.hashUtilization > 0.9 ? "#ff4444" : status.hashUtilization > 0.5 ? "#ffaa00" : "#00ff00" }}>
              {(status.hashUtilization * 100).toFixed(0)}%
            </span>
          </div>
          {status.moneyEarnedFromHashes > 0 && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Earned</span>
              <span style={{ color: "#00ff00" }}>${status.moneyEarnedFormatted}</span>
            </div>
          )}
          {status.nextTarget && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Next</span>
              <span style={{ color: status.nextTarget.canAfford ? "#00ff00" : "#ff4444" }}>
                {status.nextTarget.canAfford ? "\u2713" : "\u2717"} {status.nextTarget.costFormatted}
              </span>
            </div>
          )}
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

function HacknetDetailPanel({
  status,
  running,
  toolId,
  pid,
}: DetailPanelProps<FormattedHacknetStatus>): React.ReactElement {
  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={styles.statLabel}>Hacknet Servers</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        <div style={{ marginTop: "12px", color: "#ffaa00" }}>
          {running ? "Waiting for first update..." : "Hacknet daemon not running."}
        </div>
      </div>
    );
  }

  const hashPct = (status.hashUtilization * 100).toFixed(1);
  const hashColor = status.hashUtilization > 0.9 ? "#ff4444" : status.hashUtilization > 0.5 ? "#ffaa00" : "#00ff00";

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>Hacknet Servers</span>
          <span style={styles.dim}>|</span>
          <span style={{ color: status.autoBuy ? "#00ff00" : "#ff8800" }}>
            {status.autoBuy ? "AUTO" : "MONITOR"}
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Hash Summary */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>HASH PRODUCTION</div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Servers</span>
          <span style={styles.statValue}>{status.serverCount} / {status.maxServers}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Total Rate</span>
          <span style={{ color: "#00ff00" }}>{status.totalHashRateFormatted}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Hashes</span>
          <span style={{ color: hashColor }}>
            {status.currentHashes.toFixed(0)} / {status.hashCapacity.toFixed(0)} ({hashPct}%)
          </span>
        </div>
        {/* Hash capacity bar */}
        {status.hashCapacity > 0 && (
          <div style={{ marginTop: "4px", height: "6px", backgroundColor: "#1a1a1a", borderRadius: "3px", overflow: "hidden" }}>
            <div style={{
              width: `${Math.min(status.hashUtilization * 100, 100)}%`,
              height: "100%",
              backgroundColor: hashColor,
              transition: "width 0.3s",
            }} />
          </div>
        )}
      </div>

      {/* Hash Spending */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>HASH SPENDING</div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Strategy</span>
          <select
            style={controlSelectStyle}
            value={status.spendStrategy}
            onChange={(e) => {
              const val = (e.target as HTMLSelectElement).value as HashSpendStrategy;
              if (running) setHacknetStrategy(val);
            }}
          >
            {(Object.keys(STRATEGY_LABELS) as HashSpendStrategy[]).map(k => (
              <option key={k} value={k}>{STRATEGY_LABELS[k]}</option>
            ))}
          </select>
        </div>
        {status.spendTarget !== null && (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Target</span>
            <span style={styles.statValue}>
              {status.spendTarget}
              {status.spendTargetSource === "hack-daemon" && <span style={styles.dim}> (hack daemon)</span>}
            </span>
          </div>
        )}
        {status.spendBlocked !== null && (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Skipped</span>
            <span style={{ color: "#ffaa00" }}>{status.spendBlocked}</span>
          </div>
        )}
        {status.moneyEarnedFromHashes > 0 && (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Earned</span>
            <span style={{ color: "#00ff00" }}>${status.moneyEarnedFormatted}</span>
          </div>
        )}
        {status.hashesSpentTotal > 0 && (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Hashes Spent</span>
            <span style={styles.statValue}>{status.hashesSpentTotal.toFixed(0)}</span>
          </div>
        )}
      </div>

      {/* Upgrade Costs */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>UPGRADES</div>
        {status.nextNodeCost !== null && (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Next Server</span>
            <span style={{ color: "#ffaa00" }}>{status.nextNodeCostFormatted}</span>
          </div>
        )}
        {status.cheapestUpgrade && (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Cheapest ({status.cheapestUpgrade.type} #{status.cheapestUpgrade.serverIndex})</span>
            <span style={{ color: "#ffaa00" }}>{status.cheapestUpgrade.costFormatted}</span>
          </div>
        )}
        {!status.nextNodeCost && !status.cheapestUpgrade && (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Status</span>
            <span style={{ color: "#00ff00" }}>All maxed</span>
          </div>
        )}
      </div>

      {/* Next Target */}
      {(status.nextTarget || (status.skippedForPayback ?? 0) > 0) && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>NEXT TARGET</div>
          {status.nextTarget && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>
                {status.nextTarget.type === "new"
                  ? "New Server"
                  : `${status.nextTarget.type.charAt(0).toUpperCase() + status.nextTarget.type.slice(1)} #${status.nextTarget.serverIndex}`}
              </span>
              <span style={{ color: status.nextTarget.canAfford ? "#00ff00" : "#ff4444" }}>
                {status.nextTarget.canAfford ? "\u2713" : "\u2717"} {status.nextTarget.costFormatted}
              </span>
            </div>
          )}
          {(status.skippedForPayback ?? 0) > 0 && status.purchasesThisTick === 0 && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Waiting</span>
              <span style={{ color: "#ffaa00" }}>
                best payback {status.bestPaybackSec !== null ? formatTime(status.bestPaybackSec) : "n/a"}
                {" > "}
                {status.paybackHorizon !== null ? formatTime(status.paybackHorizon) : "no"} horizon
                {" "}({status.skippedForPayback} skipped)
              </span>
            </div>
          )}
        </div>
      )}

      {/* Per-server table */}
      {status.servers.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>SERVERS ({status.servers.length})</div>
          <div style={{ fontFamily: "monospace", fontSize: "11px" }}>
            <div style={{ color: "#888", marginBottom: "2px" }}>
              {"#".padStart(3)}  {"Lvl".padStart(4)}  {"RAM".padStart(6)}  {"Core".padStart(4)}  {"Cache".padStart(5)}  {"Rate"}
            </div>
            {status.servers.map(s => (
              <div key={s.index} style={{ color: "#ccc" }}>
                {String(s.index).padStart(3)}  {String(s.level).padStart(4)}  {String(s.ram).padStart(5)}G  {String(s.cores).padStart(4)}  {String(s.cache).padStart(5)}  {s.hashRateFormatted}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Purchase History */}
      {status.totalSpent > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>PURCHASES</div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Nodes Bought</span>
            <span style={styles.statValue}>{status.nodesBought}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Upgrades</span>
            <span style={styles.statValue}>{status.upgradesBought}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Total Spent</span>
            <span style={{ color: "#ff8800" }}>{status.totalSpentFormatted}</span>
          </div>
          {status.purchasesThisTick > 0 && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Last Tick</span>
              <span style={{ color: "#00ff00" }}>{status.purchasesThisTick} purchases</span>
            </div>
          )}
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

export const hacknetPlugin: ToolPlugin<FormattedHacknetStatus> = {
  name: "HACKNET",
  id: "hacknet",
  script: "daemons/hacknet.js",
  OverviewCard: HacknetOverviewCard,
  DetailPanel: HacknetDetailPanel,
};
