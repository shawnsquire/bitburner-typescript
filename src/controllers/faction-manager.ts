/**
 * Faction Manager Controller
 *
 * Pure logic for discovering, joining, and traveling for factions.
 * Complements controllers/factions.ts which handles aug planning and rep tracking.
 *
 * Zero NS imports. Zero RAM cost.
 *
 * Import with: import { ... } from "/controllers/faction-manager";
 */
import { FactionInfo, FactionRequirement } from "/types/ports";

// === FACTION TYPE CLASSIFICATION ===

export type FactionType = FactionInfo["type"];

interface FactionDef {
  type: FactionType;
  city?: string;
}

/** City-exclusive factions: joining one permanently blocks others from the same conflict group. */
export const CITY_FACTIONS: Record<string, string> = {
  "Sector-12": "Sector-12",
  "Aevum": "Aevum",
  "Chongqing": "Chongqing",
  "New Tokyo": "New Tokyo",
  "Ishima": "Ishima",
  "Volhaven": "Volhaven",
};

/** City factions that conflict with each other (from game source FactionInfo.tsx). */
export const CITY_FACTION_CONFLICTS: Record<string, string[]> = {
  "Sector-12": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  "Aevum": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  "Chongqing": ["Sector-12", "Aevum", "Volhaven"],
  "New Tokyo": ["Sector-12", "Aevum", "Volhaven"],
  "Ishima": ["Sector-12", "Aevum", "Volhaven"],
  "Volhaven": ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima"],
};

/** Factions that require being in a specific city to receive an invitation. */
export const LOCATION_LOCKED_FACTIONS: Record<string, string[]> = {
  "Tian Di Hui": ["Chongqing", "New Tokyo", "Ishima"],
  "The Dark Army": ["Chongqing"],
  "The Syndicate": ["Aevum", "Sector-12"],
  "Tetrads": ["Chongqing", "New Tokyo", "Ishima"],
  "Speakers for the Dead": ["Chongqing", "New Tokyo", "Ishima", "Aevum", "Sector-12", "Volhaven"],
  "Slum Snakes": ["Chongqing", "New Tokyo", "Ishima", "Aevum", "Sector-12", "Volhaven"],
};

export const TRAVEL_COST = 200_000;

/** Complete list of all known factions with type classification. */
export const ALL_KNOWN_FACTIONS: Record<string, FactionDef> = {
  // City-exclusive
  "Sector-12": { type: "city-exclusive", city: "Sector-12" },
  "Aevum": { type: "city-exclusive", city: "Aevum" },
  "Chongqing": { type: "city-exclusive", city: "Chongqing" },
  "New Tokyo": { type: "city-exclusive", city: "New Tokyo" },
  "Ishima": { type: "city-exclusive", city: "Ishima" },
  "Volhaven": { type: "city-exclusive", city: "Volhaven" },

  // Location-locked
  "Tian Di Hui": { type: "location-locked" },
  "The Dark Army": { type: "location-locked" },
  "The Syndicate": { type: "location-locked" },
  "Tetrads": { type: "location-locked" },
  "Speakers for the Dead": { type: "location-locked" },
  "Slum Snakes": { type: "location-locked" },
  // Silhouette has no location requirement (executive job title + money + karma
  // instead), but is grouped with its fellow underworld factions here since the
  // status type union has no dedicated category for it.
  "Silhouette": { type: "location-locked" },

  // Hacking factions
  "CyberSec": { type: "hacking" },
  "NiteSec": { type: "hacking" },
  "The Black Hand": { type: "hacking" },
  "BitRunners": { type: "hacking" },

  // Combat factions
  "The Covenant": { type: "combat" },
  "Daedalus": { type: "combat" },
  "Illuminati": { type: "combat" },

  // Endgame
  "Netburners": { type: "endgame" },

  // Megacorp factions
  "ECorp": { type: "megacorp" },
  "MegaCorp": { type: "megacorp" },
  "KuaiGong International": { type: "megacorp" },
  "Four Sigma": { type: "megacorp" },
  "NWO": { type: "megacorp" },
  "Blade Industries": { type: "megacorp" },
  "OmniTek Incorporated": { type: "megacorp" },
  "Bachman & Associates": { type: "megacorp" },
  "Clarke Incorporated": { type: "megacorp" },
  "Fulcrum Secret Technologies": { type: "megacorp" },

  // Special
  "Shadows of Anarchy": { type: "special" },
  "Bladeburners": { type: "special" },
  "Church of the Machine God": { type: "special" },
};

