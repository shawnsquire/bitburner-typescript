/**
 * NeuroFlux Governor Donate & Buy Script
 *
 * Donates money for reputation then purchases NeuroFlux Governor upgrades.
 * When a player has 150+ favor with a faction, they can donate money to
 * instantly gain reputation, enabling more NFG purchases than rep alone would allow.
 *
 * Requires Singularity API (SF4)
 *
 * Run: run actions/neuroflux-donate.js              (dry run - shows plan)
 *      run actions/neuroflux-donate.js --confirm    (execute donations and purchases)
 *      run actions/neuroflux-donate.js --reserve 1b (keep 1 billion in reserve)
 */
import { NS, FactionName } from "@ns";
import { COLORS } from "/lib/utils";
import {
  calculateNFGDonatePurchasePlan,
  canDonateToFaction,
  DONATION_FAVOR_THRESHOLD,
  NFGDonatePurchasePlan,
} from "/controllers/factions";
// Augments/donations are outside the budget system entirely

// === TYPES ===

export interface DonateConfig {
  confirm: boolean;
  reserve: number;
}

export interface DonateResult {
  purchased: number;
  attempted: number;
  totalSpent: number;
  donationsSpent: number;
  purchasesSpent: number;
  failed: boolean;
  failReason?: string;
}

// === CORE LOGIC ===

/**
 * Execute the donate-and-purchase plan
 */
export async function executeDonateAndPurchase(
  ns: NS,
  plan: NFGDonatePurchasePlan
): Promise<DonateResult> {
  const C = COLORS;
  let purchased = 0;
  let donationsSpent = 0;
  let purchasesSpent = 0;

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];

    // Step 1: Donate if needed
    if (step.donationNeeded > 0) {
      const success = ns.singularity.donateToFaction(plan.faction as FactionName, step.donationNeeded);
      if (!success) {
        ns.tprint(
          `${C.red}✗${C.reset} Failed to donate $${ns.format.number(step.donationNeeded)} to ${plan.faction}`
        );
        return {
          purchased,
          attempted: plan.purchases,
          totalSpent: donationsSpent + purchasesSpent,
          donationsSpent,
          purchasesSpent,
          failed: true,
          failReason: "Donation failed",
        };
      }
      donationsSpent += step.donationNeeded;
      ns.tprint(
        `${C.yellow}$${C.reset} Donated ${C.yellow}$${ns.format.number(step.donationNeeded)}${C.reset} for ${C.cyan}${ns.format.number(step.repGap)}${C.reset} rep`
      );
    }

    // Step 2: Purchase NFG
    const purchaseSuccess = ns.singularity.purchaseAugmentation(plan.faction as FactionName, "NeuroFlux Governor");
    if (!purchaseSuccess) {
      ns.tprint(
        `${C.red}✗${C.reset} Failed to purchase NeuroFlux Governor #${i + 1}`
      );
      return {
        purchased,
        attempted: plan.purchases,
        totalSpent: donationsSpent + purchasesSpent,
        donationsSpent,
        purchasesSpent,
        failed: true,
        failReason: "Purchase failed",
      };
    }

    purchasesSpent += step.purchaseCost;
    purchased++;
    ns.tprint(
      `${C.green}✓${C.reset} Purchased ${C.white}NeuroFlux Governor${C.reset} #${C.cyan}${i + 1}${C.reset} for ${C.green}$${ns.format.number(step.purchaseCost)}${C.reset}`
    );

    await ns.sleep(50); // Small delay between operations
  }

  return {
    purchased,
    attempted: plan.purchases,
    totalSpent: donationsSpent + purchasesSpent,
    donationsSpent,
    purchasesSpent,
    failed: false,
  };
}

// === DISPLAY ===

/**
 * Display the donate & buy header
 */
export function displayHeader(
  ns: NS,
  availableMoney: number,
  faction: string,
  favor: number,
  confirm: boolean
): void {
  const C = COLORS;

  ns.tprint(`${C.cyan}${"═".repeat(70)}${C.reset}`);
  ns.tprint(
    `${" ".repeat(10)}${C.white}NEUROFLUX GOVERNOR DONATE & BUY${confirm ? "" : " (DRY RUN)"}${C.reset}`
  );
  ns.tprint(`${C.cyan}${"═".repeat(70)}${C.reset}`);
  ns.tprint(`${C.dim}Faction: ${C.white}${faction}${C.reset}`);
  ns.tprint(`${C.dim}Favor: ${favor.toFixed(0)} (min ${DONATION_FAVOR_THRESHOLD} required)${C.reset}`);
  ns.tprint(`${C.dim}Available: $${ns.format.number(availableMoney)}${C.reset}`);
  ns.tprint("");
}

/**
 * Display the purchase plan table
 */
