/**
 * Darkweb Tool Plugin
 *
 * Displays darkweb program purchase status with TOR router info and program list.
 */
import React from "lib/react";
import { NS } from "@ns";
import { ToolPlugin, FormattedDarkwebStatus, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { getDarkwebStatus } from "/controllers/darkweb";

// === STATUS FORMATTING ===

function formatDarkwebStatus(ns: NS): FormattedDarkwebStatus | null {
  try {
    const raw = getDarkwebStatus(ns);
    const playerMoney = ns.getServerMoneyAvailable("home");

    const programs = raw.hasTorRouter
      ? ns.singularity.getDarkwebPrograms().map(name => {
          const cost = ns.singularity.getDarkwebProgramCost(name);
          return {
            name,
            cost,
            costFormatted: ns.format.number(cost),
            owned: ns.fileExists(name, "home"),
          };
        }).sort((a, b) => a.cost - b.cost)
      : [];

    const ownedCount = programs.filter(p => p.owned).length;
    const allOwned = programs.length > 0 && ownedCount === programs.length;

    const nextProgram = raw.nextProgram
      ? {
          name: raw.nextProgram.name,
          cost: raw.nextProgram.cost,
          costFormatted: ns.format.number(raw.nextProgram.cost),
        }
      : null;

    return {
      hasTorRouter: raw.hasTorRouter,
      ownedCount,
      totalPrograms: programs.length,
      nextProgram,
      moneyUntilNext: raw.moneyUntilNext,
      moneyUntilNextFormatted: ns.format.number(raw.moneyUntilNext),
      canAffordNext: nextProgram ? playerMoney >= nextProgram.cost : false,
      programs,
      allOwned,
    };
  } catch {
    return null;
  }
}

// === COMPONENTS ===

function DarkwebOverviewCard({ status, running, toolId, error, pid }: OverviewCardProps<FormattedDarkwebStatus>): React.ReactElement {
  const completed = !!status?.allOwned;
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>DARKWEB</span>
        <ToolControl tool={toolId} running={running} error={!!error} completed={completed} pid={pid} />
      </div>
      {error ? (
        <div style={{ color: "#ffaa00", fontSize: "11px" }}>{error}</div>
      ) : (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>TOR Router</span>
            <span style={status?.hasTorRouter ? styles.statHighlight : { color: "#888" }}>
              {status ? (status.hasTorRouter ? "INSTALLED" : "NOT OWNED") : "—"}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Programs</span>
            <span style={status?.allOwned ? styles.statHighlight : styles.statValue}>
              {status ? `${status.ownedCount}/${status.totalPrograms}` : "—"}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Next</span>
            {status?.nextProgram ? (
              <span style={status.canAffordNext ? styles.statHighlight : { color: "#888" }}>
                ${status.nextProgram.costFormatted}
              </span>
            ) : (
              <span style={styles.statHighlight}>
                {status ? "All Owned" : "—"}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function DarkwebDetailPanel({ status, running, toolId, error, pid }: DetailPanelProps<FormattedDarkwebStatus>): React.ReactElement {
  const completed = !!status?.allOwned;
  if (error) {
    return (
      <div style={styles.panel}>
        <ToolControl tool={toolId} running={running} error={true} completed={completed} pid={pid} />
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
            <span>
              <span style={styles.statLabel}>TOR Router: </span>
              <span style={{ color: "#888" }}>—</span>
            </span>
            <span style={styles.dim}>|</span>
            <span>
              <span style={styles.statLabel}>Programs: </span>
              <span style={styles.statValue}>—</span>
            </span>
          </div>
          <ToolControl tool={toolId} running={running} completed={completed} pid={pid} />
        </div>
        <div style={styles.card}>
          <div style={{ color: "#888" }}>Waiting for status...</div>
        </div>
      </div>
    );
  }

  if (!status.hasTorRouter) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span>
              <span style={styles.statLabel}>TOR Router: </span>
              <span style={{ color: "#ff4444" }}>NOT OWNED</span>
            </span>
          </div>
          <ToolControl tool={toolId} running={running} completed={completed} pid={pid} />
        </div>
        <div style={styles.card}>
          <div style={{ color: "#ffaa00", marginBottom: "8px" }}>
            TOR Router required to access darkweb programs.
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Cost</span>
            <span style={styles.statValue}>$200,000</span>
          </div>
        </div>
      </div>
    );
  }

  const unownedPrograms = status.programs.filter(p => !p.owned);
  const ownedPrograms = status.programs.filter(p => p.owned);

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span>
            <span style={styles.statLabel}>TOR: </span>
            <span style={styles.statHighlight}>INSTALLED</span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Programs: </span>
            <span style={status.allOwned ? styles.statHighlight : styles.statValue}>
              {status.ownedCount}/{status.totalPrograms}
            </span>
          </span>
        </div>
        <ToolControl tool={toolId} running={running} completed={completed} pid={pid} />
      </div>

      {/* All Programs Owned */}
      {status.allOwned && (
        <div style={{ ...styles.card, textAlign: "center" }}>
          <span style={styles.statHighlight}>All programs owned!</span>
        </div>
      )}

      {/* Next Program Info */}
      {status.nextProgram && !status.allOwned && (
        <div style={styles.card}>
          <div style={{ color: "#00ffff", fontSize: "12px", marginBottom: "8px" }}>
            NEXT PROGRAM: <span style={{ color: "#ffff00" }}>{status.nextProgram.name}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Cost</span>
            <span style={status.canAffordNext ? styles.statHighlight : { color: "#ff4444" }}>
              {status.canAffordNext ? "✓" : "✗"} ${status.nextProgram.costFormatted}
            </span>
          </div>
          {!status.canAffordNext && status.moneyUntilNext > 0 && (
            <div style={styles.stat}>
              <span style={styles.statLabel}>Need</span>
              <span style={{ color: "#ffaa00" }}>${status.moneyUntilNextFormatted} more</span>
            </div>
          )}
        </div>
      )}

      {/* Unowned Programs */}
      {unownedPrograms.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            UNOWNED PROGRAMS
            <span style={{ ...styles.dim, marginLeft: "8px", fontWeight: "normal" }}>
              {unownedPrograms.length} remaining
            </span>
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Program</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {unownedPrograms.map((program, i) => {
                const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                return (
                  <tr key={program.name} style={rowStyle}>
                    <td style={{ ...styles.tableCell, color: "#fff" }}>{program.name}</td>
                    <td style={{ ...styles.tableCell, textAlign: "right", color: "#ffaa00" }}>
                      ${program.costFormatted}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Owned Programs */}
      {ownedPrograms.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            OWNED PROGRAMS
            <span style={{ ...styles.dim, marginLeft: "8px", fontWeight: "normal" }}>
              {ownedPrograms.length} owned
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
            {ownedPrograms.map(program => (
              <span
                key={program.name}
                style={{
                  padding: "2px 8px",
                  backgroundColor: "#003300",
                  border: "1px solid #00aa00",
                  borderRadius: "3px",
                  fontSize: "11px",
                  color: "#00ff00",
                }}
              >
                {program.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// === PLUGIN EXPORT ===

export const darkwebPlugin: ToolPlugin<FormattedDarkwebStatus> = {
  name: "DARKWEB",
  id: "darkweb",
  script: "daemons/darkweb.js",
  getFormattedStatus: formatDarkwebStatus,
  OverviewCard: DarkwebOverviewCard,
  DetailPanel: DarkwebDetailPanel,
};
