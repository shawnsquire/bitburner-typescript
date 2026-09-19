/**
 * Darknet Solver: 110100100
 *
 * BinaryEncodedFeedback servers publish `passwordHintData` as
 * space-separated 8-bit binary groups, one per password character (see the
 * game's `getBinaryEncodedConfig`). Decode each group with
 * `String.fromCharCode(parseInt(group, 2))` and concatenate. One attempt.
 */
import { Solver, SolverDetails } from "/lib/darknet/solvers/types";

interface State {
  tried: boolean;
  password: string;
}

function decodeBinary(data: string): string {
  return data
    .trim()
    .split(/\s+/)
    .filter((group) => group.length > 0)
    .map((group) => String.fromCharCode(parseInt(group, 2)))
    .join("");
}

export const binary: Solver<State> = {
  id: "110100100",
  blind: true,
  start: (details: SolverDetails) => ({ tried: false, password: decodeBinary(details.data) }),
  next: (state) => {
    if (state.tried) return { giveUp: true, reason: "exhausted dictionary" };
    return { attempt: state.password, state: { ...state, tried: true } };
  },
};
