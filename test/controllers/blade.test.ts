import { describe, it, expect } from "vitest";
import {
  selectAction,
  recommendSkillUpgrade,
  selectBestCity,
  DEFAULT_BLADE_CONFIG,
  BladeState,
  BladeConfig,
  CityData,
  SkillData,
} from "/controllers/blade";

function baseState(overrides: Partial<BladeState> = {}): BladeState {
  return {
    inBladeburner: true,
    rank: 100,
    stamina: 100,
    maxStamina: 100,
    staminaPercent: 100,
    skillPoints: 0,
    city: "Sector-12",
    cityChaos: 0,
    cityPopulation: 5_000_000,
    bonusTime: 0,
    currentAction: null,
    contracts: [],
    operations: [],
    nextBlackOp: null,
    skills: [],
    cities: [],
    isDiplomacyActive: false,
    isResting: false,
    ...overrides,
  };
}

const config: BladeConfig = { ...DEFAULT_BLADE_CONFIG };

describe("selectAction", () => {
  it("rests when stamina drops below the minimum threshold", () => {
    const action = selectAction(baseState({ staminaPercent: 40 }), config);
    expect(action).toEqual({ type: "General", name: "Hyperbolic Regeneration Chamber" });
  });

  it("hysteresis: keeps resting until stamina climbs back to the restore threshold", () => {
    // Above the min-percent trigger (50) but still below the restore target (95)
    // and already resting — must not stop early just because it cleared 50%.
    const action = selectAction(baseState({ staminaPercent: 80, isResting: true }), config);
    expect(action).toEqual({ type: "General", name: "Hyperbolic Regeneration Chamber" });
  });

  it("stops resting once stamina reaches the restore threshold", () => {
    const action = selectAction(
      baseState({ staminaPercent: 96, isResting: true, contracts: [], operations: [] }),
      config,
    );
    // No analysis data yet (contracts/operations both empty arrays are still
    // "present", so this should fall through past the rest/train/diplomacy
    // checks to a real decision rather than resting).
    expect(action?.name).not.toBe("Hyperbolic Regeneration Chamber");
  });

  it("does not enter the resting hysteresis branch when not already resting, even mid-band", () => {
    // staminaPercent 80 is above min (50) and isResting=false, so the OR
    // branch (isResting && below restore) must not fire either.
    const action = selectAction(baseState({ staminaPercent: 80, isResting: false }), config);
    expect(action?.name).not.toBe("Hyperbolic Regeneration Chamber");
  });

  it("trains when max stamina is below the configured training threshold", () => {
    const trainingConfig = { ...config, staminaTrainMax: 200 };
    const action = selectAction(baseState({ maxStamina: 100 }), trainingConfig);
    expect(action).toEqual({ type: "General", name: "Training" });
  });

  it("does nothing stamina-related when staminaTrainMax is 0 (the shipped default)", () => {
    // DEFAULT_BLADE_CONFIG.staminaTrainMax is 0, so maxStamina < 0 is never
    // true — Training can never be auto-selected under the shipped default.
    const action = selectAction(baseState({ maxStamina: 1 }), config);
    expect(action?.name).not.toBe("Training");
  });

  it("triggers Diplomacy once chaos exceeds chaosMax", () => {
    const action = selectAction(baseState({ cityChaos: config.chaosMax + 1 }), config);
    expect(action).toEqual({ type: "General", name: "Diplomacy" });
  });

  it("keeps running Diplomacy until chaos drops to chaosTarget, even below chaosMax", () => {
    const action = selectAction(
      baseState({ cityChaos: config.chaosTarget + 1, isDiplomacyActive: true }),
      config,
    );
    expect(action).toEqual({ type: "General", name: "Diplomacy" });
  });

  it("stops Diplomacy once chaos reaches chaosTarget", () => {
    const action = selectAction(
      baseState({ cityChaos: config.chaosTarget, isDiplomacyActive: true, contracts: [{ name: "x", successMin: 100, successMax: 100, count: 1, time: 1, rankGain: 1 }] }),
      config,
    );
    expect(action?.name).not.toBe("Diplomacy");
  });

  it("requests Field Analysis when there is no analysis-tier data yet", () => {
    const action = selectAction(baseState({ contracts: undefined, operations: undefined }), config);
    expect(action).toEqual({ type: "General", name: "Field Analysis" });
  });

  it("takes a Black Op once rank and success threshold are both met", () => {
    const action = selectAction(
      baseState({
        rank: 1000,
        nextBlackOp: { name: "Operation Typhoon", rankRequired: 500, successMin: config.blackOpThreshold, successMax: 100 },
      }),
      config,
    );
    expect(action).toEqual({ type: "BlackOp", name: "Operation Typhoon" });
  });

  it("skips the Black Op when rank requirement is unmet even if success chance is high", () => {
    const action = selectAction(
      baseState({
        rank: 100,
        nextBlackOp: { name: "Operation Typhoon", rankRequired: 500, successMin: 100, successMax: 100 },
        contracts: [{ name: "c", successMin: config.contractThreshold, successMax: 100, count: 5, time: 1000, rankGain: 10 }],
      }),
      config,
    );
    expect(action?.type).not.toBe("BlackOp");
  });

  it("skips the Black Op when success chance is below threshold even if rank is met", () => {
    const action = selectAction(
      baseState({
        rank: 1000,
        nextBlackOp: { name: "Operation Typhoon", rankRequired: 500, successMin: config.blackOpThreshold - 1, successMax: 100 },
        contracts: [{ name: "c", successMin: config.contractThreshold, successMax: 100, count: 5, time: 1000, rankGain: 10 }],
      }),
      config,
    );
    expect(action?.type).not.toBe("BlackOp");
  });

  it("prefers Contracts over Operations when both meet threshold (sustainable first)", () => {
    const action = selectAction(
      baseState({
        contracts: [{ name: "Tracking", successMin: config.contractThreshold, successMax: 100, count: 5, time: 1000, rankGain: 10 }],
        operations: [{ name: "Raid", successMin: config.operationThreshold, successMax: 100, count: 5, time: 1000, rankGain: 100 }],
      }),
      config,
    );
    expect(action).toEqual({ type: "Contract", name: "Tracking" });
  });

  it("falls back to Operations when no contract clears its threshold", () => {
    const action = selectAction(
      baseState({
        contracts: [{ name: "Tracking", successMin: config.contractThreshold - 1, successMax: 100, count: 5, time: 1000, rankGain: 10 }],
        operations: [{ name: "Raid", successMin: config.operationThreshold, successMax: 100, count: 5, time: 1000, rankGain: 100 }],
      }),
      config,
    );
    expect(action).toEqual({ type: "Operation", name: "Raid" });
  });

  it("ignores an action with zero count remaining even if success is high", () => {
    const action = selectAction(
      baseState({
        contracts: [{ name: "Tracking", successMin: 100, successMax: 100, count: 0, time: 1000, rankGain: 10 }],
      }),
      config,
    );
    expect(action?.name).not.toBe("Tracking");
  });

  it("picks the highest rankGain contract among those clearing the threshold", () => {
    const action = selectAction(
      baseState({
        contracts: [
          { name: "Low", successMin: config.contractThreshold, successMax: 100, count: 5, time: 1000, rankGain: 5 },
          { name: "High", successMin: config.contractThreshold, successMax: 100, count: 5, time: 1000, rankGain: 50 },
        ],
      }),
      config,
    );
    expect(action).toEqual({ type: "Contract", name: "High" });
  });

  it("falls back to Field Analysis when nothing clears any threshold", () => {
    const action = selectAction(
      baseState({
        contracts: [{ name: "Tracking", successMin: 1, successMax: 1, count: 5, time: 1000, rankGain: 10 }],
        operations: [{ name: "Raid", successMin: 1, successMax: 1, count: 5, time: 1000, rankGain: 100 }],
      }),
      config,
    );
    expect(action).toEqual({ type: "General", name: "Field Analysis" });
  });
});

