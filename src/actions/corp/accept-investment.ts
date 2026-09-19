/**
 * Accept Investment Action
 *
 * One-shot: accept current investment offer.
 *
 * Usage: run actions/corp/accept-investment.js
 */
import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  try {
    const offer = ns.corporation.getInvestmentOffer();
    ns.tprint(`INFO: Current offer — Round ${offer.round}: ${ns.format.number(offer.funds)} for ${ns.format.number(offer.shares)} shares`);

    const success = ns.corporation.acceptInvestmentOffer();
    if (success) {
      ns.tprint(`SUCCESS: Accepted round ${offer.round} investment of ${ns.format.number(offer.funds)}`);
    } else {
      ns.tprint("FAILED: Could not accept investment offer");
    }
  } catch (e) {
    ns.tprint(`ERROR: ${e}`);
  }
}
