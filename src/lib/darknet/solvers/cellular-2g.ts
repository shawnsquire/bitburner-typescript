/**
 * Darknet Solver: 2G_cellular (TimingAttack)
 *
 * Not blind, and the one solver that must also solve with heartbleed
 * unavailable -- it never needs `feedback.data`.
 *
 * The game's `TimingAttack` branch of `checkPassword`
 * (`src/DarkNet/effects/authentication.ts`) checks the password
 * character-by-character and exposes two channels on failure:
 *  - `feedback.message`: `"Found a mismatch while checking each character
 *    (<i>)"`, where `i` is the index of the first character that didn't
 *    match -- so characters `0..i-1` of the attempt are confirmed correct.
 *    This is only in the server LOGS, so the agent has it only when it can
 *    call `heartbleed` (`getAuthResult` returns the generic
 *    `GenericResponseMessage.AuthFailure` to the calling script). When it
 *    parses, it is exact and always preferred.
 *  - Response time: the game adds `50ms` of auth delay per already-correct
 *    character (`sharedChars * 50` in `getResponseTime`, `effects.ts`) on top
 *    of a base time that depends on the player's charisma and intelligence
 *    (`~850 * skillFactor * intelligenceBonus`). The agent measures this as
 *    the wall-clock around its own `authenticate` call (`feedback.elapsedMs`).
 *
 * Without heartbleed only the response time is available, and its BASE is
 * unknown (it is not the 1000ms a fixed formula would give). So the
 * no-heartbleed path uses the time *relative to the other candidates at the
 * same position*, never an absolute formula: at each position every wrong
 * next-character produces the same base+50*len time, and the one correct
 * next-character produces base+50*(len+1) -- ~50ms higher. Probing the
 * alphabet at a position and taking the character whose response time stands
 * clearly above the others recovers it without ever knowing the base. Worst
 * case is a full alphabet pass per position (`alphabet.length *
 * passwordLength`, the harness's `62 * passwordLength` cap); the correct
 * character usually stands out well before the pass completes. The final
 * correct character at the last position makes the attempt equal the whole
 * password, which the exact-match branch in `checkPassword` accepts directly.
 *
 * In-game timing carries scheduling jitter the harness does not model, so the
 * no-heartbleed fallback is best-effort; with heartbleed on (the default) the
 * exact message-index path above is used and this is never reached. See
 * `docs/systems/darknet.md`.
 */
import { ParsedFeedback, Solver } from "/lib/darknet/solvers/types";

const NUMERIC_ALPHABET = "0123456789";
const FULL_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MISMATCH_INDEX_RE = /\((\d+)\)/;

/**
 * Half the per-correct-character timing step (the game adds 50ms per already
 * correct character). A candidate whose response time exceeds the position's
 * wrong-character baseline by at least this much matched one more character
 * than the rest -- the correct next character. Only the *difference* between
 * candidates at one position is used, so this is independent of the (unknown,
 * charisma/intelligence-dependent) base time.
 */
const TIMING_STEP_MARGIN = 25;

interface Cellular2gState {
  alphabet: string;
  length: number;
  knownPrefix: string;
  /** Next alphabet index to probe at the current position. */
  candidateIndex: number;
  /** Lowest response time seen at the current position (a wrong character). */
  baseline: number;
  /** The character with the highest response time seen at the current position. */
  bestChar: string | null;
  bestElapsed: number;
}

function freshPosition(): Pick<Cellular2gState, "candidateIndex" | "baseline" | "bestChar" | "bestElapsed"> {
  return { candidateIndex: 0, baseline: Infinity, bestChar: null, bestElapsed: -Infinity };
}

