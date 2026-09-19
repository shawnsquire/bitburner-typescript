/**
 * Sell All Stocks
 *
 * Liquidates all stock positions (long and short). Useful before a reset.
 *
 * Usage:
 *   run tools/control/sell-all-stocks.js
 *
 * RAM: ~10.6 GB (stock API functions)
 */
import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
  if (!ns.stock.hasTixApiAccess()) {
    ns.tprint("ERROR: No TIX API access — cannot sell stocks");
    return;
  }

  const symbols = ns.stock.getSymbols();
  let totalGain = 0;
  let positionsSold = 0;

  for (const sym of symbols) {
    const [longShares, , shortShares] = ns.stock.getPosition(sym);

    if (longShares > 0) {
      const gain = ns.stock.sellStock(sym, longShares);
      if (gain > 0) {
        ns.tprint(`SOLD LONG  ${sym}: ${ns.format.number(longShares, 0)} shares for ${ns.format.number(gain)}`);
        totalGain += gain;
        positionsSold++;
      }
    }

    if (shortShares > 0) {
      const gain = ns.stock.sellShort(sym, shortShares);
      if (gain > 0) {
        ns.tprint(`SOLD SHORT ${sym}: ${ns.format.number(shortShares, 0)} shares for ${ns.format.number(gain)}`);
        totalGain += gain;
        positionsSold++;
      }
    }
  }

  if (positionsSold === 0) {
    ns.tprint("No open positions to sell.");
    ns.toast("No stock positions to sell", "info", 2000);
  } else {
    ns.tprint(`\nSold ${positionsSold} position(s) for ${ns.format.number(totalGain)} total.`);
    ns.toast(`Sold ${positionsSold} stock position(s)`, "success", 3000);
  }
}
