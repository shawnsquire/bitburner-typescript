/**
 * Darknet Solver: DeskMemo_3.1
 *
 * EchoVuln servers leak the password directly in the static hint: the
 * game's `getEchoVulnConfig` builds `hint = \`${template} ${password}\``
 * from a set of templates ("The password is", "The PIN is", ...) followed
 * by a 3-digit numeric password. The password is always the last
 * whitespace-separated token of the hint. One attempt.
 */
import { Solver, SolverDetails } from "/lib/darknet/solvers/types";

interface State {
  tried: boolean;
  password: string;
}

function lastToken(hint: string): string {
  const tokens = hint.trim().split(/\s+/);
  return tokens[tokens.length - 1] ?? "";
}

export const deskMemo: Solver<State> = {
  id: "DeskMemo_3.1",
  blind: true,
  start: (details: SolverDetails) => ({ tried: false, password: lastToken(details.passwordHint) }),
  next: (state) => {
    if (state.tried) return { giveUp: true, reason: "exhausted dictionary" };
    return { attempt: state.password, state: { ...state, tried: true } };
  },
};
