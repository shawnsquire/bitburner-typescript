/**
 * Darknet Solver: 2G_cellular (TimingAttack)
 *
 * Not blind, and the one solver that MUST also pass with heartbleed
 * unavailable — it never needs `feedback.data`.
 *
 * The game's `TimingAttack` branch of `checkPassword`
 * (`src/DarkNet/effects/authentication.ts`) checks the password
 * character-by-character and reports two channels on failure:
 *  - `feedback.message`: `"Found a mismatch while checking each character
 *    (<i>)"`, where `i` is the index of the first character that didn't
 *    match — so characters `0..i-1` of the attempt are confirmed correct.
 *  - `feedback.elapsedMs`: the response time. `tools/test-darknet.mjs`
 *    computes it as `1000 + correctPrefixLength * 50` at 1 thread (the game
 *    UI's own formula, in `PasswordPrompt.tsx`, is different — 500 + 150 *
 *    sharedChars — so this constant pair is a harness/spec convention, not
 *    something read back out of game source); `correctPrefixLength =
 *    Math.round((elapsedMs - 1000) / 50)` recovers the same prefix length
 *    even with no `data` at all — which is exactly why this solver still
 *    works with heartbleed off (the harness's synthetic no-heartbleed
 *    feedback always carries `elapsedMs`). If the live agent ever times its
 *    own `ns.authenticate` call with a different constant pair, only the
 *    no-heartbleed fallback would need updating — the message-index path
 *    above is unaffected and is always preferred when it parses.
 *
 * The message index is preferred when it parses; `elapsedMs` is the
 * fallback. Builds the password prefix by prefix: keep the confirmed
 * prefix, try each alphabet character at the next position (padding the
 * remainder to full length with an arbitrary character), and once the
 * confirmed-correct length grows, lock in whatever prefix the attempt
 * actually confirmed (sliced straight from `passwordAttempted`, so any
 * lucky extra matches in the padding are captured too) and move on. Worst
 * case, every position needs a full alphabet pass: `alphabet.length *
 * passwordLength` attempts, exactly the harness's `62 * passwordLength`
 * cap. The final correct character at the last position makes the attempt
 * equal the whole password, which the exact-match branch in
 * `checkPassword` accepts directly — no separate submission needed.
 */
import { ParsedFeedback, Solver } from "/lib/darknet/solvers/types";

const NUMERIC_ALPHABET = "0123456789";
const FULL_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MISMATCH_INDEX_RE = /\((\d+)\)/;

/** Length of the confirmed-correct prefix of the previous attempt, from
 * whichever channel is available: the mismatch-index message, or —
 * whenever that doesn't parse (including no-heartbleed mode, where the
 * message is just "Unauthorized") — the response time. */
function derivePrefixLen(feedback: ParsedFeedback, length: number): number {
  const match = MISMATCH_INDEX_RE.exec(feedback.message);
  if (match) {
    const idx = Number(match[1]);
    if (Number.isFinite(idx) && idx >= 0) return Math.min(idx, length);
  }
  if (feedback.elapsedMs !== undefined) {
    const derived = Math.round((feedback.elapsedMs - 1000) / 50);
    if (Number.isFinite(derived)) return Math.min(Math.max(derived, 0), length);
  }
  return 0;
}

interface Cellular2gState {
  alphabet: string;
  length: number;
  knownPrefix: string;
  candidateIndex: number;
}

export const cellular2g: Solver<Cellular2gState> = {
  id: "2G_cellular",
  blind: false,

  start(details): Cellular2gState {
    const alphabet = details.passwordFormat === "numeric" ? NUMERIC_ALPHABET : FULL_ALPHABET;
    return { alphabet, length: details.passwordLength, knownPrefix: "", candidateIndex: 0 };
  },

  next(state, feedback) {
    const { alphabet, length } = state;
    let { knownPrefix, candidateIndex } = state;

    if (feedback !== null) {
      const prefixLen = derivePrefixLen(feedback, length);
      if (prefixLen > knownPrefix.length) {
        knownPrefix = feedback.passwordAttempted.slice(0, prefixLen);
        candidateIndex = 0;
      } else {
        candidateIndex++;
        if (candidateIndex >= alphabet.length) {
          return { giveUp: true, reason: `alphabet exhausted at position ${knownPrefix.length}` };
        }
      }
    }

    const idx = Math.min(candidateIndex, alphabet.length - 1);
    const nextChar = alphabet[idx];
    const padLength = Math.max(length - knownPrefix.length - 1, 0);
    const attempt = knownPrefix + nextChar + alphabet[0].repeat(padLength);
    return { attempt, state: { alphabet, length, knownPrefix, candidateIndex } };
  },
};
