/**
 * Hack Worker
 *
 * Minimal worker script for hacking a target server. Written in plain
 * JavaScript (not TypeScript) to minimize RAM cost — TS compilation adds
 * import overhead that multiplies across hundreds of fleet instances.
 *
 * RAM: 1.60 GB base + 0.10 GB (ns.hack) = 1.70 GB
 *
 * Args:
 *   [0] target   - Hostname to hack (string)
 *   [1] delay    - Additional milliseconds to wait before hacking (number, default 0)
 *   [2] launchTs - Launch timestamp for batch tracking (number, unused by worker)
 *   [3] batchTag - Batch identifier for batch tracking (string, unused by worker)
 */
/** @param {NS} ns */
export async function main(ns) {
  const target = ns.args[0];
  const delay = ns.args[1] || 0;
  await ns.hack(target, { additionalMsec: delay });
}
