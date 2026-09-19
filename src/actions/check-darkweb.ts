/**
 * Check Darkweb Status Action
 *
 * Lightweight one-shot that reads darkweb program status.
 * Publishes DarkwebStatus to port 7.
 * Target RAM: ~18 GB at SF4.1 (getDarkwebPrograms + getDarkwebProgramCost = 2 Singularity functions)
 *
 * Usage: run actions/check-darkweb.js
 */
import { NS, ProgramName } from "@ns";
import { publishStatus } from "/lib/ports";
import { STATUS_PORTS, DarkwebStatus } from "/types/ports";

export const MANUAL_COMMAND = 'ns.singularity.getDarkwebPrograms()';

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  // Exit early if the darkweb daemon is running (it publishes richer status)
  if (ns.ps("home").some(p => p.filename === "daemons/darkweb.js")) {
    return;
  }

  // Check if TOR router is owned - getDarkwebPrograms returns [] without it
  let programNames: ProgramName[];
  let hasTor = false;
  try {
    programNames = ns.singularity.getDarkwebPrograms();
    hasTor = programNames.length > 0;
  } catch {
    programNames = [];
  }

  if (!hasTor) {
    const status: DarkwebStatus = {
      hasTorRouter: false,
      ownedCount: 0,
      totalPrograms: 0,
      nextProgram: null,
      moneyUntilNext: 200_000,
      moneyUntilNextFormatted: ns.format.number(200_000, 1),
      canAffordNext: ns.getServerMoneyAvailable("home") >= 200_000,
      programs: [],
      allOwned: false,
    };
    publishStatus(ns, STATUS_PORTS.darkweb, status);
    ns.print("Published darkweb status (no TOR)");
    return;
  }

  const playerMoney = ns.getServerMoneyAvailable("home");

  const programs = programNames
    .map(name => {
      const cost = ns.singularity.getDarkwebProgramCost(name);
      return {
        name,
        cost,
        costFormatted: ns.format.number(cost, 1),
        owned: ns.fileExists(name, "home"),
      };
    })
    .sort((a, b) => a.cost - b.cost);

  const ownedCount = programs.filter(p => p.owned).length;
  const allOwned = ownedCount === programs.length;

  // Find next unowned program (cheapest first since sorted)
  const nextUnowned = programs.find(p => !p.owned) ?? null;
  const nextProgram = nextUnowned
    ? { name: nextUnowned.name, cost: nextUnowned.cost, costFormatted: nextUnowned.costFormatted }
    : null;

  const moneyUntilNext = nextUnowned ? Math.max(0, nextUnowned.cost - playerMoney) : 0;

  const status: DarkwebStatus = {
    hasTorRouter: true,
    ownedCount,
    totalPrograms: programs.length,
    nextProgram,
    moneyUntilNext,
    moneyUntilNextFormatted: ns.format.number(moneyUntilNext, 1),
    canAffordNext: nextUnowned !== null && playerMoney >= nextUnowned.cost,
    programs,
    allOwned,
  };

  publishStatus(ns, STATUS_PORTS.darkweb, status);
  ns.print("Published darkweb status to port " + STATUS_PORTS.darkweb);
}