export function displayPurchasePlan(
  ns: NS,
  plan: NFGDonatePurchasePlan
): void {
  const C = COLORS;

  ns.tprint(
    `${C.white}Can purchase ${C.green}${plan.purchases}${C.white} NFG${C.reset}`
  );
  ns.tprint("");

  // Summary box
  ns.tprint(`${C.dim}${"─".repeat(50)}${C.reset}`);
  ns.tprint(
    `  Donations: ${C.yellow}$${ns.format.number(plan.totalDonationCost).padStart(12)}${C.reset}`
  );
  ns.tprint(
    `  Purchases: ${C.green}$${ns.format.number(plan.totalPurchaseCost).padStart(12)}${C.reset}`
  );
  ns.tprint(
    `  Total:     ${C.cyan}$${ns.format.number(plan.totalCost).padStart(12)}${C.reset}`
  );
  ns.tprint(`${C.dim}${"─".repeat(50)}${C.reset}`);
  ns.tprint("");

  // Detail table
  ns.tprint(
    `${C.dim}${"#".padStart(2)}     ${"Donation".padStart(12)}     ${"Purchase".padStart(12)}     ${"Running".padStart(12)}${C.reset}`
  );
  ns.tprint(`${C.dim}${"─".repeat(55)}${C.reset}`);

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const donationStr = step.donationNeeded > 0
      ? `$${ns.format.number(step.donationNeeded)}`
      : "-";
    const purchaseStr = `$${ns.format.number(step.purchaseCost)}`;
    const runningStr = `$${ns.format.number(step.runningTotal)}`;

    ns.tprint(
      `${C.green}${(i + 1).toString().padStart(2)}${C.reset}     ` +
        `${C.yellow}${donationStr.padStart(12)}${C.reset}     ` +
        `${C.green}${purchaseStr.padStart(12)}${C.reset}     ` +
        `${C.cyan}${runningStr.padStart(12)}${C.reset}`
    );
  }

  ns.tprint(`${C.dim}${"─".repeat(55)}${C.reset}`);
}

// === RUNNER ===

export async function main(ns: NS): Promise<void> {
  const flags = ns.flags([
    ["confirm", false],
    ["reserve", 0],
  ]) as {
    confirm: boolean;
    reserve: number;
    _: string[];
  };

  const config: DonateConfig = {
    confirm: flags.confirm,
    reserve: flags.reserve,
  };

  const C = COLORS;
  const player = ns.getPlayer();
  const availableMoney = player.money - config.reserve;

  // Calculate the donate+purchase plan
  const plan = calculateNFGDonatePurchasePlan(ns, availableMoney);

  // Check if we can even donate
  if (plan.faction === "None" || !canDonateToFaction(ns, plan.faction)) {
    ns.tprint(`${C.yellow}No faction eligible for donate & buy.${C.reset}`);
    ns.tprint(`${C.dim}Requirements:${C.reset}`);
    ns.tprint(`${C.dim}  - Join a faction with NeuroFlux Governor${C.reset}`);
    ns.tprint(`${C.dim}  - Have ${DONATION_FAVOR_THRESHOLD}+ favor with that faction${C.reset}`);
    ns.tprint(`${C.dim}  - Faction must support donations (not a gang faction)${C.reset}`);
    return;
  }

  const favor = ns.singularity.getFactionFavor(plan.faction as FactionName);

  // Display header
  displayHeader(ns, availableMoney, plan.faction, favor, config.confirm);

  if (!plan.canExecute || plan.purchases === 0) {
    const currentPrice = ns.singularity.getAugmentationPrice("NeuroFlux Governor");
    const currentRepReq = ns.singularity.getAugmentationRepReq("NeuroFlux Governor");
    const currentRep = ns.singularity.getFactionRep(plan.faction as FactionName);
    const repGap = Math.max(0, currentRepReq - currentRep);

    ns.tprint(`${C.yellow}Cannot afford any NeuroFlux Governor upgrades.${C.reset}`);
    ns.tprint(`${C.dim}Next NFG costs $${ns.format.number(currentPrice)}${C.reset}`);
    if (repGap > 0) {
      ns.tprint(`${C.dim}Would also need donation for ${ns.format.number(repGap)} rep${C.reset}`);
    }
    return;
  }

  // Display plan
  displayPurchasePlan(ns, plan);

  ns.tprint("");

  // Execute if confirmed
  if (!config.confirm) {
    ns.tprint(`${C.yellow}DRY RUN - No changes made.${C.reset}`);
    ns.tprint(`${C.dim}Run with --confirm to execute donations and purchases.${C.reset}`);
    return;
  }

  ns.tprint(`${C.cyan}Executing donate & buy plan...${C.reset}`);
  ns.tprint("");

  const result = await executeDonateAndPurchase(ns, plan);

  ns.tprint("");
  ns.tprint(`${C.cyan}${"═".repeat(70)}${C.reset}`);

  if (result.failed) {
    ns.tprint(
      `${C.red}Plan failed: ${result.failReason}${C.reset}`
    );
    ns.tprint(
      `${C.dim}Completed ${result.purchased}/${result.attempted} before failure${C.reset}`
    );
  } else {
    ns.tprint(
      `${C.white}Purchased ${C.green}${result.purchased}${C.reset} NFG upgrades${C.reset}`
    );
  }

  ns.tprint(
    `${C.dim}Donated: $${ns.format.number(result.donationsSpent)} | Purchased: $${ns.format.number(result.purchasesSpent)} | Total: $${ns.format.number(result.totalSpent)}${C.reset}`
  );

  if (result.purchased > 0) {
    ns.tprint("");
    ns.tprint(`${C.yellow}Remember to install augmentations when ready:${C.reset}`);
    ns.tprint(
      `${C.dim}ns.singularity.installAugmentations() or use the Augmentations menu${C.reset}`
    );
  }
}
