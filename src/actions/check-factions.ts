/**
 * Check Factions Action
 *
 * Lightweight one-shot script that checks faction invitations and builds
 * a FactionStatus for the dashboard. Published to port 9 for the faction
 * tool to read.
 *
 * Added to queue runner's round-robin so dashboard gets updates even
 * without the faction daemon running.
 *
 * Target RAM: ~5 GB at SF4.2 (checkFactionInvitations)
 */
import { NS } from "@ns";
import { publishStatus } from "/lib/ports";
import { STATUS_PORTS, FactionStatus } from "/types/ports";
import {
  classifyFactions,
  evaluateRequirements,
  isEligibleForFaction,
  PlayerWithStats,
} from "/controllers/faction-manager";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  // Exit early if the faction daemon is running (it publishes richer status)
  if (ns.ps("home").some(p => p.filename === "daemons/faction.js")) {
    return;
  }

  const player = ns.getPlayer();

  let invitations: string[] = [];
  try {
    invitations = ns.singularity.checkFactionInvitations();
  } catch {
    // No Singularity access - that's fine, just use player.factions
  }

  let factions = classifyFactions(
    { factions: player.factions, city: player.city, money: player.money },
    invitations,
  );

  // Build player stats for requirement evaluation
  const playerStats: PlayerWithStats = {
    factions: player.factions,
    city: player.city,
    money: player.money,
    hacking: player.skills.hacking,
    strength: player.skills.strength,
    defense: player.skills.defense,
    dexterity: player.skills.dexterity,
    agility: player.skills.agility,
    augsInstalled: 0,
    karma: player.karma,
    numPeopleKilled: player.numPeopleKilled,
  };

  // Enrich factions with requirements
  factions = factions.map(f => {
    if (f.status === "joined") return f;
    const reqs = evaluateRequirements(f.name, playerStats);
    const eligible = isEligibleForFaction(f.name, playerStats);
    return { ...f, requirements: reqs ?? undefined, eligible };
  });

  const joinedCount = factions.filter(f => f.status === "joined").length;
  const invitedCount = factions.filter(f => f.status === "invited").length;
  const notInvitedCount = factions.filter(f => f.status === "not-invited").length;

  const status: FactionStatus = {
    tier: 0,
    tierName: "check",
    availableFeatures: ["status-check"],
    unavailableFeatures: ["auto-join", "auto-travel", "aug-awareness"],
    currentRamUsage: ns.getScriptRam(ns.getScriptName()),
    nextTierRam: null,
    canUpgrade: false,
    factions,
    joinedCount,
    invitedCount,
    notInvitedCount,
    pendingInvitations: invitations,
    playerCity: player.city,
    playerMoney: player.money,
    playerMoneyFormatted: ns.format.number(player.money),
    playerHacking: playerStats.hacking,
    playerStrength: playerStats.strength,
    playerDefense: playerStats.defense,
    playerDexterity: playerStats.dexterity,
    playerAgility: playerStats.agility,
    playerAugsInstalled: playerStats.augsInstalled,
  };

  publishStatus(ns, STATUS_PORTS.faction, status);
}