/** Hacking faction → server that needs a backdoor for invitation. */
export const FACTION_BACKDOOR_SERVERS: Record<string, string> = {
  "CyberSec": "CSEC",
  "NiteSec": "avmnite-02h",
  "The Black Hand": "I.I.I.I",
  "BitRunners": "run4theh111z",
};

// === EXPORTED FUNCTIONS ===

export interface PlayerLike {
  factions: string[];
  city: string;
  money: number;
}

export interface PlayerWithStats extends PlayerLike {
  hacking: number;
  strength: number;
  defense: number;
  dexterity: number;
  agility: number;
  augsInstalled: number;
  karma: number;
  numPeopleKilled: number;
}

// === FACTION REQUIREMENTS (hardcoded from Bitburner source) ===

interface RequirementDef {
  label: string;
  check: (p: PlayerWithStats) => boolean;
  verifiable: boolean;
}

const FACTION_REQUIREMENTS: Record<string, RequirementDef[]> = {
  // City factions — money thresholds
  "Sector-12": [{ label: "Money >= $15M", check: p => p.money >= 15e6, verifiable: true }],
  "Aevum": [{ label: "Money >= $40M", check: p => p.money >= 40e6, verifiable: true }],
  "Chongqing": [{ label: "Money >= $20M", check: p => p.money >= 20e6, verifiable: true }],
  "New Tokyo": [{ label: "Money >= $20M", check: p => p.money >= 20e6, verifiable: true }],
  "Ishima": [{ label: "Money >= $30M", check: p => p.money >= 30e6, verifiable: true }],
  "Volhaven": [{ label: "Money >= $50M", check: p => p.money >= 50e6, verifiable: true }],

  // Location-locked factions
  "Tian Di Hui": [
    { label: "Money >= $1M", check: p => p.money >= 1e6, verifiable: true },
    { label: "Hacking >= 50", check: p => p.hacking >= 50, verifiable: true },
  ],
  "The Dark Army": [
    { label: "Hacking >= 300", check: p => p.hacking >= 300, verifiable: true },
    { label: "Strength >= 300", check: p => p.strength >= 300, verifiable: true },
    { label: "Defense >= 300", check: p => p.defense >= 300, verifiable: true },
    { label: "Dexterity >= 300", check: p => p.dexterity >= 300, verifiable: true },
    { label: "Agility >= 300", check: p => p.agility >= 300, verifiable: true },
    { label: "Karma <= -45", check: p => p.karma <= -45, verifiable: true },
    { label: "Kills >= 5", check: p => p.numPeopleKilled >= 5, verifiable: true },
  ],
  "The Syndicate": [
    { label: "Hacking >= 200", check: p => p.hacking >= 200, verifiable: true },
    { label: "Strength >= 200", check: p => p.strength >= 200, verifiable: true },
    { label: "Defense >= 200", check: p => p.defense >= 200, verifiable: true },
    { label: "Dexterity >= 200", check: p => p.dexterity >= 200, verifiable: true },
    { label: "Agility >= 200", check: p => p.agility >= 200, verifiable: true },
    { label: "Money >= $10M", check: p => p.money >= 10e6, verifiable: true },
    { label: "Karma <= -90", check: p => p.karma <= -90, verifiable: true },
  ],
  "Tetrads": [
    { label: "Strength >= 75", check: p => p.strength >= 75, verifiable: true },
    { label: "Defense >= 75", check: p => p.defense >= 75, verifiable: true },
    { label: "Dexterity >= 75", check: p => p.dexterity >= 75, verifiable: true },
    { label: "Agility >= 75", check: p => p.agility >= 75, verifiable: true },
    { label: "Karma <= -18", check: p => p.karma <= -18, verifiable: true },
  ],
  "Speakers for the Dead": [
    { label: "Hacking >= 100", check: p => p.hacking >= 100, verifiable: true },
    { label: "Strength >= 300", check: p => p.strength >= 300, verifiable: true },
    { label: "Defense >= 300", check: p => p.defense >= 300, verifiable: true },
    { label: "Dexterity >= 300", check: p => p.dexterity >= 300, verifiable: true },
    { label: "Agility >= 300", check: p => p.agility >= 300, verifiable: true },
    { label: "Kills >= 30", check: p => p.numPeopleKilled >= 30, verifiable: true },
    { label: "Karma <= -45", check: p => p.karma <= -45, verifiable: true },
    { label: "Not working for CIA or NSA", check: () => false, verifiable: false },
  ],
  "Slum Snakes": [
    { label: "Strength >= 30", check: p => p.strength >= 30, verifiable: true },
    { label: "Defense >= 30", check: p => p.defense >= 30, verifiable: true },
    { label: "Dexterity >= 30", check: p => p.dexterity >= 30, verifiable: true },
    { label: "Agility >= 30", check: p => p.agility >= 30, verifiable: true },
    { label: "Money >= $1M", check: p => p.money >= 1e6, verifiable: true },
    { label: "Karma <= -9", check: p => p.karma <= -9, verifiable: true },
  ],
  "Silhouette": [
    { label: "Money >= $15M", check: p => p.money >= 15e6, verifiable: true },
    { label: "Karma <= -22", check: p => p.karma <= -22, verifiable: true },
    { label: "CTO, CFO, or CEO of a company", check: () => false, verifiable: false },
  ],

  // Hacking factions — hacking level + backdoor (not verifiable)
  "CyberSec": [
    { label: "Hacking >= 50", check: p => p.hacking >= 50, verifiable: true },
    { label: "Backdoor CSEC", check: () => false, verifiable: false },
  ],
  "NiteSec": [
    { label: "Hacking >= 200", check: p => p.hacking >= 200, verifiable: true },
    { label: "Backdoor avmnite-02h", check: () => false, verifiable: false },
  ],
  "The Black Hand": [
    { label: "Hacking >= 350", check: p => p.hacking >= 350, verifiable: true },
    { label: "Backdoor I.I.I.I", check: () => false, verifiable: false },
  ],
  "BitRunners": [
    { label: "Hacking >= 500", check: p => p.hacking >= 500, verifiable: true },
    { label: "Backdoor run4theh111z", check: () => false, verifiable: false },
  ],

  // Endgame / combat factions
  "Netburners": [
    { label: "Hacking >= 80", check: p => p.hacking >= 80, verifiable: true },
  ],
  "The Covenant": [
    { label: "Augs >= 20", check: p => p.augsInstalled >= 20, verifiable: true },
    { label: "Money >= $75B", check: p => p.money >= 75e9, verifiable: true },
    { label: "Hacking >= 850", check: p => p.hacking >= 850, verifiable: true },
    { label: "Strength >= 850", check: p => p.strength >= 850, verifiable: true },
    { label: "Defense >= 850", check: p => p.defense >= 850, verifiable: true },
    { label: "Dexterity >= 850", check: p => p.dexterity >= 850, verifiable: true },
    { label: "Agility >= 850", check: p => p.agility >= 850, verifiable: true },
  ],
  "Daedalus": [
    { label: "Augs >= 30", check: p => p.augsInstalled >= 30, verifiable: true },
    { label: "Money >= $100B", check: p => p.money >= 100e9, verifiable: true },
    { label: "Hacking >= 2500 OR all combat >= 1500", check: p => p.hacking >= 2500 || (p.strength >= 1500 && p.defense >= 1500 && p.dexterity >= 1500 && p.agility >= 1500), verifiable: true },
  ],
  "Illuminati": [
    { label: "Augs >= 30", check: p => p.augsInstalled >= 30, verifiable: true },
    { label: "Money >= $150B", check: p => p.money >= 150e9, verifiable: true },
    { label: "Hacking >= 1500", check: p => p.hacking >= 1500, verifiable: true },
    { label: "Strength >= 1200", check: p => p.strength >= 1200, verifiable: true },
    { label: "Defense >= 1200", check: p => p.defense >= 1200, verifiable: true },
    { label: "Dexterity >= 1200", check: p => p.dexterity >= 1200, verifiable: true },
    { label: "Agility >= 1200", check: p => p.agility >= 1200, verifiable: true },
  ],
};

