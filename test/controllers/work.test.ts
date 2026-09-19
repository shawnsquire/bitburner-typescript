import { describe, it, expect } from "vitest";
import {
  getSkillsForFocus,
  getSkillDisplayName,
  getSkillValue,
  getNextBalanceSkill,
  getTrainingOptions,
  findBestTrainingOption,
  readWorkConfig,
  writeWorkConfig,
  setWorkFocus,
  TRAVEL_COST,
  type WorkConfig,
} from "/controllers/work";
import { mockNS } from "../helpers/mock-ns";

function playerNS(skills: Partial<Record<"strength" | "defense" | "dexterity" | "agility" | "hacking" | "charisma", number>>) {
  return mockNS({
    extra: {
      getPlayer: () => ({
        skills: {
          strength: 0, defense: 0, dexterity: 0, agility: 0, hacking: 0, charisma: 0,
          ...skills,
        },
      }),
    },
  });
}

function baseConfig(overrides: Partial<WorkConfig> = {}): WorkConfig {
  return {
    focus: "balance-combat",
    skillTimeSpent: {},
    lastSkillTrained: null,
    lastRotationTime: 0,
    ...overrides,
  };
}

describe("getSkillsForFocus", () => {
  it("maps single-skill focuses to one skill", () => {
    expect(getSkillsForFocus("strength")).toEqual(["str"]);
    expect(getSkillsForFocus("hacking")).toEqual(["hacking"]);
    expect(getSkillsForFocus("charisma")).toEqual(["charisma"]);
  });

  it("maps balance focuses to their skill sets", () => {
    expect(getSkillsForFocus("balance-combat")).toEqual(["str", "def", "dex", "agi"]);
    expect(getSkillsForFocus("balance-all")).toEqual(["str", "def", "dex", "agi", "hacking", "charisma"]);
  });

  it("crime focuses and unknown focuses train no skill", () => {
    expect(getSkillsForFocus("crime-money")).toEqual([]);
    expect(getSkillsForFocus("crime-karma")).toEqual([]);
    expect(getSkillsForFocus("crime-kills")).toEqual([]);
    expect(getSkillsForFocus("crime-stats")).toEqual([]);
  });
});

describe("getSkillDisplayName", () => {
  it("maps known short codes and passes through unknown strings", () => {
    expect(getSkillDisplayName("str")).toBe("Strength");
    expect(getSkillDisplayName("hacking")).toBe("Hacking");
    expect(getSkillDisplayName("weird")).toBe("weird");
  });
});

describe("getSkillValue", () => {
  it("reads the matching player skill and defaults unknown skills to 0", () => {
    const ns = playerNS({ strength: 42, hacking: 100 });
    expect(getSkillValue(ns, "str")).toBe(42);
    expect(getSkillValue(ns, "hacking")).toBe(100);
    expect(getSkillValue(ns, "nope")).toBe(0);
  });
});

describe("getNextBalanceSkill", () => {
  it("returns the sole skill for a single-skill focus", () => {
    const ns = playerNS({});
    expect(getNextBalanceSkill(ns, baseConfig({ focus: "strength" }))).toBe("str");
  });

  it("starts at the lowest skill when nothing has been trained yet", () => {
    const ns = playerNS({ strength: 50, defense: 10, dexterity: 30, agility: 20 });
    expect(getNextBalanceSkill(ns, baseConfig({ lastSkillTrained: null }))).toBe("def");
  });

  it("restarts at the lowest skill if lastSkillTrained no longer applies to this focus", () => {
    const ns = playerNS({ strength: 50, defense: 10, dexterity: 30, agility: 20 });
    // "charisma" isn't in balance-combat's skill set (a focus change happened)
    expect(getNextBalanceSkill(ns, baseConfig({ lastSkillTrained: "charisma" }))).toBe("def");
  });

  it("keeps training the lowest skill once it's already the target", () => {
    const ns = playerNS({ strength: 50, defense: 10, dexterity: 30, agility: 20 });
    expect(getNextBalanceSkill(ns, baseConfig({ lastSkillTrained: "def" }))).toBe("def");
  });

  it("does not switch away from the current skill before the rotation interval elapses, even if it now exceeds the lowest", () => {
    const ns = playerNS({ strength: 50, defense: 10, dexterity: 30, agility: 20 });
    const config = baseConfig({ lastSkillTrained: "str", lastRotationTime: Date.now() - 1000 }); // only 1s ago
    expect(getNextBalanceSkill(ns, config)).toBe("str");
  });

  it("switches to the lowest skill once the current skill exceeds it AND the interval has elapsed", () => {
    const ns = playerNS({ strength: 50, defense: 10, dexterity: 30, agility: 20 });
    const config = baseConfig({ lastSkillTrained: "str", lastRotationTime: Date.now() - 61_000 }); // > 60s
    expect(getNextBalanceSkill(ns, config)).toBe("def");
  });

  it("does not switch if the current skill has not yet exceeded the lowest, even after the interval", () => {
    // str (10) is tied with the lowest (def, 10) - not strictly greater, so no switch.
    const ns = playerNS({ strength: 10, defense: 10, dexterity: 30, agility: 20 });
    const config = baseConfig({ lastSkillTrained: "str", lastRotationTime: Date.now() - 61_000 });
    expect(getNextBalanceSkill(ns, config)).toBe("str");
  });
});

