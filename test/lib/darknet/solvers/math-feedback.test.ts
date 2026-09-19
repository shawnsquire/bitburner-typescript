/**
 * Unit tests for the five math-feedback darknet solvers (Factori-Os,
 * BigMo%od, PHP 5.4, KingOfTheHill, OpenWebAccessPoint). These drive each
 * solver against SCRIPTED feedback built from small, hand-picked passwords
 * using the game's own per-model feedback formulas (ported here as plain
 * functions, mirroring `src/DarkNet/effects/authentication.ts` and
 * `src/DarkNet/models/packetSniffing.ts`) — no dependency on the game
 * checkout or the `tools/test-darknet.mjs` harness (that harness runs the
 * real generators/checker and is the authoritative pass/fail signal; these
 * tests just pin the reconstruction mechanism against known inputs).
 */
import { describe, it, expect } from "vitest";
import { factoriOs } from "/lib/darknet/solvers/factori-os";
import { bigMood } from "/lib/darknet/solvers/big-mood";
import { php54 } from "/lib/darknet/solvers/php54";
import { kingOfTheHill } from "/lib/darknet/solvers/king-of-the-hill";
import { openWebAccessPoint } from "/lib/darknet/solvers/open-web-access-point";
import type { ParsedFeedback, Solver, SolverDetails } from "/lib/darknet/solvers/types";

/** Minimal complete SolverDetails, overridable per-test. */
function details(overrides: Partial<SolverDetails> = {}): SolverDetails {
  return {
    host: "dn-test",
    modelId: "test",
    passwordHint: "",
    data: "",
    passwordLength: 0,
    passwordFormat: "numeric",
    difficulty: 1,
    requiredCharismaSkill: 0,
    ...overrides,
  };
}

/** Convenience: get a solver's first (feedback === null) attempt/state. */
function firstAttempt<S>(solver: Solver<S>, d: SolverDetails): { attempt: string; state: S } {
  const state = solver.start(d);
  const step = solver.next(state, null);
  if ("giveUp" in step) throw new Error("expected an initial attempt");
  return step;
}

/** Drives `solver` against a known `password`, using `feedbackFn` to build
 * the ParsedFeedback for each failed attempt. Returns the winning attempt
 * and how many attempts it took, or throws if the solver gives up or
 * doesn't converge within `cap`. */
function runToSuccess<S>(
  solver: Solver<S>,
  d: SolverDetails,
  password: string,
  feedbackFn: (password: string, attempt: string) => Partial<ParsedFeedback>,
  cap = 300,
): { attempt: string; rounds: number } {
  let state = solver.start(d);
  let feedback: ParsedFeedback | null = null;
  for (let i = 0; i < cap; i++) {
    const step = solver.next(state, feedback);
    if ("giveUp" in step) throw new Error(`solver gave up: ${step.reason}`);
    if (step.attempt === password) return { attempt: step.attempt, rounds: i + 1 };
    state = step.state;
    feedback = {
      code: 401,
      passwordAttempted: step.attempt,
      message: "that wasn't right",
      ...feedbackFn(password, step.attempt),
    };
  }
  throw new Error(`solver did not converge within ${cap} attempts`);
}

function expectGivesUpWithoutHeartbleed<S>(solver: Solver<S>, d: SolverDetails): void {
  const first = firstAttempt(solver, d);
  const noHeartbleed: ParsedFeedback = {
    code: 401,
    passwordAttempted: first.attempt,
    message: "Unauthorized",
    elapsedMs: 1000,
  };
  const second = solver.next(first.state, noHeartbleed);
  expect(second).toMatchObject({ giveUp: true, reason: "needs heartbleed" });
}

// ─── Factori-Os (divisibilityTest) ─────────────────────────────────────────

/** Mirrors the game's divisibilityTest checker branch exactly. */
function divisibilityData(password: bigint, attempt: string): string {
  if (attempt === "" || !/^\d+$/.test(attempt)) return "false";
  const divisor = BigInt(attempt);
  if (divisor === 0n) return "false";
  return (password % divisor === 0n).toString();
}

