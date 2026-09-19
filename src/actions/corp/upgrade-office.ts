/**
 * Upgrade Office Action
 *
 * One-shot: add seats to a division's office in one city, then hire to fill.
 * Spends corporation funds. The daemon does this automatically (see
 * docs/systems/corp.md, officeUpgradeReserveMult / officeMaxSize); use this
 * when it is off or the directive is pinned.
 *
 * Usage: run actions/corp/upgrade-office.js --division AgriCo --city Sector-12 --size 3 [--skipHire]
 */
import { NS, CityName } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["division", ""],
    ["city", "Sector-12"],
    ["size", 3],
    ["skipHire", false],
  ]) as { division: string; city: string; size: number; skipHire: boolean; _: string[] };

  if (!flags.division || flags.size < 1) {
    ns.tprint("ERROR: Usage: run actions/corp/upgrade-office.js --division AgriCo --city Sector-12 --size 3 [--skipHire]");
    return;
  }

  const city = flags.city as CityName;
  try {
    const before = ns.corporation.getOffice(flags.division, city).size;
    const cost = ns.corporation.getOfficeSizeUpgradeCost(flags.division, city, flags.size);

    // Returns void and silently no-ops when funds are short, so confirm the size grew.
    ns.corporation.upgradeOfficeSize(flags.division, city, flags.size);
    const after = ns.corporation.getOffice(flags.division, city).size;
    if (after <= before) {
      ns.tprint(`ERROR: Office stayed at ${before} seats; corp funds are below the ${ns.format.number(cost)} cost`);
      return;
    }
    ns.tprint(`SUCCESS: ${flags.division}/${flags.city} office ${before} → ${after} seats for ${ns.format.number(cost)}`);

    if (flags.skipHire) return;
    let hired = 0;
    while (ns.corporation.getOffice(flags.division, city).numEmployees < after) {
      if (!ns.corporation.hireEmployee(flags.division, city)) break;
      hired++;
    }
    ns.tprint(`INFO: Hired ${hired} employees; the corp daemon assigns jobs on its next tick`);
  } catch (e) {
    ns.tprint(`ERROR: ${e}`);
  }
}
