/**
 * Make Product Action
 *
 * One-shot: start developing a new product.
 *
 * Usage: run actions/corp/make-product.js --division "Pony Tobacco" --name "Product-1" --invest 1e9
 */
import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["division", ""],
    ["name", ""],
    ["invest", 1e9],
    ["city", "Sector-12"],
  ]) as { division: string; name: string; invest: number; city: string; _: string[] };

  if (!flags.division || !flags.name) {
    ns.tprint("ERROR: Usage: run actions/corp/make-product.js --division \"Pony Tobacco\" --name Product-1 --invest 1e9");
    return;
  }

  try {
    ns.corporation.makeProduct(flags.division, flags.city as any, flags.name, flags.invest, flags.invest);
    ns.tprint(`SUCCESS: Started developing "${flags.name}" in ${flags.division} (${ns.format.number(flags.invest * 2)} total investment)`);
  } catch (e) {
    ns.tprint(`ERROR: ${e}`);
  }
}
