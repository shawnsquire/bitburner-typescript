/**
 * Darkweb Daemon
 *
 * Long-running daemon that automatically purchases the TOR router and
 * darkweb programs as they become affordable, then publishes DarkwebStatus
 * to the status port for the dashboard.
 *
 * Exits automatically once all programs are owned.
 *
 * Usage:
 *   run daemons/darkweb.js
 *   run daemons/darkweb.js --one-shot
 *   run daemons/darkweb.js --interval 15000
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { analyzeDarkwebPrograms, getDarkwebStatus, purchaseTorRouter, formatMoney } from "/controllers/darkweb";
import { publishStatus } from "/lib/ports";
import { STATUS_PORTS, DarkwebStatus } from "/types/ports";
import { writeDefaultConfig, getConfigNumber, getConfigBool } from "/lib/config";
import { canAfford, notifyPurchase, reportCap, signalDone } from "/lib/budget";

/**
 * Build a DarkwebStatus object with formatted values for the dashboard.
 * Bridges raw controller data to the port type expected by the UI.
 */
function computeDarkwebStatus(ns: NS): DarkwebStatus {
  const raw = getDarkwebStatus(ns);

  // Build formatted program list
  const programs = raw.alreadyOwned
    .concat(raw.cannotAfford)
    .sort((a, b) => a.cost - b.cost)
    .map((p) => ({
      name: p.name,
      cost: p.cost,
      costFormatted: ns.format.number(p.cost),
      owned: p.owned,
    }));

  // If TOR isn't owned yet, also check already-owned programs from file checks
  // (programs may be obtained through other means)
  const ownedCount = raw.ownedCount;
  const totalPrograms = raw.totalPrograms;
  const allOwned = totalPrograms > 0 && ownedCount >= totalPrograms;

  // Next program: cheapest unowned
  let nextProgram: DarkwebStatus["nextProgram"] = null;
  let moneyUntilNext = 0;
  let canAffordNext = false;

  if (raw.nextProgram) {
    nextProgram = {
      name: raw.nextProgram.name,
      cost: raw.nextProgram.cost,
      costFormatted: ns.format.number(raw.nextProgram.cost),
    };
    moneyUntilNext = raw.moneyUntilNext;
    canAffordNext = raw.nextProgram.cost <= raw.playerMoney;
  }

  return {
    hasTorRouter: raw.hasTorRouter,
    ownedCount,
    totalPrograms,
    nextProgram,
    moneyUntilNext,
    moneyUntilNextFormatted: ns.format.number(moneyUntilNext),
    canAffordNext,
    programs,
    allOwned,
  };
}

/**
 * Print formatted darkweb status to the script log.
 */
function printStatus(ns: NS, status: DarkwebStatus, purchasedThisCycle: string[]): void {
  const C = COLORS;

  ns.print(`${C.cyan}═══ Darkweb Daemon ═══${C.reset}`);

  if (!status.hasTorRouter) {
    ns.print(`${C.yellow}TOR Router not owned${C.reset}`);
    ns.print(`${C.dim}Cost: ${formatMoney(200000)}${C.reset}`);
    return;
  }

  ns.print(
    `${C.dim}Programs: ${status.ownedCount}/${status.totalPrograms} owned${C.reset}`,
  );
  ns.print("");

  // Show purchased this cycle
  if (purchasedThisCycle.length > 0) {
    ns.print(`${C.green}PURCHASED THIS CYCLE:${C.reset}`);
    for (const name of purchasedThisCycle) {
      ns.print(`  ${C.green}\u2713${C.reset} ${name}`);
    }
    ns.print("");
  }

  // Show owned programs
  const owned = status.programs.filter((p) => p.owned);
  if (owned.length > 0) {
    ns.print(`${C.dim}OWNED:${C.reset}`);
    for (const p of owned) {
      ns.print(`  ${C.dim}\u2713 ${p.name}${C.reset}`);
    }
    ns.print("");
  }

  // Show unowned programs
  const unowned = status.programs.filter((p) => !p.owned);
  if (unowned.length > 0) {
    ns.print(`${C.yellow}NOT YET OWNED:${C.reset}`);
    for (const p of unowned) {
      ns.print(
        `  ${C.dim}${p.name}: ${p.costFormatted}${C.reset}`,
      );
    }
    ns.print("");
  }

  // Show next target
  if (status.nextProgram) {
    if (status.canAffordNext) {
      ns.print(
        `${C.green}NEXT: ${status.nextProgram.name} (${status.nextProgram.costFormatted}) - can afford!${C.reset}`,
      );
    } else {
      ns.print(
        `${C.cyan}NEXT: ${status.nextProgram.name} (${status.nextProgram.costFormatted}) - need ${status.moneyUntilNextFormatted} more${C.reset}`,
      );
    }
  } else if (status.allOwned) {
    ns.print(`${C.green}All programs owned!${C.reset}`);
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "darkweb", {
    interval: "30000",
    oneShot: "false",
  });

  do {
    const interval = getConfigNumber(ns, "darkweb", "interval", 30000);
    const oneShot = getConfigBool(ns, "darkweb", "oneShot", false);
    ns.clearLog();

    // Budget check closure: gates purchases through the budget system
    const budgetCheck = (cost: number, _name: string): boolean => {
      return canAfford(ns, "programs", cost);
    };

    // Try to buy TOR if we don't have it
    let hasTor = false;
    try {
      hasTor = ns.singularity.getDarkwebPrograms().length > 0;
    } catch {
      hasTor = false;
    }

    if (!hasTor) {
      const bought = purchaseTorRouter(ns, budgetCheck);
      if (bought) {
        notifyPurchase(ns, "programs", 200_000, "TOR Router");
        ns.tprint(`${COLORS.green}Purchased TOR Router!${COLORS.reset}`);
        hasTor = true;
      }
    }

    // Run purchase cycle (buys affordable programs)
    let purchasedThisCycle: string[] = [];
    if (hasTor) {
      const result = analyzeDarkwebPrograms(ns, true, budgetCheck);
      purchasedThisCycle = result.purchased.map((p) => p.name);

      for (const p of result.purchased) {
        notifyPurchase(ns, "programs", p.cost, p.name);
      }

      if (result.purchased.length > 0) {
        ns.tprint(
          `${COLORS.green}Purchased ${result.purchased.length} program(s): ${purchasedThisCycle.join(", ")}${COLORS.reset}`,
        );
      }
    }

    // Report remaining cost cap to budget daemon
    if (hasTor) {
      const status = getDarkwebStatus(ns);
      const remainingCost = status.cannotAfford.reduce((sum, p) => sum + p.cost, 0);
      if (remainingCost > 0) {
        reportCap(ns, "programs", remainingCost);
      }
    }

    // Compute formatted status for the dashboard
    const darkwebStatus = computeDarkwebStatus(ns);

    // Publish to port for dashboard consumption
    publishStatus(ns, STATUS_PORTS.darkweb, darkwebStatus);

    // Print terminal lines
    printStatus(ns, darkwebStatus, purchasedThisCycle);

    // Exit if all programs are owned
    if (darkwebStatus.allOwned) {
      signalDone(ns, "programs");
      ns.tprint(`${COLORS.green}All darkweb programs owned - exiting.${COLORS.reset}`);
      return;
    }

    if (!oneShot) {
      ns.print(
        `\n${COLORS.dim}Next check in ${interval / 1000}s...${COLORS.reset}`,
      );
      await ns.sleep(interval);
    }
  } while (!getConfigBool(ns, "darkweb", "oneShot", false));
}