describe("getTrainingOptions", () => {
  it("returns gym options for combat stats, sorted by expMult descending", () => {
    const ns = mockNS();
    const options = getTrainingOptions(ns, "str", "Sector-12");
    expect(options.every((o) => o.type === "gym")).toBe(true);
    const mults = options.map((o) => o.expMult);
    expect(mults).toEqual([...mults].sort((a, b) => b - a));
    // Powerhouse Gym (Sector-12, x10) should be the global best for any combat stat.
    expect(options[0].location).toBe("Powerhouse Gym");
    expect(options[0].needsTravel).toBe(false);
  });

  it("flags needsTravel and travelCost for gyms outside the player's city", () => {
    const ns = mockNS();
    const options = getTrainingOptions(ns, "str", "Volhaven");
    const powerhouse = options.find((o) => o.location === "Powerhouse Gym")!;
    expect(powerhouse.needsTravel).toBe(true);
    expect(powerhouse.travelCost).toBe(TRAVEL_COST);
    const millenium = options.find((o) => o.location === "Millenium Fitness Gym")!;
    expect(millenium.needsTravel).toBe(false);
    expect(millenium.travelCost).toBe(0);
  });

  it("returns university options for hacking and charisma", () => {
    const ns = mockNS();
    const hacking = getTrainingOptions(ns, "hacking", "Aevum");
    expect(hacking.every((o) => o.type === "university" && o.skill === "hacking")).toBe(true);
    const charisma = getTrainingOptions(ns, "charisma", "Aevum");
    expect(charisma.every((o) => o.type === "university" && o.skill === "charisma")).toBe(true);
  });

  it("returns no options for a skill with no training location (e.g. crime targets)", () => {
    const ns = mockNS();
    expect(getTrainingOptions(ns, "money", "Sector-12")).toEqual([]);
  });
});

describe("findBestTrainingOption", () => {
  it("returns the global best option when it needs no travel", () => {
    const ns = mockNS();
    const best = findBestTrainingOption(ns, "str", "Sector-12", 0);
    expect(best?.location).toBe("Powerhouse Gym");
  });

  it("returns the global best option (even if travel is needed) when the player can afford travel", () => {
    const ns = mockNS();
    const best = findBestTrainingOption(ns, "str", "Volhaven", TRAVEL_COST);
    expect(best?.location).toBe("Powerhouse Gym");
    expect(best?.needsTravel).toBe(true);
  });

  it("falls back to the best local option when travel is unaffordable", () => {
    const ns = mockNS();
    // From Aevum, global best (Powerhouse, Sector-12) needs travel; local best is Snap Fitness (x5).
    const best = findBestTrainingOption(ns, "str", "Aevum", 0);
    expect(best?.location).toBe("Snap Fitness Gym");
    expect(best?.needsTravel).toBe(false);
  });

  it("returns null when there is no local option and travel is unaffordable", () => {
    const ns = mockNS();
    // Chongqing has no gym at all.
    expect(findBestTrainingOption(ns, "str", "Chongqing", 0)).toBeNull();
  });

  it("returns null for a skill with no training options", () => {
    const ns = mockNS();
    expect(findBestTrainingOption(ns, "money", "Sector-12", 1e9)).toBeNull();
  });
});

describe("work config persistence", () => {
  it("readWorkConfig returns defaults when no file exists", () => {
    const ns = mockNS();
    const config = readWorkConfig(ns);
    expect(config.focus).toBe("balance-combat");
    expect(config.skillTimeSpent).toEqual({});
    expect(config.lastSkillTrained).toBeNull();
  });

  it("writeWorkConfig + readWorkConfig round-trips", () => {
    const ns = mockNS();
    writeWorkConfig(ns, baseConfig({ focus: "hacking", lastSkillTrained: "hacking" }));
    const config = readWorkConfig(ns);
    expect(config.focus).toBe("hacking");
    expect(config.lastSkillTrained).toBe("hacking");
  });

  it("setWorkFocus updates focus and resets rotation bookkeeping", () => {
    const ns = mockNS();
    writeWorkConfig(ns, baseConfig({
      focus: "strength",
      lastSkillTrained: "str",
      skillTimeSpent: { str: 5000 },
      lastRotationTime: 123,
    }));
    setWorkFocus(ns, "hacking");
    const config = readWorkConfig(ns);
    expect(config.focus).toBe("hacking");
    expect(config.lastSkillTrained).toBeNull();
    expect(config.skillTimeSpent).toEqual({});
    expect(config.lastRotationTime).toBeGreaterThan(123);
  });
});
