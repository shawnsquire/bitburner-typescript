/**
 * Buy Upgrade Action
 *
 * One-shot: purchase a specific corp upgrade.
 *
 * Usage: run actions/corp/buy-upgrade.js --name "Smart Factories"
 */
import { NS, CorpUpgradeName } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["name", ""],
  ]) as { name: string; _: string[] };

  const name = flags.name || (flags._.length > 0 ? String(flags._[0]) : "");

  if (!name) {
    ns.tprint("ERROR: Usage: run actions/corp/buy-upgrade.js --name \"Smart Factories\"");
    return;
  }

  try {
    const level = ns.corporation.getUpgradeLevel(name as CorpUpgradeName);
    const cost = ns.corporation.getUpgradeLevelCost(name as CorpUpgradeName);
    ns.tprint(`INFO: ${name} — current level ${level}, upgrade cost ${ns.format.number(cost)}`);

    ns.corporation.levelUpgrade(name as CorpUpgradeName);
    ns.tprint(`SUCCESS: ${name} upgraded to level ${level + 1}`);
  } catch (e) {
    ns.tprint(`ERROR: ${e}`);
  }
}
