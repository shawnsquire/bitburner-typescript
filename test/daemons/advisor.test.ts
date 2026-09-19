import { describe, it, expect } from "vitest";
import {
  AdvisorContext,
  RULES,
  evaluate,
  ruleBuyTor,
  ruleStartFactionWork,
  ruleStartShare,
  ruleBitnodeExit,
  ruleGangTerritory,
} from "/daemons/advisor";
import {
  RepStatus,
  ShareStatus,
  BitnodeStatus,
  FactionStatus,
  DarkwebStatus,
  WorkStatus,
  GangStatus,
  GangTerritoryStatus,
} from "/types/ports";

// A context with every port null, so each rule's "no data yet" guard is exercised
// by default; individual tests override just the fields they need.
function emptyContext(): AdvisorContext {
  return {
    nuke: null,
    hack: null,
    pserv: null,
    share: null,
    rep: null,
    darkweb: null,
    work: null,
    bitnode: null,
    faction: null,
    gang: null,
    gangTerritory: null,
    augments: null,
  };
}

function repStatus(overrides: Partial<RepStatus>): RepStatus {
  return {
    tier: 2,
    tierName: "target",
    availableFeatures: [],
    unavailableFeatures: [],
    currentRamUsage: 0,
    nextTierRam: null,
    canUpgrade: false,
    ...overrides,
  };
}

function shareStatus(overrides: Partial<ShareStatus>): ShareStatus {
  return {
    totalThreads: "0",
    sharePower: "1.000x",
    shareRam: "0.00GB",
    serversWithShare: 0,
    serverStats: [],
    cycleStatus: "idle",
    lastKnownThreads: "0",
    ...overrides,
  };
}

function bitnodeStatus(overrides: Partial<BitnodeStatus>): BitnodeStatus {
  return {
    augmentations: 0,
    augmentationsRequired: 30,
    money: 0,
    moneyRequired: 100e9,
    moneyFormatted: "$0",
    moneyRequiredFormatted: "$100b",
    hacking: 0,
    hackingRequired: 2500,
    augsComplete: false,
    moneyComplete: false,
    hackingComplete: false,
    allComplete: false,
    // w0r1d_d43m0n needs 3000 x WorldDaemonDifficulty (6000 in BN9); default to "not yet".
    worldDaemonRequired: 6000,
    worldDaemonComplete: false,
    ...overrides,
  };
}

function factionStatus(overrides: Partial<FactionStatus>): FactionStatus {
  return {
    tier: 2,
    tierName: "target",
    availableFeatures: [],
    unavailableFeatures: [],
    currentRamUsage: 0,
    nextTierRam: null,
    canUpgrade: false,
    factions: [],
    joinedCount: 0,
    invitedCount: 0,
    notInvitedCount: 0,
    ...overrides,
  };
}

// === ruleBuyTor: TOR router costs exactly $200k (CONSTANTS.TorRouterCost, Constants.ts) ===

describe("ruleBuyTor", () => {
  it("returns null once the TOR router is owned", () => {
    const ctx = emptyContext();
    ctx.darkweb = { hasTorRouter: true } as DarkwebStatus;
    expect(ruleBuyTor(ctx)).toBeNull();
  });

  it("scores higher once $200k is affordable", () => {
    const ctx = emptyContext();
    ctx.darkweb = { hasTorRouter: false } as DarkwebStatus;
    ctx.work = { playerMoney: 199_999 } as WorkStatus;
    const notYet = ruleBuyTor(ctx);
    ctx.work = { playerMoney: 200_000 } as WorkStatus;
    const canAfford = ruleBuyTor(ctx);
    expect(notYet?.score).toBe(70);
    expect(canAfford?.score).toBe(85);
  });
});

// === ruleStartFactionWork / ruleStartShare / ruleBitnodeExit: repGapPositive semantics ===
//
// repGapPositive is computed in daemons/rep.ts as `repGap > 0` where
// `repGap = max(0, repRequired - currentRep)` — i.e. it is true while a rep DEFICIT
// remains, not when "enough rep" has been reached. These tests pin the corrected
// (non-inverted) reading of that field.

describe("ruleStartFactionWork", () => {
  it("recommends working while a rep gap remains", () => {
    const ctx = emptyContext();
    ctx.rep = repStatus({
      targetFaction: "Daedalus",
      nextAugName: "The Red Pill",
      repGapPositive: true,
      repGapFormatted: "1.00m",
      isWorkingForFaction: false,
    });
    expect(ruleStartFactionWork(ctx)?.id).toBe("faction-work");
  });

  it("stays quiet once the gap has closed", () => {
    const ctx = emptyContext();
    ctx.rep = repStatus({
      targetFaction: "Daedalus",
      nextAugName: "The Red Pill",
      repGapPositive: false,
      isWorkingForFaction: false,
    });
    expect(ruleStartFactionWork(ctx)).toBeNull();
  });
});

