import { describe, it, expect } from "vitest";
import {
  calculateBatchDelays,
  calculatePrepPlan,
  calculateBatchThreads,
  getWorkerRamCosts,
  isTargetPrepped,
  detectDesync,
  getPrepProgress,
  IncomeTracker,
  BATCH_SPACER,
  BATCH_WINDOW,
} from "/lib/batch";
import { mockNS } from "../helpers/mock-ns";

// A minimal server object with the fields batch.ts reads via ?? defaults.
function server(overrides: Record<string, unknown> = {}) {
  return {
    minDifficulty: 1,
    hackDifficulty: 1,
    moneyMax: 1_000_000,
    moneyAvailable: 1_000_000,
    ...overrides,
  };
}

describe("calculateBatchDelays", () => {
  it("lands Hack, Weaken1, Grow, Weaken2 exactly BATCH_SPACER apart, in that order", () => {
    // Realistic ratios: growTime = 3.2x hackTime, weakenTime = 4x hackTime (fixed by the game).
    const hackTime = 4000;
    const growTime = hackTime * 3.2;
    const weakenTime = hackTime * 4;

    const d = calculateBatchDelays(hackTime, growTime, weakenTime, 0);

    const hackLands = d.hackDelay + hackTime;
    const weaken1Lands = d.weaken1Delay + weakenTime;
    const growLands = d.growDelay + growTime;
    const weaken2Lands = d.weaken2Delay + weakenTime;

    expect(weaken1Lands - hackLands).toBeCloseTo(BATCH_SPACER, 6);
    expect(growLands - hackLands).toBeCloseTo(BATCH_SPACER * 2, 6);
    expect(weaken2Lands - hackLands).toBeCloseTo(BATCH_SPACER * 3, 6);
  });

  it("offsets every delay by batchIndex * BATCH_WINDOW while preserving spacing", () => {
    const hackTime = 4000;
    const growTime = hackTime * 3.2;
    const weakenTime = hackTime * 4;

    const d0 = calculateBatchDelays(hackTime, growTime, weakenTime, 0);
    const d3 = calculateBatchDelays(hackTime, growTime, weakenTime, 3);

    expect(d3.hackDelay - d0.hackDelay).toBeCloseTo(3 * BATCH_WINDOW, 6);
    expect(d3.weaken1Delay - d0.weaken1Delay).toBeCloseTo(3 * BATCH_WINDOW, 6);
    expect(d3.growDelay - d0.growDelay).toBeCloseTo(3 * BATCH_WINDOW, 6);
    expect(d3.weaken2Delay - d0.weaken2Delay).toBeCloseTo(3 * BATCH_WINDOW, 6);
  });

  it("never returns a negative delay", () => {
    // Pathologically fast hack time relative to weaken time would otherwise
    // drive hackDelay negative; it must be clamped instead.
    const d = calculateBatchDelays(1, 3.2, 4, 0);
    expect(d.hackDelay).toBeGreaterThanOrEqual(0);
    expect(d.weaken1Delay).toBeGreaterThanOrEqual(0);
    expect(d.growDelay).toBeGreaterThanOrEqual(0);
    expect(d.weaken2Delay).toBeGreaterThanOrEqual(0);
  });
});

