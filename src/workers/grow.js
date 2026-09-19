/**
 * Grow Worker
 *
 * Minimal worker script for growing a target server. Written in plain
 * JavaScript (not TypeScript) to minimize RAM cost — TS compilation adds
 * import overhead that multiplies across hundreds of fleet instances.
 *
 * RAM: 1.60 GB base + 0.15 GB (ns.grow) = 1.75 GB
 *
 * Args:
 *   [0] target   - Hostname to grow (string)
 *   [1] delay    - Additional milliseconds to wait before growing (number, default 0)
 *   [2] launchTs - Launch timestamp for batch tracking (number, unused by worker)
 *   [3] batchTag - Batch identifier for batch tracking (string, unused by worker)
 */
/** @param {NS} ns */
export async function main(ns) {
  const target = ns.args[0];
  const delay = ns.args[1] || 0;
  await ns.grow(target, { additionalMsec: delay });
}
