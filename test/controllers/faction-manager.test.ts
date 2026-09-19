import { describe, it, expect } from "vitest";
import {
  classifyFactions,
  isSafeToAutoJoin,
  getLocationTravelTarget,
  shouldTravelForCityFaction,
  getCityForFaction,
  evaluateRequirements,
  isEligibleForFaction,
  CITY_FACTIONS,
  CITY_FACTION_CONFLICTS,
  LOCATION_LOCKED_FACTIONS,
  ALL_KNOWN_FACTIONS,
  TRAVEL_COST,
  type PlayerLike,
  type PlayerWithStats,
} from "/controllers/faction-manager";

function player(overrides: Partial<PlayerLike> = {}): PlayerLike {
  return { factions: [], city: "Sector-12", money: 0, ...overrides };
}

function stats(overrides: Partial<PlayerWithStats> = {}): PlayerWithStats {
  return {
    ...player(),
    hacking: 1,
    strength: 1,
    defense: 1,
    dexterity: 1,
    agility: 1,
    augsInstalled: 0,
    karma: 0,
    numPeopleKilled: 0,
    ...overrides,
  };
}

describe("classifyFactions", () => {
  it("marks joined factions as joined even if also listed as invited", () => {
    const results = classifyFactions(player({ factions: ["CyberSec"] }), ["CyberSec", "NiteSec"]);
    const cyberSec = results.find((f) => f.name === "CyberSec")!;
    const niteSec = results.find((f) => f.name === "NiteSec")!;
    const bitRunners = results.find((f) => f.name === "BitRunners")!;
    expect(cyberSec.status).toBe("joined");
    expect(niteSec.status).toBe("invited");
    expect(bitRunners.status).toBe("not-invited");
  });

  it("includes every known faction exactly once with a type", () => {
    const results = classifyFactions(player(), []);
    expect(results).toHaveLength(Object.keys(ALL_KNOWN_FACTIONS).length);
    for (const f of results) {
      expect(f.type).toBeTruthy();
    }
  });

  it("attaches the city for city-exclusive and location-locked factions", () => {
    const results = classifyFactions(player(), []);
    const aevum = results.find((f) => f.name === "Aevum")!;
    const tianDiHui = results.find((f) => f.name === "Tian Di Hui")!;
    const cyberSec = results.find((f) => f.name === "CyberSec")!;
    expect(aevum.city).toBe("Aevum");
    expect(tianDiHui.city).toBe(LOCATION_LOCKED_FACTIONS["Tian Di Hui"][0]);
    expect(cyberSec.city).toBeUndefined();
  });
});

describe("isSafeToAutoJoin", () => {
  it("is always safe for non-city-exclusive factions", () => {
    expect(isSafeToAutoJoin("CyberSec", "None", [])).toBe(true);
    expect(isSafeToAutoJoin("Tian Di Hui", "", [])).toBe(true);
  });

  it("is unsafe for unknown faction names", () => {
    expect(isSafeToAutoJoin("Not A Real Faction", "None", [])).toBe(false);
  });

  it("refuses city-exclusive factions when no preferred city is set", () => {
    expect(isSafeToAutoJoin("Aevum", "None", [])).toBe(false);
    expect(isSafeToAutoJoin("Aevum", "", [])).toBe(false);
  });

  it("refuses a city-exclusive faction that isn't the preferred one", () => {
    expect(isSafeToAutoJoin("Chongqing", "Aevum", [])).toBe(false);
  });

  it("allows the preferred city faction when nothing conflicting is joined", () => {
    expect(isSafeToAutoJoin("Aevum", "Aevum", [])).toBe(true);
  });

  it("refuses the preferred city faction if a conflicting one is already joined", () => {
    // Sector-12 conflicts with Chongqing per CITY_FACTION_CONFLICTS
    expect(CITY_FACTION_CONFLICTS["Chongqing"]).toContain("Sector-12");
    expect(isSafeToAutoJoin("Chongqing", "Chongqing", ["Sector-12"])).toBe(false);
  });
});

describe("shouldTravelForCityFaction", () => {
  it("returns false when no preferred city is set", () => {
    expect(shouldTravelForCityFaction(player(), "None", [], [])).toBe(false);
    expect(shouldTravelForCityFaction(player(), "", [], [])).toBe(false);
  });

  it("returns false once already joined or invited", () => {
    expect(shouldTravelForCityFaction(player(), "Aevum", ["Aevum"], [])).toBe(false);
    expect(shouldTravelForCityFaction(player(), "Aevum", [], ["Aevum"])).toBe(false);
  });

  it("returns false when already in the target city", () => {
    expect(shouldTravelForCityFaction(player({ city: "Aevum" }), "Aevum", [], [])).toBe(false);
  });

  it("returns false when a conflicting city faction is already joined", () => {
    expect(shouldTravelForCityFaction(player({ city: "Sector-12", money: 1e9 }), "Aevum", ["Chongqing"], [])).toBe(false);
  });

  it("returns false without enough money (10x travel cost buffer)", () => {
    expect(shouldTravelForCityFaction(player({ city: "Sector-12", money: TRAVEL_COST }), "Aevum", [], [])).toBe(false);
  });

  it("returns true when eligible, unblocked, and funded", () => {
    expect(
      shouldTravelForCityFaction(player({ city: "Sector-12", money: TRAVEL_COST * 10 }), "Aevum", [], []),
    ).toBe(true);
  });
});