describe("ruleStartShare", () => {
  it("recommends sharing while a rep gap remains and share is idle", () => {
    const ctx = emptyContext();
    ctx.rep = repStatus({ targetFaction: "Daedalus", repGapPositive: true });
    ctx.share = shareStatus({ cycleStatus: "idle" });
    expect(ruleStartShare(ctx)?.id).toBe("start-share");
  });

  it("stays quiet once the gap has closed", () => {
    const ctx = emptyContext();
    ctx.rep = repStatus({ targetFaction: "Daedalus", repGapPositive: false });
    ctx.share = shareStatus({ cycleStatus: "idle" });
    expect(ruleStartShare(ctx)).toBeNull();
  });

  it("does not re-recommend once share is already active or mid-cycle, even at 4+ digit thread counts", () => {
    // Regression guard: totalThreads is a toLocaleString()'d string (e.g. "1,234").
    // Number("1,234") is NaN, so a naive `Number(totalThreads) > 0` check silently
    // breaks once threads reach four digits — cycleStatus must be used instead.
    const ctx = emptyContext();
    ctx.rep = repStatus({ targetFaction: "Daedalus", repGapPositive: true });
    ctx.share = shareStatus({ cycleStatus: "active", totalThreads: "1,234" });
    expect(ruleStartShare(ctx)).toBeNull();

    ctx.share = shareStatus({ cycleStatus: "cycle", totalThreads: "1,234" });
    expect(ruleStartShare(ctx)).toBeNull();
  });

  it("does not fire without a faction target", () => {
    const ctx = emptyContext();
    expect(ruleStartShare(ctx)).toBeNull();
  });
});

describe("ruleBitnodeExit", () => {
  function joinedDaedalusFaction(): FactionStatus {
    return factionStatus({
      factions: [{ name: "Daedalus", status: "joined", type: "endgame" }],
    });
  }

  it("recommends destroying the bitnode once Daedalus rep is sufficient", () => {
    const ctx = emptyContext();
    ctx.bitnode = bitnodeStatus({ allComplete: true, worldDaemonComplete: true });
    ctx.faction = joinedDaedalusFaction();
    ctx.rep = repStatus({ targetFaction: "Daedalus", repGapPositive: false });
    expect(ruleBitnodeExit(ctx)?.id).toBe("bitnode-exit");
  });

  it("waits while the rep daemon still shows a Daedalus rep gap", () => {
    const ctx = emptyContext();
    ctx.bitnode = bitnodeStatus({ allComplete: true, worldDaemonComplete: true });
    ctx.faction = joinedDaedalusFaction();
    ctx.rep = repStatus({ targetFaction: "Daedalus", repGapPositive: true });
    expect(ruleBitnodeExit(ctx)).toBeNull();
  });

  it("treats the rep daemon having moved off Daedalus as TRP already purchased", () => {
    const ctx = emptyContext();
    ctx.bitnode = bitnodeStatus({ allComplete: true, worldDaemonComplete: true });
    ctx.faction = joinedDaedalusFaction();
    ctx.rep = repStatus({ targetFaction: "SomeOtherFaction", repGapPositive: true });
    expect(ruleBitnodeExit(ctx)?.id).toBe("bitnode-exit");
  });

  it("defaults to 'not enough rep' when the rep daemon hasn't reported yet", () => {
    const ctx = emptyContext();
    ctx.bitnode = bitnodeStatus({ allComplete: true, worldDaemonComplete: true });
    ctx.faction = joinedDaedalusFaction();
    ctx.rep = repStatus({ targetFaction: "Daedalus" }); // repGapPositive left undefined
    expect(ruleBitnodeExit(ctx)).toBeNull();
  });

  it("does not fire before all bitnode requirements are complete", () => {
    const ctx = emptyContext();
    ctx.bitnode = bitnodeStatus({ allComplete: false, worldDaemonComplete: true });
    ctx.faction = joinedDaedalusFaction();
    expect(ruleBitnodeExit(ctx)).toBeNull();
  });

  // The Daedalus invite (hacking 2500) is not the w0r1d_d43m0n requirement
  // (3000 x WorldDaemonDifficulty, 6000 in BN9); the rule must wait for the latter.
  it("does not fire while hacking is below the w0r1d_d43m0n requirement even with Daedalus done", () => {
    const ctx = emptyContext();
    ctx.bitnode = bitnodeStatus({
      allComplete: true,
      hacking: 3100,
      hackingComplete: true,
      worldDaemonRequired: 6000,
      worldDaemonComplete: false,
    });
    ctx.faction = joinedDaedalusFaction();
    ctx.rep = repStatus({ targetFaction: "Daedalus", repGapPositive: false });
    expect(ruleBitnodeExit(ctx)).toBeNull();
  });

  it("fires once hacking reaches the w0r1d_d43m0n requirement and names the level", () => {
    const ctx = emptyContext();
    ctx.bitnode = bitnodeStatus({
      allComplete: true,
      hacking: 6000,
      hackingComplete: true,
      worldDaemonRequired: 6000,
      worldDaemonComplete: true,
    });
    ctx.faction = joinedDaedalusFaction();
    ctx.rep = repStatus({ targetFaction: "Daedalus", repGapPositive: false });
    const rec = ruleBitnodeExit(ctx);
    expect(rec?.id).toBe("bitnode-exit");
    expect(rec?.reason).toContain("6000");
  });

  it("stays quiet when an older rep daemon publishes no worldDaemonComplete field", () => {
    const ctx = emptyContext();
    const legacy = bitnodeStatus({ allComplete: true }) as Partial<BitnodeStatus>;
    delete legacy.worldDaemonComplete;
    delete legacy.worldDaemonRequired;
    ctx.bitnode = legacy as BitnodeStatus;
    ctx.faction = joinedDaedalusFaction();
    ctx.rep = repStatus({ targetFaction: "Daedalus", repGapPositive: false });
    expect(ruleBitnodeExit(ctx)).toBeNull();
  });
});

