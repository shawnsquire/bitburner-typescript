/**
 * Assign Sleeve Action
 *
 * One-shot script that sets a sleeve's task based on daemon assignment.
 * Keeps sleeve API RAM cost out of the focus daemon.
 *
 * Reads the target daemon's status port to determine the specific activity
 * (which faction, which gym exercise, etc.) to assign to the sleeve.
 *
 * Usage:
 *   run actions/assign-sleeve.js --sleeve 0 --daemon rep
 *   run actions/assign-sleeve.js --sleeve 0 --daemon work
 *   run actions/assign-sleeve.js --sleeve 0 --daemon blade
 *   run actions/assign-sleeve.js --sleeve 0 --daemon none
 */
import { NS, FactionName, UniversityLocationName, GymLocationName } from "@ns";
import { peekStatus } from "/lib/ports";
import { STATUS_PORTS, RepStatus, WorkStatus } from "/types/ports";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["sleeve", 0],
    ["daemon", "none"],
  ]);

  const sleeveIndex = flags.sleeve as number;
  const daemon = flags.daemon as string;

  const numSleeves = ns.sleeve.getNumSleeves();
  if (sleeveIndex >= numSleeves) {
    ns.tprint(`ERROR: Sleeve index ${sleeveIndex} out of range (${numSleeves} sleeves available)`);
    return;
  }

  switch (daemon) {
    case "none":
      assignIdle(ns, sleeveIndex);
      break;
    case "rep":
      assignRep(ns, sleeveIndex);
      break;
    case "work":
      assignWork(ns, sleeveIndex);
      break;
    case "blade":
      assignBlade(ns, sleeveIndex);
      break;
    default:
      ns.tprint(`ERROR: Unknown daemon "${daemon}" for sleeve assignment`);
  }
}

function assignIdle(ns: NS, index: number): void {
  // Use shock recovery if shock > 0, otherwise idle
  const sleeve = ns.sleeve.getSleeve(index);
  if (sleeve.shock > 0) {
    ns.sleeve.setToShockRecovery(index);
    ns.toast(`Sleeve ${index}: shock recovery`, "info", 2000);
  } else {
    ns.sleeve.setToIdle(index);
    ns.toast(`Sleeve ${index}: idle`, "info", 2000);
  }
}

function assignRep(ns: NS, index: number): void {
  const status = peekStatus<RepStatus>(ns, STATUS_PORTS.rep, 30_000);
  const faction = status?.targetFaction || status?.focusedFaction;

  if (!faction) {
    ns.toast(`Sleeve ${index}: no target faction found for rep`, "warning", 2000);
    assignIdle(ns, index);
    return;
  }

  try {
    ns.sleeve.setToFactionWork(index, faction as FactionName, "hacking");
    ns.toast(`Sleeve ${index}: ${faction} faction work`, "success", 2000);
  } catch {
    ns.toast(`Sleeve ${index}: failed to set faction work for ${faction}`, "error", 2000);
    assignIdle(ns, index);
  }
}

function assignWork(ns: NS, index: number): void {
  const status = peekStatus<WorkStatus>(ns, STATUS_PORTS.work, 30_000);
  const focus = status?.currentFocus || "strength";

  // Map work daemon focus to sleeve activity
  if (focus === "hacking" || focus === "charisma") {
    // University courses
    const city = status?.playerCity || "Sector-12";
    const course = focus === "hacking" ? "Algorithms" : "Leadership";
    try {
      ns.sleeve.setToUniversityCourse(index, getUniversity(city) as UniversityLocationName, course);
      ns.toast(`Sleeve ${index}: ${course} at university`, "success", 2000);
    } catch {
      ns.toast(`Sleeve ${index}: failed to set university course`, "error", 2000);
      assignIdle(ns, index);
    }
  } else if (["strength", "defense", "dexterity", "agility"].includes(focus)) {
    // Gym workout — GymType uses short form: str, def, dex, agi
    const city = status?.playerCity || "Sector-12";
    const gymStatMap: Record<string, string> = {
      strength: "str", defense: "def", dexterity: "dex", agility: "agi",
    };
    const stat = (gymStatMap[focus] || "str") as "str" | "def" | "dex" | "agi";
    try {
      ns.sleeve.setToGymWorkout(index, getGym(city) as GymLocationName, stat);
      ns.toast(`Sleeve ${index}: ${stat} at gym`, "success", 2000);
    } catch {
      ns.toast(`Sleeve ${index}: failed to set gym workout`, "error", 2000);
      assignIdle(ns, index);
    }
  } else if (focus.startsWith("crime")) {
    // Crime
    try {
      ns.sleeve.setToCommitCrime(index, "Homicide");
      ns.toast(`Sleeve ${index}: committing crime`, "success", 2000);
    } catch {
      ns.toast(`Sleeve ${index}: failed to set crime`, "error", 2000);
      assignIdle(ns, index);
    }
  } else {
    assignIdle(ns, index);
  }
}

function assignBlade(ns: NS, index: number): void {
  // Default to Diplomacy (reduces chaos without risking failure)
  try {
    ns.sleeve.setToBladeburnerAction(index, "Diplomacy");
    ns.toast(`Sleeve ${index}: BB Diplomacy`, "success", 2000);
  } catch {
    // Bladeburner sleeve action may not be available
    ns.toast(`Sleeve ${index}: failed to set BB action (need Simulacrum?)`, "error", 2000);
    assignIdle(ns, index);
  }
}

/** Best gym by city. */
function getGym(city: string): string {
  switch (city) {
    case "Sector-12": return "Powerhouse Gym";
    case "Aevum": return "Snap Fitness Gym";
    case "Volhaven": return "Millenium Fitness Gym";
    default: return "Powerhouse Gym";
  }
}

/** Best university by city. */
function getUniversity(city: string): string {
  switch (city) {
    case "Sector-12": return "Rothman University";
    case "Aevum": return "Summit University";
    case "Volhaven": return "ZB Institute of Technology";
    default: return "Rothman University";
  }
}
