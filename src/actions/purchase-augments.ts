/**
 * Purchase Augmentations Action
 *
 * Analyzes all factions and purchases affordable augmentations in priority order.
 * Uses ramOverride to calculate actual RAM needed at runtime, supporting any SF4 level.
 *
 * Usage: run actions/purchase-augments.js
 *        run actions/purchase-augments.js --dry-run
 *        run actions/purchase-augments.js --max-spend 1e12
 */
import { NS, FactionName } from "@ns";
import { analyzeFactions, calculatePurchasePriority, AUG_COST_MULT, getSequentialPurchaseAugs } from "/controllers/factions";

export const MANUAL_COMMAND = 'ns.singularity.purchaseAugmentation("FACTION", "AUG_NAME")';

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["dry-run", false],
    ["max-spend", Infinity],
    ["only", ""],
  ]) as { "dry-run": boolean; "max-spend": number; only: string; _: string[] };

  const dryRun = flags["dry-run"];
  const maxSpend = flags["max-spend"];

  // Parse --only flag: JSON array of aug names to purchase exclusively
  let onlyAugs: Set<string> | null = null;
  if (flags.only) {
    try {
      const parsed = JSON.parse(flags.only) as string[];
      onlyAugs = new Set(parsed);
    } catch {
      ns.tprint(`ERROR: --only flag must be a JSON array of augment names`);
      return;
    }
  }

  // Analyze all factions and get purchase priority
  const player = ns.getPlayer();
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const factions = analyzeFactions(ns, player, ownedAugs);
  const plan = calculatePurchasePriority(ns, factions);

  // Filter plan if --only was provided
  const filteredPlan = onlyAugs
    ? plan.filter((a) => onlyAugs!.has(a.name))
    : plan;

  // Recalculate rolling multipliers for the filtered subset
  // Without this, filtered augs keep inflated multipliers from their
  // position in the full list (e.g. position 9 of 10 → 1.9^9 instead of 1.9^2)
  if (onlyAugs) {
    let mult = 1;
    for (const aug of filteredPlan) {
      aug.adjustedCost = Math.round(aug.basePrice * mult);
      aug.multiplier = mult;
      mult *= AUG_COST_MULT;
    }
  }

  if (filteredPlan.length === 0) {
    ns.tprint("No augmentations available for purchase.");
    return;
  }

  let totalSpent = 0;
  let purchased = 0;
  let skipped = 0;
  let playerMoney = ns.getServerMoneyAvailable("home");

  ns.tprint(`\n=== Augmentation Purchase ${dryRun ? "(DRY RUN)" : ""} ===`);
  ns.tprint(`Available money: ${ns.format.number(playerMoney, 1)}`);
  ns.tprint(`Augmentations in plan: ${filteredPlan.length}${onlyAugs ? ` (filtered from ${plan.length})` : ""}\n`);

  for (const aug of filteredPlan) {
    if (totalSpent + aug.adjustedCost > maxSpend) {
      ns.tprint(`  SKIP: ${aug.name} (${ns.format.number(aug.adjustedCost, 1)}) — exceeds max spend`);
      skipped++;
      continue;
    }

    if (playerMoney < aug.adjustedCost) {
      ns.tprint(`  SKIP: ${aug.name} (${ns.format.number(aug.adjustedCost, 1)}) — can't afford (have ${ns.format.number(playerMoney, 1)})`);
      skipped++;
      continue;
    }

    if (dryRun) {
      ns.tprint(`  WOULD BUY: ${aug.name} from ${aug.faction} for ${ns.format.number(aug.adjustedCost, 1)}`);
      totalSpent += aug.adjustedCost;
      playerMoney -= aug.adjustedCost;
      purchased++;
    } else {
      const success = ns.singularity.purchaseAugmentation(aug.faction as FactionName, aug.name);
      if (success) {
        ns.tprint(`  BOUGHT: ${aug.name} from ${aug.faction} for ${ns.format.number(aug.adjustedCost, 1)}`);
        totalSpent += aug.adjustedCost;
        playerMoney = ns.getServerMoneyAvailable("home");
        purchased++;
      } else {
        ns.tprint(`  FAILED: ${aug.name} from ${aug.faction}`);
        skipped++;
      }
    }
  }

  // Check for sequential purchase augs (Shadows of Anarchy, etc.)
  const sequentialAugs = getSequentialPurchaseAugs(ns, factions, playerMoney);
  if (sequentialAugs.length > 0) {
    ns.tprint(`\n--- Sequential Purchase Augs (one at a time) ---`);
    for (const item of sequentialAugs) {
      const affordStr = item.canAfford ? "CAN AFFORD" : `need $${ns.format.number(item.aug.basePrice, 1)}`;
      ns.tprint(`  ${item.aug.name} from ${item.faction} - ${affordStr}`);

      if (!dryRun && item.canAfford) {
        const success = ns.singularity.purchaseAugmentation(item.faction as FactionName, item.aug.name);
        if (success) {
          ns.tprint(`  BOUGHT: ${item.aug.name} from ${item.faction}`);
          purchased++;
          playerMoney = ns.getServerMoneyAvailable("home");
        } else {
          ns.tprint(`  FAILED: ${item.aug.name} from ${item.faction}`);
        }
      }
    }
  }

  ns.tprint(`\n--- Summary ---`);
  ns.tprint(`  ${dryRun ? "Would purchase" : "Purchased"}: ${purchased}`);
  ns.tprint(`  Skipped: ${skipped}`);
  ns.tprint(`  Total cost: ${ns.format.number(totalSpent, 1)}`);
  ns.tprint(`  Remaining money: ${ns.format.number(playerMoney, 1)}`);
}