/**
 * Evaluate requirements for a faction given player stats.
 * Returns null for factions with no tracked requirements (megacorp, special).
 */
export function evaluateRequirements(
  factionName: string,
  player: PlayerWithStats,
): FactionRequirement[] | null {
  const defs = FACTION_REQUIREMENTS[factionName];
  if (!defs) return null;

  return defs.map(d => ({
    label: d.label,
    met: d.verifiable ? d.check(player) : false,
    verifiable: d.verifiable,
  }));
}

/**
 * Returns true if all verifiable requirements are met.
 * Returns true for factions with no tracked requirements.
 */
export function isEligibleForFaction(
  factionName: string,
  player: PlayerWithStats,
): boolean {
  const defs = FACTION_REQUIREMENTS[factionName];
  if (!defs) return true;

  return defs.filter(d => d.verifiable).every(d => d.check(player));
}

/**
 * Categorize every known faction as joined/invited/not-invited with type.
 */
export function classifyFactions(
  player: PlayerLike,
  invitations: string[],
): FactionInfo[] {
  const joined = new Set(player.factions);
  const invited = new Set(invitations);

  const results: FactionInfo[] = [];

  for (const [name, def] of Object.entries(ALL_KNOWN_FACTIONS)) {
    let status: FactionInfo["status"];
    if (joined.has(name)) {
      status = "joined";
    } else if (invited.has(name)) {
      status = "invited";
    } else {
      status = "not-invited";
    }

    results.push({
      name,
      status,
      type: def.type,
      city: def.city ?? LOCATION_LOCKED_FACTIONS[name]?.[0],
    });
  }

  return results;
}

