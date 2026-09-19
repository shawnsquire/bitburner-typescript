/**
 * Runs every experiment config across the fixed seed list, aggregates median/IQR per
 * config, and writes results.json (raw) — results.md is written by report.ts from
 * results.json so the write-up can be regenerated without re-running the sims.
 */
import { runDaemon, type DaemonConfig, type DaemonParamOverrides } from "./harness.ts";
import { runCanonical, type CanonicalConfig } from "./canonical.ts";
import { seedList, type RunMetrics, type CapitalParams } from "./common.ts";
import fs from "node:fs";

const N_SEEDS = 200;
const SEEDS = seedList(N_SEEDS);
const START_CASH = 100e9;

interface Job {
  name: string;
  group: string;
  run: (seed: number) => RunMetrics;
}

function daemonJob(name: string, group: string, cfg: DaemonConfig): Job {
  return { name, group, run: (seed) => runDaemon(seed, cfg) };
}
function canonicalJob(name: string, group: string, cfg: CanonicalConfig): Job {
  return { name, group, run: (seed) => runCanonical(seed, cfg) };
}

const bucket03: CapitalParams = { mode: "bucket", bucketWeight: 0.3 };
const allin: CapitalParams = { mode: "allin", bucketWeight: 0.3 };

function timeIt<T>(label: string, fn: () => T): T {
  const t0 = Date.now();
  const result = fn();
  console.error(`  ${label}: ${Date.now() - t0}ms`);
  return result;
}

function runJob(job: Job): RunMetrics[] {
  const t0 = Date.now();
  const results = SEEDS.map((s) => job.run(s));
  const dt = Date.now() - t0;
  console.error(`[${job.group}] ${job.name}: ${SEEDS.length} seeds in ${dt}ms`);
  return results;
}

// ============================================================
// Phase 1: experiments 1, 2, 3 (fully known configs up front)
// ============================================================

const phase1Jobs: Job[] = [];

// --- Experiment 1: profiles, 30% bucket, 100b, shorting off ---
for (const profile of ["moderate", "aggressive", "conservative"] as const) {
  phase1Jobs.push(
    daemonJob(`exp1-${profile}`, "1", {
      profile,
      capital: bucket03,
      startCash: START_CASH,
      canShort: false,
    }),
  );
}

// --- Experiment 2: ablations of moderate, each alone then all together ---
const ablationOverrides: Record<string, DaemonParamOverrides> = {
  "hardStop=0": { hardStopPercent: 0 },
  "trailing=0": { trailingStopPercent: 0 },
  "maxHoldTicks=0": { maxHoldTicks: 0 },
  "sellCooldownTicks=0": { sellCooldownTicks: 0 },
  "sellForecastDeviation=0": { sellForecastDeviation: 0 },
  "maxPositions=33": { maxPositions: 33 },
};
for (const [name, overrides] of Object.entries(ablationOverrides)) {
  phase1Jobs.push(
    daemonJob(`exp2-${name}`, "2", {
      profile: "moderate",
      capital: bucket03,
      startCash: START_CASH,
      canShort: false,
      overrides,
    }),
  );
}
phase1Jobs.push(
  daemonJob("exp2-budget-allin", "2", {
    profile: "moderate",
    capital: allin,
    startCash: START_CASH,
    canShort: false,
  }),
);
phase1Jobs.push(
  daemonJob("exp2-all-ablated", "2", {
    profile: "moderate",
    capital: allin,
    startCash: START_CASH,
    canShort: false,
    overrides: {
      hardStopPercent: 0,
      trailingStopPercent: 0,
      maxHoldTicks: 0,
      sellCooldownTicks: 0,
      sellForecastDeviation: 0,
      maxPositions: 33,
    },
  }),
);
phase1Jobs.push(
  daemonJob("exp2-fillprice-stops", "2", {
    profile: "moderate",
    capital: bucket03,
    startCash: START_CASH,
    canShort: false,
    useFillPriceForStops: true,
  }),
);

