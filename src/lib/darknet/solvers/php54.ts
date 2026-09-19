/**
 * Darknet Solver: PHP 5.4
 *
 * SortedEchoVuln servers publish the password's digits sorted ascending as
 * `details.data` right from `start` -- no heartbleed needed to learn the
 * multiset. The checker then splits on length:
 *  - password.length < 5: EVERY attempt (any length) gets back the static
 *    sorted-digit hint, never RMS feedback -- this branch is blind:
 *    enumerate permutations of the known digit multiset (<=4! = 24),
 *    skipping any with a leading zero (the real password never has one,
 *    since it comes from `Number(...).toString()`).
 *  - password.length >= 5 and the attempt's length matches: `data` becomes
 *    "<sorted>; RMS Deviation:<x.xxx>", the root-mean-square per-position
 *    difference between our attempt's digits and the real ones.
 *
 * The RMS is exact on the game's side (only the printed string is rounded
 * to 3 decimals), so each position's true digit can be solved for
 * directly: probe that position with digit 0, then with digit 9, holding
 * every other position fixed between the two probes. Only the probed
 * position's squared-error term differs between the two RMS readings (the
 * rest cancels out), which gives a closed-form solve for the true digit.
 * Two probes per position, then one final submission of the assembled
 * guess -- `2*length + 1` attempts total, exact by construction.
 */
import { Solver, SolverDetails } from "/lib/darknet/solvers/types";

interface EnumerateState {
  mode: "enumerate";
  queue: string[];
  index: number;
}

interface PositionalState {
  mode: "positional";
  length: number;
  cand: number[];
  pos: number; // position currently being probed
  sub: "a" | "b"; // "a" = just probed with digit 0, "b" = just probed with digit 9
  sumSqA: number; // sum of squared errors from the "a" probe, for the current position
  done: boolean; // every position resolved; the next attempt is the final submission
}

type State = EnumerateState | PositionalState;

function uniquePermutations(digits: string[]): string[] {
  const sorted = [...digits].sort();
  const results = new Set<string>();
  const used = new Array(sorted.length).fill(false);
  const current: string[] = [];

  function backtrack(): void {
    if (current.length === sorted.length) {
      const candidate = current.join("");
      if (candidate.length === 1 || candidate[0] !== "0") results.add(candidate);
      return;
    }
    for (let i = 0; i < sorted.length; i++) {
      if (used[i]) continue;
      if (i > 0 && sorted[i] === sorted[i - 1] && !used[i - 1]) continue;
      used[i] = true;
      current.push(sorted[i]);
      backtrack();
      current.pop();
      used[i] = false;
    }
  }
  backtrack();
  return [...results];
}

function parseRmsd(data: string | undefined): number | null {
  if (!data) return null;
  const m = /RMS Deviation:([\d.]+)/.exec(data);
  return m ? Number(m[1]) : null;
}

export const php54: Solver<State> = {
  id: "PHP 5.4",
  blind: false,
  start: (details: SolverDetails): State => {
    const digits = details.data.split("").filter((c) => c >= "0" && c <= "9");
    if (details.passwordLength < 5) {
      return { mode: "enumerate", queue: uniquePermutations(digits), index: 0 };
    }
    const cand = digits.slice(0, details.passwordLength).map(Number);
    while (cand.length < details.passwordLength) cand.push(0);
    return { mode: "positional", length: details.passwordLength, cand, pos: 0, sub: "a", sumSqA: 0, done: false };
  },
  next: (state, feedback) => {
    if (state.mode === "enumerate") {
      if (state.index >= state.queue.length) return { giveUp: true, reason: "exhausted permutations" };
      const attempt = state.queue[state.index];
      return { attempt, state: { ...state, index: state.index + 1 } };
    }

    if (feedback === null) {
      // First probe: position 0 with digit 0.
      const cand = [...state.cand];
      cand[0] = 0;
      return { attempt: cand.join(""), state: { ...state, cand, pos: 0, sub: "a" } };
    }
    if (feedback.data === undefined) {
      return { giveUp: true, reason: "needs heartbleed" };
    }
    if (state.done) {
      return { giveUp: true, reason: "reconstruction mismatch" };
    }

    const rmsd = parseRmsd(feedback.data);
    if (rmsd === null) return { giveUp: true, reason: "unparseable RMS feedback" };
    const sumSq = rmsd * rmsd * state.length;

    if (state.sub === "a") {
      const cand = [...state.cand];
      cand[state.pos] = 9;
      return { attempt: cand.join(""), state: { ...state, cand, sub: "b", sumSqA: sumSq } };
    }

    // Solve for this position's true digit: diff = actual^2 - (9-actual)^2 = 18*actual - 81.
    const diff = state.sumSqA - sumSq;
    let actual = Math.round((diff + 81) / 18);
    if (actual < 0) actual = 0;
    if (actual > 9) actual = 9;

    const cand = [...state.cand];
    cand[state.pos] = actual;
    const nextPos = state.pos + 1;

    if (nextPos < state.length) {
      const probeCand = [...cand];
      probeCand[nextPos] = 0;
      return { attempt: probeCand.join(""), state: { ...state, cand, pos: nextPos, sub: "a" } };
    }

    return { attempt: cand.join(""), state: { ...state, cand, done: true } };
  },
};