/**
 * Returns true if a faction is safe to auto-join (won't block other city factions).
 * City-exclusive factions are only safe if they match the preferred city AND
 * don't conflict with already-joined city factions.
 */
export function isSafeToAutoJoin(
  name: string,
  preferredCity: string,
  joinedFactions: string[],
): boolean {
  const def = ALL_KNOWN_FACTIONS[name];
  if (!def) return false;

  // Non-city-exclusive factions are always safe
  if (def.type !== "city-exclusive") return true;

  // City factions: only join if it matches preferred AND no conflicts with joined
  if (!preferredCity || preferredCity === "None") return false;
  if (name !== preferredCity) return false;

  // Check that none of the conflicting factions have been joined
  const conflicts = CITY_FACTION_CONFLICTS[name] ?? [];
  for (const conflict of conflicts) {
    if (joinedFactions.includes(conflict)) return false;
  }

  return true;
}

/**
 * Find the best location-locked faction to travel for.
 * Returns the city to travel to and the faction it unlocks.
 */
export function getLocationTravelTarget(
  player: PlayerLike,
  invitations: string[],
  joined: string[],
  augsAvailable?: Record<string, boolean>,
  playerStats?: PlayerWithStats,
): { city: string; faction: string } | null {
  const invitedSet = new Set(invitations);
  const joinedSet = new Set(joined);

  for (const [faction, cities] of Object.entries(LOCATION_LOCKED_FACTIONS)) {
    // Skip if already joined or already invited
    if (joinedSet.has(faction) || invitedSet.has(faction)) continue;

    // If we have aug data, skip factions with no available augs
    if (augsAvailable && augsAvailable[faction] === false) continue;

    // Skip factions where verifiable stat requirements aren't met
    if (playerStats && !isEligibleForFaction(faction, playerStats)) continue;

    // Already in one of the qualifying cities?
    if (cities.includes(player.city)) continue;

    // Pick the first qualifying city
    return { city: cities[0], faction };
  }

  return null;
}

/**
 * Returns true if we should travel to the preferred city faction's city.
 */
export function shouldTravelForCityFaction(
  player: PlayerLike,
  preferred: string,
  joined: string[],
  invitations: string[],
): boolean {
  if (!preferred || preferred === "None") return false;

  // Already joined or invited? No need to travel
  if (joined.includes(preferred) || invitations.includes(preferred)) return false;

  // Already in the right city?
  const city = CITY_FACTIONS[preferred];
  if (!city) return false;
  if (player.city === city) return false;

  // Check that we won't conflict
  const conflicts = CITY_FACTION_CONFLICTS[preferred] ?? [];
  for (const conflict of conflicts) {
    if (joined.includes(conflict)) return false;
  }

  // Need enough money
  if (player.money < TRAVEL_COST * 10) return false; // 10x buffer = $2M

  return true;
}

/**
 * Get the city for a given faction name, if it's a city faction.
 */
export function getCityForFaction(name: string): string | null {
  return CITY_FACTIONS[name] ?? null;
}
