/**
 * Join Faction Action
 *
 * One-shot script to join a faction after verifying the invitation.
 * Target RAM: ~7 GB at SF4.2 (checkFactionInvitations + joinFaction)
 *
 * Usage: run actions/join-faction.js --faction CyberSec
 */
import { NS, FactionName } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["faction", ""],
  ]) as { faction: string; _: string[] };

  const faction = flags.faction || (flags._.length > 0 ? String(flags._[0]) : "");

  if (!faction) {
    ns.tprint("ERROR: No faction specified. Usage: run actions/join-faction.js --faction CyberSec");
    return;
  }

  // Verify we have an invitation
  const invitations = ns.singularity.checkFactionInvitations();
  if (!invitations.includes(faction as FactionName)) {
    ns.tprint(`FAILED: No invitation from ${faction}`);
    ns.toast(`No invitation from ${faction}`, "error", 3000);
    return;
  }

  const success = ns.singularity.joinFaction(faction as FactionName);

  if (success) {
    ns.tprint(`SUCCESS: Joined ${faction}`);
    ns.toast(`Joined ${faction}`, "success", 3000);
  } else {
    ns.tprint(`FAILED: Could not join ${faction}`);
    ns.toast(`Failed to join ${faction}`, "error", 3000);
  }
}
