/**
 * Unit tests for the four adaptive/per-attempt-feedback darknet solvers
 * (NIL, RateMyPix.Auth, DeepGreen, 2G_cellular). These drive each solver
 * against SCRIPTED feedback built from small, hand-picked passwords using
 * the game's own per-model feedback formulas (ported here as plain
 * functions, mirroring `src/DarkNet/effects/authentication.ts` and
 * `src/DarkNet/utils/darknetAuthUtils.ts`) — no dependency on the game
 * checkout or the `tools/test-darknet.mjs` harness.
 */
import { describe, it, expect } from "vitest";
import { nil } from "/lib/darknet/solvers/nil";
import { rateMyPix } from "/lib/darknet/solvers/rate-my-pix";
import { deepGreen } from "/lib/darknet/solvers/deep-green";
import { cellular2g } from "/lib/darknet/solvers/cellular-2g";
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

// ─── Ported game feedback formulas (see doc comment above) ────────────────

function yesntData(password: string, attempt: string): string {
  return attempt
    .split("")
    .map((c, i) => (c === password[i] ? "yes" : "yesn't"))
    .join(",");
}

function pepperData(password: string, attempt: string): string {
  const exactChars = password.split("").map((c, i) => c === attempt[i]);
  const pepperRepresentation = exactChars.map((ok) => (ok ? "🌶️" : "")).join("") || "0";
  return `${pepperRepresentation}/${password.length}`;
}

function exactCount(password: string, attempt: string): number {
  return password.split("").filter((c, i) => c === attempt[i]).length;
}

function misplacedCount(password: string, attempt: string): number {
  const remainingPassword = password.split("").filter((c, i) => c !== attempt[i]);
  const remainingAttempt = attempt.split("").filter((c, i) => c !== password[i]);
  return remainingAttempt.filter((c, i) => {
    const isPresent = remainingPassword.includes(c);
    const countSoFar = remainingAttempt.slice(0, i).filter((p) => p === c).length;
    const countInPassword = remainingPassword.filter((p) => p === c).length;
    return isPresent && countSoFar < countInPassword;
  }).length;
}

function mastermindData(password: string, attempt: string): string {
  return `${exactCount(password, attempt)},${misplacedCount(password, attempt)}`;
}

function sharedCharsLength(password: string, attempt: string): number {
  for (let i = 0; i < password.length; i++) {
    if (password[i] !== attempt[i]) return i;
  }
  return password.length;
}

// ─── Generic driver: run a solver to completion against scripted feedback ─

/** Drives `solver` against a known `password`, using `feedbackFn` to build
 * the ParsedFeedback for each failed attempt. Returns the winning attempt,
 * or throws if the solver gives up or doesn't converge within `cap`. */
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

// ─── NIL (Yesn_t) ───────────────────────────────────────────────────────────

describe("nil (NIL)", () => {
  it("resolves a known password from scripted per-position yes/yesn't feedback", () => {
    const password = "581294";
    const d = details({ passwordLength: password.length, passwordFormat: "numeric" });
    const { attempt } = runToSuccess(nil, d, password, (pw, a) => ({ data: yesntData(pw, a) }));
    expect(attempt).toBe(password);
  });

  it("gives up without heartbleed data", () => {
    const d = details({ passwordLength: 4, passwordFormat: "numeric" });
    const state = nil.start(d);
    const first = nil.next(state, null);
    if ("giveUp" in first) throw new Error("expected an initial attempt");
    const noHeartbleed: ParsedFeedback = {
      code: 401,
      passwordAttempted: first.attempt,
      message: "Unauthorized",
      elapsedMs: 1000,
    };
    const second = nil.next(first.state, noHeartbleed);
    expect(second).toMatchObject({ giveUp: true, reason: "needs heartbleed" });
  });
});

// ─── RateMyPix.Auth (SpiceLevel) ────────────────────────────────────────────