describe("ruleGangTerritory", () => {
  const base: GangTerritoryStatus = {
    rivals: [],
    ourPower: 0,
    ourTerritory: 0.5,
    territoryWarfareEngaged: false,
    recommendedAction: "hold",
    lastChecked: 0,
  };

  it("stays quiet when the recommendation is to hold", () => {
    const ctx = emptyContext();
    ctx.gang = { inGang: true } as GangStatus;
    ctx.gangTerritory = { ...base, recommendedAction: "hold" };
    expect(ruleGangTerritory(ctx)).toBeNull();
  });

  it("recommends enabling when winning clashes", () => {
    const ctx = emptyContext();
    ctx.gang = { inGang: true } as GangStatus;
    ctx.gangTerritory = { ...base, recommendedAction: "enable" };
    const rec = ruleGangTerritory(ctx);
    expect(rec?.title).toBe("Enable Territory Warfare");
  });

  it("recommends disabling when losing clashes", () => {
    const ctx = emptyContext();
    ctx.gang = { inGang: true } as GangStatus;
    ctx.gangTerritory = { ...base, recommendedAction: "disable" };
    const rec = ruleGangTerritory(ctx);
    expect(rec?.title).toBe("Disable Territory Warfare");
  });
});

// === evaluate(): the pure scoring/ranking engine ===

describe("evaluate", () => {
  it("returns no recommendations and totalEvaluated = RULES.length for an empty context", () => {
    const status = evaluate(emptyContext());
    expect(status.recommendations).toEqual([]);
    expect(status.topCategory).toBeNull();
    expect(status.totalEvaluated).toBe(RULES.length);
  });

  it("sorts recommendations by score descending and sets topCategory from the winner", () => {
    const ctx = emptyContext();
    ctx.darkweb = { hasTorRouter: false } as DarkwebStatus; // buy-tor, score 70
    ctx.bitnode = bitnodeStatus({ allComplete: true }); // feeds bitnode-exit / daedalus-ready
    ctx.faction = factionStatus({
      factions: [{ name: "Daedalus", status: "invited", type: "endgame" }],
    }); // daedalus-ready, score 85 (invited)

    const status = evaluate(ctx);
    const scores = status.recommendations.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(status.topCategory).toBe(status.recommendations[0]?.category ?? null);
    expect(status.recommendations[0]?.id).toBe("daedalus-ready");
  });

  it("never returns more than 20 recommendations even if every rule fires", () => {
    // Build a context generous enough that most rules produce a recommendation.
    const ctx = emptyContext();
    ctx.darkweb = { hasTorRouter: false } as DarkwebStatus;
    ctx.work = {
      playerMoney: 1e12,
      combatBalance: 0.1,
      lowestCombatStat: 1,
      highestCombatStat: 100,
    } as WorkStatus;
    const status = evaluate(ctx);
    expect(status.recommendations.length).toBeLessThanOrEqual(20);
  });

  it("swallows a throwing rule instead of crashing the whole analysis", () => {
    // ruleJoinFaction does `f.factions.find(...)` with no guard on `factions` itself;
    // a status object with pendingInvitations but no factions array throws a TypeError.
    // evaluate() must still return a status built from every other rule instead of
    // letting one bad rule take down the whole analysis (and the daemon loop with it).
    const ctx = emptyContext();
    ctx.faction = { pendingInvitations: ["SomeFaction"] } as unknown as FactionStatus;
    ctx.darkweb = { hasTorRouter: false } as DarkwebStatus; // an unrelated rule that should still fire

    let status: ReturnType<typeof evaluate> | undefined;
    expect(() => { status = evaluate(ctx); }).not.toThrow();
    expect(status?.recommendations.some((r) => r.id === "buy-tor")).toBe(true);
    expect(status?.recommendations.some((r) => r.id === "join-faction")).toBe(false);
  });
});
