/**
 * Territory Check Action Script
 *
 * Separate from gang daemon due to getChanceToWinClash costing 4 GB per rival.
 * Uses ramOverride to minimize footprint.
 *
 * Usage:
 *   run actions/check-territory.js          # Check one rival (round-robin)
 *   run actions/check-territory.js --all    # Check all rivals sequentially
 *   run actions/check-territory.js --gang NiteSec  # Check specific rival
 *
 * Publishes GangTerritoryStatus to STATUS_PORTS.gangTerritory (port 14).
 */
import { NS } from "@ns";
import { publishStatus, peekStatus } from "/lib/ports";
import {
  STATUS_PORTS,
  GangTerritoryStatus,
  GangTerritoryRival,
} from "/types/ports";

/** File to persist round-robin index across runs */
const STATE_FILE = "/data/territory-rr-index.txt";

export async function main(ns: NS): Promise<void> {
  // Base + inGang + getGangInformation + getAllGangInformation + getChanceToWinClash
  ns.ramOverride(10.6);
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["all", false],
    ["gang", ""],
  ]) as { all: boolean; gang: string; _: string[] };

  // Exit early if not in a gang
  if (!ns.gang.inGang()) {
    return;
  }

  const ourInfo = ns.gang.getGangInformation();
  const otherGangs = ns.gang.getAllGangInformation();

  // Get rival names (all gangs except ours)
  const rivalNames = Object.keys(otherGangs).filter(g => g !== ourInfo.faction);

  if (rivalNames.length === 0) {
    ns.tprint("WARN: check-territory: no rival gangs found");
    return;
  }

  // Read existing territory data from port
  const existing = peekStatus<GangTerritoryStatus>(ns, STATUS_PORTS.gangTerritory);
  const existingRivals = new Map<string, GangTerritoryRival>();
  if (existing?.rivals) {
    for (const r of existing.rivals) existingRivals.set(r.name, r);
  }

  // Determine which rivals to check
  let checkList: string[];

  if (flags.gang) {
    // Specific rival
    checkList = rivalNames.filter(g => g === flags.gang);
    if (checkList.length === 0) {
      ns.tprint(`WARN: check-territory: rival '${flags.gang}' not found`);
      return;
    }
  } else if (flags.all) {
    // All rivals
    checkList = rivalNames;
  } else {
    // Round-robin: check one rival
    let rrIndex = 0;
    if (ns.fileExists(STATE_FILE)) {
      try { rrIndex = parseInt(ns.read(STATE_FILE)) || 0; } catch { /* */ }
    }
    rrIndex = rrIndex % rivalNames.length;
    checkList = [rivalNames[rrIndex]];
    ns.write(STATE_FILE, String((rrIndex + 1) % rivalNames.length), "w");
  }

  // Check rivals sequentially (never parallel to keep RAM low)
  for (const rivalName of checkList) {
    const rivalInfo = otherGangs[rivalName];
    const clashChance = ns.gang.getChanceToWinClash(rivalName);

    existingRivals.set(rivalName, {
      name: rivalName,
      power: rivalInfo.power,
      territory: rivalInfo.territory,
      clashChance,
    });
  }

  // Build final rival list
  const allRivals: GangTerritoryRival[] = [];
  for (const name of rivalNames) {
    if (existingRivals.has(name)) {
      allRivals.push(existingRivals.get(name)!);
    } else {
      // No data yet for this rival
      const rivalInfo = otherGangs[name];
      allRivals.push({
        name,
        power: rivalInfo.power,
        territory: rivalInfo.territory,
        clashChance: -1, // Unknown
      });
    }
  }

  // Determine recommended action
  const checkedRivals = allRivals.filter(r => r.clashChance >= 0);
  let recommendedAction: "enable" | "disable" | "hold" = "hold";
  if (checkedRivals.length > 0) {
    const allAbove55 = checkedRivals.every(r => r.clashChance > 0.55);
    const anyBelow40 = checkedRivals.some(r => r.clashChance < 0.40);
    if (allAbove55) recommendedAction = "enable";
    else if (anyBelow40) recommendedAction = "disable";
  }

  const status: GangTerritoryStatus = {
    rivals: allRivals,
    ourPower: ourInfo.power,
    ourTerritory: ourInfo.territory,
    territoryWarfareEngaged: ourInfo.territoryWarfareEngaged,
    recommendedAction,
    lastChecked: Date.now(),
  };

  publishStatus(ns, STATUS_PORTS.gangTerritory, status);

  checkList.map(n => {
    const r = existingRivals.get(n);
    return `${n}: ${r ? (r.clashChance * 100).toFixed(1) + "%" : "?"}`;
  }).join(", ");
}
