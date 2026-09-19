/**
 * Hire Employees Action
 *
 * One-shot: hire and assign employees in a division/city.
 *
 * Usage: run actions/corp/hire-employees.js --division "Pony Agriculture" --city Sector-12 --count 3
 */
import { NS, CityName } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["division", ""],
    ["city", "Sector-12"],
    ["count", 3],
  ]) as { division: string; city: string; count: number; _: string[] };

  if (!flags.division) {
    ns.tprint("ERROR: Usage: run actions/corp/hire-employees.js --division \"Pony Agriculture\" --city Sector-12 --count 3");
    return;
  }

  let hired = 0;
  try {
    for (let i = 0; i < flags.count; i++) {
      const success = ns.corporation.hireEmployee(flags.division, flags.city as CityName);
      if (success) {
        hired++;
      } else {
        break;
      }
    }

    if (hired > 0) {
      ns.tprint(`SUCCESS: Hired ${hired} employees in ${flags.division}/${flags.city}`);
    } else {
      ns.tprint(`WARN: Could not hire employees (office may be full)`);
    }
  } catch (e) {
    ns.tprint(`ERROR: ${e}`);
  }
}
