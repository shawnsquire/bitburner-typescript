/**
 * Darknet Solver: OpenWebAccessPoint
 *
 * packetSniffer servers never populate `details.data`; heartbleed instead
 * returns a fresh noisy packet capture in `feedback.data` after every
 * FAILED attempt (the game's `capturePackets`, gated on difficulty):
 *  - difficulty <= 16: the capture contains `" <host>:<password> "`
 *    verbatim (spaces on both sides), `host === details.host`.
 *  - difficulty > 16: the capture contains the bare password (exactly
 *    `details.passwordLength` characters) spliced at a random offset into
 *    ~50 chars of alphanumeric noise -- a different splice and noise on
 *    every capture.
 *
 * A throwaway first attempt triggers the first capture (the attempted
 * password is irrelevant to what gets captured). From there, either
 * regex-extract the host:password pair directly, or (bare mode) collect
 * captures and intersect their length-N substrings: the real password's
 * substring is present in every capture, so once exactly one candidate
 * survives the intersection, it must be the password.
 */
import { Solver, SolverDetails } from "/lib/darknet/solvers/types";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function substringsOfLength(s: string, len: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + len <= s.length; i++) out.add(s.slice(i, i + len));
  return out;
}

interface State {
  host: string;
  passwordLength: number;
  bareMode: boolean;
  candidates: Set<string> | null;
  submitted: boolean;
}

export const openWebAccessPoint: Solver<State> = {
  id: "OpenWebAccessPoint",
  blind: false,
  start: (details: SolverDetails): State => ({
    host: details.host,
    passwordLength: details.passwordLength,
    bareMode: details.difficulty > 16,
    candidates: null,
    submitted: false,
  }),
  next: (state, feedback) => {
    if (feedback === null) {
      // Throwaway attempt -- just here to trigger the first capture.
      return { attempt: "0", state };
    }
    if (feedback.data === undefined) {
      return { giveUp: true, reason: "needs heartbleed" };
    }
    if (state.submitted) {
      return { giveUp: true, reason: "capture extraction failed" };
    }

    const capture = feedback.data;

    if (!state.bareMode) {
      const re = new RegExp(`\\s${escapeRegExp(state.host)}:(\\S+)\\s`);
      const m = re.exec(capture);
      if (m) return { attempt: m[1], state: { ...state, submitted: true } };
      return { attempt: "0", state }; // this capture didn't have it -- try again
    }

    const found = substringsOfLength(capture, state.passwordLength);
    let candidates: Set<string>;
    if (state.candidates === null) {
      candidates = found;
    } else {
      candidates = new Set([...found].filter((s) => state.candidates!.has(s)));
    }

    if (candidates.size === 1) {
      const only = [...candidates][0];
      return { attempt: only, state: { ...state, candidates, submitted: true } };
    }
    return { attempt: "0", state: { ...state, candidates } };
  },
};
