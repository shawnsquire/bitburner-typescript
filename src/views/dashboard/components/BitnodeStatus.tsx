/**
 * Bitnode Completion Status Component
 *
 * Displays fl1ght.exe requirements: augmentations, money, and hacking skill.
 */
import React from "lib/react";
import { NS } from "@ns";
import { BitnodeStatus } from "views/dashboard/types";

// === CONSTANTS ===

const BITNODE_REQUIREMENTS = {
  augmentations: 30,
  money: 100_000_000_000, // $100b
  hacking: 2500,
};

// === STATUS FORMATTING ===

export function getBitnodeStatus(ns: NS): BitnodeStatus | null {
  try {
    const player = ns.getPlayer();
    const installedAugs = ns.singularity.getOwnedAugmentations(false).length;

    const augsComplete = installedAugs >= BITNODE_REQUIREMENTS.augmentations;
    const moneyComplete = player.money >= BITNODE_REQUIREMENTS.money;
    const hackingComplete = player.skills.hacking >= BITNODE_REQUIREMENTS.hacking;

    return {
      augmentations: installedAugs,
      augmentationsRequired: BITNODE_REQUIREMENTS.augmentations,
      money: player.money,
      moneyRequired: BITNODE_REQUIREMENTS.money,
      moneyFormatted: ns.format.number(player.money),
      moneyRequiredFormatted: ns.format.number(BITNODE_REQUIREMENTS.money),
      hacking: player.skills.hacking,
      hackingRequired: BITNODE_REQUIREMENTS.hacking,
      augsComplete,
      moneyComplete,
      hackingComplete,
      allComplete: augsComplete && moneyComplete && hackingComplete,
    };
  } catch {
    return null;
  }
}

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