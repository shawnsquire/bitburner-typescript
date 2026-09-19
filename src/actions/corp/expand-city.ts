/**
 * Expand City Action
 *
 * One-shot: expand division to a city and buy warehouse.
 *
 * Usage: run actions/corp/expand-city.js --division "Pony Agriculture" --city Aevum
 */
import { NS, CityName } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["division", ""],
    ["city", ""],
  ]) as { division: string; city: string; _: string[] };

  if (!flags.division || !flags.city) {
    ns.tprint("ERROR: Usage: run actions/corp/expand-city.js --division \"Pony Agriculture\" --city Aevum");
    return;
  }

  try {
    ns.corporation.expandCity(flags.division, flags.city as CityName);
    ns.tprint(`SUCCESS: Expanded "${flags.division}" to ${flags.city}`);
  } catch (e) {
    ns.tprint(`ERROR expanding city: ${e}`);
    return;
  }

  try {
    ns.corporation.purchaseWarehouse(flags.division, flags.city as CityName);
    ns.tprint(`SUCCESS: Purchased warehouse in ${flags.city}`);
  } catch (e) {
    ns.tprint(`WARN: Could not purchase warehouse: ${e}`);
  }
}
