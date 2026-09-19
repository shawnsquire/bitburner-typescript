/**
 * Experiment 2: holding power.
 *
 * Starting state: pin the stock to the desired side (forecast < 0.5 for "short"/bearish
 * via influenceHack, forecast > 0.5 for "long"/bullish via influenceGrow) using a fixed
 * strong pin-phase rate (PIN_K=20), starting from the stock's natural bullish state.
 * Once pinned (forecast first crosses to the desired side), continue the SAME market
 * (same RNG stream) for HOLD_TICKS=3000 more ticks applying a *test* rate k (the
 * K_GRID), and report the fraction of those 3000 ticks the forecast stayed on the
 * desired side - i.e. how much ongoing pressure is needed to hold a pin through the
 * natural 75-tick cycle's b-flips and forecast drift, not just achieve it once.
 */
import { makeSingleStockMarket, applyRatePerTick, onDesiredSide, summarize, seeds, K_GRID, N_SEEDS, STOCKS } from "./lib.ts";
import type { Direction } from "./lib.ts";

const PIN_K = 20;
const PIN_TICKS = 200; // fixed-duration pin phase, chosen from exp1: median crossing
// time at k=20 is ~67-99 ticks for ECP/FLCM and ~12 for JGN, so 200 ticks of sustained
// pin-phase pressure gives every stock room to cross AND to reinforce past the crossing
// (see exp1 finalForecast-at-t=600 data) before we start measuring holding power.
const HOLD_TICKS = 3000;
const DIRECTIONS: Direction[] = ["short", "long"];

function runOne(
  seed: number,
  symbol: string,
  dir: Direction,
  testK: number,
): { pinForecast: number; fraction: number } | null {
  const market = makeSingleStockMarket(seed, symbol);

  // Pin phase: fixed strong rate for a fixed duration, same for every testK branch
  // (deterministic given (seed, symbol, dir), recomputed each time for simplicity).
  let acc = 0;
  for (let t = 1; t <= PIN_TICKS; t++) {
    market.tick();
    acc = applyRatePerTick(market, symbol, dir, PIN_K, acc);
  }
  const pinForecast = market.getForecast(symbol);
  if (!onDesiredSide(pinForecast, dir)) return null; // pin phase didn't take - exclude (rare tail)

  // Hold phase: continue the same market/RNG stream with the test rate.
  let acc2 = 0;
  let onSide = 0;
  for (let t = 1; t <= HOLD_TICKS; t++) {
    market.tick();
    acc2 = applyRatePerTick(market, symbol, dir, testK, acc2);
    if (onDesiredSide(market.getForecast(symbol), dir)) onSide++;
  }
  return { pinForecast, fraction: onSide / HOLD_TICKS };
}

function main(): void {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  const seedList = seeds(N_SEEDS);

  for (const symbol of STOCKS) {
    out[symbol] = {};
    for (const dir of DIRECTIONS) {
      out[symbol][dir] = {};
      for (const k of K_GRID) {
        const fractions: number[] = [];
        const pinForecasts: number[] = [];
        let excluded = 0;

        for (const seed of seedList) {
          const r = runOne(seed, symbol, dir, k);
          if (r === null) {
            excluded++;
            continue;
          }
          fractions.push(r.fraction);
          pinForecasts.push(r.pinForecast);
        }

        out[symbol][dir][String(k)] = {
          k,
          nSeeds: seedList.length,
          excluded,
          pinForecastAtStart: summarize(pinForecasts),
          fractionOnDesiredSide: summarize(fractions),
        };
        process.stderr.write(
          `exp2 ${symbol} ${dir} k=${k}: fracMedian=${summarize(fractions).median.toFixed(4)} pinForecastMedian=${summarize(pinForecasts).median.toFixed(4)} excluded=${excluded}\n`,
        );
      }
    }
  }

  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
