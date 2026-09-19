/**
 * Corporation Tool Plugin
 *
 * Directive-driven UI with contextual detail panels.
 * OverviewCard: directive + profit/s + status line.
 * DetailPanel: sections change based on active directive (Bootstrap/Scale/Harvest).
 */
import React from "lib/react";
import {
  ToolPlugin,
  OverviewCardProps,
  DetailPanelProps,
} from "views/dashboard/types";
import {
  CorpStatus,
  CorpPendingAction,
  CorpDirective,
} from "/types/ports";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { TierFooter } from "views/dashboard/components/TierFooter";
import {
  setCorpDirective,
  cancelCorpPending,
  toggleCorpPin,
  toggleCorpAutoTea,
  setCorpDividendRate,
  toggleCorpEnabled,
  isCorpEnabled,
} from "views/dashboard/state-store";

export type FormattedCorpStatus = CorpStatus;

// === OVERVIEW CARD ===

function CorpOverviewCard({
  status,
  running,
  toolId,
  pid,
}: OverviewCardProps<FormattedCorpStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>{status?.corpName || "CORP"}</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      {status ? (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Profit</span>
            <span style={{ color: status.profit >= 0 ? "#00ff00" : "#ff4444" }}>
              {status.profitFormatted}/s
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>
              {status.directive.charAt(0).toUpperCase() + status.directive.slice(1)}
            </span>
            <span style={{ color: "#aaa", fontSize: "11px" }}>
              {status.statusLine}
            </span>
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

// === COUNTDOWN BANNER ===

function CountdownBanner({ action }: { action: CorpPendingAction }): React.ReactElement {
  const remaining = Math.max(0, Math.ceil((action.expiresAt - Date.now()) / 1000));

  return (
    <div style={{
      padding: "6px 10px",
      marginBottom: "8px",
      background: "#332200",
      border: "1px solid #664400",
      borderRadius: "4px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <span style={{ color: "#ffaa00", fontWeight: "bold", fontSize: "12px" }}>
            {"\u26A0"} {action.description}
          </span>
          <span style={{ color: "#888", fontSize: "11px", marginLeft: "8px" }}>
            in {remaining}s
          </span>
        </div>
        <button
          onClick={() => cancelCorpPending()}
          style={{
            background: "#442200",
            color: "#ffaa00",
            border: "1px solid #664400",
            borderRadius: "3px",
            padding: "2px 8px",
            fontSize: "11px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
      {Object.entries(action.details).length > 0 && (
        <div style={{ marginTop: "4px", fontSize: "11px", color: "#888" }}>
          {Object.entries(action.details).map(([k, v]) => (
            <span key={k} style={{ marginRight: "12px" }}>{k}: {v}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// === DIRECTIVE SELECTOR ===

function DirectiveSelector({ status }: { status: CorpStatus }): React.ReactElement {
  const directives: CorpDirective[] = ["bootstrap", "scale", "harvest"];

  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "11px", marginBottom: "6px" }}>
      <span style={{ color: "#888" }}>Directive:</span>
      <select
        value={status.directive}
        onChange={(e) => setCorpDirective(e.target.value as CorpDirective)}
        style={{
          background: "#1a1a2e",
          color: "#e0e0e0",
          border: "1px solid #333",
          borderRadius: "3px",
          padding: "2px 6px",
          fontSize: "11px",
        }}
      >
        {directives.map(d => (
          <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
        ))}
      </select>
      <label style={{ color: "#888", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={status.directivePinned}
          onChange={(e) => toggleCorpPin(e.target.checked)}
          style={{ marginRight: "4px" }}
        />
        Pin
      </label>
    </div>
  );
}

// === SECTION COMPONENTS ===

function StatusSection({ status }: { status: CorpStatus }): React.ReactElement {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>STATUS</div>
      <div style={{ ...styles.stat, marginBottom: "2px" }}>
        <span style={styles.statLabel}>Current</span>
        <span style={{ color: "#e0e0e0" }}>{status.statusLine}</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Next</span>
        <span style={{ color: "#aaa" }}>{status.nextStep}</span>
      </div>
    </div>
  );
}

function FinancialsSection({ status }: { status: CorpStatus }): React.ReactElement {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>FINANCIALS</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px", fontSize: "11px" }}>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Funds</span>
          <span>{status.fundsFormatted}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Profit</span>
          <span style={{ color: status.profit >= 0 ? "#00ff00" : "#ff4444" }}>{status.profitFormatted}/s</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Revenue</span>
          <span style={{ color: "#00cc44" }}>{status.revenueFormatted}/s</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Expenses</span>
          <span style={{ color: "#ff6666" }}>{status.expensesFormatted}/s</span>
        </div>
      </div>
    </div>
  );
}

function DivisionSetupSection({ status }: { status: CorpStatus }): React.ReactElement {
  const expectedDivs = ["Agriculture", "Chemical", "Tobacco"];

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>DIVISION SETUP</div>
      {expectedDivs.map(type => {
        const div = status.divisions.find(d => d.type === type);
        const cities = div?.cities.length ?? 0;
        const done = cities >= 6;
        return (
          <div key={type} style={{ ...styles.stat, marginBottom: "2px" }}>
            <span style={styles.statLabel}>{type}</span>
            <span style={{ color: done ? "#00cc44" : div ? "#ffaa00" : "#555" }}>
              {div ? `${cities}/6 cities` : "Not created"}
              {done && " \u2713"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function UnlockChecklistSection({ status }: { status: CorpStatus }): React.ReactElement {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>UNLOCKS</div>
      {status.unlocks.map(u => (
        <div key={u.name} style={{ ...styles.stat, marginBottom: "2px" }}>
          <span style={styles.statLabel}>{u.name}</span>
          <span style={{ color: u.owned ? "#00cc44" : "#888" }}>
            {u.owned ? "\u2713" : u.costFormatted}
          </span>
        </div>
      ))}
    </div>
  );
}

function InvestmentSection({ status }: { status: CorpStatus }): React.ReactElement {
  if (status.isPublic) return <React.Fragment />;

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>INVESTMENT</div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Round</span>
        <span>{status.investmentRound}</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Offer</span>
        <span style={{ color: "#ffaa00" }}>{status.currentOfferFormatted}</span>
      </div>
    </div>
  );
}

function UpgradesSection({ status }: { status: CorpStatus }): React.ReactElement {
  const sorted = [...status.upgrades].sort((a, b) => b.level - a.level);

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>UPGRADES</div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.tableHeader}>Name</th>
            <th style={{ ...styles.tableHeader, textAlign: "right" }}>Lv</th>
            <th style={{ ...styles.tableHeader, textAlign: "right" }}>Next</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(u => (
            <tr key={u.name}>
              <td style={styles.tableCell}>{u.name}</td>
              <td style={{ ...styles.tableCell, textAlign: "right" }}>{u.level}</td>
              <td style={{ ...styles.tableCell, textAlign: "right", color: "#888" }}>{u.costFormatted}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductPipelineSection({ status }: { status: CorpStatus }): React.ReactElement {
  if (status.products.length === 0) return <React.Fragment />;

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>PRODUCTS ({status.products.length})</div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.tableHeader}>Name</th>
            <th style={{ ...styles.tableHeader, textAlign: "right" }}>Rating</th>
            <th style={{ ...styles.tableHeader, textAlign: "right" }}>Progress</th>
          </tr>
        </thead>
        <tbody>
          {status.products.map(p => (
            <tr key={p.name}>
              <td style={styles.tableCell}>{p.name}</td>
              <td style={{ ...styles.tableCell, textAlign: "right" }}>
                {p.progress >= 100 ? p.rating.toFixed(1) : "-"}
              </td>
              <td style={{ ...styles.tableCell, textAlign: "right" }}>
                {p.progress >= 100 ? (
                  <span style={{ color: "#00cc44" }}>{"\u2713"}</span>
                ) : (
                  <span style={{ color: "#ffaa00" }}>{p.progress.toFixed(0)}%</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DivisionPerformanceSection({ status }: { status: CorpStatus }): React.ReactElement {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>DIVISIONS ({status.divisions.length})</div>
      {status.divisions.map(div => (
        <div key={div.name} style={{ marginBottom: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", fontWeight: "bold" }}>
            <span style={{ color: "#e0e0e0" }}>{div.name}</span>
            <span style={{ color: div.profit >= 0 ? "#00cc44" : "#ff4444" }}>
              {div.profitFormatted}/s
            </span>
          </div>
          {div.warehouses.length > 0 && (
            <div style={{ fontSize: "10px", color: "#888", marginTop: "2px" }}>
              {div.warehouses.map(wh => (
                <span key={wh.city} style={{ marginRight: "8px" }}>
                  {wh.city.substring(0, 3)}: {wh.usedPercent}%
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DividendSection({ status }: { status: CorpStatus }): React.ReactElement {
  if (!status.isPublic) return <React.Fragment />;

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>DIVIDENDS</div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Rate</span>
        <span>{(status.dividendRate * 100).toFixed(1)}%</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Income</span>
        <span style={{ color: "#00cc44" }}>{status.dividendIncomeFormatted}/s</span>
      </div>
    </div>
  );
}

function ShareSection({ status }: { status: CorpStatus }): React.ReactElement {
  if (!status.isPublic) return <React.Fragment />;

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>SHARES</div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Price</span>
        <span>{status.sharePriceFormatted}</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Owned</span>
        <span>{status.ownedShares.toLocaleString()}</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Issued</span>
        <span>{status.issuedShares.toLocaleString()}</span>
      </div>
    </div>
  );
}

function BudgetSection({ status }: { status: CorpStatus }): React.ReactElement {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>BUDGET</div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>Allocation</span>
        <span>{status.budgetBalanceFormatted}</span>
      </div>
    </div>
  );
}

// === SETTINGS ===

function SettingsSection({ status }: { status: CorpStatus }): React.ReactElement {
  const enabled = isCorpEnabled();

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>SETTINGS</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "11px", marginTop: "4px" }}>
        <label style={{ color: "#888", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={status.autoTea}
            onChange={(e) => toggleCorpAutoTea(e.target.checked)}
            style={{ marginRight: "4px" }}
          />
          Auto Tea
        </label>
      </div>

      {status.isPublic && (
        <div style={{ marginTop: "6px" }}>
          <span style={{ color: "#888", fontSize: "11px", marginRight: "6px" }}>Dividends:</span>
          {[0, 0.05, 0.1, 0.25, 0.5, 1.0].map(rate => (
            <button
              key={rate}
              onClick={() => setCorpDividendRate(rate)}
              style={{
                background: Math.abs(status.dividendRate - rate) < 0.001 ? "#003366" : "#1a1a2e",
                color: Math.abs(status.dividendRate - rate) < 0.001 ? "#00ccff" : "#888",
                border: "1px solid #333",
                borderRadius: "3px",
                padding: "2px 6px",
                fontSize: "10px",
                cursor: "pointer",
                marginRight: "4px",
              }}
            >
              {(rate * 100).toFixed(0)}%
            </button>
          ))}
        </div>
      )}

      <div style={{ marginTop: "8px" }}>
        <button
          onClick={() => toggleCorpEnabled(!enabled)}
          style={{
            background: enabled ? "#330000" : "#003300",
            color: enabled ? "#ff4444" : "#00cc44",
            border: `1px solid ${enabled ? "#660000" : "#006600"}`,
            borderRadius: "3px",
            padding: "3px 10px",
            fontSize: "11px",
            cursor: "pointer",
          }}
        >
          {enabled ? "Disable Corp" : "Enable Corp"}
        </button>
      </div>
    </div>
  );
}

// === DETAIL PANEL ===

function CorpDetailPanel({
  status,
  running,
  toolId,
  pid,
}: DetailPanelProps<FormattedCorpStatus>): React.ReactElement {
  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <span style={styles.dim}>Corp daemon not running</span>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>{status.corpName || "Corp"}</span>
          <span style={styles.dim}>|</span>
          <span style={{ color: status.profit >= 0 ? "#00ff00" : "#ff4444", fontSize: "12px" }}>
            {status.profitFormatted}/s
          </span>
          <span style={styles.dim}>|</span>
          <span style={{ color: "#888", fontSize: "11px" }}>
            Funds: {status.fundsFormatted}
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Directive selector */}
      {status.exists && <DirectiveSelector status={status} />}

      {/* Countdown banner */}
      {status.pendingAction && <CountdownBanner action={status.pendingAction} />}

      {/* Status (always shown) */}
      <StatusSection status={status} />

      {/* Directive-contextual sections */}
      {status.directive === "bootstrap" && (
        <>
          <DivisionSetupSection status={status} />
          <UnlockChecklistSection status={status} />
          <BudgetSection status={status} />
          {status.divisions.length > 0 && <FinancialsSection status={status} />}
          <InvestmentSection status={status} />
        </>
      )}

      {status.directive === "scale" && (
        <>
          <FinancialsSection status={status} />
          <InvestmentSection status={status} />
          <UpgradesSection status={status} />
          <ProductPipelineSection status={status} />
          <DivisionPerformanceSection status={status} />
        </>
      )}

      {status.directive === "harvest" && (
        <>
          <FinancialsSection status={status} />
          <DividendSection status={status} />
          <ShareSection status={status} />
          <ProductPipelineSection status={status} />
          <DivisionPerformanceSection status={status} />
        </>
      )}

      {/* Settings (always shown) */}
      <SettingsSection status={status} />

      <TierFooter tier={status.tier} tierName={status.tierName} />
    </div>
  );
}

// === PLUGIN EXPORT ===

export const corpPlugin: ToolPlugin<FormattedCorpStatus> = {
  name: "CORP",
  id: "corp",
  script: "daemons/corp.js",
  OverviewCard: CorpOverviewCard,
  DetailPanel: CorpDetailPanel,
};
