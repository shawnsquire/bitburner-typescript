/**
 * Check Faction Rep Action
 *
 * Lightweight one-shot that reads faction reputation and favor.
 * Publishes partial RepStatus to port 5.
 * Target RAM: ~34 GB at SF4.1 (getFactionRep + getFactionFavor = 2 Singularity functions)
 *
 * Usage: run actions/check-faction-rep.js
 *        run actions/check-faction-rep.js --faction CyberSec
 */
import { NS, FactionName } from "@ns";
import { publishStatus } from "/lib/ports";
import { STATUS_PORTS, RepStatus } from "/types/ports";

export const MANUAL_COMMAND = 'ns.singularity.getFactionRep("FACTION_NAME")';

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  // Exit early if the rep daemon is running (it publishes richer status)
  if (ns.ps("home").some(p => p.filename === "daemons/rep.js")) {
    return;
  }

  const flags = ns.flags([
    ["faction", ""],
  ]) as { faction: string; _: string[] };

  const player = ns.getPlayer();
  const factions = player.factions;

  if (factions.length === 0) {
    ns.print("No factions joined yet.");
    return;
  }

  // If a specific faction is requested, only check that one
  const targetFactions = flags.faction ? [flags.faction] : factions;

  // Build faction rep data
  let bestFaction = "";
  let bestRep = 0;
  let bestFavor = 0;

  for (const factionName of targetFactions) {
    const rep = ns.singularity.getFactionRep(factionName as FactionName);
    const favor = ns.singularity.getFactionFavor(factionName as FactionName);

    if (rep > bestRep) {
      bestRep = rep;
      bestFaction = factionName;
      bestFavor = favor;
    }
  }

  // Publish a partial RepStatus with what we know
  const status: Partial<RepStatus> & { targetFaction: string; currentRep: number; currentRepFormatted: string; favor: number } = {
    targetFaction: bestFaction,
    nextAugName: null,
    repRequired: 0,
    repRequiredFormatted: "-",
    currentRep: bestRep,
    currentRepFormatted: ns.format.number(bestRep, 1),
    repGap: 0,
    repGapFormatted: "-",
    repGapPositive: false,
    repProgress: 0,
    installedAugs: 0,
    repGainRate: 0,
    eta: "-",
    nextAugCost: 0,
    nextAugCostFormatted: "-",
    canAffordNextAug: false,
    favor: bestFavor,
    favorToUnlock: ns.getFavorToDonate(),
    pendingBackdoors: [],
    nonWorkableFactions: [],
    isWorkingForFaction: false,
    isOptimalWork: false,
    bestWorkType: "hacking",
    currentWorkType: null,
    isWorkable: true,
  };

  publishStatus(ns, STATUS_PORTS.rep, status as RepStatus);
  ns.print(`Published rep status: ${bestFaction} rep=${ns.format.number(bestRep, 1)} favor=${bestFavor}`);
}
