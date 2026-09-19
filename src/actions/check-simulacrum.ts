/**
 * Check Simulacrum Action
 *
 * One-shot script that detects whether The Blade's Simulacrum is installed and
 * writes `simulacrum=true|false` to /config/focus.txt. The blade daemon reads
 * that key to decide whether Bladeburner needs the player's focus.
 *
 * Lives outside the focus daemon so the daemon's resident RAM stays at what its
 * loop needs. Detection uses ns.getResetInfo().ownedAugs (installed
 * augmentations, 1 GB, no Source-File 4 needed) instead of
 * singularity.getOwnedAugmentations (80 GB without SF4 and throws without it).
 *
 * Usage:
 *   run actions/check-simulacrum.js
 *
 * Exec'd by daemons/focus.js at startup and on a `refresh` control message.
 */
import { NS } from "@ns";
import { setConfigValue } from "/lib/config";

const SIMULACRUM_NAME = "The Blade's Simulacrum";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  let hasSimulacrum = false;
  try {
    hasSimulacrum = ns.getResetInfo().ownedAugs.has(SIMULACRUM_NAME);
  } catch {
    // Leave false: no way to detect, and false is the safe direction
    // (blade daemon then respects the focus holder).
  }

  setConfigValue(ns, "focus", "simulacrum", hasSimulacrum ? "true" : "false");
  ns.print(`Simulacrum: ${hasSimulacrum ? "installed" : "not installed"}`);
}
