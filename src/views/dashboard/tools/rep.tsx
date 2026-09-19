/**
 * Rep Tool Plugin
 *
 * Displays reputation progress with ETA, progress bar, and running totals.
 * Supports tiered display based on daemon operating tier.
 */
import React from "lib/react";
import { ToolPlugin, FormattedRepStatus, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { ProgressBar } from "views/dashboard/components/ProgressBar";
import { startFactionWork, runBackdoors, restartRepDaemon, claimFocus } from "views/dashboard/state-store";
import { TierFooter } from "views/dashboard/components/TierFooter";

// === TIER DISPLAY HELPERS ===

const TIER_COLORS: Record<number, string> = {
  0: "#888888", // lite - gray
  1: "#00aa00", // basic - green
  2: "#00aaaa", // target - cyan
  3: "#0088ff", // analysis - blue
  4: "#aa00aa", // planning - purple
  5: "#ff8800", // prereqs - orange
  6: "#00ff00", // auto-work - bright green
};

const TIER_LABELS: Record<number, string> = {
  0: "Lite",
  1: "Basic",
  2: "Target",
  3: "Analysis",
  4: "Planning",
  5: "Prereqs",
  6: "Full",
};

// === COMPONENTS ===

function RepOverviewCard({ status, running, toolId, error, pid }: OverviewCardProps<FormattedRepStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>REP</span>
        <ToolControl tool={toolId} running={running} error={!!error} pid={pid} />
      </div>
      {error ? (
        <div style={{ color: "#ffaa00", fontSize: "11px" }}>{error}</div>
      ) : (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Next Unlock</span>
            <span style={{ color: "#ffff00", fontSize: "11px" }}>
              {status?.nextAugName
                ? (status.nextAugName.length > 18 ? status.nextAugName.substring(0, 18) + "..." : status.nextAugName)
                : status?.targetFaction ?? "—"}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Rep</span>
            <span style={styles.statValue}>
              {status?.currentRepFormatted && status?.repRequiredFormatted
                ? `${status.currentRepFormatted} / ${status.repRequiredFormatted}`
                : "—"}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>ETA</span>
            <span style={styles.etaDisplay}>{status?.eta ?? "—"}</span>
          </div>
        </>
      )}
    </div>
  );
}

function RepDetailPanel({ status, error, running, toolId, pid }: DetailPanelProps<FormattedRepStatus>): React.ReactElement {
  if (error) {
    return (
      <div style={styles.panel}>
        <ToolControl tool={toolId} running={running} error={true} pid={pid} />
        <div style={{ color: "#ffaa00", marginTop: "12px" }}>{error}</div>
        <div style={{ ...styles.dim, marginTop: "8px", fontSize: "11px" }}>
          Requires Singularity API (Source-File 4)
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={styles.statLabel}>REP Daemon</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        {!running ? (
          <>
            <div style={{ marginTop: "12px", color: "#ffaa00" }}>
              REP daemon not running.
            </div>
            <div style={{ ...styles.dim, marginTop: "8px", fontSize: "11px" }}>
              Click to start the daemon and load rep status.
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: "12px", color: "#ffaa00" }}>
              Waiting for status...
            </div>
            <div style={{ ...styles.dim, marginTop: "8px", fontSize: "11px" }}>
              Daemon may be starting up. Check the daemon's tail log for details.
            </div>
          </>
        )}
      </div>
    );
  }

  // Tier-aware rendering
  const tier = status.tier ?? 6;
  const tierColor = TIER_COLORS[tier] ?? "#888";
  const tierLabel = TIER_LABELS[tier] ?? "Unknown";

  // High tier (3+): Full display
  if (tier >= 3) {
    return <HighTierDetailPanel status={status} running={running} toolId={"rep"} pid={pid} />;
  }

  // Low tier (0-2): Basic display
  return <LowTierDetailPanel status={status} running={running} toolId={"rep"} pid={pid} tierColor={tierColor} tierLabel={tierLabel} />;
}

// === LOW TIER PANEL (0-2) ===