describe("factori-os (Factori-Os)", () => {
  it("reconstructs a product of small primes from scripted true/false divisibility", () => {
    // 2^3 * 3 * 97 -- exercises both prime-power detection (2^3) and
    // single-hit primes (3, 97), difficulty <= 12 so no large-prime phase.
    const password = 2n ** 3n * 3n * 97n;
    const d = details({ difficulty: 8 });
    const { attempt } = runToSuccess(factoriOs, d, password.toString(), (_pw, a) => ({
      data: divisibilityData(password, a),
    }));
    expect(BigInt(attempt)).toBe(password);
  });

  it("also recovers a largePrimes factor once difficulty > 12", () => {
    // Includes 1069, the first entry of the game's largePrimes list.
    const password = 2n * 5n * 1069n;
    const d = details({ difficulty: 13 });
    const { attempt } = runToSuccess(factoriOs, d, password.toString(), (_pw, a) => ({
      data: divisibilityData(password, a),
    }));
    expect(BigInt(attempt)).toBe(password);
  });

  it("gives up without heartbleed data", () => {
    expectGivesUpWithoutHeartbleed(factoriOs, details({ difficulty: 8 }));
  });
});

// ─── BigMo%od (tripleModulo) ────────────────────────────────────────────────

/** Mirrors the game's tripleModulo checker branch exactly. */
function tripleModuloData(password: string, attempt: string): string {
  const pw = Number(password);
  const n = Number(attempt);
  const result = (pw % n) % (((n - 1) % 32) + 1);
  return result.toString();
}

describe("big-mood (BigMo%od)", () => {
  it("CRT-reconstructs a password from scripted (pw%n)%(n%32) residues", () => {
    const password = "84217";
    const d = details({ passwordLength: password.length });
    const { attempt, rounds } = runToSuccess(bigMood, d, password, (pw, a) => ({ data: tripleModuloData(pw, a) }), 20);
    expect(attempt).toBe(password);
    expect(rounds).toBe(12); // 11 probes + 1 CRT-reconstructed submission
  });

  it("gives up without heartbleed data", () => {
    expectGivesUpWithoutHeartbleed(bigMood, details({ passwordLength: 5 }));
  });
});

// ─── PHP 5.4 (SortedEchoVuln) ───────────────────────────────────────────────

function sortedDigits(password: string): string {
  return password.split("").sort().join("");
}

/** Mirrors the game's SortedEchoVuln checker branch exactly. */
function rmsdData(password: string, attempt: string): string {
  const sorted = sortedDigits(password);
  if (password.length < 5 || attempt.length !== password.length) return sorted;
  let squaredError = 0;
  for (let i = 0; i < attempt.length; i++) {
    squaredError += (Number(attempt[i]) - Number(password[i])) ** 2;
  }
  const rmsd = Math.sqrt(squaredError / attempt.length);
  return `${sorted}; RMS Deviation:${rmsd.toFixed(3)}`;
}

describe("php54 (PHP 5.4)", () => {
  it("hill-climbs to a known permutation from scripted RMS deviation (length >= 5)", () => {
    const password = "83052";
    const d = details({ passwordLength: password.length, data: sortedDigits(password) });
    const { attempt, rounds } = runToSuccess(php54, d, password, (pw, a) => ({ data: rmsdData(pw, a) }), 60);
    expect(attempt).toBe(password);
    expect(rounds).toBe(2 * password.length + 1); // two probes per position, plus the final submission
  });

  it("enumerates permutations for a known password (length < 5), skipping leading zero", () => {
    const password = "203"; // digits {0,2,3}; "023"/"032" must never be attempted
    const d = details({ passwordLength: password.length, data: sortedDigits(password) });
    const { attempt } = runToSuccess(php54, d, password, (pw, a) => ({ data: rmsdData(pw, a) }), 30);
    expect(attempt).toBe(password);
  });

  it("the length < 5 branch never attempts a leading zero", () => {
    const password = "203";
    const d = details({ passwordLength: password.length, data: sortedDigits(password) });
    let state = php54.start(d);
    let feedback: ParsedFeedback | null = null;
    for (let i = 0; i < 30; i++) {
      const step = php54.next(state, feedback);
      if ("giveUp" in step) break;
      expect(step.attempt[0]).not.toBe("0");
      if (step.attempt === password) break;
      state = step.state;
      feedback = { code: 401, passwordAttempted: step.attempt, message: "hint", data: rmsdData(password, step.attempt) };
    }
  });

  it("gives up without heartbleed data (length >= 5)", () => {
    const password = "83052";
    expectGivesUpWithoutHeartbleed(php54, details({ passwordLength: password.length, data: sortedDigits(password) }));
  });
});