// --- Experiment 3: canonical variants, same capital settings, plus all-in ---
const CANON_BASE: CanonicalConfig = {
  startCash: START_CASH,
  canShort: false,
  capital: bucket03,
  entryThreshold: 0.1,
  exitHysteresis: 0,
};
phase1Jobs.push(canonicalJob("exp3-baseline", "3", { ...CANON_BASE }));
phase1Jobs.push(canonicalJob("exp3-entry0.05", "3", { ...CANON_BASE, entryThreshold: 0.05 }));
phase1Jobs.push(canonicalJob("exp3-entry0.15", "3", { ...CANON_BASE, entryThreshold: 0.15 }));
for (const H of [25, 50, 100]) {
  phase1Jobs.push(canonicalJob(`exp3-spreadaware-H${H}`, "3", { ...CANON_BASE, entryThreshold: 0, spreadAware: { H } }));
}
for (const nDiv of [4, 8]) {
  phase1Jobs.push(canonicalJob(`exp3-diversified-N${nDiv}`, "3", { ...CANON_BASE, diversifiedN: nDiv }));
}
phase1Jobs.push(canonicalJob("exp3-hysteresis0.05", "3", { ...CANON_BASE, exitHysteresis: 0.05 }));
phase1Jobs.push(canonicalJob("exp3-allin", "3", { ...CANON_BASE, capital: allin }));

console.error(`Phase 1: ${phase1Jobs.length} configs x ${N_SEEDS} seeds`);
const results: Record<string, RunMetrics[]> = {};
const configLog: Record<string, unknown> = {};
for (const job of phase1Jobs) {
  results[job.name] = runJob(job);
}

// Record configs for the report (re-derive from the job builders above is awkward once
// closures are built, so just re-list them here for the JSON dump).
configLog["exp1-moderate"] = { profile: "moderate", capital: bucket03, startCash: START_CASH, canShort: false };
configLog["exp1-aggressive"] = { profile: "aggressive", capital: bucket03, startCash: START_CASH, canShort: false };
configLog["exp1-conservative"] = { profile: "conservative", capital: bucket03, startCash: START_CASH, canShort: false };
for (const [name, overrides] of Object.entries(ablationOverrides)) {
  configLog[`exp2-${name}`] = { profile: "moderate", capital: bucket03, startCash: START_CASH, canShort: false, overrides };
}
configLog["exp2-budget-allin"] = { profile: "moderate", capital: allin, startCash: START_CASH, canShort: false };
configLog["exp2-all-ablated"] = {
  profile: "moderate",
  capital: allin,
  startCash: START_CASH,
  canShort: false,
  overrides: { hardStopPercent: 0, trailingStopPercent: 0, maxHoldTicks: 0, sellCooldownTicks: 0, sellForecastDeviation: 0, maxPositions: 33 },
};
configLog["exp2-fillprice-stops"] = { profile: "moderate", capital: bucket03, startCash: START_CASH, canShort: false, useFillPriceForStops: true };
configLog["exp3-baseline"] = { ...CANON_BASE };
configLog["exp3-entry0.05"] = { ...CANON_BASE, entryThreshold: 0.05 };
configLog["exp3-entry0.15"] = { ...CANON_BASE, entryThreshold: 0.15 };
for (const H of [25, 50, 100]) configLog[`exp3-spreadaware-H${H}`] = { ...CANON_BASE, entryThreshold: 0, spreadAware: { H } };
for (const nDiv of [4, 8]) configLog[`exp3-diversified-N${nDiv}`] = { ...CANON_BASE, diversifiedN: nDiv };
configLog["exp3-hysteresis0.05"] = { ...CANON_BASE, exitHysteresis: 0.05 };
configLog["exp3-allin"] = { ...CANON_BASE, capital: allin };

