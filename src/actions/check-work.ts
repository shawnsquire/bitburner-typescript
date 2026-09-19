/**
 * Check Work Status Action
 *
 * Lightweight one-shot that reads current work state and player stats.
 * Publishes partial WorkStatus to port 6.
 * Target RAM: ~11 GB at SF4.1 (getCurrentWork + isFocused = 2 Singularity functions)
 *
 * Usage: run actions/check-work.js
 */
import { NS } from "@ns";
import { publishStatus } from "/lib/ports";
import { STATUS_PORTS, WorkStatus } from "/types/ports";

export const MANUAL_COMMAND = 'ns.singularity.getCurrentWork()';

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  // Exit early if the work daemon is running (it publishes richer status)
  if (ns.ps("home").some(p => p.filename === "daemons/work.js")) {
    return;
  }

  const player = ns.getPlayer();
  const currentWork = ns.singularity.getCurrentWork();
  const focused = ns.singularity.isFocused();

  // Read work config if it exists
  let currentFocus = "strength";
  try {
    const configRaw = ns.read("/data/work-config.json");
    if (configRaw) {
      const config = JSON.parse(configRaw);
      currentFocus = config.focus || "strength";
    }
  } catch { /* use default */ }

  // Determine activity type and display
  let activityType: "gym" | "university" | "crime" | "idle" | "other" = "idle";
  let activityDisplay = "Idle";
  let isTraining = false;

  if (currentWork !== null) {
    const work = currentWork as unknown as Record<string, unknown>;
    const workType = work.type as string;
    if (workType === "CLASS") {
      const classType = work.classType as string;
      const location = work.location as string;
      if (classType?.includes("gym")) {
        activityType = "gym";
        activityDisplay = `Gym: ${location}${focused ? " (focused)" : ""}`;
        isTraining = true;
      } else {
        activityType = "university";
        activityDisplay = `Univ: ${location}${focused ? " (focused)" : ""}`;
        isTraining = true;
      }
    } else if (workType === "CRIME") {
      activityType = "crime";
      const crimeType = work.crimeType as string;
      activityDisplay = `Crime: ${crimeType}${focused ? " (focused)" : ""}`;
      isTraining = true;
    } else if (workType === "COMPANY") {
      activityType = "other";
      const companyName = work.companyName as string;
      activityDisplay = `Company: ${companyName}${focused ? " (focused)" : ""}`;
    } else if (workType === "FACTION") {
      activityType = "other";
      activityDisplay = `Faction work${focused ? " (focused)" : ""}`;
    } else {
      activityType = "other";
      activityDisplay = `${workType}${focused ? " (focused)" : ""}`;
    }
  }

  // Build focus label
  const focusLabels: Record<string, string> = {
    "strength": "STR",
    "defense": "DEF",
    "dexterity": "DEX",
    "agility": "AGI",
    "hacking": "HACK",
    "charisma": "CHA",
    "balance-all": "BAL-ALL",
    "balance-combat": "BAL-CMB",
    "crime-money": "CRIME $",
    "crime-stats": "CRIME XP",
    "crime-karma": "CRIME K",
    "crime-kills": "CRIME KL",
  };

  const combatStats = [player.skills.strength, player.skills.defense, player.skills.dexterity, player.skills.agility];
  const lowestCombat = Math.min(...combatStats);
  const highestCombat = Math.max(...combatStats);

  const status: WorkStatus = {
    tier: 0,
    tierName: "monitor",
    availableFeatures: ["status-display"],
    unavailableFeatures: ["gym-training", "university-training", "travel", "crime"],
    currentRamUsage: ns.getScriptRam(ns.getScriptName()),
    currentFocus,
    focusLabel: focusLabels[currentFocus] || currentFocus.toUpperCase(),
    playerCity: player.city,
    playerMoney: player.money,
    playerMoneyFormatted: ns.format.number(player.money, 1),
    isFocused: focused,
    skills: {
      strength: player.skills.strength,
      defense: player.skills.defense,
      dexterity: player.skills.dexterity,
      agility: player.skills.agility,
      hacking: player.skills.hacking,
      charisma: player.skills.charisma,
      strengthFormatted: ns.format.number(player.skills.strength, 0),
      defenseFormatted: ns.format.number(player.skills.defense, 0),
      dexterityFormatted: ns.format.number(player.skills.dexterity, 0),
      agilityFormatted: ns.format.number(player.skills.agility, 0),
      hackingFormatted: ns.format.number(player.skills.hacking, 0),
      charismaFormatted: ns.format.number(player.skills.charisma, 0),
    },
    activityDisplay,
    activityType,
    isTraining,
    recommendation: null,  // Not computed in lightweight action
    canTravelToBest: false,
    skillTimeSpent: [],  // Not tracked in lightweight action
    lowestCombatStat: lowestCombat,
    highestCombatStat: highestCombat,
    combatBalance: highestCombat > 0 ? lowestCombat / highestCombat : 1,
    balanceRotation: null,  // Not computed in lightweight action
    crimeInfo: null,  // Not computed in lightweight action
    pendingCrimeSwitch: null,  // Not computed in lightweight action
  };

  publishStatus(ns, STATUS_PORTS.work, status);
  ns.print("Published work status to port " + STATUS_PORTS.work);
}