// ─── KingOfTheHill (globalMaxima) ──────────────────────────────────────────

/** A single clean Gaussian hill -- the game's own simplified near-field
 * formula, which is what the full landscape always reduces to when there's
 * only one hill (low difficulty). Exercises the same climb-then-exact-solve
 * mechanism the full multi-hill harness (`test:darknet`) validates against
 * the real generator/checker. */
function singleHillData(password: string, attempt: string, width: number): string {
  const p = Number(password);
  const x = Number(attempt);
  const altitude = 10000 * Math.exp(-(((x - p) / width) ** 2));
  return altitude.toString();
}

describe("king-of-the-hill (KingOfTheHill)", () => {
  it("climbs to the peak of a scripted single-Gaussian altitude function", () => {
    const password = "4832";
    const width = 10 ** Math.max(password.length - 2, 0) + 1;
    const d = details({ passwordLength: password.length, difficulty: 1 });
    const { attempt } = runToSuccess(kingOfTheHill, d, password, (pw, a) => ({ data: singleHillData(pw, a, width) }), 60);
    expect(attempt).toBe(password);
  });

  it("gives up without heartbleed data", () => {
    expectGivesUpWithoutHeartbleed(kingOfTheHill, details({ passwordLength: 4, difficulty: 1 }));
  });
});

// ─── OpenWebAccessPoint (packetSniffer) ────────────────────────────────────

describe("open-web-access-point (OpenWebAccessPoint)", () => {
  it("extracts the password from a '<host>:<password>' capture (difficulty <= 16)", () => {
    const host = "n00dles";
    const password = "s3cr3t";
    const d = details({ host, passwordLength: password.length, difficulty: 10 });

    const state = openWebAccessPoint.start(d);
    const first = openWebAccessPoint.next(state, null);
    if ("giveUp" in first) throw new Error("expected a throwaway first attempt");

    const noise = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const capture = noise.slice(0, 12) + ` ${host}:${password} ` + noise.slice(12);
    const second = openWebAccessPoint.next(first.state, {
      code: 401,
      passwordAttempted: first.attempt,
      message: "hint",
      data: capture,
    });
    if ("giveUp" in second) throw new Error("expected an extracted attempt");
    expect(second.attempt).toBe(password);
  });

  it("extracts the password from repeated bare-password captures (difficulty > 16)", () => {
    const password = "k9f2";
    const d = details({ passwordLength: password.length, difficulty: 20 });

    const state = openWebAccessPoint.start(d);
    const first = openWebAccessPoint.next(state, null);
    if ("giveUp" in first) throw new Error("expected a throwaway first attempt");

    // Two independent captures, password spliced at different offsets into
    // filler that shares no substring with it -- the intersection of their
    // length-4 substrings is exactly the password.
    const capture1 = "mmmmmmmmmm" + password + "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const capture2 = "qqqqqqqqqqqqqqqqqqqq" + password + "wwwwwwwwwwwwwwwwwwww";

    const second = openWebAccessPoint.next(first.state, {
      code: 401,
      passwordAttempted: first.attempt,
      message: "hint",
      data: capture1,
    });
    if ("giveUp" in second) throw new Error("expected another throwaway attempt");
    expect(second.attempt).not.toBe(password); // not narrowed to a single candidate yet

    const third = openWebAccessPoint.next(second.state, {
      code: 401,
      passwordAttempted: second.attempt,
      message: "hint",
      data: capture2,
    });
    if ("giveUp" in third) throw new Error("expected the extracted attempt");
    expect(third.attempt).toBe(password);
  });

  it("gives up without heartbleed data", () => {
    expectGivesUpWithoutHeartbleed(openWebAccessPoint, details({ passwordLength: 4, difficulty: 10 }));
  });
});