describe("getLocationTravelTarget", () => {
  it("returns null once every location-locked faction is joined", () => {
    const joined = Object.keys(LOCATION_LOCKED_FACTIONS);
    expect(getLocationTravelTarget(player(), [], joined)).toBeNull();
  });

  it("returns null when the player is already in a qualifying city for every remaining faction", () => {
    // Chongqing qualifies for every location-locked faction except The Syndicate,
    // so pre-join The Syndicate to leave nothing to travel for.
    const joined = ["The Syndicate"];
    expect(getLocationTravelTarget(player({ city: "Chongqing" }), [], joined)).toBeNull();
  });

  it("skips factions already joined or invited", () => {
    const joined = Object.keys(LOCATION_LOCKED_FACTIONS).filter((f) => f !== "The Syndicate");
    const target = getLocationTravelTarget(player({ city: "Chongqing" }), [], joined);
    // Only The Syndicate remains, which requires Aevum or Sector-12
    expect(target).toEqual({ city: "Aevum", faction: "The Syndicate" });
  });

  it("skips factions with no augs available when aug data is supplied", () => {
    const target = getLocationTravelTarget(player(), [], [], { "Tian Di Hui": false });
    expect(target?.faction).not.toBe("Tian Di Hui");
  });

  it("skips factions whose verifiable stat requirements aren't met", () => {
    const lowStats = stats({ money: 0, hacking: 0 });
    const target = getLocationTravelTarget(player(), [], [], undefined, lowStats);
    // Tian Di Hui needs $1M and 50 hacking; Slum Snakes has other combat reqs too,
    // none of which lowStats satisfies, so nothing should be picked.
    expect(target).toBeNull();
  });

  it("returns the first qualifying city for an eligible, un-joined faction", () => {
    const goodStats = stats({ money: 10e6, hacking: 100, strength: 400, defense: 400, dexterity: 400, agility: 400 });
    const target = getLocationTravelTarget(player({ city: "Sector-12" }), [], [], undefined, goodStats);
    expect(target).not.toBeNull();
    expect(LOCATION_LOCKED_FACTIONS[target!.faction]).toContain(target!.city);
  });
});

describe("getCityForFaction", () => {
  it("resolves city factions and returns null for everything else", () => {
    for (const city of Object.keys(CITY_FACTIONS)) {
      expect(getCityForFaction(city)).toBe(city);
    }
    expect(getCityForFaction("CyberSec")).toBeNull();
    expect(getCityForFaction("Not A Faction")).toBeNull();
  });
});

describe("evaluateRequirements / isEligibleForFaction", () => {
  it("returns null requirements and eligible=true for factions with no tracked requirements", () => {
    expect(evaluateRequirements("ECorp", stats())).toBeNull();
    expect(isEligibleForFaction("ECorp", stats())).toBe(true);
    expect(evaluateRequirements("Shadows of Anarchy", stats())).toBeNull();
  });

  it("marks unverifiable requirements as unmet but excludes them from eligibility", () => {
    const reqs = evaluateRequirements("CyberSec", stats({ hacking: 100 }))!;
    const backdoor = reqs.find((r) => r.label.startsWith("Backdoor"))!;
    expect(backdoor.verifiable).toBe(false);
    expect(backdoor.met).toBe(false);
    // Hacking requirement alone (the only verifiable one) is satisfied.
    expect(isEligibleForFaction("CyberSec", stats({ hacking: 100 }))).toBe(true);
  });

  it("is ineligible when a verifiable requirement is unmet", () => {
    expect(isEligibleForFaction("CyberSec", stats({ hacking: 10 }))).toBe(false);
  });

  it("evaluates karma thresholds as <= (more negative is 'more' criminal)", () => {
    expect(isEligibleForFaction("Slum Snakes", stats({
      strength: 30, defense: 30, dexterity: 30, agility: 30, money: 1e6, karma: -9,
    }))).toBe(true);
    expect(isEligibleForFaction("Slum Snakes", stats({
      strength: 30, defense: 30, dexterity: 30, agility: 30, money: 1e6, karma: -8,
    }))).toBe(false);
  });

  it("evaluates Daedalus' OR condition (hacking OR full combat)", () => {
    const viaHacking = stats({ augsInstalled: 30, money: 100e9, hacking: 2500 });
    const viaCombat = stats({
      augsInstalled: 30, money: 100e9, hacking: 0,
      strength: 1500, defense: 1500, dexterity: 1500, agility: 1500,
    });
    const neither = stats({ augsInstalled: 30, money: 100e9, hacking: 0, strength: 1499 });
    expect(isEligibleForFaction("Daedalus", viaHacking)).toBe(true);
    expect(isEligibleForFaction("Daedalus", viaCombat)).toBe(true);
    expect(isEligibleForFaction("Daedalus", neither)).toBe(false);
  });
});
