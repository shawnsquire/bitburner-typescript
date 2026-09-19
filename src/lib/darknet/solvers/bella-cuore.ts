/**
 * Darknet Solver: BellaCuore (RomanNumeral)
 *
 * Not blind — two forms, distinguished by whether `details.data` contains a
 * comma:
 *
 * - Exact form (difficulty < 8 in the game's `getRomanNumeralConfig`):
 *   `details.data` is a single roman numeral (or `"nulla"` for 0). Decode
 *   with `romanNumeralDecoder` (ported verbatim) and emit the decimal value
 *   in one attempt.
 * - Range form (difficulty >= 8): `details.data` is `"<encMin>,<encMax>"`.
 *   Decode both bounds, then binary-search the integer password: after each
 *   failed attempt the game's `checkPassword` reports `feedback.data` as
 *   `"ALTUS NIMIS"` (attempt too HIGH, `Number(attempt) > Number(password)`)
 *   or `"PARUM BREVIS"` (attempt too LOW) — see
 *   `src/DarkNet/effects/authentication.ts`'s `RomanNumeral` branch.
 *
 * If heartbleed is unavailable, `feedback.data` is undefined on a range-form
 * retry and the solver gives up (`"needs heartbleed"`); the exact form never
 * needs a retry.
 */
import { Solver } from "/lib/darknet/solvers/types";

/** Verbatim port of the game's `romanNumeralDecoder`. */
function romanNumeralDecoder(input: string): number {
  if (input.toLowerCase() === "nulla") {
    return 0;
  }

  const romanToInt: { [key: string]: number } = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let total = 0;
  let prevValue = 0;

  for (let i = input.length - 1; i >= 0; i--) {
    const currentValue = romanToInt[input[i]];
    if (currentValue < prevValue) {
      total -= currentValue;
    } else {
      total += currentValue;
    }
    prevValue = currentValue;
  }

  return total;
}

type BellaCuoreState =
  | { kind: "exact"; answer: string }
  | { kind: "range"; lo: number; hi: number };

export const bellaCuore: Solver<BellaCuoreState> = {
  id: "BellaCuore",
  blind: false,

  start(details): BellaCuoreState {
    const commaIndex = details.data.indexOf(",");
    if (commaIndex === -1) {
      return { kind: "exact", answer: String(romanNumeralDecoder(details.data)) };
    }
    const lo = romanNumeralDecoder(details.data.slice(0, commaIndex));
    const hi = romanNumeralDecoder(details.data.slice(commaIndex + 1));
    return { kind: "range", lo, hi };
  },

  next(state, feedback) {
    if (state.kind === "exact") {
      if (feedback !== null) {
        return { giveUp: true, reason: "exact decode should succeed in one attempt" };
      }
      return { attempt: state.answer, state };
    }

    let { lo, hi } = state;
    if (feedback !== null) {
      if (feedback.data === undefined) {
        return { giveUp: true, reason: "needs heartbleed" };
      }
      const attempted = Number(feedback.passwordAttempted);
      if (feedback.data === "ALTUS NIMIS") {
        hi = attempted - 1;
      } else if (feedback.data === "PARUM BREVIS") {
        lo = attempted + 1;
      }
    }

    if (lo > hi) {
      return { giveUp: true, reason: "search range exhausted" };
    }
    const mid = Math.floor((lo + hi) / 2);
    return { attempt: String(mid), state: { kind: "range", lo, hi } };
  },
};
