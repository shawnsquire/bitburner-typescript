/**
 * Purchase NeuroFlux Governor Action
 *
 * Purchases as many NeuroFlux Governor levels as possible from the best faction.
 * Uses factions controller for analysis.
 * Target RAM: ~340 GB at SF4.1
 *
 * Usage: run actions/purchase-neuroflux.js
 *        run actions/purchase-neuroflux.js --faction CyberSec
 *        run actions/purchase-neuroflux.js --dry-run
 *        run actions/purchase-neuroflux.js --max-levels 10
 */
import { NS, FactionName } from "@ns";
import { getNeuroFluxInfo, calculateNeuroFluxPurchasePlan } from "/controllers/factions";

export const MANUAL_COMMAND = 'ns.singularity.purchaseAugmentation("FACTION", "NeuroFlux Governor")';

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["faction", ""],
    ["dry-run", false],
    ["max-levels", Infinity],
  ]) as { faction: string; "dry-run": boolean; "max-levels": number; _: string[] };

  const dryRun = flags["dry-run"];
  const maxLevels = flags["max-levels"];

  // Get NeuroFlux info (honoring --faction override, if it's a joined faction with NFG)
  const nfInfo = getNeuroFluxInfo(ns, flags.faction || undefined);
  const factionName = nfInfo.bestFaction || flags.faction;

  if (!factionName) {
    ns.tprint("ERROR: No faction available for NeuroFlux Governor purchase.");
    ns.tprint("  Join a faction and earn enough reputation first.");
    return;
  }

  ns.tprint(`\n=== NeuroFlux Governor Purchase ${dryRun ? "(DRY RUN)" : ""} ===`);
  ns.tprint(`Current NFG level: ${nfInfo.currentLevel}`);
  ns.tprint(`Target faction: ${factionName}`);

  // Check if we have enough reputation
  if (!nfInfo.hasEnoughRep) {
    ns.tprint(`Not enough reputation to purchase NeuroFlux Governor.`);
    ns.tprint(`  Need ${ns.format.number(nfInfo.repRequired)} rep, have ${ns.format.number(nfInfo.bestFactionRep)} with ${factionName}.`);
    return;
  }

  // Calculate how many we can buy (use the resolved faction so the plan matches
  // whichever faction we're actually about to purchase through)
  const availableMoney = ns.getServerMoneyAvailable("home");
  const plan = calculateNeuroFluxPurchasePlan(ns, availableMoney, factionName);

  if (!plan || plan.purchases === 0) {
    ns.tprint("Cannot purchase any NeuroFlux Governor levels.");
    ns.tprint("  Not enough reputation or money.");
    return;
  }

  const levelsToBuy = Math.min(plan.purchases, maxLevels);

  ns.tprint(`Levels available: ${plan.purchases}`);
  ns.tprint(`Levels to buy: ${levelsToBuy}`);
  ns.tprint(`Total cost: ${ns.format.number(plan.totalCost, 1)}`);

  let purchased = 0;

  for (let i = 0; i < levelsToBuy; i++) {
    if (dryRun) {
      ns.tprint(`  WOULD BUY: NeuroFlux Governor level ${nfInfo.currentLevel + i + 1}`);
      purchased++;
    } else {
      const success = ns.singularity.purchaseAugmentation(factionName as FactionName, "NeuroFlux Governor");
      if (success) {
        purchased++;
        ns.tprint(`  BOUGHT: NeuroFlux Governor level ${nfInfo.currentLevel + purchased}`);
      } else {
        ns.tprint(`  FAILED at level ${nfInfo.currentLevel + purchased + 1} — stopping`);
        break;
      }
    }
  }

  ns.tprint(`\n--- Summary ---`);
  ns.tprint(`  ${dryRun ? "Would purchase" : "Purchased"}: ${purchased} levels`);
  ns.tprint(`  New NFG level: ${nfInfo.currentLevel + purchased}`);
  ns.tprint(`  Remaining money: ${ns.format.number(ns.getServerMoneyAvailable("home"), 1)}`);
}
