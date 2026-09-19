/**
 * Share Worker
 *
 * Shares computing power with factions. Written in plain JavaScript to
 * minimize RAM cost for fleet deployment.
 *
 * RAM: 1.60 GB base + 2.40 GB (ns.share) = 4.00 GB
 *
 * Args: none
 */
/** @param {NS} ns */
export async function main(ns) {
  await ns.share();
}
