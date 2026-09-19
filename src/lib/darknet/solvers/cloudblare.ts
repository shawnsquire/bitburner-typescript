/**
 * Darknet Solver: CloudBlare(tm)
 *
 * Captcha servers build `passwordHintData` by interleaving random filler
 * characters between the digits of a purely-numeric password (see the
 * game's `getCaptchaConfig` / `getFillerChars`). The filler set
 * (`/[]╬╸.-()*~:;><#\`) contains no digits, so stripping every non-digit
 * character from `data` recovers the password exactly. One attempt.
 */
import { Solver, SolverDetails } from "/lib/darknet/solvers/types";

interface State {
  tried: boolean;
  password: string;
}

function stripFiller(data: string): string {
  return data.replace(/[^0-9]/g, "");
}

export const cloudblare: Solver<State> = {
  id: "CloudBlare(tm)",
  blind: true,
  start: (details: SolverDetails) => ({ tried: false, password: stripFiller(details.data) }),
  next: (state) => {
    if (state.tried) return { giveUp: true, reason: "exhausted dictionary" };
    return { attempt: state.password, state: { ...state, tried: true } };
  },
};
