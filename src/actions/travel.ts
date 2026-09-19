/**
 * Travel to City Action
 *
 * One-shot script to travel to a specified city.
 * Target RAM: ~34 GB at SF4.1 (travelToCity = 1 Singularity function)
 *
 * Usage: run actions/travel.js --city Sector-12
 *        run actions/travel.js --city Volhaven
 */
import { NS, CityName } from "@ns";

export const MANUAL_COMMAND = 'ns.singularity.travelToCity("CITY_NAME")';

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["city", ""],
  ]) as { city: string; _: string[] };

  const city = flags.city || (flags._.length > 0 ? String(flags._[0]) : "");

  if (!city) {
    ns.tprint("ERROR: No city specified. Usage: run actions/travel.js --city Sector-12");
    ns.tprint("  Valid cities: Sector-12, Aevum, Volhaven, Chongqing, New Tokyo, Ishima");
    return;
  }

  const validCities = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];
  if (!validCities.includes(city)) {
    ns.tprint(`ERROR: Invalid city "${city}". Valid: ${validCities.join(", ")}`);
    return;
  }

  const cost = 200_000;
  const money = ns.getServerMoneyAvailable("home");

  if (money < cost) {
    ns.tprint(`FAILED: Not enough money to travel. Need $200k, have ${ns.format.number(money, 1)}`);
    return;
  }

  const success = ns.singularity.travelToCity(city as CityName);

  if (success) {
    ns.tprint(`SUCCESS: Traveled to ${city}`);
  } else {
    ns.tprint(`FAILED: Could not travel to ${city}`);
  }
}