describe("isTargetPrepped / detectDesync / getPrepProgress", () => {
  it("isTargetPrepped is true only at min security and near-max money", () => {
    const ns = mockNS({ extra: { getServer: () => server({ hackDifficulty: 1, moneyAvailable: 999_999 }) } });
    expect(isTargetPrepped(ns, "n00dles")).toBe(true);
  });

  it("isTargetPrepped is false when security is above tolerance", () => {
    const ns = mockNS({ extra: { getServer: () => server({ hackDifficulty: 5 }) } });
    expect(isTargetPrepped(ns, "n00dles")).toBe(false);
  });

  it("isTargetPrepped is false when money is below the 99.9% tolerance", () => {
    const ns = mockNS({ extra: { getServer: () => server({ moneyAvailable: 900_000 }) } });
    expect(isTargetPrepped(ns, "n00dles")).toBe(false);
  });

  it("detectDesync flags blown security even with full money", () => {
    const ns = mockNS({ extra: { getServer: () => server({ hackDifficulty: 3 }) } });
    expect(detectDesync(ns, "n00dles")).toBe(true);
  });

  it("detectDesync flags money well below max even at min security", () => {
    const ns = mockNS({ extra: { getServer: () => server({ moneyAvailable: 500_000 }) } });
    expect(detectDesync(ns, "n00dles")).toBe(true);
  });

  it("detectDesync is false for a healthy, prepped server", () => {
    const ns = mockNS({ extra: { getServer: () => server() } });
    expect(detectDesync(ns, "n00dles")).toBe(false);
  });

  it("getPrepProgress is 1.0 for a fully prepped server", () => {
    const ns = mockNS({ extra: { getServer: () => server() } });
    expect(getPrepProgress(ns, "n00dles")).toBe(1.0);
  });

  it("getPrepProgress is 0.5 when money is empty but security is at minimum", () => {
    const ns = mockNS({ extra: { getServer: () => server({ moneyAvailable: 0 }) } });
    expect(getPrepProgress(ns, "n00dles")).toBeCloseTo(0.5, 6);
  });
});

describe("calculatePrepPlan", () => {
  it("needs zero threads once already at min security and max money", () => {
    const ns = mockNS({
      extra: {
        getServer: () => server(),
        getWeakenTime: () => 20_000,
        growthAnalyze: () => { throw new Error("should not be called when already prepped"); },
      },
    });
    const plan = calculatePrepPlan(ns, "n00dles");
    expect(plan).toEqual({
      weakenThreads: 0,
      growThreads: 0,
      compensateWeakenThreads: 0,
      totalThreads: 0,
      estimatedTime: 20_000,
    });
  });

  it("computes weaken threads to close the security gap", () => {
    const ns = mockNS({
      extra: {
        getServer: () => server({ hackDifficulty: 11 }), // 10 above min of 1
        getWeakenTime: () => 20_000,
        growthAnalyze: () => 0,
      },
    });
    const plan = calculatePrepPlan(ns, "n00dles");
    // 10 security / 0.05 per weaken thread = 200 threads
    expect(plan.weakenThreads).toBe(200);
    expect(plan.growThreads).toBe(0);
    expect(plan.compensateWeakenThreads).toBe(0);
  });

  it("computes grow threads plus a compensating weaken for the resulting security", () => {
    const ns = mockNS({
      extra: {
        getServer: () => server({ moneyAvailable: 500_000 }),
        getWeakenTime: () => 20_000,
        growthAnalyze: () => 50, // pretend growthAnalyze says 50 threads needed
      },
    });
    const plan = calculatePrepPlan(ns, "n00dles");
    expect(plan.growThreads).toBe(50);
    // 50 threads * 0.004 sec/thread / 0.05 sec/weaken-thread = 4 compensating threads
    expect(plan.compensateWeakenThreads).toBe(4);
    expect(plan.totalThreads).toBe(50 + 4);
  });

  it("floors curMoney at 1 to avoid a divide-by-zero growth target when money is 0", () => {
    let capturedGrowthNeeded = 0;
    const ns = mockNS({
      extra: {
        getServer: () => server({ moneyAvailable: 0, moneyMax: 1_000_000 }),
        getWeakenTime: () => 20_000,
        growthAnalyze: (_host: string, growthNeeded: number) => { capturedGrowthNeeded = growthNeeded; return 100; },
      },
    });
    calculatePrepPlan(ns, "n00dles");
    expect(Number.isFinite(capturedGrowthNeeded)).toBe(true);
    expect(capturedGrowthNeeded).toBe(1_000_000); // 1_000_000 / max(0, 1)
  });
});

describe("getWorkerRamCosts", () => {
  it("reads each worker script's RAM cost independently (hack/grow/weaken are not interchangeable)", () => {
    const ns = mockNS({
      extra: {
        getScriptRam: (path: string) => {
          if (path === "/workers/hack.js") return 1.7;
          if (path === "/workers/grow.js") return 1.75;
          if (path === "/workers/weaken.js") return 1.75;
          throw new Error(`unexpected script path ${path}`);
        },
      },
    });
    expect(getWorkerRamCosts(ns)).toEqual({ hack: 1.7, grow: 1.75, weaken: 1.75 });
  });
});

