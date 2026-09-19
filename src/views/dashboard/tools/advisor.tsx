/**
 * Advisor Tool Plugin
 *
 * Displays ranked recommendations from the advisor daemon.
 * OverviewCard shows top recommendation; DetailPanel shows full scored table.
 */
import React from "lib/react";
import { ToolPlugin, FormattedAdvisorStatus, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { AdvisorCategory, Recommendation } from "/types/ports";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";

// === HELPERS ===

function scoreColor(score: number): string {
  if (score >= 90) return "#ff4444";
  if (score >= 70) return "#ffaa00";
  if (score >= 50) return "#ffff00";
  if (score >= 30) return "#00ff00";
  return "#666";
}

const CATEGORY_COLORS: Record<AdvisorCategory, string> = {
  infrastructure: "#0088ff",
  money: "#00ff00",
  skills: "#ffff00",
  factions: "#ff88ff",
  augmentations: "#ff4444",
  gang: "#ff8800",
  endgame: "#00ffff",
};

function categoryColor(cat: AdvisorCategory): string {
  return CATEGORY_COLORS[cat] || "#888";
}

// === COMPONENTS ===

function AdvisorOverviewCard({ status, running, toolId, pid }: OverviewCardProps<FormattedAdvisorStatus>): React.ReactElement {
  const top = status?.recommendations?.[0];
  const count = status?.recommendations?.length ?? 0;

  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>ADVISOR</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      {top ? (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Top</span>
            <span style={{ color: scoreColor(top.score) }}>[{top.score}]</span>
          </div>
          <div style={{ color: "#fff", fontSize: "11px", marginBottom: "4px" }}>
            {top.title}
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Recs</span>
            <span style={styles.statValue}>{count}</span>
          </div>
        </>
      ) : (
        <div style={styles.stat}>
          <span style={styles.statLabel}>Status</span>
          <span style={styles.dim}>{running ? "Analyzing..." : "Stopped"}</span>
        </div>
      )}
    </div>
  );
}

function AdvisorDetailPanel({ status, running, toolId, pid }: DetailPanelProps<FormattedAdvisorStatus>): React.ReactElement {
  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={styles.statLabel}>Advisor</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        {!running ? (
          <>
            <div style={{ marginTop: "12px", color: "#ffaa00" }}>
              Advisor daemon not running.
            </div>
            <div style={{ ...styles.dim, marginTop: "8px", fontSize: "11px" }}>
              Click to start the daemon and get recommendations.
            </div>
          </>
        ) : (
          <div style={{ marginTop: "12px", color: "#ffaa00" }}>
            Waiting for analysis...
          </div>
        )}
      </div>
    );
  }

  const recs = status.recommendations;

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>Advisor</span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Recs: </span>
            <span style={styles.statHighlight}>{recs.length}</span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>Analysis: </span>
            <span style={styles.dim}>{status.lastAnalysisMs}ms</span>
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Recommendations Table */}
      {recs.length > 0 ? (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>RECOMMENDATIONS</div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.tableHeader, width: "40px", textAlign: "right" }}>Score</th>
                <th style={styles.tableHeader}>Recommendation</th>
                <th style={{ ...styles.tableHeader, width: "90px" }}>Category</th>
              </tr>
            </thead>
            <tbody>
              {recs.map((rec: Recommendation, i: number) => {
                const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                return (
                  <tr key={rec.id} style={rowStyle}>
                    <td style={{ ...styles.tableCell, textAlign: "right", color: scoreColor(rec.score), fontWeight: "bold" }}>
                      {rec.score}
                    </td>
                    <td style={styles.tableCell}>
                      <div style={{ color: "#fff" }}>{rec.title}</div>
                      <div style={{ color: "#888", fontSize: "11px" }}>{rec.reason}</div>
                    </td>
                    <td style={{ ...styles.tableCell, color: categoryColor(rec.category), fontSize: "11px" }}>
                      {rec.category}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ marginTop: "12px", color: "#00ff00", textAlign: "center" }}>
          No recommendations — all systems nominal
        </div>
      )}

      {/* Category Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginTop: "12px" }}>
        {(Object.keys(CATEGORY_COLORS) as AdvisorCategory[]).map(cat => (
          <div key={cat} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <div style={{ width: "8px", height: "8px", borderRadius: "2px", backgroundColor: categoryColor(cat) }} />
            <span style={{ color: "#888", fontSize: "10px" }}>{cat}</span>
          </div>
        ))}
      </div>

      {/* Score Legend */}
      <div style={{ ...styles.dim, marginTop: "8px", fontSize: "10px" }}>
        Score: <span style={{ color: "#ff4444" }}>90-100</span> Critical |{" "}
        <span style={{ color: "#ffaa00" }}>70-89</span> High |{" "}
        <span style={{ color: "#ffff00" }}>50-69</span> Medium |{" "}
        <span style={{ color: "#00ff00" }}>30-49</span> Normal
      </div>
    </div>
  );
}

// === PLUGIN EXPORT ===

export const advisorPlugin: ToolPlugin<FormattedAdvisorStatus> = {
  name: "ADVISOR",
  id: "advisor",
  script: "daemons/advisor.js",
  OverviewCard: AdvisorOverviewCard,
  DetailPanel: AdvisorDetailPanel,
};
