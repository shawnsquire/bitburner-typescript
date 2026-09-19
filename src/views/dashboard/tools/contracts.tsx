/**
 * Contracts Tool Plugin
 *
 * OverviewCard shows solved/failed/pending counts and solver coverage.
 * DetailPanel shows pending contracts table + recent results table.
 */
import React from "lib/react";
import {
  ToolPlugin,
  FormattedContractsStatus,
  OverviewCardProps,
  DetailPanelProps,
} from "views/dashboard/types";
import { ContractResult, PendingContract } from "/types/ports";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { forceContractAttempt } from "views/dashboard/state-store";

// === OVERVIEW CARD ===

function ContractsOverviewCard({
  status,
  running,
  toolId,
  pid,
}: OverviewCardProps<FormattedContractsStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>CONTRACTS</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      {status ? (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Solved</span>
            <span style={{ color: "#00ff00" }}>{status.solved}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Failed</span>
            <span style={{ color: status.failed > 0 ? "#ff4444" : "#888" }}>{status.failed}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Pending</span>
            <span style={styles.statValue}>{status.pendingContracts.length}</span>
          </div>
        </>
      ) : (
        <div style={styles.stat}>
          <span style={styles.statLabel}>Status</span>
          <span style={styles.dim}>{running ? "Scanning..." : "Stopped"}</span>
        </div>
      )}
    </div>
  );
}

// === DETAIL PANEL ===

function ContractsDetailPanel({
  status,
  running,
  toolId,
  pid,
}: DetailPanelProps<FormattedContractsStatus>): React.ReactElement {
  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={styles.statLabel}>Contracts</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        {!running ? (
          <>
            <div style={{ marginTop: "12px", color: "#ffaa00" }}>
              Contracts daemon not running.
            </div>
            <div style={{ ...styles.dim, marginTop: "8px", fontSize: "11px" }}>
              Click to start scanning for coding contracts.
            </div>
          </>
        ) : (
          <div style={{ marginTop: "12px", color: "#ffaa00" }}>
            Waiting for first scan...
          </div>
        )}
      </div>
    );
  }

  const pending = status.pendingContracts;
  const recent = status.recentResults;

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>Contracts</span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Solved: </span>
            <span style={{ color: "#00ff00" }}>{status.solved}</span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Failed: </span>
            <span style={{ color: status.failed > 0 ? "#ff4444" : "#888" }}>{status.failed}</span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Found: </span>
            <span style={styles.statValue}>{status.found}</span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Solvers: </span>
            <span style={{ color: status.knownTypes === status.totalTypes ? "#00ff00" : "#ffaa00" }}>
              {status.knownTypes}/{status.totalTypes}
            </span>
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Scan Info */}
      <div style={{ ...styles.dim, fontSize: "10px", marginTop: "4px" }}>
        Scanned {status.serversScanned} servers in {status.lastScanTime}ms
      </div>

      {/* Pending Contracts */}
      {pending.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>PENDING ({pending.length})</div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Host</th>
                <th style={styles.tableHeader}>Type</th>
                <th style={{ ...styles.tableHeader, width: "50px", textAlign: "right" }}>Tries</th>
                <th style={{ ...styles.tableHeader, width: "80px" }}>Reason</th>
                <th style={{ ...styles.tableHeader, width: "50px" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((c: PendingContract, i: number) => {
                const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                const reasonColor =
                  c.reason === "no solver" ? "#ff8800"
                    : c.reason === "low tries" ? "#ff4444"
                    : "#ffaa00";
                return (
                  <tr key={`${c.host}:${c.file}`} style={rowStyle}>
                    <td style={{ ...styles.tableCell, color: "#0088ff" }}>{c.host}</td>
                    <td style={styles.tableCell}>{c.type}</td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>{c.triesRemaining}</td>
                    <td style={{ ...styles.tableCell, color: reasonColor }}>{c.reason}</td>
                    <td style={styles.tableCell}>
                      {c.reason === "low tries" && running && (
                        <button
                          style={{
                            background: "transparent",
                            border: "1px solid #ffaa00",
                            color: "#ffaa00",
                            cursor: "pointer",
                            padding: "1px 6px",
                            fontSize: "10px",
                          }}
                          onClick={() => forceContractAttempt(c.host, c.file)}
                        >
                          Force
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Results */}
      {recent.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>RECENT RESULTS ({recent.length})</div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.tableHeader, width: "50px" }}>Result</th>
                <th style={styles.tableHeader}>Host</th>
                <th style={styles.tableHeader}>Type</th>
                <th style={styles.tableHeader}>Reward</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r: ContractResult, i: number) => {
                const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                return (
                  <tr key={`${r.host}:${r.file}:${r.timestamp}`} style={rowStyle}>
                    <td style={{ ...styles.tableCell, color: r.success ? "#00ff00" : "#ff4444", fontWeight: "bold" }}>
                      {r.success ? "OK" : "FAIL"}
                    </td>
                    <td style={{ ...styles.tableCell, color: "#0088ff" }}>{r.host}</td>
                    <td style={styles.tableCell}>{r.type}</td>
                    <td style={{ ...styles.tableCell, color: r.success ? "#00ff00" : "#888" }}>
                      {r.reward || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {pending.length === 0 && recent.length === 0 && (
        <div style={{ marginTop: "12px", color: "#00ff00", textAlign: "center" }}>
          No pending contracts — all clear
        </div>
      )}
    </div>
  );
}

// === PLUGIN EXPORT ===

export const contractsPlugin: ToolPlugin<FormattedContractsStatus> = {
  name: "CONTRACTS",
  id: "contracts",
  script: "daemons/contracts.js",
  OverviewCard: ContractsOverviewCard,
  DetailPanel: ContractsDetailPanel,
};
