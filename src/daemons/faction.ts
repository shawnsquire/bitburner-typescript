/**
 * Faction Manager Daemon (Tiered Architecture)
 *
 * Long-running daemon that handles discovering, joining, and traveling for factions.
 * Operates in graduated tiers based on available RAM:
 *
 *   Tier 0 (Lite):       ~5GB   - Cached display, player.factions only
 *   Tier 1 (Join):       ~11GB  - Show invitations, auto-join non-exclusive
 *   Tier 2 (Aug-Aware):  ~19GB  - Show aug counts, filter travel by aug availability
 *   Tier 3 (Auto-Manage): ~21GB - Auto-travel for location-locked + preferred city faction
 *
 * Usage:
 *   run daemons/faction.js                          # Auto-select best tier
 *   run daemons/faction.js --preferred-city Aevum   # Set preferred city faction
 *   run daemons/faction.js --tier join              # Force specific tier
 *   run daemons/faction.js --one-shot               # Run once and exit
 */
import { NS, CityName, FactionName } from "@ns";
import { COLORS } from "/lib/utils";
import { calcAvailableAfterKills, freeRamForTarget } from "/lib/ram-utils";
import { publishStatus } from "/lib/ports";
import { STATUS_PORTS, FactionStatus, FactionInfo } from "/types/ports";
import { writeDefaultConfig, getConfigNumber, getConfigBool, getConfigString } from "/lib/config";
import {
  classifyFactions,
  isSafeToAutoJoin,
  getLocationTravelTarget,
  shouldTravelForCityFaction,
  getCityForFaction,
  evaluateRequirements,
  isEligibleForFaction,
  FACTION_BACKDOOR_SERVERS,
  TRAVEL_COST,
  PlayerLike,
  PlayerWithStats,
} from "/controllers/faction-manager";

// === TIER DEFINITIONS ===

type FactionTierName = "lite" | "join" | "aug-aware" | "auto-manage";

interface FactionTierConfig {
  tier: number;
  name: FactionTierName;
  functions: string[];
  features: string[];
  description: string;
}

const BASE_FUNCTIONS = [
  "getResetInfo",
  "getServerMaxRam",
  "getServerUsedRam",
  "ps",
  "getScriptRam",
  "getPlayer",
  "getPortHandle",
];

const FACTION_TIERS: FactionTierConfig[] = [
  {
    tier: 0,
    name: "lite",
    functions: [],
    features: ["cached-display"],
    description: "Shows player.factions only (no Singularity)",
  },
  {
    tier: 1,
    name: "join",
    functions: [
      "singularity.checkFactionInvitations",
      "singularity.joinFaction",
    ],
    features: ["invitations", "auto-join"],
    description: "Show invitations, auto-join non-exclusive",
  },
  {
    tier: 2,
    name: "aug-aware",
    functions: [
      "singularity.getAugmentationsFromFaction",
      "singularity.getOwnedAugmentations",
      "serverExists",
      "getServer",
    ],
    features: ["aug-counts", "aug-filter"],
    description: "Show aug counts, filter travel by aug availability",
  },
  {
    tier: 3,
    name: "auto-manage",
    functions: [
      "singularity.travelToCity",
      "exec",
    ],
    features: ["auto-travel"],
    description: "Auto-travel for location-locked + preferred city faction",
  },
];

// === DYNAMIC RAM CALCULATION ===

const BASE_SCRIPT_COST = 1.6;
const RAM_BUFFER_PERCENT = 0.05;

function calculateTierRam(ns: NS, tierIndex: number): number {
  let ram = BASE_SCRIPT_COST;

  for (const fn of BASE_FUNCTIONS) {
    ram += ns.getFunctionRamCost(fn);
  }

  for (let i = 0; i <= tierIndex; i++) {
    for (const fn of FACTION_TIERS[i].functions) {
      ram += ns.getFunctionRamCost(fn);
    }
  }

  ram *= (1 + RAM_BUFFER_PERCENT);
  return Math.ceil(ram * 10) / 10;
}

