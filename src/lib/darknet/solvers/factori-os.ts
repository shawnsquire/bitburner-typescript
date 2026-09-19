/**
 * Darknet Solver: Factori-Os
 *
 * divisibilityTest servers pick a password built by the game's
 * `getPasswordMadeUpOfPrimesProduct`: a small base in `[1, 5*(scale+1)]`
 * (scale = min(difficulty/2, 15), so the base itself is always <=80 and
 * therefore only ever divisible by primes <=79 -- all covered by
 * `smallPrimes`, which runs to 97) times a handful of further factors each
 * drawn from either `smallPrimes` or the composite range 1..5 (so a factor
 * of 4 = 2^2 can show up too), plus (difficulty>12) one `largePrimes`
 * entry, plus (difficulty>24) a second one. Every prime factor of the
 * password is therefore either <=97 or one of the 83 `largePrimes`.
 *
 * We can't read the password, but `divisibilityTest`'s feedback answers
 * "is the password divisible by my attempt" (`data: "true"|"false"`).
 * Probe each small prime, raising the power tested while it keeps
 * dividing, to recover its exact multiplicity; then (difficulty>12) probe
 * each large prime once, retesting a hit at difficulty>24 in case that
 * prime was drawn twice. Multiply every confirmed prime power together and
 * submit the product -- it reconstructs the whole password exactly.
 */
import { Solver, SolverDetails } from "/lib/darknet/solvers/types";

// Copied verbatim from the game's `smallPrimes` / `largePrimes`.
const SMALL_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97];
const LARGE_PRIMES = [
  1069, 1409, 1471, 1567, 1597, 1601, 1697, 1747, 1801, 1889, 1979, 1999, 2063, 2207, 2371, 2503, 2539, 2693, 2741,
  2753, 2801, 2819, 2837, 2909, 2939, 3169, 3389, 3571, 3761, 3881, 4217, 4289, 4547, 4729, 4789, 4877, 4943, 4951,
  4957, 5393, 5417, 5419, 5441, 5519, 5527, 5647, 5779, 5881, 6007, 6089, 6133, 6389, 6451, 6469, 6547, 6661, 6719,
  6841, 7103, 7549, 7559, 7573, 7691, 7753, 7867, 8053, 8081, 8221, 8329, 8599, 8677, 8761, 8839, 8963, 9103, 9199,
  9343, 9467, 9551, 9601, 9739, 9749, 9859,
];

type Phase = "small" | "large" | "largeRetest" | "submit" | "done";

interface State {
  product: bigint;
  phase: Phase;
  index: number; // index into SMALL_PRIMES or LARGE_PRIMES for the phase we're in
  prime: bigint; // prime currently being probed
  exponent: number; // exponent of `prime` the last attempt tested
  useLarge: boolean; // difficulty > 12: also probe largePrimes
  retestLarge: boolean; // difficulty > 24: a largePrimes hit might repeat
}

function advanceSmall(state: State): { attempt: string; state: State } {
  const nextIndex = state.index + 1;
  if (nextIndex < SMALL_PRIMES.length) {
    const prime = BigInt(SMALL_PRIMES[nextIndex]);
    return { attempt: prime.toString(), state: { ...state, index: nextIndex, prime, exponent: 1 } };
  }
  if (state.useLarge) {
    const prime = BigInt(LARGE_PRIMES[0]);
    return { attempt: prime.toString(), state: { ...state, phase: "large", index: 0, prime, exponent: 1 } };
  }
  return { attempt: state.product.toString(), state: { ...state, phase: "submit" } };
}

function advanceLarge(state: State): { attempt: string; state: State } {
  const nextIndex = state.index + 1;
  if (nextIndex < LARGE_PRIMES.length) {
    const prime = BigInt(LARGE_PRIMES[nextIndex]);
    return { attempt: prime.toString(), state: { ...state, index: nextIndex, prime, exponent: 1 } };
  }
  return { attempt: state.product.toString(), state: { ...state, phase: "submit" } };
}

export const factoriOs: Solver<State> = {
  id: "Factori-Os",
  blind: false,
  start: (details: SolverDetails): State => ({
    product: 1n,
    phase: "small",
    index: 0,
    prime: BigInt(SMALL_PRIMES[0]),
    exponent: 1,
    useLarge: details.difficulty > 12,
    retestLarge: details.difficulty > 24,
  }),
  next: (state, feedback) => {
    if (feedback === null) {
      // First probe: is the password divisible by smallPrimes[0]?
      return { attempt: state.prime.toString(), state };
    }
    if (feedback.data === undefined) {
      return { giveUp: true, reason: "needs heartbleed" };
    }
    if (state.phase === "submit") {
      // Our reconstructed product didn't match -- shouldn't happen.
      return { giveUp: true, reason: "reconstruction mismatch" };
    }

    const divides = feedback.data === "true";

    if (state.phase === "small") {
      if (divides) {
        const product = state.product * state.prime;
        const exponent = state.exponent + 1;
        const attempt = (state.prime ** BigInt(exponent)).toString();
        return { attempt, state: { ...state, product, exponent } };
      }
      return advanceSmall(state);
    }

    if (state.phase === "large") {
      if (divides) {
        const product = state.product * state.prime;
        if (state.retestLarge) {
          const attempt = (state.prime * state.prime).toString();
          return { attempt, state: { ...state, product, phase: "largeRetest" } };
        }
        return advanceLarge({ ...state, product });
      }
      return advanceLarge(state);
    }

    // phase === "largeRetest": did this large prime show up a second time?
    const product = divides ? state.product * state.prime : state.product;
    return advanceLarge({ ...state, product, phase: "large" });
  },
};
