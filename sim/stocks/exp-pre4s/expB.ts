// Experiment B: sampling misalignment between a poller (6000ms sleep + U(20,200)ms loop
// overhead, i.e. period in [6020, 6200]ms) and a market ticking every 6000ms (normal) or
// 4000ms (offline/bonus-time catch-up).
import { Market } from "/tmp/claude-1000/-home-shawn--herdr-worktrees-bitburner-typescript-stocks/67a69ebc-119f-4e9a-acf8-71dce941d214/scratchpad/stocksim/market.ts";
import { mulberry32 } from "/tmp/claude-1000/-home-shawn--herdr-worktrees-bitburner-typescript-stocks/67a69ebc-119f-4e9a-acf8-71dce941d214/scratchpad/stocksim/rng.ts";
import {
  createPriceHistory,
  addPrice,
  estimateForecast,
} from "../../../src/controllers/stocks.ts";
import type { PriceHistory } from "../../../src/controllers/stocks.ts";
import { createDirHistory, addSample, estimateFromDirHistory } from "./estimators.ts";
import type { DirHistory } from "./estimators.ts";
import { summarize, writeJSON, sign, seedRange, now } from "./common.ts";

const TARGET_TICKS = 3000;
const SEED_BASE = 2_000_000;
const NUM_SEEDS = Number(process.argv[2] ?? 300);
const MAX_HOLD_POLLS = 60; // ticksHeld counter increments once per poll iteration
const FLIP_HORIZON_POLLS = 75;

interface FlipTrack {
  prevSign: number;
  pending: { p0: number; target: number } | null;
}

interface RunResult {
  duplicatesPer1000: number;
  skipsPer1000: number;
  totalPolls: number;
  bias1: number;
  bias2: number;
  mae1: number;
  mae2: number;
  lagSamples1: number[];
  lagSamples2: number[];
  holdTicksSamples: number[]; // real market ticks elapsed over MAX_HOLD_POLLS consecutive polls
}

function overheadMs(rng: () => number): number {
  return 20 + rng() * (200 - 20);
}

function simulateOneRegime(seed: number, marketPeriodMs: number, overheadRng: () => number): RunResult {
  const market = new Market(seed, { cash: 0 });
  const symbols = market.symbols();

  const hist1 = new Map<string, PriceHistory>();
  const hist2 = new Map<string, DirHistory>();
  const prevTrueF = new Map<string, number | null>();
  const ft1 = new Map<string, FlipTrack>();
  const ft2 = new Map<string, FlipTrack>();
  for (const sym of symbols) {
    hist1.set(sym, createPriceHistory(40));
    hist2.set(sym, createDirHistory(40));
    prevTrueF.set(sym, null);
    ft1.set(sym, { prevSign: 0, pending: null });
    ft2.set(sym, { prevSign: 0, pending: null });
  }

  let currentTickIndex = 0;
  let pollTime = 0;
  let lastPollTickIndex = -1;
  let duplicates = 0;
  let skips = 0;
  let totalPolls = 0;

  let biasSum1 = 0, biasCount1 = 0, biasSum2 = 0, biasCount2 = 0;
  let maeSum1 = 0, maeSum2 = 0;
  const lagSamples1: number[] = [];
  const lagSamples2: number[] = [];
  const tickIndexHistory: number[] = [];

  while (currentTickIndex < TARGET_TICKS) {
    pollTime += 6000 + overheadMs(overheadRng);
    const k = Math.floor(pollTime / marketPeriodMs);
    while (currentTickIndex < k) {
      market.tick();
      currentTickIndex++;
    }
    if (lastPollTickIndex >= 0) {
      if (k === lastPollTickIndex) duplicates++;
      else if (k > lastPollTickIndex + 1) skips += k - lastPollTickIndex - 1;
    }
    lastPollTickIndex = k;
    const pollIdx = totalPolls; // 0-based index of this poll
    totalPolls++;
    tickIndexHistory.push(k);

    for (const sym of symbols) {
      const price = market.getPrice(sym);
      const trueF = market.getForecast(sym);
      const h1 = hist1.get(sym)!;
      const h2 = hist2.get(sym)!;
      addPrice(h1, price);
      addSample(h2, price, "skipFlat");
      const e1 = estimateForecast(h1, 10);
      const e2 = estimateFromDirHistory(h2, 10);

      if (e1 !== null) {
        biasSum1 += e1 - trueF;
        maeSum1 += Math.abs(e1 - trueF);
        biasCount1++;
      }
      if (e2 !== null) {
        biasSum2 += e2 - trueF;
        maeSum2 += Math.abs(e2 - trueF);
        biasCount2++;
      }

      // Flip-lag resolution against pending targets, poll-indexed.
      for (const [est, ftMap, lagArr] of [
        [e1, ft1, lagSamples1] as const,
        [e2, ft2, lagSamples2] as const,
      ]) {
        const f = ftMap.get(sym)!;
        if (f.pending !== null) {
          const es = est !== null ? sign(est - 0.5) : 0;
          if (es === f.pending.target) {
            lagArr.push(pollIdx - f.pending.p0);
            f.pending = null;
          } else if (pollIdx - f.pending.p0 > FLIP_HORIZON_POLLS) {
            f.pending = null;
          }
        }
      }

      // Detect a qualifying true-forecast flip event (as seen by this poll's sample stream).
      const prev = prevTrueF.get(sym)!;
      if (prev !== null) {
        const prevSign = sign(prev - 0.5);
        const currSign = sign(trueF - 0.5);
        if (
          prevSign !== 0 &&
          currSign !== 0 &&
          prevSign !== currSign &&
          Math.abs(prev - 0.5) >= 0.10 &&
          Math.abs(trueF - 0.5) >= 0.10
        ) {
          for (const ftMap of [ft1, ft2]) {
            const f = ftMap.get(sym)!;
            if (f.pending !== null) f.pending = null; // censored: truth flipped again first
            if (f.prevSign === prevSign) f.pending = { p0: pollIdx, target: currSign };
          }
        }
      }
      prevTrueF.set(sym, trueF);
      ft1.get(sym)!.prevSign = e1 !== null ? sign(e1 - 0.5) : 0;
      ft2.get(sym)!.prevSign = e2 !== null ? sign(e2 - 0.5) : 0;
    }
  }

  return {
    duplicatesPer1000: (duplicates / TARGET_TICKS) * 1000,
    skipsPer1000: (skips / TARGET_TICKS) * 1000,
    totalPolls,
    bias1: biasCount1 > 0 ? biasSum1 / biasCount1 : NaN,
    bias2: biasCount2 > 0 ? biasSum2 / biasCount2 : NaN,
    mae1: biasCount1 > 0 ? maeSum1 / biasCount1 : NaN,
    mae2: biasCount2 > 0 ? maeSum2 / biasCount2 : NaN,
    lagSamples1,
    lagSamples2,
    holdTicksSamples:
      tickIndexHistory.length > MAX_HOLD_POLLS
        ? tickIndexHistory.slice(MAX_HOLD_POLLS).map((k, i) => k - tickIndexHistory[i])
        : [],
  };
}

