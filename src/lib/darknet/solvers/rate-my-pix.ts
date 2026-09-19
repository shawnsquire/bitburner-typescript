/**
 * Darknet Solver: RateMyPix.Auth (SpiceLevel)
 *
 * Not blind. The game's `SpiceLevel` branch of `checkPassword`
 * (`src/DarkNet/effects/authentication.ts`) reports `feedback.data` as
 * `"<N pepper emoji>/<passwordLength>"` where N is the COUNT of exactly
 * correct positions in the previous attempt (`"0/<len>"` when none match) —
 * only the count, never which positions. Since the pepper glyph is multiple
 * UTF-16 code units, the count is read by splitting on it rather than by
 * measuring `.length`.
 *
 * Two phases:
 *  1. Scan: for each alphabet character `c`, attempt `c.repeat(length)`.
 *     The returned count is exactly how many positions equal `c`, so this
 *     recovers the password's character multiset. It doubles as the search
 *     for an absent (0-count) character to use as filler, and stops once
 *     both are known — usually much sooner than a full alphabet pass, and
 *     never later than one (alphabet size always exceeds password length
 *     for every difficulty this model appears at, so an absent character is
 *     guaranteed to exist).
 *  2. Place: for each known character, binary-search-free linear probing —
 *     attempt filler everywhere except the candidate at one still-unresolved
 *     position; filler cannot coincidentally match (it's absent from the
 *     whole password), so the count is exactly 0 or 1, i.e. a yes/no oracle
 *     for "does this position hold this character". Already-resolved
 *     positions are skipped on every subsequent probe, so this costs at
 *     most `length * (length + 1) / 2` attempts in the worst (all-distinct)
 *     case. Once every position is resolved, the resolved string itself is
 *     submitted as the final attempt (the exact-match branch in
 *     `checkPassword` fires before the per-model branch, so it succeeds).
 *
 * If heartbleed is unavailable, `feedback.data` is undefined on every retry
 * and the solver gives up (`"needs heartbleed"`) — there is no way to learn
 * the spice count blind.
 */
import { Solver } from "/lib/darknet/solvers/types";

const NUMERIC_ALPHABET = "0123456789";
const FULL_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PEPPER = "🌶️";

function parsePepperCount(data: string): number {
  const countPart = data.split("/")[0];
  return countPart.split(PEPPER).length - 1;
}

type Probe = { kind: "scan"; char: string } | { kind: "place"; char: string; pos: number } | null;

interface RmpState {
  alphabet: string;
  length: number;
  phase: "scan" | "place";
  scanIndex: number;
  countsSum: number;
  multiset: { char: string; count: number }[];
  filler: string | null;
  resolved: (string | null)[];
  placeCandidateIndex: number;
  placeRemaining: number;
  placePos: number;
  lastProbe: Probe;
}

export const rateMyPix: Solver<RmpState> = {
  id: "RateMyPix.Auth",
  blind: false,

  start(details): RmpState {
    const alphabet = details.passwordFormat === "numeric" ? NUMERIC_ALPHABET : FULL_ALPHABET;
    return {
      alphabet,
      length: details.passwordLength,
      phase: "scan",
      scanIndex: 0,
      countsSum: 0,
      multiset: [],
      filler: null,
      resolved: new Array(details.passwordLength).fill(null) as (string | null)[],
      placeCandidateIndex: 0,
      placeRemaining: 0,
      placePos: 0,
      lastProbe: null,
    };
  },

  next(state, feedback) {
    let {
      phase,
      scanIndex,
      countsSum,
      multiset,
      filler,
      resolved,
      placeCandidateIndex,
      placeRemaining,
      placePos,
    } = state;
    const { alphabet, length, lastProbe } = state;

    if (feedback !== null) {
      if (feedback.data === undefined) {
        return { giveUp: true, reason: "needs heartbleed" };
      }
      const count = parsePepperCount(feedback.data);

      if (lastProbe?.kind === "scan") {
        const { char } = lastProbe;
        if (count > 0) {
          multiset = [...multiset, { char, count }];
          countsSum += count;
        } else if (filler === null) {
          filler = char;
        }

        if (countsSum >= length && filler !== null) {
          phase = "place";
          resolved = new Array(length).fill(null) as (string | null)[];
          placeCandidateIndex = 0;
          placeRemaining = multiset.length > 0 ? multiset[0].count : 0;
          placePos = 0;
        } else {
          scanIndex++;
          if (scanIndex >= alphabet.length) {
            return { giveUp: true, reason: "could not identify the full character multiset" };
          }
        }
      } else if (lastProbe?.kind === "place") {
        const { char, pos } = lastProbe;
        if (count > 0) {
          resolved = resolved.map((r, i) => (i === pos ? char : r));
          placeRemaining--;
        }
        placePos = pos + 1;
        if (placeRemaining <= 0) {
          placeCandidateIndex++;
          placePos = 0;
          placeRemaining = placeCandidateIndex < multiset.length ? multiset[placeCandidateIndex].count : 0;
        }
      }
    }

    if (phase === "scan") {
      const char = alphabet[scanIndex];
      const attempt = char.repeat(length);
      return {
        attempt,
        state: {
          alphabet,
          length,
          phase,
          scanIndex,
          countsSum,
          multiset,
          filler,
          resolved,
          placeCandidateIndex,
          placeRemaining,
          placePos,
          lastProbe: { kind: "scan", char },
        },
      };
    }

    if (resolved.every((r) => r !== null)) {
      return {
        attempt: resolved.join(""),
        state: {
          alphabet,
          length,
          phase,
          scanIndex,
          countsSum,
          multiset,
          filler,
          resolved,
          placeCandidateIndex,
          placeRemaining,
          placePos,
          lastProbe,
        },
      };
    }

    while (placePos < length && resolved[placePos] !== null) placePos++;
    if (placeCandidateIndex >= multiset.length || placePos >= length) {
      return { giveUp: true, reason: "placement exhausted before resolving every position" };
    }

    const char = multiset[placeCandidateIndex].char;
    const fillerChar = filler ?? alphabet[0];
    const attempt = resolved.map((r, i) => (i === placePos ? char : fillerChar)).join("");
    return {
      attempt,
      state: {
        alphabet,
        length,
        phase,
        scanIndex,
        countsSum,
        multiset,
        filler,
        resolved,
        placeCandidateIndex,
        placeRemaining,
        placePos,
        lastProbe: { kind: "place", char, pos: placePos },
      },
    };
  },
};
