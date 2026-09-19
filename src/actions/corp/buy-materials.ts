/**
 * Buy Materials Action
 *
 * One-shot: buy production materials for a city using controller logic.
 *
 * Usage: run actions/corp/buy-materials.js --division "Pony Agriculture" --city Sector-12
 */
import { NS, CityName, CorpMaterialName } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["division", ""],
    ["city", ""],
  ]) as { division: string; city: string; _: string[] };

  if (!flags.division || !flags.city) {
    ns.tprint("ERROR: Usage: run actions/corp/buy-materials.js --division \"Pony Agriculture\" --city Sector-12");
    return;
  }

  try {
    const wh = ns.corporation.getWarehouse(flags.division, flags.city as CityName);
    const available = wh.size - wh.sizeUsed;
    if (available <= 0) {
      ns.tprint(`WARN: Warehouse in ${flags.city} is full (${wh.sizeUsed}/${wh.size})`);
      return;
    }

    // Buy materials proportionally
    const materials: Record<string, number> = { Water: 0.5, Chemicals: 0.5 };
    for (const [name, ratio] of Object.entries(materials)) {
      const amount = Math.floor(available * ratio);
      if (amount > 0) {
        ns.corporation.buyMaterial(flags.division, flags.city as CityName, name as CorpMaterialName, amount);
        ns.tprint(`SUCCESS: Buying ${amount} ${name} in ${flags.city}`);
      }
    }

    // Wait one cycle then stop buying
    await ns.corporation.nextUpdate();

    for (const name of Object.keys(materials)) {
      ns.corporation.buyMaterial(flags.division, flags.city as CityName, name as CorpMaterialName, 0);
    }
    ns.tprint("SUCCESS: Material purchase complete, stopped buying");
  } catch (e) {
    ns.tprint(`ERROR: ${e}`);
  }
}
