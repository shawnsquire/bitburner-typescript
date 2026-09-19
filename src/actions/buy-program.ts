/**
 * Buy Darkweb Program Action
 *
 * One-shot script to purchase a specific darkweb program.
 * Target RAM: ~34 GB at SF4.1 (purchaseProgram = 1 Singularity function)
 *
 * Usage: run actions/buy-program.js --program BruteSSH.exe
 */
import { NS, ProgramName } from "@ns";

export const MANUAL_COMMAND = 'ns.singularity.purchaseProgram("PROGRAM_NAME")';

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["program", ""],
  ]) as { program: string; _: string[] };

  const programName = flags.program || (flags._.length > 0 ? String(flags._[0]) : "");

  if (!programName) {
    ns.tprint("ERROR: No program specified. Usage: run actions/buy-program.js --program BruteSSH.exe");
    return;
  }

  // Check if already owned
  if (ns.fileExists(programName, "home")) {
    ns.tprint(`Already own ${programName}`);
    return;
  }

  // ns.singularity.purchaseProgram() throws if Source-File 4 isn't available.
  let success = false;
  try {
    success = ns.singularity.purchaseProgram(programName as ProgramName);
  } catch {
    success = false;
  }

  if (success) {
    ns.tprint(`SUCCESS: Purchased ${programName}`);
  } else {
    ns.tprint(`FAILED: Could not purchase ${programName} (not enough money, invalid name, or missing Source-File 4)`);
  }
}
