/**
 * Install Augmentations Action
 *
 * One-shot script to install purchased augmentations and soft-reset.
 * WARNING: This resets the game! Only run when ready.
 * Target RAM: ~82 GB at SF4.1 (installAugmentations = 1 Singularity function)
 *
 * Usage: run actions/install-augments.js
 *        run actions/install-augments.js --confirm
 */
import { NS } from "@ns";
import { setConfigValue } from "/lib/config";

export const MANUAL_COMMAND = 'ns.singularity.installAugmentations("start.js")';

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["confirm", false],
    ["script", "start.js"],
  ]) as { confirm: boolean; script: string; _: string[] };

  if (!flags.confirm) {
    ns.tprint("WARNING: This will install augmentations and SOFT RESET the game!");
    ns.tprint("  To confirm, run: run actions/install-augments.js --confirm");
    ns.tprint(`  Start script: ${flags.script}`);
    return;
  }

  // The game re-initialises the stock market on install (Prestige.ts calls
  // initStockMarket), which wipes every open position without paying for it. Sell
  // everything first; the stocks daemon may be holding most of net worth.
  liquidateStocks(ns);

  // Pre-configure defaults for post-reset
  // Config files persist across soft resets
  setConfigValue(ns, "hack", "strategy", "money");
  setConfigValue(ns, "work", "focus", "hacking");
  setConfigValue(ns, "focus", "holder", "work");
  setConfigValue(ns, "pserv", "autoBuy", "true");

  ns.tprint(`Installing augmentations... Restarting with ${flags.script}`);
  ns.singularity.installAugmentations(flags.script);
}

function liquidateStocks(ns: NS): void {
  let hasTix = false;
  try {
    hasTix = ns.stock.hasTixApiAccess();
  } catch {
    return; // no stock market in this BitNode
  }
  if (!hasTix) return;
  let sold = 0;
  for (const sym of ns.stock.getSymbols()) {
    const [longShares, , shortShares] = ns.stock.getPosition(sym);
    if (longShares > 0 && ns.stock.sellStock(sym, longShares) > 0) sold++;
    if (shortShares > 0 && ns.stock.sellShort(sym, shortShares) > 0) sold++;
  }
  if (sold > 0) ns.tprint(`Sold ${sold} stock position(s) before install.`);
}
