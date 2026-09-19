/**
 * Darknet Solver: DeepGreen (MastermindHint)
 *
 * Not blind. The game's `MastermindHint` branch of `checkPassword`
 * (`src/DarkNet/effects/authentication.ts`) reports `feedback.data` as
 * `"<exact>,<misplaced>"`: `exact` is `getExactCorrectCharsCount` (positions
 * where the attempt matches the password) and `misplaced` is the
 * duplicate-aware `getMisplacedCorrectCharsCount`
 * (`src/DarkNet/utils/darknetAuthUtils.ts`) — classic Mastermind pegs.
 *
 * Only the `exact` count is needed, in two phases mirroring RateMyPix:
 *  1. Scan: for each alphabet character `c`, attempt `c.repeat(length)`.
 *     A uniform-repeat attempt always makes `misplaced` come out 0 (every
 *     mismatched position holds `c`, and `c` is by construction excluded
 *     from `getMisplacedCorrectCharsCount`'s "remaining password chars" at
 *     those positions), so `exact` alone gives the number of positions
 *     equal to `c` — the password's character multiset. This scan also
 *     finds an absent (0-count) character to use as filler, stopping once
 *     both are known (never later than one full alphabet pass — alphabet
 *     size always exceeds password length for every difficulty this model
 *     appears at, so an absent character is guaranteed to exist).
 *  2. Place: for each known character, attempt filler everywhere except the
 *     candidate at one still-unresolved position. Filler cannot
 *     coincidentally match (it's absent from the whole password), so
 *     `exact` is exactly 0 or 1 — a yes/no oracle for "does this position
 *     hold this character". Already-resolved positions are skipped on every
 *     subsequent probe, so this costs at most `length * (length + 1) / 2`
 *     attempts in the worst (all-distinct) case. Once every position is
 *     resolved, the resolved string itself is submitted as the final
 *     attempt (the exact-match branch in `checkPassword` fires before the
 *     per-model branch, so it succeeds).
 *
 * If heartbleed is unavailable, `feedback.data` is undefined on every retry
 * and the solver gives up (`"needs heartbleed"`) — there is no way to learn
 * exact/misplaced counts blind.
 */
import { Solver } from "/lib/darknet/solvers/types";

const NUMERIC_ALPHABET = "0123456789";
const FULL_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function parseExactCount(data: string): number {
  const exactPart = data.split(",")[0];
  const n = Number(exactPart);
  return Number.isFinite(n) ? n : 0;
}

type Probe = { kind: "scan"; char: string } | { kind: "place"; char: string; pos: number } | null;

interface DeepGreenState {
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

export const deepGreen: Solver<DeepGreenState> = {
  id: "DeepGreen",
  blind: false,

  start(details): DeepGreenState {
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
      const exact = parseExactCount(feedback.data);

      if (lastProbe?.kind === "scan") {
        const { char } = lastProbe;
        if (exact > 0) {
          multiset = [...multiset, { char, count: exact }];
          countsSum += exact;
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
        if (exact > 0) {
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