describe("calculateBatchThreads", () => {
  // Regression test for a real bug: ramPerBatch used to be computed as
  // totalThreads * (hack.js's RAM cost), silently under-budgeting grow/weaken
  // threads whenever their script RAM differs from hack.js's.
  it("prices hack/grow/weaken threads at their own distinct RAM costs", () => {
    const ns = mockNS({
      extra: {
        getServer: () => server(),
        fileExists: () => false,
        hackAnalyze: () => 0.1, // 10% per thread -> 3 threads for 25%
        growthAnalyze: () => 6, // -> 6 grow threads
      },
    });
    const ramCosts = { hack: 1.7, grow: 1.75, weaken: 1.75 };
    const bt = calculateBatchThreads(ns, "n00dles", 0.25, ramCosts);

    expect(bt.hackThreads).toBe(3);
    expect(bt.growThreads).toBe(6);
    // weaken1 = ceil(3 * 0.002 / 0.05) = 1, weaken2 = ceil(6 * 0.004 / 0.05) = 1
    expect(bt.weaken1Threads).toBe(1);
    expect(bt.weaken2Threads).toBe(1);

    const expectedRam =
      bt.hackThreads * ramCosts.hack +
      (bt.weaken1Threads + bt.weaken2Threads) * ramCosts.weaken +
      bt.growThreads * ramCosts.grow;
    expect(bt.ramPerBatch).toBeCloseTo(expectedRam, 9);

    // Sanity: if grow/weaken RAM had been mispriced at hack.js's rate (the
    // bug), ramPerBatch would come out lower than the correct value here
    // since grow/weaken cost more per thread than hack.
    const buggyRam = bt.totalThreads * ramCosts.hack;
    expect(bt.ramPerBatch).toBeGreaterThan(buggyRam);
  });

  it("never returns zero threads for hack or grow even at extreme inputs", () => {
    const ns = mockNS({
      extra: {
        getServer: () => server(),
        fileExists: () => false,
        hackAnalyze: () => 0, // pathological: analyze reports 0
        growthAnalyze: () => 0,
      },
    });
    const bt = calculateBatchThreads(ns, "n00dles", 0.5, { hack: 1.7, grow: 1.75, weaken: 1.75 });
    expect(bt.hackThreads).toBeGreaterThanOrEqual(1);
    expect(bt.growThreads).toBeGreaterThanOrEqual(1);
    expect(bt.weaken1Threads).toBeGreaterThanOrEqual(1);
    expect(bt.weaken2Threads).toBeGreaterThanOrEqual(1);
  });
});

describe("IncomeTracker", () => {
  it("returns 0 income per sec with no samples", () => {
    expect(new IncomeTracker().getIncomePerSec()).toBe(0);
  });

  it("averages recorded samples over the elapsed window (minimum 1s)", () => {
    const tracker = new IncomeTracker(60);
    tracker.record(1000);
    // Only one sample so far -> elapsed is floored to 1000ms -> 1000/s.
    expect(tracker.getIncomePerSec()).toBeCloseTo(1000, 6);
  });

  it("prunes samples older than the window on read", () => {
    const tracker = new IncomeTracker(1); // 1 second window
    const past = Date.now() - 5000;
    tracker.loadSamples([{ time: past, amount: 999_999 }]);
    expect(tracker.getIncomePerSec()).toBe(0);
    expect(tracker.toJSON()).toEqual([]);
  });

  it("loadSamples discards samples older than the window", () => {
    const tracker = new IncomeTracker(60);
    const now = Date.now();
    tracker.loadSamples([
      { time: now - 120_000, amount: 111 }, // outside 60s window, dropped
      { time: now - 1000, amount: 222 },     // inside window, kept
    ]);
    const json = tracker.toJSON();
    expect(json).toHaveLength(1);
    expect(json[0].amount).toBe(222);
  });
});
