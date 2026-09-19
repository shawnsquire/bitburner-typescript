/**
 * Gang Tool Plugin
 *
 * Dashboard OverviewCard and DetailPanel for the gang daemon.
 * Reads status from the gang status port.
 */
import React from "lib/react";
import { ToolPlugin, OverviewCardProps, DetailPanelProps } from "views/dashboard/types";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { GangStatus, GangStrategy, GangMemberStatus } from "/types/ports";
import { ProgressBar } from "views/dashboard/components/ProgressBar";
import { TierFooter } from "views/dashboard/components/TierFooter";
import {
  setGangStrategy,
  pinGangMember,
  unpinGangMember,
  ascendGangMember,
  toggleGangPurchases,
  forceGangEquipmentBuy,
  setGangTrainingThreshold,
  setGangAscensionThresholds,
  setGangWantedThreshold,
  setGangGrowTarget,
  setGangGrowRespectReserve,
  setGangTerritoryThreshold,
  getStateSnapshot,
} from "views/dashboard/state-store";
import { formatTime } from "lib/utils";

// === HELPERS ===

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// === CONTROL STYLES ===

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

const smallBtnStyle: React.CSSProperties = {
  backgroundColor: "#1a1a1a",
  color: "#888",
  border: "1px solid #333",
  borderRadius: "3px",
  padding: "1px 6px",
  fontSize: "10px",
  fontFamily: "inherit",
  cursor: "pointer",
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

/** Editable number input. Commits on blur or Enter. */
function EditableNumber({ value, onCommit, prefix, min, max, step }: {
  value: number;
  onCommit: (v: number) => void;
  prefix?: string;
  min?: number;
  max?: number;
  step?: number;
}): React.ReactElement {
  const display = prefix ? `${value}` : `${value}`;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "2px" }}>
      {prefix && <span style={{ color: "#888", fontSize: "11px" }}>{prefix}</span>}
      <input
        type="number"
        style={settingInputStyle}
        defaultValue={display}
        key={value}
        min={min}
        max={max}
        step={step ?? 1}
        onBlur={(e) => {
          const v = parseFloat((e.target as HTMLInputElement).value);
          if (!isNaN(v) && v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = parseFloat((e.target as HTMLInputElement).value);
            if (!isNaN(v) && v !== value) onCommit(v);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </span>
  );
}

// === STRATEGY SELECTOR ===

function StrategySelector({ current, running, balancedPhase }: { current: GangStrategy; running: boolean; balancedPhase?: string }): React.ReactElement {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <span style={{ ...styles.statLabel, fontSize: "11px" }}>Strategy</span>
      <select
        style={controlSelectStyle}
        value={current}
        onChange={(e) => {
          const val = (e.target as HTMLSelectElement).value as GangStrategy;
          if (running) setGangStrategy(val);
        }}
      >
        <option value="balanced">Balanced</option>
        <option value="grow">Grow</option>
        <option value="respect">Respect</option>
        <option value="money">Money</option>
        <option value="territory">Territory</option>
      </select>
      {current === "balanced" && balancedPhase && (
        <span style={{ color: "#00ffff", fontSize: "10px" }}>({balancedPhase})</span>
      )}
    </span>
  );
}

// === MEMBER CARD ===