// ============================================================
// Decide "canonical-best": highest median primary metric among the exp3 variants
// that use the SAME capital settings as the daemon comparison (bucket 0.3) - the
// all-in run is its own capital-axis data point, not a "best trading logic" pick.
// ============================================================
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const exp3BucketNames = phase1Jobs
  .filter((j) => j.group === "3" && j.name !== "exp3-allin")
  .map((j) => j.name);
let bestName = exp3BucketNames[0];
let bestMedian = -Infinity;
for (const name of exp3BucketNames) {
  const m = median(results[name].map((r) => r.logReturnPer100Ticks));
  if (m > bestMedian) {
    bestMedian = m;
    bestName = name;
  }
}
console.error(`canonical-best = ${bestName} (median logReturn/100t = ${bestMedian.toFixed(5)})`);
const canonicalBestConfig = configLog[bestName] as CanonicalConfig;

// ============================================================
// Phase 2: experiments 4 (capital sensitivity) and 5 (shorting on/off)
// ============================================================

const phase2Jobs: Job[] = [];
const CASH_LEVELS = [1e9, 10e9, 100e9, 1e12, 10e12];

const daemonModerateCfg: DaemonConfig = { profile: "moderate", capital: bucket03, startCash: START_CASH, canShort: false };
const daemonAllAbatedCfg: DaemonConfig = configLog["exp2-all-ablated"] as DaemonConfig;

for (const cash of CASH_LEVELS) {
  phase2Jobs.push(daemonJob(`exp4-daemon-moderate-cash${cash}`, "4", { ...daemonModerateCfg, startCash: cash }));
  phase2Jobs.push(daemonJob(`exp4-daemon-all-ablated-cash${cash}`, "4", { ...daemonAllAbatedCfg, startCash: cash }));
  phase2Jobs.push(canonicalJob(`exp4-canonical-best-cash${cash}`, "4", { ...canonicalBestConfig, startCash: cash }));
}

// --- Experiment 5: shorting on vs off, 100b ---
phase2Jobs.push(daemonJob("exp5-daemon-moderate-short-on", "5", { ...daemonModerateCfg, canShort: true }));
phase2Jobs.push(daemonJob("exp5-daemon-moderate-short-off", "5", { ...daemonModerateCfg, canShort: false }));
phase2Jobs.push(canonicalJob("exp5-canonical-best-short-on", "5", { ...canonicalBestConfig, canShort: true }));
phase2Jobs.push(canonicalJob("exp5-canonical-best-short-off", "5", { ...canonicalBestConfig, canShort: false }));

console.error(`Phase 2: ${phase2Jobs.length} configs x ${N_SEEDS} seeds`);
for (const job of phase2Jobs) {
  results[job.name] = runJob(job);
}
// Log phase 2 configs explicitly (they weren't captured on the Job objects themselves).
for (const cash of CASH_LEVELS) {
  configLog[`exp4-daemon-moderate-cash${cash}`] = { ...daemonModerateCfg, startCash: cash };
  configLog[`exp4-daemon-all-ablated-cash${cash}`] = { ...daemonAllAbatedCfg, startCash: cash };
  configLog[`exp4-canonical-best-cash${cash}`] = { ...canonicalBestConfig, startCash: cash };
}
configLog["exp5-daemon-moderate-short-on"] = { ...daemonModerateCfg, canShort: true };
configLog["exp5-daemon-moderate-short-off"] = { ...daemonModerateCfg, canShort: false };
configLog["exp5-canonical-best-short-on"] = { ...canonicalBestConfig, canShort: true };
configLog["exp5-canonical-best-short-off"] = { ...canonicalBestConfig, canShort: false };

// ============================================================
// Write raw results
// ============================================================
const output = {
  nSeeds: N_SEEDS,
  seeds: SEEDS,
  horizon: 3000,
  canonicalBestName: bestName,
  configs: configLog,
  results,
};
fs.writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(output));
console.error("Wrote results.json");
