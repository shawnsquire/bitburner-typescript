import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
  const infiltrations = ns.infiltration.getPossibleLocations()
    .map(x => ns.infiltration.getInfiltration(x.name))
    .sort((a, b) => a.difficulty - b.difficulty);

  ns.tprint(`${"Location".padStart(24)} ${"Dif".padEnd(4)} ${"Cl".padEnd(3)} ${"Sec".padEnd(6)} ${"Reward".padEnd(8)} Rep/C`)
  for (const loc of infiltrations) {
    const repPerChallenge = loc.reward.tradeRep / loc.maxClearanceLevel;
    ns.tprint(`${loc.location.name.slice(0, 12).padStart(12)}, ${loc.location.city.padEnd(10)} ${ns.format.number(loc.difficulty, 2).padEnd(4)} ${ns.format.number(loc.maxClearanceLevel, 0).padEnd(3)} ${ns.format.number(loc.startingSecurityLevel).padEnd(6)} ${ns.format.number(loc.reward.tradeRep).padEnd(8)} ${ns.format.number(repPerChallenge, 2)}`);
  }
}