// === Run across seeds for both market-tick regimes ===

const regimes = [
  { name: "market6000ms", periodMs: 6000 },
  { name: "market4000ms", periodMs: 4000 },
];

const seeds = seedRange(SEED_BASE, NUM_SEEDS);
const t0 = now();

const perRegime: Record<string, {
  dup: number[]; skip: number[]; bias1: number[]; bias2: number[]; mae1: number[]; mae2: number[];
  lag1: number[]; lag2: number[]; holdTicks: number[];
}> = {};
for (const r of regimes) perRegime[r.name] = { dup: [], skip: [], bias1: [], bias2: [], mae1: [], mae2: [], lag1: [], lag2: [], holdTicks: [] };

for (const seed of seeds) {
  // Independent overhead RNG stream per seed, disjoint from the market's own RNG.
  const overheadRng = mulberry32(seed ^ 0x9e3779b9);
  for (const r of regimes) {
    const res = simulateOneRegime(seed, r.periodMs, overheadRng);
    const bucket = perRegime[r.name];
    bucket.dup.push(res.duplicatesPer1000);
    bucket.skip.push(res.skipsPer1000);
    bucket.bias1.push(res.bias1);
    bucket.bias2.push(res.bias2);
    bucket.mae1.push(res.mae1);
    bucket.mae2.push(res.mae2);
    if (res.lagSamples1.length > 0) bucket.lag1.push(res.lagSamples1.sort((a, b) => a - b)[Math.floor(res.lagSamples1.length / 2)]);
    if (res.lagSamples2.length > 0) bucket.lag2.push(res.lagSamples2.sort((a, b) => a - b)[Math.floor(res.lagSamples2.length / 2)]);
    bucket.holdTicks.push(...res.holdTicksSamples);
  }
}

const elapsed = now() - t0;
console.error(`expB: ${NUM_SEEDS} seeds x 2 regimes x ~${TARGET_TICKS} ticks in ${(elapsed / 1000).toFixed(1)}s`);

const result = {
  config: { seeds: NUM_SEEDS, targetTicks: TARGET_TICKS, seedBase: SEED_BASE, maxHoldPolls: MAX_HOLD_POLLS, pollPeriodMs: "6000 + U(20,200)" },
  regimes: Object.fromEntries(
    regimes.map((r) => {
      const b = perRegime[r.name];
      return [
        r.name,
        {
          duplicatesPer1000Ticks: summarize(b.dup),
          skipsPer1000Ticks: summarize(b.skip),
          bias_estimator1_downOnFlat: summarize(b.bias1),
          bias_estimator2_flatSkip: summarize(b.bias2),
          mae_estimator1_downOnFlat: summarize(b.mae1),
          mae_estimator2_flatSkip: summarize(b.mae2),
          flipLagPolls_estimator1: summarize(b.lag1),
          flipLagPolls_estimator2: summarize(b.lag2),
          realMarketTicksPer60Polls: summarize(b.holdTicks),
        },
      ];
    }),
  ),
  elapsedSec: elapsed / 1000,
};

writeJSON("/tmp/claude-1000/-home-shawn--herdr-worktrees-bitburner-typescript-stocks/67a69ebc-119f-4e9a-acf8-71dce941d214/scratchpad/exp-pre4s/resultsB.json", result);
console.error("wrote resultsB.json");