function calculateAllTierRamCosts(ns: NS): number[] {
  return FACTION_TIERS.map((_, i) => calculateTierRam(ns, i));
}

// === HELPER FUNCTIONS ===

function selectBestTier(
  potentialRam: number,
  sf4Level: number,
  tierRamCosts: number[],
): { tier: FactionTierConfig; ramCost: number } {
  if (sf4Level === 0) {
    return { tier: FACTION_TIERS[0], ramCost: tierRamCosts[0] };
  }

  let bestTierIndex = 0;
  for (let i = FACTION_TIERS.length - 1; i >= 0; i--) {
    if (potentialRam >= tierRamCosts[i]) {
      bestTierIndex = i;
      break;
    }
  }

  return { tier: FACTION_TIERS[bestTierIndex], ramCost: tierRamCosts[bestTierIndex] };
}

function getAvailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = 0; i <= tier; i++) {
    features.push(...FACTION_TIERS[i].features);
  }
  return features;
}

function getUnavailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = tier + 1; i < FACTION_TIERS.length; i++) {
    features.push(...FACTION_TIERS[i].features);
  }
  return features;
}

// === STATUS COMPUTATION ===

function computeStatus(
  ns: NS,
  tier: FactionTierConfig,
  currentRam: number,
  nextTierRam: number | null,
  factions: FactionInfo[],
  preferredCity: string,
  autoJoined: string[],
  autoTraveled: string,
  lastAction: string,
  playerStats?: PlayerWithStats,
  pendingBackdoors?: FactionStatus["pendingBackdoors"],
): FactionStatus {
  const player = ns.getPlayer();

  const joinedCount = factions.filter(f => f.status === "joined").length;
  const invitedCount = factions.filter(f => f.status === "invited").length;
  const notInvitedCount = factions.filter(f => f.status === "not-invited").length;

  const status: FactionStatus = {
    tier: tier.tier,
    tierName: tier.name,
    availableFeatures: getAvailableFeatures(tier.tier),
    unavailableFeatures: getUnavailableFeatures(tier.tier),
    currentRamUsage: currentRam,
    nextTierRam,
    canUpgrade: tier.tier < FACTION_TIERS.length - 1,
    factions,
    joinedCount,
    invitedCount,
    notInvitedCount,
  };

  // Tier 1+
  if (tier.tier >= 1) {
    status.pendingInvitations = factions
      .filter(f => f.status === "invited")
      .map(f => f.name);
  }

  // Tier 2+
  if (tier.tier >= 2) {
    status.playerCity = player.city;
    status.playerMoney = player.money;
    status.playerMoneyFormatted = ns.format.number(player.money);
    if (playerStats) {
      status.playerHacking = playerStats.hacking;
      status.playerStrength = playerStats.strength;
      status.playerDefense = playerStats.defense;
      status.playerDexterity = playerStats.dexterity;
      status.playerAgility = playerStats.agility;
      status.playerAugsInstalled = playerStats.augsInstalled;
    }
    if (pendingBackdoors && pendingBackdoors.length > 0) {
      status.pendingBackdoors = pendingBackdoors;
    }
  }

  // Tier 3
  if (tier.tier >= 3) {
    status.preferredCityFaction = preferredCity || "None";
    status.autoJoined = autoJoined;
    status.autoTraveled = autoTraveled;
    status.lastAction = lastAction;
  }

  return status;
}

// === PRINT FUNCTIONS ===