function LowTierDetailPanel({
  status,
  running,
  toolId,
  pid,
  tierColor,
  tierLabel,
}: {
  status: FormattedRepStatus;
  running: boolean;
  toolId: "rep";
  pid?: number;
  tierColor: string;
  tierLabel: string;
}): React.ReactElement {
  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>REP Daemon</span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* RAM Info */}
      <div style={{
        ...styles.card,
        backgroundColor: "rgba(100, 100, 100, 0.15)",
        borderLeft: `3px solid ${tierColor}`,
        marginTop: "8px",
      }}>
        <div style={{ color: tierColor, fontSize: "11px", marginBottom: "6px" }}>
          LIMITED FUNCTIONALITY MODE
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>RAM Usage</span>
          <span style={styles.statValue}>{status.currentRamUsage}GB</span>
        </div>
        {status.nextTierRam && (
          <div style={styles.stat}>
            <span style={styles.statLabel}>Next Tier Needs</span>
            <span style={{ color: "#ffaa00" }}>{status.nextTierRam}GB</span>
          </div>
        )}
        <div style={{ ...styles.dim, fontSize: "10px", marginTop: "6px" }}>
          Features: {status.availableFeatures?.join(", ") ?? "none"}
        </div>
        {status.unavailableFeatures && status.unavailableFeatures.length > 0 && (
          <div style={{ color: "#888", fontSize: "10px", marginTop: "4px" }}>
            Missing: {status.unavailableFeatures.slice(0, 4).join(", ")}
            {status.unavailableFeatures.length > 4 && ` +${status.unavailableFeatures.length - 4} more`}
          </div>
        )}
      </div>

      {/* All Factions List (Tier 1+) */}
      {status.allFactions && status.allFactions.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            JOINED FACTIONS
            <span style={{ ...styles.dim, marginLeft: "8px", fontWeight: "normal" }}>
              {status.allFactions.length} total
            </span>
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Faction</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Rep</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Favor</th>
              </tr>
            </thead>
            <tbody>
              {status.allFactions.slice(0, 10).map((faction, i) => (
                <tr key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                  <td style={{ ...styles.tableCell, color: "#fff" }}>
                    {faction.name.substring(0, 24)}
                  </td>
                  <td style={{ ...styles.tableCell, textAlign: "right", color: "#00ff00" }}>
                    {faction.currentRepFormatted}
                  </td>
                  <td style={{ ...styles.tableCell, textAlign: "right", color: "#888" }}>
                    {faction.favor.toFixed(0)}
                  </td>
                </tr>
              ))}
              {status.allFactions.length > 10 && (
                <tr style={styles.tableRowAlt}>
                  <td style={{ ...styles.tableCell, ...styles.dim }} colSpan={3}>
                    ... +{status.allFactions.length - 10} more
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Lite mode message (Tier 0) */}
      {status.tier === 0 && (
        <div style={{ marginTop: "12px", color: "#888", fontSize: "11px" }}>
          No live data available. Need SF4 (Singularity) for faction rep tracking.
        </div>
      )}

      <TierFooter
        tier={status.tier}
        tierName={tierLabel}
        currentRamUsage={status.currentRamUsage}
        nextTierRam={status.nextTierRam}
        canUpgrade={status.canUpgrade}
      />
    </div>
  );
}

// === HIGH TIER PANEL (3+) ===