function MemberCard({ member, taskNames, running, growTarget }: {
  member: GangMemberStatus;
  taskNames: string[];
  running: boolean;
  growTarget?: number;
}): React.ReactElement {
  const asc = member.ascensionResult;
  const isFlagged = asc?.action === "flag";
  const mult = member.avgCombatMultiplier ?? 1;
  const graduated = growTarget ? mult >= growTarget : false;

  return (
    <div style={{
      ...styles.card,
      borderColor: isFlagged ? "#ffff00" : "#222",
      padding: "6px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
        <span style={{ color: "#00ffff", fontSize: "12px", fontWeight: "bold" }}>
          {member.name}
          {member.isPinned && <span style={{ color: "#ffaa00", marginLeft: "4px", fontSize: "10px" }} title="Pinned">P</span>}
        </span>
        <span style={{ display: "flex", gap: "4px", alignItems: "center" }}>
          <span style={{ fontSize: "10px", color: graduated ? "#00ff00" : "#ffaa00" }} title="Avg ascension multiplier">
            x{mult.toFixed(1)}
          </span>
          {isFlagged && (
            <button
              style={{ ...smallBtnStyle, color: "#ffff00", borderColor: "#ffff00" }}
              title={`Ascend: ${asc.bestStat} x${asc.bestGain.toFixed(2)}`}
              onClick={() => { if (running) ascendGangMember(member.name); }}
            >
              ASC
            </button>
          )}
          <button
            style={smallBtnStyle}
            onClick={() => {
              if (!running) return;
              if (member.isPinned) unpinGangMember(member.name);
              else pinGangMember(member.name, member.task);
            }}
          >
            {member.isPinned ? "Unpin" : "Pin"}
          </button>
        </span>
      </div>

      {/* Task */}
      <div style={{ marginBottom: "3px" }}>
        <select
          style={{ ...controlSelectStyle, width: "100%", fontSize: "10px" }}
          value={member.task}
          onChange={(e) => {
            const val = (e.target as HTMLSelectElement).value;
            if (running) pinGangMember(member.name, val);
          }}
        >
          {taskNames.length > 0
            ? taskNames.map(t => <option key={t} value={t}>{t}</option>)
            : <option value={member.task}>{member.task}</option>}
        </select>
      </div>

      {/* Task reason */}
      {member.taskReason && (
        <div style={{ fontSize: "9px", color: "#666", marginBottom: "2px" }}>
          {member.taskReason}
        </div>
      )}

      {/* Stats compact */}
      <div style={{ fontSize: "10px", color: "#888", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1px 8px" }}>
        <span>STR: <span style={{ color: "#fff" }}>{formatNumber(member.str)}</span></span>
        <span>DEF: <span style={{ color: "#fff" }}>{formatNumber(member.def)}</span></span>
        <span>DEX: <span style={{ color: "#fff" }}>{formatNumber(member.dex)}</span></span>
        <span>AGI: <span style={{ color: "#fff" }}>{formatNumber(member.agi)}</span></span>
      </div>

      {/* Gains */}
      <div style={{ fontSize: "10px", color: "#888", marginTop: "3px" }}>
        <span style={{ color: "#00ff00" }}>${formatNumber(member.moneyGain * 5)}/s</span>
        <span style={{ marginLeft: "8px", color: "#00ffff" }}>{formatNumber(member.respectGain * 5)} rep/s</span>
      </div>

      {/* Ascension info */}
      {asc && asc.action !== "skip" && (
        <div style={{
          fontSize: "10px",
          color: asc.action === "auto" ? "#00ff00" : "#ffff00",
          marginTop: "2px",
        }}>
          Asc: {asc.bestStat} x{asc.bestGain.toFixed(2)}
        </div>
      )}
    </div>
  );
}

// === OVERVIEW CARD ===

function GangOverviewCard({ status, running, toolId, error, pid }: OverviewCardProps<GangStatus>): React.ReactElement {
  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>GANG</span>
        <ToolControl tool={toolId} running={running} error={!!error} pid={pid} />
      </div>
      {error ? (
        <div style={{ color: "#ffaa00", fontSize: "11px" }}>{error}</div>
      ) : !status || !running ? (
        <div style={{ color: "#888", fontSize: "11px" }}>Offline</div>
      ) : !status.inGang ? (
        <div style={{ fontSize: "11px" }}>
          <div style={{ color: "#888", marginBottom: "4px" }}>Karma</div>
          <ProgressBar
            progress={status.karmaProgress ?? 0}
            label={`${((status.karmaProgress ?? 0) * 100).toFixed(0)}%`}
            fillColor="#aa0000"
          />
        </div>
      ) : (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Income</span>
            <span style={styles.statHighlight}>{status.moneyGainRateFormatted ?? "0"}/s</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Terr / Mbrs</span>
            <span style={styles.statValue}>
              {status.territory !== undefined ? formatPct(status.territory) : "?"} | {status.memberCount ?? 0}/{status.maxMembers ?? 12}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Wanted</span>
            <span style={{ color: (status.wantedPenalty ?? 1) >= 0.99 ? "#00ff00" : (status.wantedPenalty ?? 1) >= 0.9 ? "#ffff00" : "#ff4444", fontSize: "11px" }}>
              {status.wantedPenalty !== undefined ? formatPct(status.wantedPenalty) : "—"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// === DETAIL PANEL ===

/** Known combat gang tasks (subset - populated from status if available) */
const FALLBACK_TASK_NAMES = [
  "Unassigned", "Mug People", "Deal Drugs", "Strongarm Civilians",
  "Run a Con", "Armed Robbery", "Traffick Illegal Arms",
  "Threaten & Blackmail", "Human Trafficking", "Terrorism",
  "Vigilante Justice", "Train Combat", "Train Hacking", "Train Charisma",
  "Territory Warfare",
];

function GangDetailPanel({ status, running, toolId, pid }: DetailPanelProps<GangStatus>): React.ReactElement {
  if (!status && !running) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}><span style={styles.statLabel}>Gang Daemon</span></div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        <div style={styles.card}>
          <div style={{ color: "#888" }}>Daemon not running. Start it to manage your gang.</div>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}><span style={styles.statLabel}>Gang Daemon</span></div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        <div style={styles.card}><div style={{ color: "#ffaa00" }}>Waiting for status...</div></div>
      </div>
    );
  }

  if (!status.inGang) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}><span style={styles.statLabel}>Gang Daemon</span></div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        <div style={{
          ...styles.card,
          backgroundColor: "rgba(170, 0, 0, 0.1)",
          borderLeft: "3px solid #aa0000",
        }}>
          <div style={{ color: "#ff4444", fontSize: "12px", marginBottom: "8px" }}>GANG REQUIREMENTS</div>
          <ProgressBar
            progress={status.karmaProgress ?? 0}
            label={`${((status.karmaProgress ?? 0) * 100).toFixed(1)}%`}
            fillColor="#aa0000"
          />
          <div style={styles.stat}>
            <span style={styles.statLabel}>Current Karma</span>
            <span style={styles.statValue}>{formatNumber(status.karma ?? 0)}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Required</span>
            <span style={{ color: "#ff4444" }}>-{formatNumber(status.karmaRequired ?? 54000)}</span>
          </div>
          {(() => {
            const work = getStateSnapshot().workStatus;
            const rate = work?.crimeInfo?.karmaPerMin;
            if (rate && Math.abs(rate) > 0) {
              const remaining = (status.karmaRequired ?? 54000) - Math.abs(status.karma ?? 0);
              const etaSec = (remaining / Math.abs(rate)) * 60;
              return (
                <div style={{ ...styles.etaDisplay, fontSize: "10px", marginTop: "6px" }}>
                  ETA: {formatTime(etaSec)} at {work?.crimeInfo?.karmaPerMinFormatted}/min
                </div>
              );
            }
            return (
              <div style={{ color: "#888", fontSize: "10px", marginTop: "6px" }}>
                Commit crimes via the Work daemon to accumulate karma. You need -54,000 karma to create a gang.
              </div>
            );
          })()}
        </div>
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

  // GangStatus does not carry the live task name list, so the task
  // dropdown always uses the known-task fallback (both ternary branches
  // below previously resolved to the same value).
  const taskNames = FALLBACK_TASK_NAMES;

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span>
            <span style={styles.statLabel}>Faction: </span>
            <span style={styles.statValue}>{status.faction}</span>
          </span>
          <span style={styles.dim}>|</span>
          <StrategySelector current={status.strategy ?? "balanced"} running={running} balancedPhase={status.balancedPhase} />
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Metrics Bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", marginTop: "8px" }}>
        <div style={styles.card}>
          <div style={{ color: "#ffff00", fontSize: "14px", fontWeight: "bold" }}>{status.moneyGainRateFormatted ?? "0"}/s</div>
          <div style={{ color: "#888", fontSize: "10px" }}>Income</div>
        </div>
        <div style={styles.card}>
          <div style={{ color: "#00ffff", fontSize: "14px", fontWeight: "bold" }}>{status.respectGainRateFormatted ?? "0"}/s</div>
          <div style={{ color: "#888", fontSize: "10px" }}>Respect ({status.respectFormatted ?? "0"})</div>
        </div>
        <div style={styles.card}>
          <div style={{ color: "#00ff00", fontSize: "14px", fontWeight: "bold" }}>{status.territory !== undefined ? formatPct(status.territory) : "?"}</div>
          <div style={{ color: "#888", fontSize: "10px" }}>Territory</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", marginTop: "4px" }}>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Wanted</span>
          <span style={{ color: (status.wantedPenalty ?? 1) < 0.95 ? "#ff4444" : "#00ff00", fontSize: "11px" }}>
            {status.wantedPenalty !== undefined ? formatPct(status.wantedPenalty) : "?"}
          </span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Members</span>
          <span style={styles.statValue}>{status.memberCount ?? 0}/{status.maxMembers ?? 12}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Bonus</span>
          <span style={{ color: (status.bonusTime ?? 0) > 5000 ? "#00ff00" : "#888", fontSize: "11px" }}>
            {status.bonusTime !== undefined ? `${(status.bonusTime / 1000).toFixed(0)}s` : "—"}
          </span>
        </div>
      </div>

      {/* Recruitment */}
      {status.canRecruit && (
        <div style={{ ...styles.card, borderColor: "#00ff00", marginTop: "8px" }}>
          <span style={{ color: "#00ff00", fontSize: "11px" }}>
            Can recruit! ({status.recruitsAvailable ?? 0} available)
          </span>
        </div>
      )}
      {!status.canRecruit && status.respectForNextRecruit !== undefined && status.respectForNextRecruit > 0 && (
        <div style={{ ...styles.stat, marginTop: "4px" }}>
          <span style={styles.statLabel}>Next Recruit</span>
          <span style={{ color: "#888", fontSize: "11px" }}>{status.respectForNextRecruitFormatted} respect needed</span>
        </div>
      )}

      {/* Ascension Alerts */}
      {status.ascensionAlerts && status.ascensionAlerts.length > 0 && (
        <div style={{ ...styles.card, borderColor: "#ffff00", marginTop: "8px" }}>
          <div style={{ color: "#ffff00", fontSize: "12px", marginBottom: "4px" }}>ASCENSION ALERTS</div>
          {status.ascensionAlerts.map(a => (
            <div key={a.memberName} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0" }}>
              <span style={{ color: "#fff", fontSize: "11px" }}>
                {a.memberName}: {a.bestStat} x{a.bestGain.toFixed(2)}
              </span>
              <button
                style={{ ...smallBtnStyle, color: "#ffff00", borderColor: "#ffff00" }}
                onClick={() => { if (running) ascendGangMember(a.memberName); }}
              >
                Ascend
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Members Grid */}
      {status.members && status.members.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>MEMBERS</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "8px" }}>
            {status.members.map(m => (
              <MemberCard key={m.name} member={m} taskNames={taskNames} running={running} growTarget={status.growTargetMultiplier} />
            ))}
          </div>
        </div>
      )}

      {/* Equipment Section */}
      {status.tier >= 2 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            EQUIPMENT
            <span style={{ ...styles.dim, marginLeft: "8px", fontWeight: "normal" }}>
              {status.availableUpgrades ?? 0} upgrades available
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={styles.statLabel}>Auto-Purchase</span>
            <button
              style={{
                ...smallBtnStyle,
                color: status.purchasingEnabled ? "#00ff00" : "#ff4444",
                borderColor: status.purchasingEnabled ? "#00ff00" : "#ff4444",
              }}
              onClick={() => { if (running) toggleGangPurchases(!status.purchasingEnabled); }}
            >
              {status.purchasingEnabled ? "ON" : "OFF"}
            </button>
          </div>
          {status.purchasableEquipment && status.purchasableEquipment.length > 0 && (
            <>
              <div style={{
                maxHeight: "150px",
                overflowY: "auto",
                marginTop: "6px",
                border: "1px solid #222",
                borderRadius: "3px",
                padding: "4px",
                backgroundColor: "#0a0a0a",
              }}>
                {[...status.purchasableEquipment]
                  .sort((a, b) => a.cost - b.cost)
                  .map((item, i) => (
                    <div key={`${item.member}-${item.name}`} style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "1px 4px",
                      fontSize: "10px",
                      fontFamily: "monospace",
                      backgroundColor: i % 2 === 0 ? "transparent" : "#111",
                    }}>
                      <span>
                        <span style={{ color: "#00ffff" }}>{item.member}</span>
                        <span style={{ color: "#555" }}> — </span>
                        <span style={{ color: "#fff" }}>{item.name}</span>
                        <span style={{ color: "#555", marginLeft: "4px", fontSize: "9px" }}>{item.type}</span>
                      </span>
                      <span style={{ color: "#ffff00" }}>${formatNumber(item.cost)}</span>
                    </div>
                  ))}
              </div>
              <button
                style={{
                  ...smallBtnStyle,
                  marginTop: "6px",
                  color: "#ffaa00",
                  borderColor: "#ffaa00",
                  padding: "3px 10px",
                  fontSize: "11px",
                }}
                onClick={() => { if (running) forceGangEquipmentBuy(); }}
              >
                Buy All
              </button>
            </>
          )}
        </div>
      )}

      {/* Territory Section */}
      {status.territoryData && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            TERRITORY
            <span style={{
              marginLeft: "8px",
              fontWeight: "normal",
              fontSize: "11px",
              color: status.territoryData.recommendedAction === "enable" ? "#00ff00"
                : status.territoryData.recommendedAction === "disable" ? "#ff4444"
                : "#888",
            }}>
              {status.territoryData.recommendedAction.toUpperCase()}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Warfare</span>
            <span style={{ color: status.territoryWarfareEngaged ? "#00ff00" : "#888" }}>
              {status.territoryWarfareEngaged ? "ENGAGED" : "OFF"}
            </span>
          </div>
          <div style={{ ...styles.stat, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={styles.statLabel}>
              Auto Threshold{(status.territoryAutoThreshold ?? 101) > 100 ? " (OFF)" : ""}
            </span>
            <EditableNumber
              value={status.territoryAutoThreshold ?? 101}
              onCommit={(v) => { if (running) setGangTerritoryThreshold(v); }}
              prefix="%"
              min={0}
              max={101}
              step={5}
            />
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Our Power</span>
            <span style={styles.statValue}>{formatNumber(status.territoryData.ourPower)}</span>
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Rival</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Power</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Territory</th>
                <th style={{ ...styles.tableHeader, textAlign: "right" }}>Clash</th>
              </tr>
            </thead>
            <tbody>
              {status.territoryData.rivals.map((r, i) => (
                <tr key={r.name} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                  <td style={styles.tableCell}>{r.name}</td>
                  <td style={{ ...styles.tableCell, textAlign: "right" }}>{formatNumber(r.power)}</td>
                  <td style={{ ...styles.tableCell, textAlign: "right" }}>{formatPct(r.territory)}</td>
                  <td style={{
                    ...styles.tableCell,
                    textAlign: "right",
                    color: r.clashChance < 0 ? "#555"
                      : r.clashChance > 0.55 ? "#00ff00"
                      : r.clashChance < 0.40 ? "#ff4444"
                      : "#ffff00",
                  }}>
                    {r.clashChance >= 0 ? formatPct(r.clashChance) : "?"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Settings */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>SETTINGS</div>
        <div style={{ ...styles.stat, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={styles.statLabel}>Training Threshold</span>
          <EditableNumber
            value={status.trainingThreshold ?? 500}
            onCommit={(v) => { if (running) setGangTrainingThreshold(v); }}
            min={50}
            step={50}
          />
        </div>
        {(status.strategy === "grow" || status.strategy === "balanced") && (
          <>
            <div style={{ ...styles.stat, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={styles.statLabel}>Grow Target Mult</span>
              <EditableNumber
                value={status.growTargetMultiplier ?? 30}
                onCommit={(v) => { if (running) setGangGrowTarget(v); }}
                prefix="x"
                min={5}
                step={5}
              />
            </div>
            <div style={{ ...styles.stat, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={styles.statLabel}>Respect Reserve</span>
              <EditableNumber
                value={status.growRespectReserve ?? 2}
                onCommit={(v) => { if (running) setGangGrowRespectReserve(v); }}
                min={0}
                max={11}
                step={1}
              />
            </div>
          </>
        )}
        <div style={{ ...styles.stat, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={styles.statLabel}>Wanted Threshold</span>
          <EditableNumber
            value={parseFloat(((status.wantedThreshold ?? 0.95) * 100).toFixed(1))}
            onCommit={(v) => { if (running) setGangWantedThreshold(v / 100); }}
            prefix="%"
            min={50}
            max={100}
            step={1}
          />
        </div>
        <div style={{ ...styles.stat, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={styles.statLabel}>Ascend Auto</span>
          <EditableNumber
            value={parseFloat((status.ascendAutoThreshold ?? 1.5).toFixed(2))}
            onCommit={(v) => { if (running) setGangAscensionThresholds(v, status.ascendReviewThreshold ?? 1.15); }}
            prefix="x"
            min={1.05}
            max={5}
            step={0.05}
          />
        </div>
        <div style={{ ...styles.stat, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={styles.statLabel}>Ascend Review</span>
          <EditableNumber
            value={parseFloat((status.ascendReviewThreshold ?? 1.15).toFixed(2))}
            onCommit={(v) => { if (running) setGangAscensionThresholds(status.ascendAutoThreshold ?? 1.5, v); }}
            prefix="x"
            min={1.01}
            max={5}
            step={0.05}
          />
        </div>
      </div>

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

export const gangPlugin: ToolPlugin<GangStatus> = {
  name: "GANG",
  id: "gang",
  script: "daemons/gang.js",
  OverviewCard: GangOverviewCard,
  DetailPanel: GangDetailPanel,
};
