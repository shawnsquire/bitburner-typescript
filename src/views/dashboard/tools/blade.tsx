/**
 * Bladeburner Tool Plugin
 *
 * Dashboard OverviewCard and DetailPanel for the Bladeburner daemon.
 * Reads status from the blade status port.
 */
import React from "lib/react";
import { ToolPlugin, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { TierFooter } from "views/dashboard/components/TierFooter";
import { ProgressBar } from "views/dashboard/components/ProgressBar";
import { BladeburnerStatus, BladeActionInfo } from "/types/ports";
import { buyBladeSkill, buyAllBladeSkills, setBladeConfig } from "views/dashboard/state-store";

const { useState } = React;

// === HELPERS ===

function successColor(min: number): string {
  if (min >= 90) return "#00ff00";
  if (min >= 70) return "#ffff00";
  if (min >= 50) return "#ffaa00";
  return "#ff4444";
}

function actionTypeColor(type: BladeburnerStatus["currentActionType"]): string {
  switch (type) {
    case "operation": return "#00ffff";
    case "contract": return "#ffff00";
    case "blackop": return "#ff00ff";
    case "general": return "#888";
    case "idle": return "#555";
    default: return "#888";
  }
}

// === STYLES ===

const sectionHeaderStyle: React.CSSProperties = {
  color: "#00ffff",
  fontSize: "11px",
  marginBottom: "4px",
  marginTop: "12px",
  cursor: "pointer",
  userSelect: "none",
};

const configGroupHeaderStyle: React.CSSProperties = {
  color: "#666",
  fontSize: "10px",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  marginTop: "8px",
  marginBottom: "2px",
  borderBottom: "1px solid #222",
  paddingBottom: "1px",
};

const tableRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "1px 0",
  fontSize: "11px",
};

const settingInputStyle: React.CSSProperties = {
  backgroundColor: "#1a1a1a",
  color: "#00ff00",
  border: "1px solid #333",
  borderRadius: "3px",
  padding: "1px 4px",
  fontSize: "11px",
  fontFamily: "inherit",
  width: "60px",
  textAlign: "right",
};

const buyBtnStyle: React.CSSProperties = {
  backgroundColor: "#003300",
  color: "#00ff00",
  border: "1px solid #005500",
  borderRadius: "3px",
  padding: "1px 8px",
  fontSize: "10px",
  fontFamily: "inherit",
  cursor: "pointer",
};

const buyAllBtnStyle: React.CSSProperties = {
  backgroundColor: "#002244",
  color: "#44aaff",
  border: "1px solid #004488",
  borderRadius: "3px",
  padding: "1px 8px",
  fontSize: "10px",
  fontFamily: "inherit",
  cursor: "pointer",
};

// === COLLAPSIBLE SECTION ===

function Section({ title, defaultOpen, children }: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div>
      <div
        style={sectionHeaderStyle}
        onClick={() => setOpen(!open)}
      >
        {open ? "▾" : "▸"} {title}
      </div>
      {open && children}
    </div>
  );
}

// === CONFIG CONTROLS ===