describe("recommendSkillUpgrade", () => {
  const skills: SkillData[] = [
    { name: "Blade's Intuition", level: 0, upgradeCost: 1 },
    { name: "Digital Observer", level: 5, upgradeCost: 1 },
    { name: "Overclock", level: 89, upgradeCost: 1 },
    { name: "Reaper", level: 0, upgradeCost: 1 },
  ];

  it("picks the lowest-level skill within the top-priority group", () => {
    const rec = recommendSkillUpgrade(skills, 100);
    expect(rec?.name).toBe("Blade's Intuition");
  });

  it("respects a per-skill max level override (Overclock caps at 90)", () => {
    const capped: SkillData[] = [{ name: "Overclock", level: 90, upgradeCost: 1 }];
    expect(recommendSkillUpgrade(capped, 100)).toBeNull();
  });

  it("returns null when every group's candidates are unaffordable", () => {
    // Group 1 (Blade's Intuition/Digital Observer/Overclock) and group 2's
    // only present member (Reaper) all cost 1 SP, which a 0 SP budget can't cover.
    const rec = recommendSkillUpgrade(skills, 0);
    expect(rec).toBeNull();
  });

  it("returns null when no skill in any group is known or affordable", () => {
    expect(recommendSkillUpgrade([], 1000)).toBeNull();
  });

  it("never recommends a skill outside the priority list (documents a real gap)", () => {
    // Tracer, Datamancer, Cyber's Edge and Hands of Midas are real, useful
    // Bladeburner skills that are simply absent from SKILL_PRIORITY — this
    // test documents that gap rather than asserting desired behavior.
    const onlyOmitted: SkillData[] = [
      { name: "Tracer", level: 0, upgradeCost: 1 },
      { name: "Datamancer", level: 0, upgradeCost: 1 },
      { name: "Cyber's Edge", level: 0, upgradeCost: 1 },
      { name: "Hands of Midas", level: 0, upgradeCost: 1 },
    ];
    expect(recommendSkillUpgrade(onlyOmitted, 1_000_000)).toBeNull();
  });
});

