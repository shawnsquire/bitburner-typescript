/**
 * Darknet Solver: PrimeTime 2 (LargestPrimeFactor)
 *
 * Blind, one-attempt decode. `details.data` is the target integer, built by
 * the game's `getLargestPrimeFactorPassword` as one `largePrimes` entry
 * (max 9859) times up to six `smallPrimes` factors (max 97 each, capped at
 * `1 + min(5, floor(difficulty/3))` factors) — worst case ~8.21e15, safely
 * under `Number.MAX_SAFE_INTEGER` (~9.007e15), so plain trial division with
 * `Number` arithmetic (no `BigInt`) is exact throughout. Dividing out every
 * `smallPrimes` factor leaves exactly the large prime.
 */
import { Solver } from "/lib/darknet/solvers/types";

// Verbatim copy of the game's `smallPrimes` (src/DarkNet/controllers/ServerGenerator.ts).
const SMALL_PRIMES = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
];

function largestPrimeFactor(target: number): number {
  let n = target;
  for (const p of SMALL_PRIMES) {
    while (n % p === 0) {
      n /= p;
    }
  }
  return n;
}

interface PrimeTimeState {
  attempt: string;
}

export const primeTime: Solver<PrimeTimeState> = {
  id: "PrimeTime 2",
  blind: true,

  start(details): PrimeTimeState {
    const result = largestPrimeFactor(Number(details.data));
    return { attempt: String(result) };
  },

  next(state, feedback) {
    if (feedback !== null) {
      return { giveUp: true, reason: "decode should succeed in one attempt" };
    }
    return { attempt: state.attempt, state };
  },
};