describe("rate-my-pix (RateMyPix.Auth)", () => {
  it("counts pepper emoji occurrences by splitting, not by .length (multi-UTF-16 trap)", () => {
    // The pepper glyph "🌶️" is a surrogate pair plus a variation selector:
    // 3 UTF-16 code units. A naive `.length`-based count of "🌶️🌶️🌶️" (3
    // peppers) would read as 9, not 3. Drive two scan rounds for a
    // length-5 password: first establish a known-absent filler ("0"),
    // then feed a genuine 3-pepper count and check the THIRD attempt.
    // Correct parsing keeps countsSum at 3 (< 5), so the scan continues to
    // the next alphabet char ("2" repeated). A miscount of 9 (>= 5, and a
    // filler is already known) would instead jump straight to placement,
    // whose attempt is candidate-at-one-position + filler elsewhere — not
    // a single repeated character — making the two outcomes distinguishable.
    const d = details({ passwordLength: 5, passwordFormat: "numeric" });
    const first = nilLikeFirstAttempt(rateMyPix, d); // "00000"
    expect(first.attempt).toBe("00000");

    const secondStep = rateMyPix.next(first.state, {
      code: 401,
      passwordAttempted: first.attempt,
      message: "Not spicy enough",
      data: "0/5", // no exact matches for "0" -> "0" becomes the filler
    });
    if ("giveUp" in secondStep) throw new Error("expected another scan attempt");
    expect(secondStep.attempt).toBe("11111");

    const thirdStep = rateMyPix.next(secondStep.state, {
      code: 401,
      passwordAttempted: secondStep.attempt,
      message: "Not spicy enough",
      data: "🌶️🌶️🌶️/5",
    });
    if ("giveUp" in thirdStep) throw new Error("expected another scan attempt");
    expect(thirdStep.attempt).toBe("22222");
  });

  it("resolves a small password (with a repeated character) from scripted counts", () => {
    const password = "5131a";
    const d = details({ passwordLength: password.length, passwordFormat: "alphanumeric" });
    const { attempt } = runToSuccess(rateMyPix, d, password, (pw, a) => ({ data: pepperData(pw, a) }), 200);
    expect(attempt).toBe(password);
  });

  it("gives up without heartbleed data", () => {
    const d = details({ passwordLength: 4, passwordFormat: "numeric" });
    const first = nilLikeFirstAttempt(rateMyPix, d);
    const second = rateMyPix.next(first.state, {
      code: 401,
      passwordAttempted: first.attempt,
      message: "Unauthorized",
      elapsedMs: 1000,
    });
    expect(second).toMatchObject({ giveUp: true, reason: "needs heartbleed" });
  });
});

/** Convenience: get a solver's first (feedback === null) attempt/state. */
function nilLikeFirstAttempt<S>(solver: Solver<S>, d: SolverDetails): { attempt: string; state: S } {
  const state = solver.start(d);
  const step = solver.next(state, null);
  if ("giveUp" in step) throw new Error("expected an initial attempt");
  return step;
}

// ─── DeepGreen (MastermindHint) ─────────────────────────────────────────────

describe("deep-green (DeepGreen)", () => {
  it("resolves a small password from scripted exact,misplaced feedback", () => {
    const password = "3a7a1";
    const d = details({ passwordLength: password.length, passwordFormat: "alphanumeric" });
    const { attempt } = runToSuccess(deepGreen, d, password, (pw, a) => ({ data: mastermindData(pw, a) }), 200);
    expect(attempt).toBe(password);
  });

  it("gives up without heartbleed data", () => {
    const d = details({ passwordLength: 4, passwordFormat: "numeric" });
    const first = nilLikeFirstAttempt(deepGreen, d);
    const second = deepGreen.next(first.state, {
      code: 401,
      passwordAttempted: first.attempt,
      message: "Unauthorized",
      elapsedMs: 1000,
    });
    expect(second).toMatchObject({ giveUp: true, reason: "needs heartbleed" });
  });
});

// ─── 2G_cellular (TimingAttack) ─────────────────────────────────────────────

describe("cellular-2g (2G_cellular)", () => {
  it("builds a password from scripted mismatch-index messages", () => {
    const password = "48213";
    const d = details({ passwordLength: password.length, passwordFormat: "numeric" });
    const { attempt } = runToSuccess(
      cellular2g,
      d,
      password,
      (pw, a) => {
        const idx = sharedCharsLength(pw, a);
        return { message: `Found a mismatch while checking each character (${idx})` };
      },
      1000,
    );
    expect(attempt).toBe(password);
  });

  it("builds a password from relative elapsedMs alone, independent of the base (no usable message)", () => {
    const password = "70951";
    const d = details({ passwordLength: password.length, passwordFormat: "numeric" });
    // Base of 2500ms, NOT 1000: in-game the response-time base depends on
    // charisma/intelligence, so the solver may only use the +50ms-per-correct
    // -character difference between candidates, never an absolute formula.
    const { attempt } = runToSuccess(
      cellular2g,
      d,
      password,
      (pw, a) => ({
        message: "Unauthorized",
        elapsedMs: 2500 + sharedCharsLength(pw, a) * 50,
      }),
      1000,
    );
    expect(attempt).toBe(password);
  });
});