describe("selectBestCity", () => {
  const cities: CityData[] = [
    { name: "Sector-12", chaos: 10, population: 1_000_000, communities: 1 },
    { name: "Aevum", chaos: 60, population: 10_000_000, communities: 2 },
    { name: "Volhaven", chaos: 5, population: 500_000, communities: 0 },
  ];

  it("picks the highest-population city under the chaos ceiling", () => {
    // Aevum has more population but exceeds chaosMax (60 > 50 default);
    // Sector-12 is the best remaining option and isn't the current city.
    expect(selectBestCity("Volhaven", cities, 50)).toBe("Sector-12");
  });

  it("returns null when the current city is already the best choice", () => {
    expect(selectBestCity("Sector-12", cities, 50)).toBeNull();
  });

  it("falls back to the lowest-chaos city when every city exceeds the ceiling", () => {
    expect(selectBestCity("Sector-12", cities, 1)).toBe("Volhaven");
  });

  it("Raid quarantine picks the lowest-population city that still has communities", () => {
    // Sector-12 has the lowest population overall but 0 communities is
    // ineligible for Raids; among cities with communities>0, Sector-12 (1M)
    // beats Aevum (10M).
    expect(selectBestCity("Aevum", cities, 50, "Raid")).toBe("Sector-12");
  });

  it("Raid quarantine ignores chaos entirely (only cares about population + communities)", () => {
    // Aevum's chaos (60) would normally disqualify it for general work, but
    // Raid quarantine has no chaos check — it must still be excluded here
    // only because Sector-12 has lower population, not because of chaos.
    const highChaosOnly: CityData[] = [
      { name: "Aevum", chaos: 90, population: 2_000_000, communities: 3 },
      { name: "Sector-12", chaos: 90, population: 1_000_000, communities: 1 },
    ];
    expect(selectBestCity("Aevum", highChaosOnly, 10, "Raid")).toBe("Sector-12");
  });

  it("Raid quarantine returns null when no city has any communities", () => {
    const noCommunities: CityData[] = [{ name: "Sector-12", chaos: 0, population: 1, communities: 0 }];
    expect(selectBestCity("Sector-12", noCommunities, 50, "Raid")).toBeNull();
  });
});
