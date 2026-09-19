/**
 * Darknet Solver: NIL (Yesn_t)
 *
 * Not blind. The game's `Yesn_t` branch of `checkPassword`
 * (`src/DarkNet/effects/authentication.ts`) reports `feedback.data` as a
 * comma-joined `"yes"`/`"yesn't"` token per position: `attemptedPassword[i]
 * === password[i] ? "yes" : "yesn't"`. Positions are independent, so every
 * attempt probes ALL still-unresolved positions with the same candidate
 * character at once: whichever positions answer `"yes"` are locked in to
 * that character, and the candidate advances through the alphabet for the
 * rest. Once every position is resolved, the resolved string itself is
 * submitted as the final attempt (the exact-match branch in `checkPassword`
 * fires before the per-model branch, so that attempt always succeeds).
 *
 * The alphabet is `details.passwordFormat === "numeric" ? "0-9" :
 * "0-9a-zA-Z"` (the game's `getPassword` draws from `numbers` then, when
 * `allowLetters`, `letters = lowercase + uppercase`). One full alphabet pass
 * resolves every position (each position's real character is tried exactly
 * once), so this takes at most `alphabet.length + 1` attempts — well under
 * the 70 cap for the largest (62-char) alphabet.
 *
 * If heartbleed is unavailable, `feedback.data` is undefined on every retry
 * and the solver gives up (`"needs heartbleed"`) — there is no way to learn
 * per-position correctness blind.
 */
import { Solver } from "/lib/darknet/solvers/types";

const NUMERIC_ALPHABET = "0123456789";
const FULL_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

interface NilState {
  alphabet: string;
  length: number;
  /** Resolved character per position, or null while still unknown. */
  resolved: (string | null)[];
  /** Index into `alphabet` used to fill every unresolved position in the
   * attempt this state is about to produce (or just produced). */
  candidateIndex: number;
}

export const nil: Solver<NilState> = {
  id: "NIL",
  blind: false,

  start(details): NilState {
    const alphabet = details.passwordFormat === "numeric" ? NUMERIC_ALPHABET : FULL_ALPHABET;
    return {
      alphabet,
      length: details.passwordLength,
      resolved: new Array(details.passwordLength).fill(null) as (string | null)[],
      candidateIndex: 0,
    };
  },

  next(state, feedback) {
    let { resolved, candidateIndex } = state;
    const { alphabet } = state;

    if (feedback !== null) {
      if (feedback.data === undefined) {
        return { giveUp: true, reason: "needs heartbleed" };
      }
      const tokens = feedback.data.split(",");
      const candidate = alphabet[candidateIndex];
      resolved = resolved.map((r, i) => (r === null && tokens[i] === "yes" ? candidate : r));

      if (resolved.every((r) => r !== null)) {
        return { attempt: resolved.join(""), state: { ...state, resolved } };
      }

      candidateIndex++;
      if (candidateIndex >= alphabet.length) {
        return { giveUp: true, reason: "alphabet exhausted without resolving every position" };
      }
    }

    const attempt = resolved.map((r) => r ?? alphabet[candidateIndex]).join("");
    return { attempt, state: { ...state, resolved, candidateIndex } };
  },
};
