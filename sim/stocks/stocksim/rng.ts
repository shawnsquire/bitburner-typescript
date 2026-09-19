/**
 * Seeded PRNG for the stock simulator.
 *
 * The real game calls the platform `Math.random()` everywhere (see StockMarket.ts,
 * Stock.ts, StockMarketHelpers.ts, PlayerInfluencing.ts). For a reproducible Monte
 * Carlo backtest we need a substitute that:
 *   - is deterministic given a seed (same seed -> same tick-by-tick outcomes)
 *   - is injected into every place the game would have called Math.random(),
 *     never calling the real Math.random() directly.
 *
 * mulberry32 is a small, fast, decent-quality 32-bit PRNG. It is not
 * cryptographically secure and is not the algorithm V8 uses for Math.random(),
 * but nothing in the ported game logic depends on the specific RNG algorithm -
 * only on "a uniform value in [0, 1)" - so substituting it is faithful to the
 * mechanics while making runs reproducible.
 */

/** A source of uniform random numbers in [0, 1), matching the Math.random() contract. */
export type Rng = () => number;

/** Construct a mulberry32 PRNG function seeded with a 32-bit integer. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Port of src/utils/helpers/getRandomIntInclusive.ts.
 *
 * The original always calls the global Math.random(); here the rng source is an
 * explicit parameter so it can be the same injected seeded generator used
 * everywhere else in the simulator (constructor field: this always the FIRST
 * argument, unlike the original which takes no rng parameter at all).
 *
 * Gets a random integer between min (inclusive) and max (inclusive).
 */
export function getRandomIntInclusive(rng: Rng, min: number, max: number): number {
  if (!Number.isInteger(min)) {
    throw new Error(`Min is not an integer. Min: ${min}.`);
  }
  if (!Number.isInteger(max)) {
    throw new Error(`Max is not an integer. Max: ${max}.`);
  }
  if (min > max) {
    throw new Error(`Min is greater than max. Min: ${min}. Max: ${max}.`);
  }
  return Math.floor(rng() * (max - min + 1) + min);
}