function printStatus(ns: NS, status: FactionStatus): void {
  const C = COLORS;

  ns.print(`${C.cyan}=== Faction Manager (${status.tierName}) ===${C.reset}`);
  ns.print(
    `${C.dim}Tier ${status.tier} | RAM: ${ns.format.ram(status.currentRamUsage)}${C.reset}`
  );
  ns.print(
    `${C.green}${status.joinedCount}${C.reset} joined  ` +
    `${C.yellow}${status.invitedCount}${C.reset} invited  ` +
    `${C.dim}${status.notInvitedCount} remaining${C.reset}`
  );

  if (status.pendingInvitations && status.pendingInvitations.length > 0) {
    ns.print("");
    ns.print(`${C.yellow}PENDING INVITATIONS${C.reset}`);
    for (const name of status.pendingInvitations) {
      const f = status.factions.find(fi => fi.name === name);
      ns.print(`  ${C.white}${name}${C.reset} ${C.dim}(${f?.type ?? "unknown"})${C.reset}`);
    }
  }

  if (status.preferredCityFaction && status.preferredCityFaction !== "None") {
    ns.print("");
    ns.print(`${C.cyan}Preferred city:${C.reset} ${C.white}${status.preferredCityFaction}${C.reset}`);
  }

  if (status.lastAction) {
    ns.print(`${C.dim}Last action: ${status.lastAction}${C.reset}`);
  }

  if (status.autoJoined && status.autoJoined.length > 0) {
    ns.print(`${C.green}Auto-joined: ${status.autoJoined.join(", ")}${C.reset}`);
  }

  if (status.canUpgrade && status.nextTierRam) {
    ns.print("");
    ns.print(
      `${C.yellow}Upgrade available: ${C.reset}` +
      `${C.white}${ns.format.ram(status.nextTierRam)}${C.reset} ${C.dim}for next tier${C.reset}`
    );
  }
}

// === MAIN DAEMON LOOP ===

function buildSpawnArgs(tier: string): string[] {
  const args: string[] = [];
  if (tier) args.push("--tier", tier);
  return args;
}

