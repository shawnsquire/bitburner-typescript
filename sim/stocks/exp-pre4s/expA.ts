// Experiment A: pre-4S forecast/volatility estimator accuracy vs ground truth.
import { Market } from "/tmp/claude-1000/-home-shawn--herdr-worktrees-bitburner-typescript-stocks/67a69ebc-119f-4e9a-acf8-71dce941d214/scratchpad/stocksim/market.ts";
import {
  createPriceHistory,
  addPrice,
  estimateForecast,
  estimateVolatility,
} from "../../../src/controllers/stocks.ts";
import type { PriceHistory } from "../../../src/controllers/stocks.ts";
import {
  createDirHistory,
  addSample,
  estimateFromDirHistory,
  createEwma,
  updateEwma,
  readEwma,
  createInvAware,
  updateInvAware,
  createVolWindow,
  updateVolWindow,
  maxLogRetVol,
} from "./estimators.ts";
import type { DirHistory, EwmaState, InvAwareState, VolWindowState } from "./estimators.ts";
import { summarize, writeJSON, sign, seedRange, now } from "./common.ts";

const HORIZON = 3000;
const SEED_BASE = 1_000_000; // disjoint from B/C seed ranges
const NUM_SEEDS = Number(process.argv[2] ?? 300);
const FLIP_HORIZON = 75; // give up waiting for an estimator to catch a flip after this many ticks

const FORECAST_ESTS = ["repo1_w40", "flatskip_w40", "w20", "w80", "ewma10", "ewma20", "invaware"] as const;
type EstName = (typeof FORECAST_ESTS)[number];

interface Acc {
  maeSum: number;
  maeCount: number;
  // Spec metric: "P(sign correct) when |estimate-0.5| >= 0.10" - conditioned on the
  // ESTIMATE being confident (precision-like: when the bot would act, is it right?).
  signCorrect_actionGated: number;
  actionEligible: number;
  // Extra diagnostic: conditioned on the TRUTH being strong (recall-like: when there's
  // really a signal, does the estimator see it?). Reported as a labeled secondary column.
  signCorrect_truthGated: number;
  truthEligible: number;
  falseSignal: number;
  falseEligible: number;
  lagSamples: number[];
  censored: number;
  events: number;
}
function newAcc(): Acc {
  return {
    maeSum: 0, maeCount: 0,
    signCorrect_actionGated: 0, actionEligible: 0,
    signCorrect_truthGated: 0, truthEligible: 0,
    falseSignal: 0, falseEligible: 0,
    lagSamples: [], censored: 0, events: 0,
  };
}

interface PerSymEstState {
  prevSign: number;
  pending: { t0: number; target: number } | null;
}

interface PerSymState {
  repo40: PriceHistory;
  repo20: PriceHistory;
  repo80: PriceHistory;
  flat40: DirHistory;
  ewma10: EwmaState;
  ewma20: EwmaState;
  inv: InvAwareState;
  volWin: VolWindowState;
  prevTrueF: number | null;
  est: Record<EstName, PerSymEstState>;
}

function newPerSymState(): PerSymState {
  const est = {} as Record<EstName, PerSymEstState>;
  for (const name of FORECAST_ESTS) est[name] = { prevSign: 0, pending: null };
  return {
    repo40: createPriceHistory(40),
    repo20: createPriceHistory(20),
    repo80: createPriceHistory(80),
    flat40: createDirHistory(40),
    ewma10: createEwma(10),
    ewma20: createEwma(20),
    inv: createInvAware(40, 10, "downOnFlat"),
    volWin: createVolWindow(40),
    prevTrueF: null,
    est,
  };
}

// Per-seed aggregates across all seeds (each entry = one seed's pooled-across-stocks value)
const perSeedMAE: Record<EstName, number[]> = Object.fromEntries(FORECAST_ESTS.map((n) => [n, []])) as any;
const perSeedSignAccAction: Record<EstName, number[]> = Object.fromEntries(FORECAST_ESTS.map((n) => [n, []])) as any;
const perSeedSignAccTruth: Record<EstName, number[]> = Object.fromEntries(FORECAST_ESTS.map((n) => [n, []])) as any;
const perSeedFalseRate: Record<EstName, number[]> = Object.fromEntries(FORECAST_ESTS.map((n) => [n, []])) as any;
const perSeedMedianLag: Record<EstName, number[]> = Object.fromEntries(FORECAST_ESTS.map((n) => [n, []])) as any;
let totalEvents: Record<EstName, number> = Object.fromEntries(FORECAST_ESTS.map((n) => [n, 0])) as any;
let totalCensored: Record<EstName, number> = Object.fromEntries(FORECAST_ESTS.map((n) => [n, 0])) as any;
let totalResolved: Record<EstName, number> = Object.fromEntries(FORECAST_ESTS.map((n) => [n, 0])) as any;

