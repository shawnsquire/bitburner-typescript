/**
 * Budget Tool Plugin (Snapshot Allowance Model)
 *
 * OverviewCard shows net worth, active bucket count, rush indicator.
 * DetailPanel shows allowance bars, bucket table, rush toggle, weight settings.
 */
import React from "lib/react";
import {
  ToolPlugin,
  FormattedBudgetStatus,
  OverviewCardProps,
  DetailPanelProps,
} from "views/dashboard/types";
import { BucketState } from "/types/ports";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { ProgressBar } from "views/dashboard/components/ProgressBar";
import { formatTime } from "lib/utils";
import {
  rushBudgetBucket,
  cancelBudgetRush,
  freezeBudgetBucket,
  unfreezeBudgetBucket,
  updateBudgetWeight,
  resetBudgetWeights,
  runScript,
} from "views/dashboard/state-store";

// === SETTINGS INPUT STYLE ===

const settingInputStyle: React.CSSProperties = {
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

/** Editable number input. Commits on blur or Enter. */
function EditableNumber({ value, onCommit, min, max, step }: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}): React.ReactElement {
  return (
    <input
      type="number"
      style={settingInputStyle}
      defaultValue={String(value)}
      key={value}
      min={min}
      max={max}
      step={step ?? 1}
      onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
        const v = parseInt(e.target.value, 10);
        if (!isNaN(v) && v !== value) onCommit(v);
      }}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          const v = parseInt((e.target as HTMLInputElement).value, 10);
          if (!isNaN(v) && v !== value) onCommit(v);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

// === OVERVIEW CARD ===

