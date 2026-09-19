/**
 * Darknet Solver: AccountsManager_4.2 (GuessNumber)
 *
 * Not blind. `details.passwordHint` says "between 0 and <10^len>" where
 * `10^len` is exactly `10 ** details.passwordLength`, so the password lives
 * in `[0, 10 ** details.passwordLength - 1]`. Binary-search that range:
 * after each failed attempt, the game's `checkPassword` GuessNumber branch
 * (`src/DarkNet/effects/authentication.ts`) reports `feedback.data` as
 * `"Lower"` (`Number(attempt) > Number(password)`, i.e. the attempt was too
 * HIGH — go lower) or `"Higher"` (attempt too LOW — go higher).
 *
 * If heartbleed is unavailable, `feedback.data` is undefined on every retry:
 * fall back to counting up from 0. The password max is small (about 110 at
 * difficulty 30), well within the harness's 150-attempt no-heartbleed cap.
 */
import { Solver } from "/lib/darknet/solvers/types";

interface AccountsManagerState {
  lo: number;
  hi: number;
  nextCount: number;
}

export const accountsManager: Solver<AccountsManagerState> = {
  id: "AccountsManager_4.2",
  blind: false,

  start(details): AccountsManagerState {
    const hi = Math.max(0, 10 ** details.passwordLength - 1);
    return { lo: 0, hi, nextCount: 0 };
  },

  next(state, feedback) {
    // First attempt (no feedback yet): use the binary-search midpoint of the
    // full range. Whether heartbleed is available is only revealed once this
    // attempt fails.
    if (feedback === null) {
      const mid = Math.floor((state.lo + state.hi) / 2);
      return { attempt: String(mid), state };
    }

    // No heartbleed: fall back to counting up from 0.
    if (feedback.data === undefined) {
      const attempt = state.nextCount;
      return { attempt: String(attempt), state: { ...state, nextCount: attempt + 1 } };
    }

    let { lo, hi } = state;
    const attempted = Number(feedback.passwordAttempted);
    if (feedback.data === "Lower") {
      hi = attempted - 1;
    } else if (feedback.data === "Higher") {
      lo = attempted + 1;
    }

    if (lo > hi) {
      return { giveUp: true, reason: "search range exhausted" };
    }
    const mid = Math.floor((lo + hi) / 2);
    return { attempt: String(mid), state: { lo, hi, nextCount: state.nextCount } };
  },
};
