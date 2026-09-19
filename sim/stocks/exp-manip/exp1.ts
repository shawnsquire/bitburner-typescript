/**
 * Experiment 1: push strength.
 *
 * For ECP (mega-cap, otlkMag 19), FLCM (mid, otlkMag 16), JGN (small, otlkMag 1),
 * apply k guaranteed-successful bearish influence events per tick (k in K_GRID),
 * starting from each stock's natural bullish initial state, market otherwise running
 * normally (cycles on, forecast drift on). For each (stock, k) over N_SEEDS seeds,
 * run up to 600 ticks and measure:
 *   - ticks until the visible forecast first crosses below 0.5 (median/IQR), the
 *     fraction of seeds that never cross within 600 ticks, AND whether that first
 *     crossing was caused by the 75-tick cycle's unconditional b-flip
 *     (stockMarketCycle, tracked via market.cycleFlips) vs by otlkMag itself
 *     drifting through zero under sustained pressure (inside cycleForecast(), with
 *     no cycle event that tick) - these are mechanically very different and get
 *     conflated by a single "crossing time" number.
 *   - P(on the bearish side) and the median visible forecast at tick 600 (NOT a
 *     single "steady state" - the long-run behavior is bimodal: b is bullish or
 *     bearish, so the median forecast is a weak summary; P(bearish) is the useful one)
 *   - how a 75-tick market cycle's b-flip (which also does otlkMagForecast = 100 -
 *     otlkMagForecast) interacts with continuous pressure: each time a cycle flip
 *     knocks a pinned-bearish stock back to bullish, how long (ticks) until
 *     continued pressure re-pins it below 0.5 (median/mean/IQR among those that do
 *     re-pin within the run, plus how many never re-pin before the run ends)
 */
import { makeSingleStockMarket, applyRatePerTick, onDesiredSide, summarize, seeds, K_GRID, N_SEEDS, STOCKS } from "./lib.ts";

const MAX_TICKS = 600;
const DIR = "short" as const; // bearish pressure via influenceHack

interface RunResult {
  crossingTick: number | null;
  crossingIsFlipDriven: boolean | null; // null if never crossed
  finalForecast: number;
  finalOnSide: boolean;
  repinLatencies: number[];
  depinEvents: number;
  censoredDepins: number;
}

function runOne(seed: number, symbol: string, k: number): RunResult {
  const market = makeSingleStockMarket(seed, symbol);
  let acc = 0;
  let crossingTick: number | null = null;
  let crossingIsFlipDriven: boolean | null = null;
  let prevSide = false; // starts bullish -> not on the (short) desired side
  let pendingDepinTick: number | null = null;
  const repinLatencies: number[] = [];
  let depinEvents = 0;

  let forecast = market.getForecast(symbol);
  for (let t = 1; t <= MAX_TICKS; t++) {
    const cf0 = market.cycleFlips;
    const bPre = market.getStockState(symbol).b;
    market.tick();
    const flipped = market.cycleFlips > cf0; // stockMarketCycle's unconditional 45%/75-tick b-flip
    acc = applyRatePerTick(market, symbol, DIR, k, acc);
    const bPost = market.getStockState(symbol).b;
    forecast = market.getForecast(symbol);
    const side = onDesiredSide(forecast, DIR);

    if (crossingTick === null && side) {
      crossingTick = t;
      // Classify: did stockMarketCycle's b-flip cause this, or did otlkMag itself
      // drift through zero inside cycleForecast() with no cycle event this tick?
      crossingIsFlipDriven = flipped && bPre !== bPost;
    }

    if (flipped && prevSide === true && side === false) {
      // A 75-tick cycle flip knocked us OFF the pinned-bearish side.
      depinEvents++;
      pendingDepinTick = t;
    }
    if (pendingDepinTick !== null && side === true) {
      repinLatencies.push(t - pendingDepinTick);
      pendingDepinTick = null;
    }
    prevSide = side;
  }

  return {
    crossingTick,
    crossingIsFlipDriven,
    finalForecast: forecast,
    finalOnSide: onDesiredSide(forecast, DIR),
    repinLatencies,
    depinEvents,
    censoredDepins: pendingDepinTick !== null ? 1 : 0,
  };
}

function main(): void {
  const out: Record<string, Record<string, unknown>> = {};
  const seedList = seeds(N_SEEDS);

  for (const symbol of STOCKS) {
    out[symbol] = {};
    for (const k of K_GRID) {
      const crossingTicks: number[] = [];
      const finalForecasts: number[] = [];
      const allRepinLatencies: number[] = [];
      let neverCrossed = 0;
      let totalDepinEvents = 0;
      let totalCensored = 0;
      let flipDrivenCrossings = 0;
      let driftDrivenCrossings = 0;
      let finalOnSideCount = 0;

      for (const seed of seedList) {
        const r = runOne(seed, symbol, k);
        if (r.crossingTick === null) neverCrossed++;
        else {
          crossingTicks.push(r.crossingTick);
          if (r.crossingIsFlipDriven) flipDrivenCrossings++;
          else driftDrivenCrossings++;
        }
        finalForecasts.push(r.finalForecast);
        if (r.finalOnSide) finalOnSideCount++;
        allRepinLatencies.push(...r.repinLatencies);
        totalDepinEvents += r.depinEvents;
        totalCensored += r.censoredDepins;
      }

      out[symbol][String(k)] = {
        k,
        nSeeds: seedList.length,
        crossingTicks: summarize(crossingTicks),
        fractionNeverCrossed: neverCrossed / seedList.length,
        crossingMechanism: {
          flipDriven: flipDrivenCrossings,
          driftDriven: driftDrivenCrossings,
          fractionDriftDriven: (flipDrivenCrossings + driftDrivenCrossings) > 0
            ? driftDrivenCrossings / (flipDrivenCrossings + driftDrivenCrossings)
            : null,
        },
        finalForecast: summarize(finalForecasts),
        fractionOnDesiredSideAt600: finalOnSideCount / seedList.length,
        repin: {
          depinEvents: totalDepinEvents,
          repinnedCount: allRepinLatencies.length,
          censoredCount: totalCensored,
          latencies: summarize(allRepinLatencies),
        },
      };
      const s = summarize(crossingTicks);
      process.stderr.write(
        `exp1 ${symbol} k=${k}: crossMedian=${s.median} neverCross=${(neverCrossed / seedList.length).toFixed(3)} ` +
          `driftDrivenFrac=${((driftDrivenCrossings / Math.max(1, flipDrivenCrossings + driftDrivenCrossings))).toFixed(3)} ` +
          `P(bearish@600)=${(finalOnSideCount / seedList.length).toFixed(3)}\n`,
      );
    }
  }

  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
