import { describe, it, expect } from "vitest";
import { octantVoxel } from "/lib/darknet/solvers/octant-voxel";
import { mathml } from "/lib/darknet/solvers/mathml";
import { primeTime } from "/lib/darknet/solvers/prime-time";
import { bellaCuore } from "/lib/darknet/solvers/bella-cuore";
import { accountsManager } from "/lib/darknet/solvers/accounts-manager";
import type { ParsedFeedback, SolverDetails } from "/lib/darknet/solvers/types";

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

describe("octant-voxel (OctantVoxel)", () => {
  it("decodes a known base,encoded integer", () => {
    // base 16, "2A" = 2*16 + 10 = 42
    const state = octantVoxel.start(details({ data: "16,2A" }));
    const step = octantVoxel.next(state, null);
    expect(step).toMatchObject({ attempt: "42" });
  });

  it("decodes a known base,encoded value with a fractional part", () => {
    // base 8, "12.4" = 1*8 + 2 + 4/8 = 10.5
    const state = octantVoxel.start(details({ data: "8,12.4" }));
    const step = octantVoxel.next(state, null);
    expect(step).toMatchObject({ attempt: "10.5" });
  });

  it("decodes with a fractional base", () => {
    // base 8.3, "1" = 1 * 8.3^0 = 1
    const state = octantVoxel.start(details({ data: "8.3,1" }));
    const step = octantVoxel.next(state, null);
    expect(step).toMatchObject({ attempt: "1" });
  });

  it("gives up if asked for a second attempt", () => {
    const state = octantVoxel.start(details({ data: "16,2A" }));
    const step = octantVoxel.next(state, { code: 401, passwordAttempted: "42", message: "Unauthorized" });
    expect(step).toMatchObject({ giveUp: true });
  });
});

describe("mathml (MathML)", () => {
  it.each([
    ["4 + 5 * 2", "14"],
    ["4 ➕ 5 ҳ 2", "14"], // unicode operator swap, difficulty > 12
    ["(1 + 2) * 3", "9"],
    ["10 ÷ 2 ➖ 1", "4"],
  ])("evaluates %j to %j", (expression, expected) => {
    const state = mathml.start(details({ data: expression }));
    const step = mathml.next(state, null);
    expect(step).toMatchObject({ attempt: expected });
  });

  it("strips a trailing code-injection suffix appended after a comma", () => {
    const expression = `4 + 5 , !globalThis.pwn3d && (globalThis.pwn3d=true) , ns.exit()`;
    const state = mathml.start(details({ data: expression }));
    const step = mathml.next(state, null);
    expect(step).toMatchObject({ attempt: "9" });
  });

  it("removes an injected ns.exit(), immediately after an opening paren", () => {
    const expression = "(ns.exit(),6 + 7) * 2";
    const state = mathml.start(details({ data: expression }));
    const step = mathml.next(state, null);
    expect(step).toMatchObject({ attempt: "26" });
  });
});

describe("prime-time (PrimeTime 2)", () => {
  it("extracts the large prime factor from a known product", () => {
    // 1069 (a game largePrimes entry) * 2 * 3 = 6414
    const state = primeTime.start(details({ data: "6414" }));
    const step = primeTime.next(state, null);
    expect(step).toMatchObject({ attempt: "1069" });
  });

  it("extracts the large prime factor when compounded with several small primes", () => {
    // 9859 * 2 * 2 * 3 * 5 * 7 = 4142780... use a smaller, easier-to-verify combo
    const largePrime = 9859;
    const target = largePrime * 2 * 3 * 5 * 7 * 11;
    const state = primeTime.start(details({ data: String(target) }));
    const step = primeTime.next(state, null);
    expect(step).toMatchObject({ attempt: String(largePrime) });
  });
});

describe("bella-cuore (BellaCuore)", () => {
  it("decodes a known roman numeral in the exact form (no comma in data)", () => {
    const state = bellaCuore.start(details({ data: "XLII" })); // 42
    const step = bellaCuore.next(state, null);
    expect(step).toMatchObject({ attempt: "42" });
  });

  it("decodes 'nulla' as 0", () => {
    const state = bellaCuore.start(details({ data: "nulla" }));
    const step = bellaCuore.next(state, null);
    expect(step).toMatchObject({ attempt: "0" });
  });

  it("binary-searches a range using scripted ALTUS/PARUM feedback", () => {
    const target = 57;
    // Roman-encoded range [0, 100]: "nulla,C"
    let state = bellaCuore.start(details({ data: "nulla,C" }));
    let feedback: ParsedFeedback | null = null;
    let lastAttempt: string | null = null;

    for (let i = 0; i < 12; i++) {
      const step = bellaCuore.next(state, feedback);
      if ("giveUp" in step) throw new Error(`gave up: ${step.reason}`);
      lastAttempt = step.attempt;
      state = step.state;
      const attempted = Number(step.attempt);
      if (attempted === target) break;
      const data = attempted > target ? "ALTUS NIMIS" : "PARUM BREVIS";
      feedback = { code: 401, passwordAttempted: step.attempt, message: "Unauthorized", data };
    }

    expect(lastAttempt).toBe(String(target));
  });

  it("gives up on a range retry when heartbleed data is unavailable", () => {
    let state = bellaCuore.start(details({ data: "nulla,C" }));
    const first = bellaCuore.next(state, null);
    if ("giveUp" in first) throw new Error("expected a first attempt");
    state = first.state;

    const step = bellaCuore.next(state, {
      code: 401,
      passwordAttempted: first.attempt,
      message: "Unauthorized",
    });
    expect(step).toMatchObject({ giveUp: true, reason: "needs heartbleed" });
  });
});

describe("accounts-manager (AccountsManager_4.2)", () => {
  it("converges on a known password using scripted Higher/Lower feedback", () => {
    const target = 83;
    let state = accountsManager.start(details({ passwordLength: 3 })); // range [0, 999]
    let feedback: ParsedFeedback | null = null;
    let lastAttempt: string | null = null;

    for (let i = 0; i < 12; i++) {
      const step = accountsManager.next(state, feedback);
      if ("giveUp" in step) throw new Error(`gave up: ${step.reason}`);
      lastAttempt = step.attempt;
      state = step.state;
      const attempted = Number(step.attempt);
      if (attempted === target) break;
      const data = attempted > target ? "Lower" : "Higher";
      feedback = { code: 401, passwordAttempted: step.attempt, message: "Unauthorized", data };
    }

    expect(lastAttempt).toBe(String(target));
  });

  it("falls back to counting up from 0 when heartbleed data is unavailable", () => {
    const target = 7;
    let state = accountsManager.start(details({ passwordLength: 2 })); // range [0, 99]
    let feedback: ParsedFeedback | null = null;
    let lastAttempt: string | null = null;

    for (let i = 0; i < 150; i++) {
      const step = accountsManager.next(state, feedback);
      if ("giveUp" in step) throw new Error(`gave up: ${step.reason}`);
      lastAttempt = step.attempt;
      state = step.state;
      if (Number(step.attempt) === target) break;
      // No-heartbleed synthetic feedback: no `data` field.
      feedback = { code: 401, passwordAttempted: step.attempt, message: "Unauthorized" };
    }

    expect(lastAttempt).toBe(String(target));
  });
});
