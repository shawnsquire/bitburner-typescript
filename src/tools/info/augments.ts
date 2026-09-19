import { NS, Multipliers } from "@ns";
import { getInstalledAugs, getPendingAugs } from "/controllers/factions";

export async function main(ns: NS): Promise<void> {
  const installed = getInstalledAugs(ns);
  // Count-based diff (not a plain `!installed.includes(a)` filter): NeuroFlux
  // Governor can appear multiple times in the "purchased" list (once per queued
  // level) while only ever appearing once in the installed list, so a naive
  // membership filter would hide ALL pending NFG once any NFG is installed.
  const pending = getPendingAugs(ns);

  ns.tprint(`\n=== Installed Augmentations (${installed.length}) ===`);
  for (const aug of installed.sort()) {
    const stats = ns.singularity.getAugmentationStats(aug);
    const bonuses = formatStats(stats);
    ns.tprint(`  ${aug}${bonuses ? ` — ${bonuses}` : ""}`);
  }

  if (pending.length > 0) {
    ns.tprint(`\n=== Pending Install (${pending.length}) ===`);
    for (const aug of pending.sort()) {
      const stats = ns.singularity.getAugmentationStats(aug);
      const bonuses = formatStats(stats);
      ns.tprint(`  ${aug}${bonuses ? ` — ${bonuses}` : ""}`);
    }
  }

  ns.tprint(`\nTotal: ${installed.length} installed, ${pending.length} pending`);
}

function formatStats(stats: Multipliers): string {
  return Object.entries(stats)
    .filter(([, v]) => v !== 1)
    .map(([k, v]) => {
      const name = k.replace(/_/g, " ");
      const pct = ((v - 1) * 100).toFixed(0);
      return `${name} ${v > 1 ? "+" : ""}${pct}%`;
    })
    .join(", ");
}
