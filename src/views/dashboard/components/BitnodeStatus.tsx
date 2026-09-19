/**
 * Bitnode Completion Status Component
 *
 * Displays fl1ght.exe requirements: augmentations, money, and hacking skill.
 * Status data is computed and published by daemons/rep.ts (computeBitnodeStatus)
 * to STATUS_PORTS.bitnode; this component only renders it.
 */
import React from "lib/react";
import { BitnodeStatus } from "views/dashboard/types";

// === COMPONENT ===

interface BitnodeStatusBarProps {
  status: BitnodeStatus | null;
}

export function BitnodeStatusBar({ status }: BitnodeStatusBarProps): React.ReactElement | null {
  if (!status) return null;

  const checkStyle = (complete: boolean) => ({
    color: complete ? "#00ff00" : "#ff4444",
    marginRight: "4px",
  });

  const valueStyle = (complete: boolean) => ({
    color: complete ? "#00ff00" : "#fff",
  });

  const itemStyle = {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "11px",
  };

  return (
    <div style={{
      display: "flex",
      flexWrap: "wrap",
      gap: "8px 16px",
      padding: "6px 10px",
      backgroundColor: status.allComplete ? "#002200" : "#1a1a1a",
      border: status.allComplete ? "1px solid #00ff00" : "1px solid #333",
      borderRadius: "3px",
      marginBottom: "8px",
      fontSize: "11px",
    }}>
      <span style={{ color: "#00ffff", fontWeight: "bold" }}>FL1GHT.EXE</span>
      <span style={itemStyle}>
        <span style={checkStyle(status.augsComplete)}>{status.augsComplete ? "[x]" : "[ ]"}</span>
        <span style={{ color: "#888" }}>Augs:</span>
        <span style={valueStyle(status.augsComplete)}>{status.augmentations}/{status.augmentationsRequired}</span>
      </span>
      <span style={itemStyle}>
        <span style={checkStyle(status.moneyComplete)}>{status.moneyComplete ? "[x]" : "[ ]"}</span>
        <span style={{ color: "#888" }}>Money:</span>
        <span style={valueStyle(status.moneyComplete)}>${status.moneyFormatted}/${status.moneyRequiredFormatted}</span>
      </span>
      <span style={itemStyle}>
        <span style={checkStyle(status.hackingComplete)}>{status.hackingComplete ? "[x]" : "[ ]"}</span>
        <span style={{ color: "#888" }}>Hack:</span>
        <span style={valueStyle(status.hackingComplete)}>{status.hacking}/{status.hackingRequired}</span>
      </span>
    </div>
  );
}