function BudgetOverviewCard({
  status,
  running,
  toolId,
  pid,
}: OverviewCardProps<FormattedBudgetStatus>): React.ReactElement {
  const activeCount = status
    ? Object.values(status.buckets).filter((b: BucketState) => b.active).length
    : 0;
  const totalCount = status ? Object.keys(status.buckets).length : 0;

  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>BUDGET</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      {status ? (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Net Worth</span>
            <span style={{ color: "#00ff00" }}>{status.netWorthFormatted}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Buckets</span>
            <span style={styles.statValue}>{activeCount}/{totalCount}</span>
          </div>
          {status.rushBucket && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Rush</span>
              <span style={{ color: "#ffaa00" }}>{status.rushBucket}</span>
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

const barColors: Record<string, string> = {
  stocks: "#0088ff",
  servers: "#00cc44",
  gang: "#ff4444",
  corp: "#ff8800",
  home: "#44cc88",
  hacknet: "#ffaa00",
  programs: "#aa44ff",
  "wse-access": "#44aaff",
};

function getBarColor(bucket: string): string {
  return barColors[bucket] ?? "#888";
}

function BudgetDetailPanel({
  status,
  running,
  toolId,
  pid,
}: DetailPanelProps<FormattedBudgetStatus>): React.ReactElement {
  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={styles.statLabel}>Budget</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        {!running ? (
          <>
            <div style={{ marginTop: "12px", color: "#ffaa00" }}>
              Budget daemon not running.
            </div>
            <div style={{ ...styles.dim, marginTop: "8px", fontSize: "11px" }}>
              Consumers will assume unlimited budget (graceful fallback).
            </div>
          </>
        ) : (
          <div style={{ marginTop: "12px", color: "#ffaa00" }}>
            Waiting for first update...
          </div>
        )}
      </div>
    );
  }

  const allBuckets = Object.values(status.buckets) as BucketState[];
  allBuckets.sort((a, b) => b.allowance - a.allowance);

  const maxAllowance = Math.max(...allBuckets.map(b => b.allowance), 1);

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>Budget</span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Cash: </span>
            <span style={{ color: "#00ff00" }}>{status.totalCashFormatted}</span>
          </span>
          {status.portfolioValue > 0 && (
            <>
              <span style={styles.dim}>|</span>
              <span>
                <span style={styles.statLabel}>Portfolio: </span>
                <span style={{ color: "#0088ff" }}>{status.portfolioValueFormatted}</span>
              </span>
            </>
          )}
          {status.corpFunds > 0 && (
            <>
              <span style={styles.dim}>|</span>
              <span>
                <span style={styles.statLabel}>Corp: </span>
                <span style={{ color: "#ff8800" }}>{status.corpFundsFormatted}</span>
              </span>
            </>
          )}
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>NW: </span>
            <span style={{ color: "#00ff00", fontWeight: "bold" }}>{status.netWorthFormatted}</span>
          </span>
          {status.incomePerSecFormatted && (
            <>
              <span style={styles.dim}>|</span>
              <span>
                <span style={styles.statLabel}>Income: </span>
                <span style={{ color: "#88ff88" }}>{status.incomePerSecFormatted}</span>
                <span style={styles.dim}> ({status.incomeSource})</span>
              </span>
            </>
          )}
          {status.rushBucket && (
            <>
              <span style={styles.dim}>|</span>
              <span style={{ color: "#ffaa00" }}>RUSH: {status.rushBucket}</span>
            </>
          )}
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Savings goal: the cheapest pending next purchase the daemon is reserving cash for */}
      {status.goal && (
        <div style={{ marginTop: "12px" }}>
          <div style={styles.sectionTitle}>SAVING FOR</div>
          <div style={{ fontSize: "12px", marginBottom: "4px" }}>
            <span style={{ color: getBarColor(status.goal.bucket), fontWeight: "bold" }}>{status.goal.label}</span>
            <span style={styles.dim}> ({status.goal.bucket})</span>
            {status.goal.granted ? (
              <span style={{ color: "#00ff00", marginLeft: "8px" }}>GRANTED</span>
            ) : (
              <span style={{ color: "#aaa", marginLeft: "8px" }}>
                ETA {status.goal.etaSec !== undefined && isFinite(status.goal.etaSec) ? formatTime(status.goal.etaSec) : "unknown"}
              </span>
            )}
          </div>
          <ProgressBar
            progress={status.goal.progress}
            label={`${status.goal.reservedFormatted} / ${status.goal.costFormatted}`}
            fillColor={status.goal.granted ? "#00aa00" : getBarColor(status.goal.bucket)}
          />
        </div>
      )}

      {/* Allowance Bar Chart */}
      <div style={{ marginTop: "12px" }}>
        <div style={styles.sectionTitle}>ALLOWANCES</div>
        {allBuckets.map((b: BucketState) => {
          const barWidth = maxAllowance > 0 ? Math.max(1, (b.allowance / maxAllowance) * 100) : 0;
          const color = b.active ? getBarColor(b.bucket) : "#555";
          return (
            <div key={b.bucket} style={{ display: "flex", alignItems: "center", marginBottom: "3px", gap: "8px" }}>
              <span style={{ width: "80px", fontSize: "11px", color: b.active ? "#ddd" : "#666", textAlign: "right" }}>
                {b.bucket}
              </span>
              <div style={{ flex: 1, height: "14px", background: "#222", borderRadius: "2px", overflow: "hidden" }}>
                <div style={{
                  width: `${barWidth}%`,
                  height: "100%",
                  background: color,
                  opacity: b.active ? 1 : 0.4,
                  borderRadius: "2px",
                }} />
              </div>
              <span style={{ width: "70px", fontSize: "11px", color: b.active ? "#fff" : "#666", textAlign: "right" }}>
                {b.allowanceFormatted}
              </span>
            </div>
          );
        })}
      </div>

      {/* Bucket Table */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>DETAILS ({allBuckets.length})</div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.tableHeader}>Bucket</th>
              <th style={{ ...styles.tableHeader, width: "80px", textAlign: "right" }}>Allowance</th>
              <th style={{ ...styles.tableHeader, width: "70px", textAlign: "right" }}>Holding</th>
              <th style={{ ...styles.tableHeader, width: "70px", textAlign: "right" }}>Lifetime</th>
              <th style={{ ...styles.tableHeader, width: "120px" }}>Next</th>
              <th style={{ ...styles.tableHeader, width: "50px", textAlign: "right" }}>Weight</th>
              <th style={{ ...styles.tableHeader, width: "60px", textAlign: "center" }}>Status</th>
              <th style={{ ...styles.tableHeader, width: "40px", textAlign: "center" }}>Freeze</th>
              <th style={{ ...styles.tableHeader, width: "50px", textAlign: "center" }}>Rush</th>
            </tr>
          </thead>
          <tbody>
            {allBuckets.map((b: BucketState, i: number) => {
              const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
              const statusLabel = !b.active ? "Done" : b.frozen ? "Frozen" : status.rushBucket === b.bucket ? "Rush" : "Active";
              const statusColor = !b.active ? "#666" : b.frozen ? "#4488ff" : status.rushBucket === b.bucket ? "#ffaa00" : "#00ff00";
              const isRushed = status.rushBucket === b.bucket;

              return (
                <tr key={b.bucket} style={rowStyle}>
                  <td style={{ ...styles.tableCell, color: getBarColor(b.bucket) }}>
                    {b.bucket}
                    {b.isHolder && <span style={{ color: "#888", fontSize: "10px", marginLeft: "4px" }}>H</span>}
                  </td>
                  <td style={{ ...styles.tableCell, textAlign: "right", color: b.allowance > 0 ? "#00ff00" : "#888" }}>
                    {b.allowanceFormatted}
                  </td>
                  <td style={{ ...styles.tableCell, textAlign: "right", color: b.isHolder && b.currentHolding > 0 ? "#0088ff" : "#555" }}>
                    {b.isHolder ? b.currentHoldingFormatted : "\u2014"}
                  </td>
                  <td style={{ ...styles.tableCell, textAlign: "right", color: "#888" }}>
                    {b.lifetimeSpentFormatted}
                  </td>
                  <td style={{
                    ...styles.tableCell,
                    fontSize: "11px",
                    color: status.goal?.bucket === b.bucket ? "#ffaa00" : b.nextLabel ? "#aaa" : "#555",
                  }}>
                    {b.nextLabel ? `${b.nextLabel} (${b.nextCostFormatted})` : "\u2014"}
                  </td>
                  <td style={{ ...styles.tableCell, textAlign: "right", color: "#ddd" }}>
                    {b.weight}%
                  </td>
                  <td style={{ ...styles.tableCell, textAlign: "center", color: statusColor, fontSize: "11px" }}>
                    {statusLabel}
                  </td>
                  <td style={{ ...styles.tableCell, textAlign: "center" }}>
                    {b.active && (
                      <span
                        style={{
                          cursor: "pointer",
                          color: b.frozen ? "#4488ff" : "#555",
                          fontSize: "14px",
                        }}
                        onClick={() => {
                          if (b.frozen) {
                            unfreezeBudgetBucket(b.bucket);
                          } else {
                            freezeBudgetBucket(b.bucket);
                          }
                        }}
                      >
                        {b.frozen ? "\u2744" : "\u25CB"}
                      </span>
                    )}
                  </td>
                  <td style={{ ...styles.tableCell, textAlign: "center" }}>
                    {b.active && !b.frozen && (
                      <span
                        style={{
                          cursor: "pointer",
                          color: isRushed ? "#ffaa00" : "#555",
                          fontSize: "14px",
                        }}
                        onClick={() => {
                          if (isRushed) {
                            cancelBudgetRush();
                          } else {
                            rushBudgetBucket(b.bucket);
                          }
                        }}
                      >
                        {isRushed ? "\u26A1" : "\u25CB"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>ACTIONS</div>
        <button
          style={{
            backgroundColor: "#2a1a1a",
            color: "#ff6644",
            border: "1px solid #ff4422",
            borderRadius: "3px",
            padding: "4px 12px",
            fontSize: "12px",
            fontFamily: "inherit",
            cursor: "pointer",
          }}
          onClick={() => runScript("budget", "actions/firesale.js")}
        >
          FIRESALE
        </button>
        <span style={{ ...styles.dim, marginLeft: "8px", fontSize: "11px" }}>
          Sell stocks, kill spenders, switch to drain mode
        </span>
      </div>

      {/* Settings */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>SETTINGS</div>

        <div style={{
          marginBottom: "8px",
          fontSize: "11px",
          color: "#888",
        }}>
          Weights are independent caps (% of cash for spenders, % of net worth for holders)
        </div>

        {/* Per-bucket weight editors */}
        {allBuckets.map((b: BucketState) => (
          <div key={b.bucket} style={{ ...styles.stat, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ ...styles.statLabel, color: getBarColor(b.bucket) }}>
              {b.bucket}
              {b.isHolder && <span style={{ color: "#666", fontSize: "10px", marginLeft: "4px" }}>(NW)</span>}
            </span>
            <EditableNumber
              value={b.weight}
              onCommit={(v) => { if (running) updateBudgetWeight(b.bucket, v); }}
              min={0}
              step={5}
            />
          </div>
        ))}

        {/* Reset Defaults button */}
        <div style={{ marginTop: "8px" }}>
          <button
            style={{
              backgroundColor: "#1a1a1a",
              color: "#888",
              border: "1px solid #444",
              borderRadius: "3px",
              padding: "2px 8px",
              fontSize: "11px",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
            onClick={() => { if (running) resetBudgetWeights(); }}
          >
            Reset Defaults
          </button>
        </div>
      </div>
    </div>
  );
}

// === PLUGIN EXPORT ===

export const budgetPlugin: ToolPlugin<FormattedBudgetStatus> = {
  name: "BUDGET",
  id: "budget",
  script: "daemons/budget.js",
  OverviewCard: BudgetOverviewCard,
  DetailPanel: BudgetDetailPanel,
};