// Volatility comparison, pooled per-seed
const perSeedVolMAE_repo: number[] = [];
const perSeedVolMAE_maxRaw: number[] = [];
const perSeedVolMAE_maxCorr: number[] = [];
const perSeedVolRatio_repo: number[] = []; // mean(estVol)/mean(trueVol)
const perSeedVolRatio_maxRaw: number[] = [];
const perSeedVolRatio_maxCorr: number[] = [];
let flatTickCount = 0;
let totalTickCount = 0;

const seeds = seedRange(SEED_BASE, NUM_SEEDS);
const t0 = now();

for (const seed of seeds) {
  const market = new Market(seed, { cash: 0 });
  const symbols = market.symbols();
  const states = new Map<string, PerSymState>();
  for (const sym of symbols) states.set(sym, newPerSymState());

  const acc: Record<EstName, Acc> = Object.fromEntries(FORECAST_ESTS.map((n) => [n, newAcc()])) as any;
  let volSumEst_repo = 0, volSumTrue_repo = 0, volMaeSum_repo = 0, volCount_repo = 0;
  let volSumEst_maxRaw = 0, volSumTrue_maxRaw = 0, volMaeSum_maxRaw = 0, volCount_maxRaw = 0;
  let volSumEst_maxCorr = 0, volMaeSum_maxCorr = 0;

  for (let t = 0; t < HORIZON; t++) {
    market.tick();
    for (const sym of symbols) {
      const st = states.get(sym)!;
      const price = market.getPrice(sym);
      const trueF = market.getForecast(sym);
      const trueVol = market.getVolatility(sym);

      // Track flat ticks (diagnostic only)
      totalTickCount++;
      if (st.repo40.prices.length > 0 && price === st.repo40.prices[st.repo40.prices.length - 1]) flatTickCount++;

      // Update all histories
      addPrice(st.repo40, price);
      addPrice(st.repo20, price);
      addPrice(st.repo80, price);
      addSample(st.flat40, price, "skipFlat");
      updateEwma(st.ewma10, price);
      updateEwma(st.ewma20, price);
      const invEst = updateInvAware(st.inv, price);
      updateVolWindow(st.volWin, price);

      const estVals: Record<EstName, number | null> = {
        repo1_w40: estimateForecast(st.repo40, 10),
        flatskip_w40: estimateFromDirHistory(st.flat40, 10),
        w20: estimateForecast(st.repo20, 10),
        w80: estimateForecast(st.repo80, 10),
        ewma10: readEwma(st.ewma10, 10),
        ewma20: readEwma(st.ewma20, 10),
        invaware: invEst,
      };

      // Volatility comparison (repo estimateVolatility reuses repo40's price window)
      const estVolRepo = estimateVolatility(st.repo40);
      if (estVolRepo !== null) {
        volSumEst_repo += estVolRepo;
        volSumTrue_repo += trueVol;
        volMaeSum_repo += Math.abs(estVolRepo - trueVol);
        volCount_repo++;
      }
      const maxVol = maxLogRetVol(st.volWin, 10);
      if (maxVol !== null) {
        volSumEst_maxRaw += maxVol.raw;
        volSumEst_maxCorr += maxVol.corrected;
        volSumTrue_maxRaw += trueVol;
        volMaeSum_maxRaw += Math.abs(maxVol.raw - trueVol);
        volMaeSum_maxCorr += Math.abs(maxVol.corrected - trueVol);
        volCount_maxRaw++;
      }

      // Per-estimator metrics
      for (const name of FORECAST_ESTS) {
        const est = estVals[name];
        const a = acc[name];
        const es = st.est[name];

        if (est !== null) {
          a.maeSum += Math.abs(est - trueF);
          a.maeCount++;

          if (Math.abs(est - 0.5) >= 0.10) {
            a.actionEligible++;
            if (sign(est - 0.5) === sign(trueF - 0.5)) a.signCorrect_actionGated++;
          }
          if (Math.abs(trueF - 0.5) >= 0.10) {
            a.truthEligible++;
            if (sign(est - 0.5) === sign(trueF - 0.5)) a.signCorrect_truthGated++;
          }
          if (Math.abs(trueF - 0.5) < 0.03) {
            a.falseEligible++;
            if (Math.abs(est - 0.5) >= 0.10) a.falseSignal++;
          }
        }

        // Flip lag resolution (check before updating prevSign for this tick)
        if (es.pending !== null) {
          const estSign = est !== null ? sign(est - 0.5) : 0;
          if (estSign === es.pending.target) {
            a.lagSamples.push(t - es.pending.t0);
            totalResolved[name]++;
            es.pending = null;
          } else if (t - es.pending.t0 > FLIP_HORIZON) {
            a.censored++;
            totalCensored[name]++;
            es.pending = null;
          }
        }

        es.prevSign = est !== null ? sign(est - 0.5) : 0;
      }

      // Detect a qualifying true-forecast flip event this tick
      if (st.prevTrueF !== null) {
        const prevSign = sign(st.prevTrueF - 0.5);
        const currSign = sign(trueF - 0.5);
        if (
          prevSign !== 0 &&
          currSign !== 0 &&
          prevSign !== currSign &&
          Math.abs(st.prevTrueF - 0.5) >= 0.10 &&
          Math.abs(trueF - 0.5) >= 0.10
        ) {
          for (const name of FORECAST_ESTS) {
            const a = acc[name];
            const es = st.est[name];
            a.events++;
            totalEvents[name]++;
            if (es.pending !== null) {
              // truth flipped again before the estimator caught the previous flip
              a.censored++;
              totalCensored[name]++;
              es.pending = null;
            }
            if (es.prevSign === prevSign) {
              // estimator was correctly tracking pre-flip - eligible to time its catch-up
              es.pending = { t0: t, target: currSign };
            }
          }
        }
      }
      st.prevTrueF = trueF;
    }
  }

  for (const name of FORECAST_ESTS) {
    const a = acc[name];
    perSeedMAE[name].push(a.maeCount > 0 ? a.maeSum / a.maeCount : NaN);
    perSeedSignAccAction[name].push(a.actionEligible > 0 ? a.signCorrect_actionGated / a.actionEligible : NaN);
    perSeedSignAccTruth[name].push(a.truthEligible > 0 ? a.signCorrect_truthGated / a.truthEligible : NaN);
    perSeedFalseRate[name].push(a.falseEligible > 0 ? a.falseSignal / a.falseEligible : NaN);
    if (a.lagSamples.length > 0) {
      const sorted = [...a.lagSamples].sort((x, y) => x - y);
      perSeedMedianLag[name].push(sorted[Math.floor(sorted.length / 2)]);
    }
  }
  if (volCount_repo > 0) {
    perSeedVolMAE_repo.push(volMaeSum_repo / volCount_repo);
    perSeedVolRatio_repo.push(volSumEst_repo / volSumTrue_repo);
  }
  if (volCount_maxRaw > 0) {
    perSeedVolMAE_maxRaw.push(volMaeSum_maxRaw / volCount_maxRaw);
    perSeedVolMAE_maxCorr.push(volMaeSum_maxCorr / volCount_maxRaw);
    perSeedVolRatio_maxRaw.push(volSumEst_maxRaw / volSumTrue_maxRaw);
    perSeedVolRatio_maxCorr.push(volSumEst_maxCorr / volSumTrue_maxRaw);
  }
}