function HighTierDetailPanel({
  status,
  running,
  toolId,
  pid,
}: {
  status: FormattedRepStatus;
  running: boolean;
  toolId: "rep";
  pid?: number;
}): React.ReactElement {
  const handleBackdoors = () => {
    runBackdoors();
  };

  const handleStartWork = () => {
    if (status.targetFaction && status.targetFaction !== "None" && status.bestWorkType) {
      startFactionWork(status.targetFaction, status.bestWorkType);
    }
  };

  // Show work button when: workable faction, not optimal work, and still need rep
  const showWorkButton = status.isWorkable && !status.isOptimalWork && status.repGapPositive;

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span>
            <span style={styles.statLabel}>Target: </span>
            <select
              style={{
                backgroundColor: "#1a1a1a",
                color: "#00ff00",
                border: "1px solid #333",
                borderRadius: "3px",
                padding: "1px 4px",
                fontSize: "12px",
                fontFamily: "inherit",
                cursor: "pointer",
              }}
              value={status.focusedFaction ?? ""}
              onChange={(e) => {
                const val = (e.target as HTMLSelectElement).value;
                restartRepDaemon(val || undefined);
              }}
            >
              <option value="">Auto ({status.targetFaction ?? "None"})</option>
              {(status.allFactions ?? []).map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Favor: </span>
            <span style={styles.statValue}>
              {(status.favor ?? 0).toFixed(0)}/{(status.favorToUnlock ?? 150).toFixed(0)}
            </span>
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
      </div>

      {/* Focus Yielding Banner */}
      {status.focusYielding && (
        <div style={{
          backgroundColor: "rgba(255, 170, 0, 0.1)",
          border: "1px solid #ffaa00",
          borderRadius: "4px",
          padding: "8px 12px",
          marginBottom: "8px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <span style={{ color: "#ffaa00", fontSize: "12px" }}>
            Yielding focus to another daemon
          </span>
          <button
            style={{
              ...styles.buttonPlay,
              marginLeft: 0,
              padding: "3px 10px",
              backgroundColor: "#554400",
              color: "#ffaa00",
              fontSize: "11px",
            }}
            onClick={() => claimFocus("rep")}
          >
            Claim Focus
          </button>
        </div>
      )}

      {/* Action Buttons */}
      {((status.pendingBackdoors && status.pendingBackdoors.length > 0) || showWorkButton) && (
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
          {showWorkButton && (
            <button
              style={{
                ...styles.buttonPlay,
                marginLeft: 0,
                padding: "4px 12px",
                backgroundColor: "#005500",
                color: "#00ff00",
              }}
              onClick={handleStartWork}
              title={`Start ${status.bestWorkType} work for ${status.targetFaction} with focus`}
            >
              Work: {status.bestWorkType}
            </button>
          )}
          {status.pendingBackdoors && status.pendingBackdoors.length > 0 && (
            <button
              style={{
                ...styles.buttonPlay,
                marginLeft: 0,
                padding: "4px 12px",
                backgroundColor: "#004455",
                color: "#00ffff",
              }}
              onClick={handleBackdoors}
              title={status.pendingBackdoors.join(", ")}
            >
              Backdoors ({status.pendingBackdoors.length})
            </button>
          )}
        </div>
      )}

      {/* Next Unlock Section */}
      {status.nextAugName && (
        <div style={styles.card}>
          <div style={{ color: "#00ffff", fontSize: "12px", marginBottom: "8px" }}>
            NEXT UNLOCK: <span style={{ color: "#ffff00" }}>{status.nextAugName}</span>
          </div>

          {/* Progress Bar */}
          <ProgressBar
            progress={status.repProgress ?? 0}
            label={`${((status.repProgress ?? 0) * 100).toFixed(1)}%`}
            fillColor={(status.repProgress ?? 0) >= 1 ? "#00aa00" : "#0088aa"}
          />

          {/* Rep Stats */}
          <div style={styles.stat}>
            <span style={styles.statLabel}>Rep Progress</span>
            <span style={styles.statValue}>
              {status.currentRepFormatted} / {status.repRequiredFormatted}
            </span>
          </div>
          {status.repGapPositive && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Need</span>
              <span style={{ color: "#ffaa00" }}>{status.repGapFormatted} more</span>
            </div>
          )}

          {/* ETA and Cost */}
          <div style={{ ...styles.stat, marginTop: "8px" }}>
            <span style={styles.statLabel}>ETA</span>
            <span style={styles.etaDisplay}>
              {status.eta ?? "???"}
              {(status.repGainRate ?? 0) > 0 && (
                <span style={styles.dim}> @ {(status.repGainRate ?? 0).toFixed(1)}/s</span>
              )}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Cost</span>
            <span style={status.canAffordNextAug ? styles.statHighlight : { color: "#ff4444" }}>
              {status.canAffordNextAug ? "" : ""} ${status.nextAugCostFormatted}
            </span>
          </div>
        </div>
      )}

      {/* Non-workable Factions Hint Box */}
      {status.nonWorkableFactions && status.nonWorkableFactions.length > 0 && (
        <div style={{
          ...styles.card,
          backgroundColor: "rgba(128, 0, 128, 0.15)",
          borderLeft: "3px solid #aa00aa",
        }}>
          <div style={{ color: "#cc88cc", fontSize: "11px", marginBottom: "6px" }}>
            PASSIVE PROGRESS (infiltration/special)
          </div>
          {status.nonWorkableFactions.map((item, i) => (
            <div key={i} style={{ marginBottom: i < status.nonWorkableFactions!.length - 1 ? "8px" : 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                <span style={{ color: "#ffffff", fontSize: "11px" }}>{item.factionName}</span>
                <span style={{ color: "#888", fontSize: "10px" }}>
                  {item.currentRep} / {item.requiredRep}
                </span>
              </div>
              <div style={{
                height: "6px",
                backgroundColor: "rgba(0, 0, 0, 0.3)",
                borderRadius: "3px",
                overflow: "hidden",
              }}>
                <div style={{
                  height: "100%",
                  width: `${item.progress * 100}%`,
                  backgroundColor: "#aa00aa",
                  borderRadius: "3px",
                }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "2px" }}>
                <span style={{ color: "#888", fontSize: "10px" }}>
                  {item.nextAugName.substring(0, 32)}
                </span>
                <span style={{ color: "#cc88cc", fontSize: "10px" }}>
                  {(item.progress * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <TierFooter
        tier={status.tier ?? 6}
        tierName={TIER_LABELS[status.tier ?? 6] ?? "Unknown"}
        currentRamUsage={status.currentRamUsage}
        nextTierRam={status.nextTierRam}
        canUpgrade={status.canUpgrade}
      />
    </div>
  );
}

// === PLUGIN EXPORT ===

export const repPlugin: ToolPlugin<FormattedRepStatus> = {
  name: "REP",
  id: "rep",
  script: "daemons/rep.js",
  OverviewCard: RepOverviewCard,
  DetailPanel: RepDetailPanel,
};