export async function main(ns: NS): Promise<void> {
  ns.ramOverride(5);
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "faction", {
    interval: "10000",
    oneShot: "false",
    preferredCity: "",
    noKill: "false",
  });

  const flags = ns.flags([
    ["tier", ""],
  ]) as {
    tier: string;
    _: string[];
  };

  const forcedTierName = flags.tier as FactionTierName | "";
  const spawnArgs = buildSpawnArgs(flags.tier);
  const noKill = getConfigBool(ns, "faction", "noKill", false);

  const sf4Level = ns.getResetInfo().ownedSF.get(4) ?? 0;
  const tierRamCosts = calculateAllTierRamCosts(ns);

  const currentScriptRam = 5;
  let potentialRam: number;

  if (noKill) {
    potentialRam = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam;
  } else {
    potentialRam = calcAvailableAfterKills(ns) + currentScriptRam;
  }

  let selectedTier: FactionTierConfig;
  let requiredRam: number;

  if (forcedTierName) {
    const forcedIndex = FACTION_TIERS.findIndex(t => t.name === forcedTierName);
    if (forcedIndex >= 0) {
      selectedTier = FACTION_TIERS[forcedIndex];
      requiredRam = tierRamCosts[forcedIndex];
    } else {
      ns.tprint(`WARN: Unknown tier "${forcedTierName}", using auto-select`);
      const result = selectBestTier(potentialRam, sf4Level, tierRamCosts);
      selectedTier = result.tier;
      requiredRam = result.ramCost;
    }
  } else {
    const result = selectBestTier(potentialRam, sf4Level, tierRamCosts);
    selectedTier = result.tier;
    requiredRam = result.ramCost;
  }

  // Free RAM if needed
  const currentlyAvailable = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam;
  if (requiredRam > currentlyAvailable && !noKill) {
    freeRamForTarget(ns, requiredRam);
  }

  if (selectedTier.tier > 0) {
    const actual = ns.ramOverride(requiredRam);
    if (actual < requiredRam) {
      const result = selectBestTier(actual, sf4Level, tierRamCosts);
      selectedTier = result.tier;
      requiredRam = result.ramCost;
      ns.ramOverride(requiredRam);
    }
  }

  ns.tprint(`INFO: Faction daemon: ${selectedTier.name} tier (${ns.format.ram(requiredRam)} RAM)`);

  // State tracking
  const autoJoined: string[] = [];
  let autoTraveled = "";
  let lastAction = "";
  let cyclesSinceUpgradeCheck = 0;
  const UPGRADE_CHECK_INTERVAL = 10;

  do {
    const oneShot = getConfigBool(ns, "faction", "oneShot", false);
    const interval = getConfigNumber(ns, "faction", "interval", 10000);
    const preferredCity = getConfigString(ns, "faction", "preferredCity", "");

    ns.clearLog();

    const player = ns.getPlayer();
    const playerLike: PlayerLike = {
      factions: player.factions,
      city: player.city,
      money: player.money,
    };

    // Build PlayerWithStats for requirement evaluation (Tier 2+)
    let playerStats: PlayerWithStats | undefined;
    if (selectedTier.tier >= 2) {
      let augsInstalled = 0;
      try {
        augsInstalled = ns.singularity.getOwnedAugmentations(false).length;
      } catch { /* no access */ }
      playerStats = {
        ...playerLike,
        hacking: player.skills.hacking,
        strength: player.skills.strength,
        defense: player.skills.defense,
        dexterity: player.skills.dexterity,
        agility: player.skills.agility,
        augsInstalled,
        karma: player.karma,
        numPeopleKilled: player.numPeopleKilled,
      };
    }

    // Get invitations (Tier 1+)
    let invitations: string[] = [];
    if (selectedTier.tier >= 1) {
      try {
        invitations = ns.singularity.checkFactionInvitations();
      } catch {
        // SF4 not available
      }
    }

    // Classify factions
    let factions = classifyFactions(playerLike, invitations);

    // Aug awareness (Tier 2+) — query ALL factions, not just joined
    if (selectedTier.tier >= 2) {
      try {
        const ownedAugs = new Set(ns.singularity.getOwnedAugmentations(true));
        factions = factions.map(f => {
          try {
            const factionAugs = ns.singularity.getAugmentationsFromFaction(f.name as FactionName);
            const available = factionAugs.filter(a => !ownedAugs.has(a));
            return {
              ...f,
              augCount: factionAugs.length,
              availableAugCount: available.length,
              hasAugsAvailable: available.length > 0,
            };
          } catch {
            return f;
          }
        });
      } catch {
        // SF4 not available for this function
      }
    }

    // Requirement evaluation (Tier 2+)
    if (selectedTier.tier >= 2 && playerStats !== undefined) {
      factions = factions.map(f => {
        if (f.status === "joined") return f;
        const reqs = evaluateRequirements(f.name, <PlayerWithStats>playerStats);
        const eligible = isEligibleForFaction(f.name, <PlayerWithStats>playerStats);
        return { ...f, requirements: reqs ?? undefined, eligible };
      });
    }

    // Backdoor detection (Tier 2+) — check hacking faction servers
    let pendingBackdoors: FactionStatus["pendingBackdoors"];
    if (selectedTier.tier >= 2) {
      pendingBackdoors = [];
      for (const [faction, server] of Object.entries(FACTION_BACKDOOR_SERVERS)) {
        // Skip if already joined or invited
        const fi = factions.find(f => f.name === faction);
        if (fi && (fi.status === "joined" || fi.status === "invited")) continue;

        try {
          if (!ns.serverExists(server)) continue;
          const srv = ns.getServer(server);
          if (srv.backdoorInstalled) continue;
          pendingBackdoors.push({
            faction,
            server,
            rooted: srv.hasAdminRights,
            haveHacking: player.skills.hacking >= (srv.requiredHackingSkill ?? 0),
          });
        } catch { /* server doesn't exist yet */ }
      }

      // Auto-trigger backdoors at tier 3 if any are ready
      if (selectedTier.tier >= 3 && pendingBackdoors.some(b => b.rooted && b.haveHacking)) {
        const alreadyRunning = ns.ps("home").some(p => p.filename === "actions/faction-backdoors.js");
        if (!alreadyRunning) {
          const pid = ns.exec("actions/faction-backdoors.js", "home", 1);
          if (pid > 0) {
            lastAction = "Auto-started backdoor installation";
            ns.toast("Auto-started faction backdoors", "info", 3000);
          }
        }
      }
    }

    // Auto-join logic (Tier 1+)
    if (selectedTier.tier >= 1) {
      for (const invitation of invitations) {
        if (player.factions.includes(invitation as FactionName)) continue;

        if (isSafeToAutoJoin(invitation, preferredCity, player.factions)) {
          try {
            const success = ns.singularity.joinFaction(invitation as FactionName);
            if (success) {
              autoJoined.push(invitation);
              lastAction = `Joined ${invitation}`;
              ns.toast(`Auto-joined ${invitation}`, "success", 3000);
            }
          } catch {
            // joinFaction failed
          }
        }
      }
    }

    // Auto-travel logic (Tier 3)
    if (selectedTier.tier >= 3) {
      // Travel for preferred city faction
      if (shouldTravelForCityFaction(playerLike, preferredCity, player.factions, invitations)) {
        const city = getCityForFaction(preferredCity);
        if (city && player.money >= TRAVEL_COST * 10) {
          try {
            const success = ns.singularity.travelToCity(city as CityName);
            if (success) {
              autoTraveled = city;
              lastAction = `Traveled to ${city} for ${preferredCity}`;
              ns.toast(`Traveled to ${city} for ${preferredCity}`, "info", 3000);
            }
          } catch {
            // Travel failed
          }
        }
      }

      // Travel for location-locked factions
      const augsAvailable: Record<string, boolean> = {};
      if (selectedTier.tier >= 2) {
        for (const f of factions) {
          if (f.hasAugsAvailable !== undefined) {
            augsAvailable[f.name] = f.hasAugsAvailable;
          }
        }
      }

      const travelTarget = getLocationTravelTarget(
        playerLike,
        invitations,
        player.factions,
        selectedTier.tier >= 2 ? augsAvailable : undefined,
        playerStats,
      );

      if (travelTarget && player.money >= TRAVEL_COST * 10) {
        try {
          const success = ns.singularity.travelToCity(travelTarget.city as CityName);
          if (success) {
            autoTraveled = travelTarget.city;
            lastAction = `Traveled to ${travelTarget.city} for ${travelTarget.faction}`;
            ns.toast(`Traveled to ${travelTarget.city} for ${travelTarget.faction}`, "info", 3000);
          }
        } catch {
          // Travel failed
        }
      }
    }

    // Build and publish status
    const nextTierRam = selectedTier.tier < FACTION_TIERS.length - 1
      ? tierRamCosts[selectedTier.tier + 1]
      : null;

    const status = computeStatus(
      ns, selectedTier, requiredRam, nextTierRam,
      factions, preferredCity, autoJoined, autoTraveled, lastAction,
      playerStats, pendingBackdoors,
    );

    publishStatus(ns, STATUS_PORTS.faction, status);
    printStatus(ns, status);

    // Check for upgrade opportunity
    cyclesSinceUpgradeCheck++;
    if (cyclesSinceUpgradeCheck >= UPGRADE_CHECK_INTERVAL) {
      cyclesSinceUpgradeCheck = 0;
      const upgradeRam = calcAvailableAfterKills(ns) + requiredRam;

      for (let i = FACTION_TIERS.length - 1; i > selectedTier.tier; i--) {
        if (upgradeRam >= tierRamCosts[i]) {
          ns.tprint(`INFO: Upgrading faction daemon from ${selectedTier.name} to ${FACTION_TIERS[i].name}`);
          ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 }, ...spawnArgs);
          return;
        }
      }
    }

    if (!oneShot) {
      ns.print(`\n${COLORS.dim}Next check in ${interval / 1000}s...${COLORS.reset}`);
      await ns.sleep(interval);
    }
  } while (!getConfigBool(ns, "faction", "oneShot", false));
}
