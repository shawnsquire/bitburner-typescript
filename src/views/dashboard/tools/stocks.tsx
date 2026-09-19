/**
 * Stocks Tool Plugin
 *
 * OverviewCard shows P&L, position count, and mode.
 * DetailPanel shows positions table, signals, hack awareness overlay, and budget info.
 */
import React from "lib/react";
import {
  ToolPlugin,
  FormattedStocksStatus,
  OverviewCardProps,
  DetailPanelProps,
} from "views/dashboard/types";
import { StockPosition, StockSignal, TradeRecord } from "/types/ports";
import { styles } from "views/dashboard/styles";
import { ToolControl } from "views/dashboard/components/ToolControl";
import { TierFooter } from "views/dashboard/components/TierFooter";
import { runScript, resetStocksPnl, setStocksProfile } from "views/dashboard/state-store";

// === OVERVIEW CARD ===

function StocksOverviewCard({
  status,
  running,
  toolId,
  pid,
}: OverviewCardProps<FormattedStocksStatus>): React.ReactElement {
  const modeColors: Record<string, string> = {
    disabled: "#888",
    monitor: "#ffaa00",
    pre4s: "#00ff00",
    scraped: "#00bbff",
    "4s": "#00ffff",
  };

  return (
    <div style={styles.cardOverview}>
      <div style={styles.cardTitle}>
        <span>STOCKS</span>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>
      {status ? (
        <>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Mode</span>
            <span style={{ color: modeColors[status.mode] || "#888" }}>
              {status.mode.toUpperCase()}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>P&L</span>
            <span style={{ color: status.totalProfit >= 0 ? "#00ff00" : "#ff4444" }}>
              {status.totalProfitFormatted}
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>Positions</span>
            <span style={styles.statValue}>
              {status.longPositions}L / {status.shortPositions}S
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

// === DETAIL PANEL ===

function StocksDetailPanel({
  status,
  running,
  toolId,
  pid,
}: DetailPanelProps<FormattedStocksStatus>): React.ReactElement {
  if (!status) {
    return (
      <div style={styles.panel}>
        <div style={styles.row}>
          <div style={styles.rowLeft}>
            <span style={styles.statLabel}>Stocks</span>
          </div>
          <ToolControl tool={toolId} running={running} pid={pid} />
        </div>
        {!running ? (
          <>
            <div style={{ marginTop: "12px", color: "#ffaa00" }}>
              Stocks daemon not running.
            </div>
            <div style={{ ...styles.dim, marginTop: "8px", fontSize: "11px" }}>
              Click to start stock market monitoring and trading.
            </div>
          </>
        ) : (
          <div style={{ marginTop: "12px", color: "#ffaa00" }}>
            Waiting for first tick...
          </div>
        )}
      </div>
    );
  }

  const modeColors: Record<string, string> = {
    disabled: "#888",
    monitor: "#ffaa00",
    pre4s: "#00ff00",
    scraped: "#00bbff",
    "4s": "#00ffff",
  };

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.row}>
        <div style={styles.rowLeft}>
          <span style={styles.statLabel}>Stocks</span>
          <span style={styles.dim}>|</span>
          <span style={{ color: modeColors[status.mode] || "#888" }}>
            {status.mode.toUpperCase()}
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>P&L: </span>
            <span style={{ color: status.totalProfit >= 0 ? "#00ff00" : "#ff4444" }}>
              {status.totalProfitFormatted}
            </span>
          </span>
          <span style={styles.dim}>|</span>
          <span>
            <span style={styles.statLabel}>$/s: </span>
            <span style={{ color: status.profitPerSec >= 0 ? "#00ff00" : "#ff4444" }}>
              {status.profitPerSecFormatted}
            </span>
          </span>
        </div>
        <ToolControl tool={toolId} running={running} pid={pid} />
      </div>

      {/* Action buttons row */}
      {(status.positions.length > 0 || (status.hasTIX && !status.has4S) || status.tickCount > 0) && (
        <div style={{ marginTop: "4px", display: "flex", gap: "6px", alignItems: "center" }}>
          {status.positions.length > 0 && (
            <button
              style={{
                ...styles.buttonPlay,
                marginLeft: 0,
                padding: "2px 8px",
                backgroundColor: "#553300",
                color: "#ffaa00",
              }}
              onClick={() => runScript("stocks", "tools/control/sell-all-stocks.js")}
            >
              SELL ALL
            </button>
          )}
          {status.tickCount > 0 && (
            <button
              style={{
                ...styles.buttonPlay,
                marginLeft: 0,
                padding: "2px 8px",
                backgroundColor: "#333",
                color: "#aaa",
              }}
              onClick={() => resetStocksPnl()}
            >
              RESET P&L
            </button>
          )}
          {status.hasTIX && !status.has4S && (
            <button
              style={{
                ...styles.buttonPlay,
                marginLeft: 0,
                padding: "2px 8px",
                backgroundColor: "#003355",
                color: "#00bbff",
              }}
              onClick={() => runScript("stocks", "actions/scrape-forecasts.js")}
            >
              SCRAPE 4S
            </button>
          )}
          {status.scrapedForecastCount !== undefined && status.scrapedForecastAge !== undefined && (
            <span style={{ fontSize: "10px", color: status.scrapedForecastAge < 30000 ? "#00bbff" : "#888" }}>
              (scraped: {status.scrapedForecastCount}sym, {Math.round(status.scrapedForecastAge / 1000)}s ago)
            </span>
          )}
        </div>
      )}

      {/* Profile & API Status */}
      <div style={{ marginTop: "6px", display: "flex", gap: "12px", fontSize: "11px", alignItems: "center" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          Profile:
          <select
            value={status.activeProfile || "moderate"}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              const val = e.target.value;
              if (val !== "custom") setStocksProfile(val);
            }}
            style={{
              backgroundColor: "#222",
              color: "#00ffff",
              border: "1px solid #444",
              fontSize: "10px",
              padding: "1px 4px",
              cursor: "pointer",
            }}
          >
            <option value="aggressive">Aggressive</option>
            <option value="moderate">Moderate</option>
            <option value="conservative">Conservative</option>
            <option value="custom">Custom</option>
          </select>
        </span>
        <span style={styles.dim}>|</span>
        <span>
          WSE: <span style={{ color: status.hasWSE ? "#00ff00" : "#ff4444" }}>
            {status.hasWSE ? "YES" : "NO"}
          </span>
        </span>
        <span>
          TIX: <span style={{ color: status.hasTIX ? "#00ff00" : "#ff4444" }}>
            {status.hasTIX ? "YES" : "NO"}
          </span>
        </span>
        <span>
          4S: <span style={{ color: status.has4S ? "#00ff00" : "#ff4444" }}>
            {status.has4S ? "YES" : "NO"}
          </span>
        </span>
        <span style={styles.dim}>|</span>
        <span>
          Capital: <span style={styles.statValue}>{status.tradingCapitalFormatted}</span>
        </span>
        <span style={styles.dim}>|</span>
        <span style={styles.dim}>Tick #{status.tickCount}</span>
      </div>

      {/* Portfolio Summary */}
      <div style={{ marginTop: "8px", display: "flex", gap: "16px" }}>
        <span>
          <span style={styles.statLabel}>Portfolio: </span>
          <span style={{ color: "#00ffff" }}>{status.portfolioValueFormatted}</span>
        </span>
        <span>
          <span style={styles.statLabel}>Realized: </span>
          <span style={{ color: status.realizedProfit >= 0 ? "#00ff00" : "#ff4444" }}>
            {status.realizedProfitFormatted}
          </span>
        </span>
        <span>
          <span style={styles.statLabel}>Pos: </span>
          <span>{status.longPositions}L / {status.shortPositions}S</span>
        </span>
      </div>

      {/* Market Overview Grid (4S/scraped mode only) */}
      {status.marketOverview && status.marketOverview.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            MARKET OVERVIEW ({status.marketOverview.filter(c => c.direction === "bull").length} bull / {status.marketOverview.filter(c => c.direction === "bear").length} bear)
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, 1fr)",
            gap: "1px",
            fontSize: "10px",
            fontFamily: "monospace",
          }}>
            {status.marketOverview.map(cell => {
              const deviation = Math.abs(cell.forecast - 0.5);
              const intensity = Math.min(1, deviation / 0.25);
              const isBull = cell.direction === "bull";
              const r = isBull ? 0 : Math.round(100 + 155 * intensity);
              const g = isBull ? Math.round(100 + 155 * intensity) : 0;
              const color = `rgb(${r}, ${g}, 0)`;
              const borderColor = cell.held ? "#ffff00" : "transparent";
              return (
                <div
                  key={cell.symbol}
                  style={{
                    padding: "2px 3px",
                    textAlign: "center",
                    color,
                    border: `1px solid ${borderColor}`,
                    backgroundColor: cell.held ? "rgba(255,255,0,0.05)" : "transparent",
                  }}
                >
                  <div style={{ fontWeight: cell.held ? "bold" : "normal" }}>{cell.symbol}</div>
                  <div>{isBull ? "\u25b2" : "\u25bc"}{cell.forecast.toFixed(2)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Positions Table */}
      {status.positions.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>POSITIONS ({status.positions.length})</div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Symbol</th>
                <th style={{ ...styles.tableHeader, width: "50px" }}>Dir</th>
                <th style={{ ...styles.tableHeader, width: "70px", textAlign: "right" }}>Shares</th>
                <th style={{ ...styles.tableHeader, width: "80px", textAlign: "right" }}>Avg</th>
                <th style={{ ...styles.tableHeader, width: "80px", textAlign: "right" }}>Price</th>
                <th style={{ ...styles.tableHeader, width: "90px", textAlign: "right" }}>P&L</th>
                <th style={{ ...styles.tableHeader, width: "50px", textAlign: "right" }}>Conf</th>
              </tr>
            </thead>
            <tbody>
              {status.positions.map((p: StockPosition, i: number) => {
                const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                const dirColor = p.direction === "long" ? "#00ff00" : "#ff8800";
                const plColor = p.profit >= 0 ? "#00ff00" : "#ff4444";
                return (
                  <tr key={`${p.symbol}-${p.direction}`} style={rowStyle}>
                    <td style={{ ...styles.tableCell, color: "#0088ff" }}>{p.symbol}</td>
                    <td style={{ ...styles.tableCell, color: dirColor }}>
                      {p.direction.toUpperCase()}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>
                      {formatCompact(p.shares)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>
                      {formatCompact(p.avgPrice)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>
                      {formatCompact(p.currentPrice)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right", color: plColor }}>
                      {p.profitFormatted}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>
                      {(p.confidence * 100).toFixed(0)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Signals */}
      {status.signals.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>SIGNALS ({status.signals.length})</div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Symbol</th>
                <th style={{ ...styles.tableHeader, width: "60px" }}>Direction</th>
                <th style={{ ...styles.tableHeader, width: "60px", textAlign: "right" }}>Ret/tick</th>
                <th style={{ ...styles.tableHeader, width: "80px", textAlign: "right" }}>
                  {status.mode === "pre4s" ? "Est. forecast" : "Forecast"}
                </th>
              </tr>
            </thead>
            <tbody>
              {status.signals.map((s: StockSignal, i: number) => {
                const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                const dirColor = s.direction === "long" ? "#00ff00"
                               : s.direction === "short" ? "#ff8800"
                               : "#888";
                return (
                  <tr key={s.symbol} style={rowStyle}>
                    <td style={{ ...styles.tableCell, color: "#0088ff" }}>{s.symbol}</td>
                    <td style={{ ...styles.tableCell, color: dirColor }}>
                      {s.direction.toUpperCase()}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>
                      {(s.strength * 100).toFixed(3)}%
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>
                      {s.forecast !== undefined ? s.forecast.toFixed(3) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Session Stats */}
      {status.sessionStats && (
        <div style={{ marginTop: "8px", fontSize: "11px" }}>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <span>
              Win: <span style={{ color: status.sessionStats.winRate >= 0.5 ? "#00ff00" : "#ff4444" }}>
                {(status.sessionStats.winRate * 100).toFixed(0)}%
              </span>
              <span style={styles.dim}> ({status.sessionStats.wins}/{status.sessionStats.totalTrades})</span>
            </span>
            <span>
              Avg: <span style={{ color: status.sessionStats.avgProfit >= 0 ? "#00ff00" : "#ff4444" }}>
                {status.sessionStats.avgProfitFormatted}
              </span>
            </span>
            <span>
              Best: <span style={{ color: "#00ff00" }}>{status.sessionStats.bestTradeFormatted}</span>
            </span>
            <span>
              Worst: <span style={{ color: "#ff4444" }}>{status.sessionStats.worstTradeFormatted}</span>
            </span>
            <span style={styles.dim}>
              Avg Hold: {status.sessionStats.avgHoldTicks} ticks
            </span>
          </div>
          {/* Long vs Short breakdown */}
          <div style={{ display: "flex", gap: "16px", marginTop: "4px" }}>
            <span>
              <span style={{ color: "#00ff00" }}>LONG</span>
              <span style={styles.dim}>: </span>
              <span style={{ color: status.sessionStats.long.totalProfit >= 0 ? "#00ff00" : "#ff4444" }}>
                {status.sessionStats.long.totalProfitFormatted}
              </span>
              <span style={styles.dim}>
                {" "}({(status.sessionStats.long.winRate * 100).toFixed(0)}% of {status.sessionStats.long.trades})
              </span>
            </span>
            <span>
              <span style={{ color: "#ff8800" }}>SHORT</span>
              <span style={styles.dim}>: </span>
              <span style={{ color: status.sessionStats.short.totalProfit >= 0 ? "#00ff00" : "#ff4444" }}>
                {status.sessionStats.short.totalProfitFormatted}
              </span>
              <span style={styles.dim}>
                {" "}({(status.sessionStats.short.winRate * 100).toFixed(0)}% of {status.sessionStats.short.trades})
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Trade History */}
      {status.recentTrades && status.recentTrades.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>RECENT TRADES ({status.recentTrades.length})</div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Symbol</th>
                <th style={{ ...styles.tableHeader, width: "45px" }}>Dir</th>
                <th style={{ ...styles.tableHeader, width: "70px", textAlign: "right" }}>Entry</th>
                <th style={{ ...styles.tableHeader, width: "70px", textAlign: "right" }}>Exit</th>
                <th style={{ ...styles.tableHeader, width: "80px", textAlign: "right" }}>P&L</th>
                <th style={{ ...styles.tableHeader, width: "40px", textAlign: "right" }}>Ticks</th>
                <th style={{ ...styles.tableHeader, width: "70px" }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {[...status.recentTrades].reverse().map((t: TradeRecord, i: number) => {
                const rowStyle = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
                const dirColor = t.direction === "long" ? "#00ff00" : "#ff8800";
                const plColor = t.profit >= 0 ? "#00ff00" : "#ff4444";
                const reasonColors: Record<string, string> = {
                  "signal": "#00ff00",
                  "external": "#888",
                };
                return (
                  <tr key={`${t.symbol}-${t.direction}-${i}`} style={rowStyle}>
                    <td style={{ ...styles.tableCell, color: "#0088ff" }}>{t.symbol}</td>
                    <td style={{ ...styles.tableCell, color: dirColor }}>
                      {t.direction === "long" ? "L" : "S"}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>
                      {formatCompact(t.entryPrice)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>
                      {formatCompact(t.exitPrice)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right", color: plColor }}>
                      {t.profitFormatted}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" }}>
                      {t.ticksHeld}
                    </td>
                    <td style={{ ...styles.tableCell, color: reasonColors[t.exitReason] || "#888", fontSize: "10px" }}>
                      {t.exitReason}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {status.positions.length === 0 && status.signals.length === 0 && status.hasTIX && (
        <div style={{ marginTop: "12px", color: "#888", textAlign: "center" }}>
          No positions or signals — building price history ({status.tickCount} ticks)
        </div>
      )}

      {/* No TIX state */}
      {!status.hasTIX && (
        <div style={{ marginTop: "12px", color: "#ffaa00", textAlign: "center" }}>
          Waiting for TIX API access (TIX: $5B)
        </div>
      )}

      <TierFooter tier={status.tier} tierName={status.tierName} />
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(1) + "t";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toFixed(0);
}

// === PLUGIN EXPORT ===

export const stocksPlugin: ToolPlugin<FormattedStocksStatus> = {
  name: "STOCKS",
  id: "stocks",
  script: "daemons/stocks.js",
  OverviewCard: StocksOverviewCard,
  DetailPanel: StocksDetailPanel,
};