const elapsed = now() - t0;
console.error(`expA: ${NUM_SEEDS} seeds x ${HORIZON} ticks in ${(elapsed / 1000).toFixed(1)}s`);

const result = {
  config: { seeds: NUM_SEEDS, horizon: HORIZON, seedBase: SEED_BASE, flipHorizon: FLIP_HORIZON },
  diagnostics: { flatTickCount, totalTickCount, flatTickFraction: flatTickCount / totalTickCount },
  estimators: Object.fromEntries(
    FORECAST_ESTS.map((name) => [
      name,
      {
        mae: summarize(perSeedMAE[name]),
        // Spec metric: "P(sign correct) when |estimate-0.5| >= 0.10" - conditioned on the
        // estimate being confident (precision: when the bot would act, is it right?).
        signAccuracy_whenEstimateConfident: summarize(perSeedSignAccAction[name]),
        // Secondary diagnostic: conditioned on the truth being strong (recall: when
        // there's really a signal, does the estimator see it?).
        signAccuracy_whenTruthStrong: summarize(perSeedSignAccTruth[name]),
        falseSignalRate: summarize(perSeedFalseRate[name]),
        flipLagTicks: summarize(perSeedMedianLag[name]),
        flipEventsTotal: totalEvents[name],
        flipResolvedTotal: totalResolved[name],
        flipCensoredTotal: totalCensored[name],
      },
    ]),
  ),
  volatility: {
    repoEstimateVolatility: {
      mae: summarize(perSeedVolMAE_repo),
      ratioEstOverTrue: summarize(perSeedVolRatio_repo),
    },
    maxLogReturn_raw: {
      mae: summarize(perSeedVolMAE_maxRaw),
      ratioEstOverTrue: summarize(perSeedVolRatio_maxRaw),
    },
    maxLogReturn_biasCorrected: {
      mae: summarize(perSeedVolMAE_maxCorr),
      ratioEstOverTrue: summarize(perSeedVolRatio_maxCorr),
    },
  },
  elapsedSec: elapsed / 1000,
};

writeJSON("/tmp/claude-1000/-home-shawn--herdr-worktrees-bitburner-typescript-stocks/67a69ebc-119f-4e9a-acf8-71dce941d214/scratchpad/exp-pre4s/resultsA.json", result);
console.error("wrote resultsA.json");