export const cellular2g: Solver<Cellular2gState> = {
  id: "2G_cellular",
  blind: false,

  start(details): Cellular2gState {
    const alphabet = details.passwordFormat === "numeric" ? NUMERIC_ALPHABET : FULL_ALPHABET;
    return { alphabet, length: details.passwordLength, knownPrefix: "", ...freshPosition() };
  },

  next(state, feedback) {
    const { alphabet, length } = state;
    let { knownPrefix, candidateIndex, baseline, bestChar, bestElapsed } = state;

    if (feedback !== null) {
      const result = advance(feedback, { knownPrefix, candidateIndex, baseline, bestChar, bestElapsed, alphabet, length });
      if ("giveUp" in result) return result;
      ({ knownPrefix, candidateIndex, baseline, bestChar, bestElapsed } = result);
    }

    if (knownPrefix.length >= length) {
      // Whole password confirmed correct but not accepted -- nothing left to try.
      return { giveUp: true, reason: "prefix complete but not accepted" };
    }

    const nextChar = alphabet[Math.min(candidateIndex, alphabet.length - 1)];
    const padLength = Math.max(length - knownPrefix.length - 1, 0);
    const attempt = knownPrefix + nextChar + alphabet[0].repeat(padLength);
    return { attempt, state: { alphabet, length, knownPrefix, candidateIndex, baseline, bestChar, bestElapsed } };
  },
};

type Position = Pick<Cellular2gState, "knownPrefix" | "candidateIndex" | "baseline" | "bestChar" | "bestElapsed" | "alphabet" | "length">;
type Advanced = Omit<Position, "alphabet" | "length">;

/** Fold one feedback record into the search: commit a character when the position resolves, else probe the next candidate. */
function advance(feedback: ParsedFeedback, p: Position): Advanced | { giveUp: true; reason: string } {
  const { alphabet, length, knownPrefix } = p;
  let { candidateIndex, baseline, bestChar, bestElapsed } = p;
  const commit = (char: string): Advanced => ({ knownPrefix: knownPrefix + char, ...freshPosition() });

  // 1) Preferred: the exact mismatch index from the log message (heartbleed on).
  const match = MISMATCH_INDEX_RE.exec(feedback.message);
  const idx = match ? Number(match[1]) : NaN;
  if (Number.isFinite(idx) && idx >= 0) {
    const prefixLen = Math.min(idx, length);
    if (prefixLen > knownPrefix.length) return { knownPrefix: feedback.passwordAttempted.slice(0, prefixLen), ...freshPosition() };
    candidateIndex++;
    if (candidateIndex >= alphabet.length) return { giveUp: true, reason: `alphabet exhausted at position ${knownPrefix.length}` };
    return { knownPrefix, candidateIndex, baseline, bestChar, bestElapsed };
  }

  // 2) No message index (no-heartbleed): relative timing over the position.
  if (feedback.elapsedMs !== undefined) {
    const probedChar = feedback.passwordAttempted[knownPrefix.length] ?? "";
    const t = feedback.elapsedMs;
    if (t < baseline) baseline = t;
    if (t > bestElapsed) {
      bestElapsed = t;
      bestChar = probedChar;
    }
    // A candidate standing a clear step above a wrong-character baseline is the
    // correct next character; commit it and move on.
    if (bestChar !== null && baseline !== Infinity && bestElapsed - baseline >= TIMING_STEP_MARGIN) {
      return commit(bestChar);
    }
    candidateIndex++;
    if (candidateIndex >= alphabet.length) {
      // Scanned the whole alphabet: take the strongest candidate if one stood
      // out at all, otherwise there is no usable timing signal here.
      if (bestChar !== null && bestElapsed > baseline) return commit(bestChar);
      return { giveUp: true, reason: `no timing signal at position ${knownPrefix.length}` };
    }
    return { knownPrefix, candidateIndex, baseline, bestChar, bestElapsed };
  }

  // 3) No usable channel at all.
  candidateIndex++;
  if (candidateIndex >= alphabet.length) return { giveUp: true, reason: `alphabet exhausted at position ${knownPrefix.length}` };
  return { knownPrefix, candidateIndex, baseline, bestChar, bestElapsed };
}
