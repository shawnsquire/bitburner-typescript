/**
 * Augments Tool Plugin
 *
 * Displays purchasable augmentations with checkboxes for selective buying,
 * a purchase planner that recomputes rolling costs, NFG section, and
 * sequential augs. Independent of the rep daemon.
 */
import React from "lib/react";
import { ToolPlugin, FormattedAugmentsStatus, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { ProgressBar } from "views/dashboard/components/ProgressBar";
import { runScript, installAugments, buySelectedAugments, getPluginUIState, setPluginUIState } from "views/dashboard/state-store";
import { AUG_COST_MULT } from "/controllers/factions";

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

// === COMPONENTS ===

function AugmentsOverviewCard({ status, running, toolId, pid }: OverviewCardProps<FormattedAugmentsStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>AUGS</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Pending</span>
        <span style={styles.statValue}>{status?.pendingAugs ?? "—"}</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Installed</span>
        <span style={styles.statValue}>{status?.installedAugs ?? "—"}</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Available</span>
        <span style={styles.statHighlight}>{status?.available?.length ?? "—"}</span>
      </div>
    </div>
  );
}

function AugmentsDetailPanel({ status, running, toolId, pid }: DetailPanelProps<FormattedAugmentsStatus>): React.ReactElement {
  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={styles.statLabel}>Augments Daemon</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        {!running ? (
          <>
            <div style={{ marginTop: "12px", color: "#ffaa00" }}>
              Augments daemon not running.
            </div>
            <div style={{ ...styles.dim, marginTop: "8px", fontSize: "11px" }}>
              Click to start the daemon and load augmentation data.
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: "12px", color: "#ffaa00" }}>
              Waiting for status...
            </div>
            <div style={{ ...styles.dim, marginTop: "8px", fontSize: "11px" }}>
              Daemon may be starting up.
            </div>
          </>
        )}
      </div>
    );
  }

  // Selected set from pluginUIState (opt-in: new items default to unchecked)
  const selected = getPluginUIState<string[]>("augments", "selected", []);
  const selectedSet = new Set(selected);

  const isChecked = (name: string) => selectedSet.has(name);

  const toggleAug = (name: string) => {
    const current = getPluginUIState<string[]>("augments", "selected", []);
    const currentSet = new Set(current);
    if (currentSet.has(name)) {
      currentSet.delete(name);
    } else {
      currentSet.add(name);
    }
    setPluginUIState("augments", "selected", [...currentSet]);
  };

  // Filter dropdown
  const filter = getPluginUIState<string>("augments", "filter", "none");
  const displayAvailable = filter === "none"
    ? status.available
    : status.available.filter((a) => a.tags ? a.tags.includes(filter) : true);

  const allVisibleChecked = displayAvailable.length > 0 && displayAvailable.every((a) => isChecked(a.name));
  const toggleAllVisible = () => {
    const current = getPluginUIState<string[]>("augments", "selected", []);
    const currentSet = new Set(current);
    if (allVisibleChecked) {
      for (const a of displayAvailable) currentSet.delete(a.name);
    } else {
      for (const a of displayAvailable) currentSet.add(a.name);
    }
    setPluginUIState("augments", "selected", [...currentSet]);
  };

  // Checked items for purchase planner (always uses full list, not filtered)
  const checkedItems = status.available.filter((a) => isChecked(a.name));
  const checkedCount = checkedItems.length;

  // Compute rolling adjusted costs for checked items using AUG_COST_MULT
  let rollingMultiplier = 1;
  const plannerItems = checkedItems.map((item) => {
    const rollingAdjusted = item.baseCost * rollingMultiplier;
    const result = { ...item, rollingAdjusted, rollingTotal: 0 };
    rollingMultiplier *= AUG_COST_MULT;
    return result;
  });
  let runningTotal = 0;
  for (const item of plannerItems) {
    runningTotal += item.rollingAdjusted;
    item.rollingTotal = runningTotal;
  }
  const totalPlanCost = runningTotal;

  // Handlers
  const handleBuyChecked = () => {
    const names = checkedItems.map((a) => a.name);
    if (names.length > 0) {
      buySelectedAugments(names);
    }
  };

  const handleBuyNFG = () => {
    runScript("augments", "actions/purchase-neuroflux.js", []);
  };

  const handleDonateAndBuyNFG = () => {
    runScript("augments", "actions/neuroflux-donate.js", ["--confirm"]);
  };

  // Install augments confirmation state
  const confirmInstall = getPluginUIState<boolean>("augments", "confirmInstall", false);
  const handleInstallAugs = () => {
    if (confirmInstall) {
      installAugments();
      setPluginUIState("augments", "confirmInstall", false);
    } else {
      setPluginUIState("augments", "confirmInstall", true);
    }
  };
  const handleInstallBlur = () => {
    setPluginUIState("augments", "confirmInstall", false);
  };

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>Augments</span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Action Buttons */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
        {checkedCount > 0 && (
          <button
            style={{ ...styles.buttonPlay, marginLeft: 0, padding: "4px 12px" }}
            onClick={handleBuyChecked}
          >
            Buy Checked ({checkedCount})
          </button>
        )}
        {status.neuroFlux?.purchasePlan && status.neuroFlux.purchasePlan.purchases > 0 && (
          <button
            style={{
              ...styles.buttonPlay, marginLeft: 0, padding: "4px 12px",
              backgroundColor: "#003366", color: "#00aaff",
            }}
            onClick={handleBuyNFG}
            title={`Buy ${status.neuroFlux.purchasePlan.purchases} NFG level(s) for $${status.neuroFlux.purchasePlan.totalCostFormatted}`}
          >
            Buy NFG ({status.neuroFlux.purchasePlan.purchases})
          </button>
        )}
        {status.neuroFlux?.canDonate && status.neuroFlux?.donationPlan && (
          <button
            style={{
              ...styles.buttonPlay, marginLeft: 0, padding: "4px 12px",
              backgroundColor: "#554400", color: "#ffcc00",
            }}
            onClick={handleDonateAndBuyNFG}
            title={`Donate & buy ${status.neuroFlux.donationPlan.purchases} NFG level(s) for $${status.neuroFlux.donationPlan.totalCostFormatted}`}
          >
            Donate+NFG ({status.neuroFlux.donationPlan.purchases})
          </button>
        )}
        {(status.pendingAugs ?? 0) > 0 && (
          <button
            style={{
              ...styles.buttonPlay,
              backgroundColor: confirmInstall ? "#aa0000" : "#550055",
              color: confirmInstall ? "#fff" : "#ff88ff",
              padding: "4px 12px",
            }}
            onClick={handleInstallAugs}
            onBlur={handleInstallBlur}
          >
            {confirmInstall ? "Confirm Install?" : `Install Augs (${status.pendingAugs})`}
          </button>
        )}
      </div>

      {/* Table 1: Available Purchases */}
      {status.available.length > 0 && (
        <div style={styles.section}>
          <div style={{ ...styles.sectionTitle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>
              AVAILABLE PURCHASES
              <span style={{ ...styles.dim, marginLeft: "8px", fontWeight: "normal" }}>
                {filter !== "none"
                  ? `${displayAvailable.length}/${status.available.length} shown`
                  : `${checkedCount}/${status.available.length} selected`}
              </span>
            </span>
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
              value={filter}
              onChange={(e) => setPluginUIState("augments", "filter", (e.target as HTMLSelectElement).value)}
            >
              <option value="none">All</option>
              <option value="hacking">Hacking</option>
              <option value="combat">Combat</option>
              <option value="charisma">Charisma</option>
              <option value="crime">Crime</option>
              <option value="hacknet">Hacknet</option>
              <option value="bladeburner">Bladeburner</option>
              <option value="rep">Rep</option>
              <option value="work">Work</option>
              <option value="prereq">Has Prereq</option>
            </select>
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.tableHeader, width: "28px", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={allVisibleChecked}
                    onChange={toggleAllVisible}
                    style={{ cursor: "pointer", accentColor: "#00ff00" }}
                    title={allVisibleChecked ? "Deselect all visible" : "Select all visible"}
                  />
                </th>
                <th style={styles.tableHeader}>Augmentation</th>
                <th style={styles.tableHeader}>Faction</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Base Cost</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Adjusted</th>
              </tr>
            </thead>
            <tbody>
              {displayAvailable.map((item, i) => {
                const checked = isChecked(item.name);
                const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                return (
                  <tr key={i} style={rowStyle}>
                    <td style={{ ...styles.tableCell, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAug(item.name)}
                        style={{ cursor: "pointer", accentColor: "#00ff00" }}
                      />
                    </td>
                    <td style={{ ...styles.tableCell, color: checked ? "#fff" : "#666" }}>
                      {item.name.substring(0, 32)}
                    </td>
                    <td style={{ ...styles.tableCell, color: checked ? "#aaa" : "#555" }}>
                      {item.faction.substring(0, 16)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right", color: "#888" }}>
                      ${item.baseCostFormatted}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right", color: checked ? "#00ff00" : "#555" }}>
                      ${item.adjustedCostFormatted}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Table 2: Purchase Planner (checked items only) */}
      {plannerItems.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            PURCHASE PLANNER
            <span style={{ ...styles.dim, marginLeft: "8px", fontWeight: "normal" }}>
              {plannerItems.length} augs | ${formatNumber(totalPlanCost)} total
            </span>
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.tableHeader, width: "24px" }}>#</th>
                <th style={styles.tableHeader}>Augmentation</th>
                <th style={styles.tableHeader}>Faction</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Rolling Adj.</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {plannerItems.slice(0, 15).map((item, i) => {
                const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                const affordable = item.rollingTotal <= status.playerMoney;
                return (
                  <tr key={i} style={rowStyle}>
                    <td style={{ ...styles.tableCell, color: "#888" }}>{i + 1}</td>
                    <td style={{ ...styles.tableCell, color: affordable ? "#fff" : "#666" }}>
                      {item.name.substring(0, 32)}
                    </td>
                    <td style={{ ...styles.tableCell, color: affordable ? "#aaa" : "#555" }}>
                      {item.faction.substring(0, 16)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right", color: affordable ? "#00ff00" : "#ff4444" }}>
                      ${formatNumber(item.rollingAdjusted)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right", ...styles.runningTotal }}>
                      ${formatNumber(item.rollingTotal)}
                    </td>
                  </tr>
                );
              })}
              {plannerItems.length > 15 && (
                <tr style={styles.tableRowAlt}>
                  <td style={{ ...styles.tableCell, ...styles.dim }} colSpan={5}>
                    ... +{plannerItems.length - 15} more
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Sequential Purchase Augs (Shadows of Anarchy, etc.) */}
      {status.sequentialAugs && status.sequentialAugs.length > 0 && (
        <div style={{
          ...styles.card,
          backgroundColor: "rgba(255, 170, 0, 0.1)",
          borderLeft: "3px solid #ffaa00",
          marginTop: "8px",
        }}>
          <div style={{ color: "#ffaa00", fontSize: "11px", marginBottom: "6px" }}>
            SEQUENTIAL ONLY (one at a time)
          </div>
          {status.sequentialAugs.map((item, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
              <span style={{ color: "#fff", fontSize: "11px" }}>
                {item.augName.substring(0, 28)}
              </span>
              <span style={{ fontSize: "11px" }}>
                <span style={{ color: "#888" }}>{item.faction}</span>
                {" - "}
                <span style={{ color: item.canAfford ? "#00ff00" : "#ff4444" }}>
                  ${item.costFormatted}
                </span>
              </span>
            </div>
          ))}
          <div style={{ color: "#888", fontSize: "10px", marginTop: "4px" }}>
            Rep requirement increases after each purchase
          </div>
        </div>
      )}

      {/* NeuroFlux Governor Section */}
      {status.neuroFlux && status.neuroFlux.bestFaction && (
        <div style={{
          ...styles.card,
          backgroundColor: "rgba(0, 150, 255, 0.1)",
          borderLeft: "3px solid #0088ff",
          marginTop: "8px",
        }}>
          <div style={{ color: "#0088ff", fontSize: "11px", marginBottom: "6px" }}>
            NEUROFLUX GOVERNOR
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Level</span>
            <span style={styles.statValue}>{status.neuroFlux.currentLevel}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Best Faction</span>
            <span style={styles.statValue}>{status.neuroFlux.bestFaction}</span>
          </div>

          {/* Rep progress when not enough rep */}
          {!status.neuroFlux.hasEnoughRep && (
            <>
              <div style={{ marginTop: "8px", marginBottom: "4px" }}>
                <ProgressBar
                  progress={status.neuroFlux.repProgress}
                  label={`${(status.neuroFlux.repProgress * 100).toFixed(1)}%`}
                  fillColor="#0088ff"
                />
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Rep Progress</span>
                <span style={styles.statValue}>
                  {status.neuroFlux.currentRepFormatted} / {status.neuroFlux.repRequiredFormatted}
                </span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Need</span>
                <span style={{ color: "#ffaa00" }}>{status.neuroFlux.repGapFormatted} more</span>
              </div>
              {status.neuroFlux.outrightCost !== null && (
                <div style={styles.stat}>
                  <span style={styles.statLabel}>Buy Outright</span>
                  <span style={{ color: status.neuroFlux.outrightCost <= status.playerMoney ? "#00ff00" : "#ff4444" }}>
                    ${status.neuroFlux.outrightCostFormatted}
                  </span>
                  <span style={{ ...styles.dim, marginLeft: "6px", fontSize: "10px" }}>
                    (${status.neuroFlux.donationCostForGapFormatted} donate + ${status.neuroFlux.currentPriceFormatted} buy)
                  </span>
                </div>
              )}
            </>
          )}

          {/* Next level cost when have rep but can't afford */}
          {status.neuroFlux.hasEnoughRep && !status.neuroFlux.canPurchase && (
            <>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Next Level</span>
                <span style={{ color: "#ff4444" }}>
                  ${status.neuroFlux.currentPriceFormatted}
                </span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Need</span>
                <span style={{ color: "#ffaa00" }}>
                  ${formatNumber(status.neuroFlux.currentPrice - status.playerMoney)} more
                </span>
              </div>
            </>
          )}

          {/* Purchase info when can buy */}
          {status.neuroFlux.purchasePlan && status.neuroFlux.purchasePlan.purchases > 0 && (
            <>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Can Buy</span>
                <span style={styles.statHighlight}>
                  {status.neuroFlux.purchasePlan.purchases} upgrade{status.neuroFlux.purchasePlan.purchases !== 1 ? "s" : ""}
                </span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Total Cost</span>
                <span style={{ color: "#00ff00" }}>
                  ${status.neuroFlux.purchasePlan.totalCostFormatted}
                </span>
              </div>
            </>
          )}

          {/* Rep-limited warning */}
          {status.neuroFlux.purchasePlan?.repLimited && status.neuroFlux.purchasePlan.purchases > 0 && status.neuroFlux.purchasePlan.nextRepGapFormatted && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Next Level</span>
              <span style={{ color: "#ffaa00" }}>
                Need {status.neuroFlux.purchasePlan.nextRepGapFormatted} more rep
              </span>
            </div>
          )}

          {/* Donate & Buy section when eligible */}
          {status.neuroFlux.canDonate && status.neuroFlux.donationPlan && (
            <div style={{
              marginTop: "12px",
              paddingTop: "8px",
              borderTop: "1px solid rgba(255, 200, 0, 0.3)",
            }}>
              <div style={{ color: "#ffcc00", fontSize: "11px", marginBottom: "6px" }}>
                DONATE & BUY (150+ favor)
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Can Buy</span>
                <span style={styles.statHighlight}>
                  {status.neuroFlux.donationPlan.purchases} upgrade{status.neuroFlux.donationPlan.purchases !== 1 ? "s" : ""}
                </span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Donations</span>
                <span style={{ color: "#ffcc00" }}>
                  ${status.neuroFlux.donationPlan.totalDonationCostFormatted}
                </span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Purchases</span>
                <span style={{ color: "#00ff00" }}>
                  ${status.neuroFlux.donationPlan.totalPurchaseCostFormatted}
                </span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statLabel}>Total</span>
                <span style={{ color: "#00ffff" }}>
                  ${status.neuroFlux.donationPlan.totalCostFormatted}
                </span>
              </div>
            </div>
          )}

          {/* Show next NFG cost when has rep but can't afford */}
          {status.neuroFlux.hasEnoughRep && !status.neuroFlux.purchasePlan && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Next Cost</span>
              <span style={{ color: "#ff4444" }}>${status.neuroFlux.currentPriceFormatted}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// === PLUGIN EXPORT ===

export const augmentsPlugin: ToolPlugin<FormattedAugmentsStatus> = {
  name: "AUGS",
  id: "augments",
  script: "daemons/augments.js",
  OverviewCard: AugmentsOverviewCard,
  DetailPanel: AugmentsDetailPanel,
};
