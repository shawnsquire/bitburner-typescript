/**
 * Expand Division Action
 *
 * One-shot: create a new industry division.
 *
 * Usage: run actions/corp/expand-division.js --type Tobacco --name "Pony Tobacco"
 */
import { NS, CorpIndustryName } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["type", ""],
    ["name", ""],
  ]) as { type: string; name: string; _: string[] };

  if (!flags.type || !flags.name) {
    ns.tprint("ERROR: Usage: run actions/corp/expand-division.js --type Agriculture --name \"Pony Agriculture\"");
    return;
  }

  try {
    ns.corporation.expandIndustry(flags.type as CorpIndustryName, flags.name);
    ns.tprint(`SUCCESS: Created ${flags.type} division "${flags.name}"`);
  } catch (e) {
    ns.tprint(`ERROR: ${e}`);
  }
}
