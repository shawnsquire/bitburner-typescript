/**
 * Darknet Solver: Pr0verFl0
 *
 * BufferOverflow's `checkPassword` branch compares a "received" buffer
 * (the attempt, padded/truncated) against an "expected" buffer built from
 * the attempt itself once it's longer than the real password — so any
 * single character repeated `2 * passwordLength` times authenticates:
 * the first `passwordLength` characters (received) and the second
 * `passwordLength` characters (expected) are identical by construction.
 * One attempt.
 */
import { Solver, SolverDetails } from "/lib/darknet/solvers/types";

interface State {
  tried: boolean;
  attempt: string;
}

export const proverflo: Solver<State> = {
  id: "Pr0verFl0",
  blind: true,
  start: (details: SolverDetails) => ({ tried: false, attempt: "0".repeat(2 * details.passwordLength) }),
  next: (state) => {
    if (state.tried) return { giveUp: true, reason: "exhausted dictionary" };
    return { attempt: state.attempt, state: { ...state, tried: true } };
  },
};
