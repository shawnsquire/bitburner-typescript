/**
 * Work for Faction Action
 *
 * One-shot script to start working for a faction.
 * Target RAM: ~50 GB at SF4.1 (workForFaction = 1 Singularity function, higher cost)
 *
 * Usage: run actions/work-for-faction.js --faction CyberSec --type hacking
 *        run actions/work-for-faction.js --faction "Tian Di Hui" --type field
 */
import { NS, FactionName } from "@ns";

export const MANUAL_COMMAND = 'ns.singularity.workForFaction("FACTION", "WORK_TYPE", false)';

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["faction", ""],
    ["type", "hacking"],
    ["focus", false],
  ]) as { faction: string; type: string; focus: boolean; _: string[] };

  const faction = flags.faction || (flags._.length > 0 ? String(flags._[0]) : "");
  const workType = flags.type;
  const focus = flags.focus;

  if (!faction) {
    ns.tprint("ERROR: No faction specified. Usage: run actions/work-for-faction.js --faction CyberSec --type hacking");
    return;
  }

  const validTypes = ["hacking", "field", "security"];
  if (!validTypes.includes(workType)) {
    ns.tprint(`ERROR: Invalid work type "${workType}". Valid: ${validTypes.join(", ")}`);
    return;
  }

  const success = ns.singularity.workForFaction(faction as FactionName, workType as "hacking" | "field" | "security", focus);

  if (success) {
    ns.tprint(`SUCCESS: Started ${workType} work for ${faction}${focus ? " (focused)" : ""}`);
    ns.toast(`Started ${workType} work for ${faction}`, "success", 3000);
  } else {
    ns.tprint(`FAILED: Could not start ${workType} work for ${faction}`);
    ns.tprint(`  Check: Are you a member? Does this faction support ${workType} work?`);
    ns.toast(`FAILED: Could not start ${workType} work for ${faction}`, "error", 5000);
  }
}