function ConfigNumber({ label, value, configKey, suffix, min, max, step }: {
  label: string;
  value: number;
  configKey: string;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
}): React.ReactElement {
  return (
    <div style={{ ...tableRowStyle, alignItems: "center" }}>
      <span style={{ color: "#888" }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <input
          type="number"
          style={settingInputStyle}
          defaultValue={String(value)}
          key={value}
          min={min ?? 0}
          max={max}
          step={step ?? 1}
          onBlur={(e) => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            if (!isNaN(v) && v !== value) setBladeConfig(configKey, v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = parseFloat((e.target as HTMLInputElement).value);
              if (!isNaN(v) && v !== value) setBladeConfig(configKey, v);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {suffix && <span style={{ color: "#555", fontSize: "10px" }}>{suffix}</span>}
      </span>
    </div>
  );
}

function ConfigGroup({ title, children }: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <div style={configGroupHeaderStyle}>{title}</div>
      {children}
    </div>
  );
}

// === ACTION TABLE ===

const actionGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto auto",
  gap: "1px 10px",
  fontSize: "11px",
  alignItems: "baseline",
};

function ActionTable({ actions, label }: {
  actions: BladeActionInfo[];
  label: string;
}): React.ReactElement {
  const active = actions.filter(a => a.count > 0);
  if (active.length === 0) {
    return <div style={{ color: "#555", fontSize: "11px" }}>No {label.toLowerCase()} available</div>;
  }
  return (
    <div style={actionGridStyle}>
      {active.map(a => (
        <React.Fragment key={a.name}>
          <span style={{ color: "#ccc" }}>{a.name}</span>
          <span style={{ color: successColor(a.successMin), textAlign: "right" }}>{a.successFormatted}</span>
          <span style={{ color: "#555", textAlign: "right" }}>×{Math.floor(a.count)}</span>
          <span style={{ color: "#555", textAlign: "right" }}>{a.timeFormatted}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// === OVERVIEW CARD ===

function BladeOverviewCard({
  status,
  running,
  toolId,
  error,
  pid,
}: OverviewCardProps<BladeburnerStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>BLADE</span>
        <ToolControl tool={toolId} running={running} error={!!error} pid={pid} />
      </div>
      {error ? (
        <div style={{ color: "#ffaa00", fontSize: "11px" }}>{error}</div>
      ) : !status || !running ? (
        <div style={{ color: "#888", fontSize: "11px" }}>Offline</div>
      ) : !status.inBladeburner ? (
        <div style={{ color: "#888", fontSize: "11px" }}>Not in Bladeburner</div>
      ) : (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Rank</span>
            <span style={styles.statHighlight}>{status.rankFormatted}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Stamina</span>
            <span style={{ color: status.staminaPercent > 50 ? "#00ff00" : "#ffaa00", fontSize: "11px" }}>
              {status.staminaPercent.toFixed(0)}%
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Action</span>
            <span style={{ color: actionTypeColor(status.currentActionType), fontSize: "11px" }}>
              {status.currentAction}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// === DETAIL PANEL ===

function BladeDetailPanel({
  status,
  running,
  toolId,
  error,
  pid,
}: DetailPanelProps<BladeburnerStatus>): React.ReactElement {
  if (error) {
    return (
      <div style={styles.panel}>
        <ToolControl tool={toolId} running={running} error={true} pid={pid} />
        <div style={{ color: "#ffaa00", marginTop: "12px" }}>{error}</div>
      </div>
    );
  }

  if (!status || !running) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}><span style={styles.statLabel}>Bladeburner</span></div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        <div style={{ color: "#888", marginTop: "12px" }}>Daemon not running</div>
      </div>
    );
  }

  if (!status.inBladeburner) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}><span style={styles.statLabel}>Bladeburner</span></div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        <div style={{ color: "#ffaa00", marginTop: "12px" }}>Not in Bladeburner division</div>
        <div style={{ color: "#888", fontSize: "11px", marginTop: "4px" }}>
          Requires 100 in all combat stats to join
        </div>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>City: </span>
          <span style={styles.statValue}>{status.city}</span>
          <span style={{ color: "#555", marginLeft: "8px", fontSize: "11px" }}>
            Chaos: {status.cityChaosFormatted} | Pop: {status.cityPopulationFormatted}
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Focus Yielding Banner */}
      {status.focusYielding && (
        <div style={{
          backgroundColor: "rgba(255, 170, 0, 0.1)",
          border: "1px solid #ffaa00",
          borderRadius: "4px",
          padding: "8px 12px",
          marginBottom: "8px",
        }}>
          <span style={{ color: "#ffaa00", fontSize: "12px" }}>
            Yielding focus to another daemon
          </span>
        </div>
      )}

      {/* Summary Card */}
      <div style={styles.card}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
          <div>
            <span style={styles.statLabel}>Rank </span>
            <span style={{ color: "#00ff00", fontSize: "14px", fontWeight: "bold" }}>{status.rankFormatted}</span>
          </div>
          <div>
            <span style={styles.statLabel}>SP </span>
            <span style={styles.statValue}>{status.skillPointsFormatted}</span>
          </div>
          {status.bonusTime > 1000 && (
            <div>
              <span style={styles.statLabel}>Bonus </span>
              <span style={{ color: "#00aaff", fontSize: "11px" }}>{status.bonusTimeFormatted}</span>
            </div>
          )}
        </div>

        {/* Stamina bar */}
        <ProgressBar
          progress={status.staminaPercent / 100}
          label={`Stamina: ${status.staminaFormatted} (${status.staminaPercent.toFixed(0)}%)`}
          fillColor={status.staminaPercent > 50 ? "#00aa00" : "#ffaa00"}
        />

        {/* Current action */}
        <div style={{ marginTop: "6px" }}>
          <span style={styles.statLabel}>Action: </span>
          <span style={{ color: actionTypeColor(status.currentActionType), fontSize: "12px" }}>
            {status.currentAction}
          </span>
        </div>

        {/* Recommended action */}
        {status.recommendedAction && (
          <div>
            <span style={styles.statLabel}>Next: </span>
            <span style={{ color: "#00ff00", fontSize: "11px" }}>{status.recommendedAction}</span>
          </div>
        )}
      </div>

      {/* Next Black Op */}
      {status.nextBlackOp && (
        <div style={{
          ...styles.card,
          borderLeft: status.nextBlackOp.rankMet ? "2px solid #ff00ff" : "2px solid #555",
        }}>
          <div style={{ color: "#ff00ff", fontSize: "11px", marginBottom: "4px" }}>NEXT BLACK OP</div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "#ccc", fontSize: "12px" }}>{status.nextBlackOp.name}</span>
            <span style={{ color: successColor(status.nextBlackOp.successMin), fontSize: "11px" }}>
              {status.nextBlackOp.successFormatted}
            </span>
          </div>
          <div style={{ fontSize: "11px", color: status.nextBlackOp.rankMet ? "#00ff00" : "#ff4444" }}>
            Rank req: {status.nextBlackOp.rankRequired.toLocaleString()}
            {status.nextBlackOp.rankMet ? " ✓" : ` (need ${(status.nextBlackOp.rankRequired - status.rank).toLocaleString()} more)`}
          </div>
        </div>
      )}
      {status.nextBlackOp === null && (
        <div style={{ ...styles.card, borderLeft: "2px solid #00ff00" }}>
          <div style={{ color: "#00ff00", fontSize: "12px" }}>All Black Ops Complete!</div>
        </div>
      )}

      {/* Operations */}
      {status.operations && (
        <Section title="OPERATIONS" defaultOpen={true}>
          <ActionTable actions={status.operations} label="Operations" />
        </Section>
      )}

      {/* Contracts */}
      {status.contracts && (
        <Section title="CONTRACTS" defaultOpen={false}>
          <ActionTable actions={status.contracts} label="Contracts" />
        </Section>
      )}

      {/* Skills */}
      {status.skills && (
        <Section title="SKILLS" defaultOpen={false}>
          {status.recommendedSkill && (
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "4px 0",
              marginBottom: "4px",
              borderBottom: "1px solid #333",
            }}>
              <span style={{ color: "#00ff00", fontSize: "11px" }}>
                Recommended: {status.recommendedSkill.name} ({status.recommendedSkill.costFormatted} SP)
              </span>
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  style={buyBtnStyle}
                  onClick={() => buyBladeSkill(status.recommendedSkill!.name)}
                >
                  Buy
                </button>
                <button
                  style={buyAllBtnStyle}
                  onClick={() => buyAllBladeSkills()}
                >
                  Buy All
                </button>
              </div>
            </div>
          )}
          {status.skills.map(s => (
            <div key={s.name} style={tableRowStyle}>
              <span style={{ color: "#ccc" }}>{s.name}</span>
              <span>
                <span style={styles.statValue}>Lv {s.level}</span>
                <span style={{ color: "#555", marginLeft: "8px" }}>{s.upgradeCostFormatted} SP</span>
              </span>
            </div>
          ))}
        </Section>
      )}

      {/* Cities */}
      {status.cities && (
        <Section title="CITIES" defaultOpen={false}>
          {status.cities.map(c => (
            <div key={c.name} style={{
              ...tableRowStyle,
              fontWeight: c.name === status.city ? "bold" : "normal",
              color: c.name === status.city ? "#00ff00" : "#ccc",
            }}>
              <span>{c.name}{c.name === status.city ? " ◄" : ""}</span>
              <span style={{ color: "#888" }}>
                Pop: {c.populationFormatted} | Chaos: {c.chaosFormatted} | Com: {c.communities}
              </span>
            </div>
          ))}
        </Section>
      )}

      {/* BB Faction Rep */}
      {status.bladeburnerFactionRep !== undefined && (
        <Section title="FACTION REP" defaultOpen={false}>
          <div style={tableRowStyle}>
            <span style={{ color: "#ccc" }}>Bladeburners</span>
            <span style={styles.statValue}>{status.bladeburnerFactionRepFormatted}</span>
          </div>
          {status.bladeburnerAugs && status.bladeburnerAugs.map(a => (
            <div key={a.name} style={tableRowStyle}>
              <span style={{ color: a.owned ? "#555" : "#ccc", textDecoration: a.owned ? "line-through" : "none" }}>
                {a.name}
              </span>
              <span style={{ color: a.owned ? "#555" : "#ffaa00", fontSize: "11px" }}>
                {a.repReqFormatted}
              </span>
            </div>
          ))}
        </Section>
      )}

      {/* Config */}
      {status.config && (
        <Section title="CONFIG" defaultOpen={false}>
          <ConfigGroup title="Action thresholds">
            <ConfigNumber label="Operation min" value={status.config.operationThreshold} configKey="operationThreshold" suffix="%" min={0} max={100} />
            <ConfigNumber label="Black Op min" value={status.config.blackOpThreshold} configKey="blackOpThreshold" suffix="%" min={0} max={100} />
            <ConfigNumber label="Contract min" value={status.config.contractThreshold} configKey="contractThreshold" suffix="%" min={0} max={100} />
          </ConfigGroup>
          <ConfigGroup title="Stamina">
            <ConfigNumber label="Rest below" value={status.config.staminaMinPercent} configKey="staminaMinPercent" suffix="%" min={0} max={100} />
            <ConfigNumber label="Resume above" value={status.config.staminaRestoreTo} configKey="staminaRestoreTo" suffix="%" min={0} max={100} />
            <ConfigNumber label="Train until max" value={status.config.staminaTrainMax} configKey="staminaTrainMax" min={0} />
          </ConfigGroup>
          <ConfigGroup title="Chaos / Diplomacy">
            <ConfigNumber label="Trigger above" value={status.config.chaosMax} configKey="chaosMax" min={0} />
            <ConfigNumber label="Reduce until" value={status.config.chaosTarget} configKey="chaosTarget" min={0} />
          </ConfigGroup>
          <ConfigGroup title="Other">
            <ConfigNumber label="Field Analysis spread" value={status.config.successSpreadMax} configKey="successSpreadMax" suffix="%" min={0} max={100} />
            <ConfigNumber label="Switch city below pop" value={status.config.populationMin} configKey="populationMin" min={0} step={100000} />
          </ConfigGroup>
        </Section>
      )}

      {/* Tier Footer */}
      <TierFooter
        tier={status.tier}
        tierName={status.tierName}
        currentRamUsage={status.currentRamUsage}
      />
    </div>
  );
}

// === PLUGIN EXPORT ===

export const bladePlugin: ToolPlugin<BladeburnerStatus> = {
  name: "BLADE",
  id: "blade",
  script: "daemons/blade.js",
  OverviewCard: BladeOverviewCard,
  DetailPanel: BladeDetailPanel,
};
