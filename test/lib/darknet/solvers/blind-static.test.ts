import { describe, it, expect } from "vitest";
import { zeroLogon } from "/lib/darknet/solvers/zero-logon";
import { deskMemo } from "/lib/darknet/solvers/desk-memo";
import { freshInstall } from "/lib/darknet/solvers/fresh-install";
import { laika } from "/lib/darknet/solvers/laika";
import { eurozone } from "/lib/darknet/solvers/eurozone";
import { topPass } from "/lib/darknet/solvers/top-pass";
import { cloudblare } from "/lib/darknet/solvers/cloudblare";
import { binary } from "/lib/darknet/solvers/binary";
import { ordoXenos } from "/lib/darknet/solvers/ordo-xenos";
import { proverflo } from "/lib/darknet/solvers/proverflo";
import type { Solver, SolverDetails } from "/lib/darknet/solvers/types";

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

/** Drives a blind solver to completion, collecting every attempt it emits. */
function collectAttempts<S>(solver: Solver<S>, d: SolverDetails, cap = 200): string[] {
  const attempts: string[] = [];
  let state = solver.start(d);
  for (let i = 0; i < cap; i++) {
    const step = solver.next(state, null);
    if ("giveUp" in step) return attempts;
    attempts.push(step.attempt);
    state = step.state;
  }
  throw new Error("solver did not give up within cap");
}

describe("zero-logon (ZeroLogon)", () => {
  it("attempts the empty string first", () => {
    const state = zeroLogon.start(details());
    const step = zeroLogon.next(state, null);
    expect(step).toMatchObject({ attempt: "" });
  });

  it("gives up after the one attempt", () => {
    const attempts = collectAttempts(zeroLogon, details());
    expect(attempts).toEqual([""]);
  });
});

describe("desk-memo (DeskMemo_3.1)", () => {
  it.each([
    ["The password is 927", "927"],
    ["The PIN is 004", "004"],
    ["Remember to use 512", "512"],
    ["It's set to 8", "8"],
    ["The key is 372", "372"],
    ["The secret is 019", "019"],
  ])("extracts the last token from %j", (hint, expected) => {
    const state = deskMemo.start(details({ passwordHint: hint }));
    const step = deskMemo.next(state, null);
    expect(step).toMatchObject({ attempt: expected });
  });
});

describe("fresh-install (FreshInstall_1.0)", () => {
  it("emits the whole default-settings dictionary in order", () => {
    const attempts = collectAttempts(freshInstall, details());
    expect(attempts).toEqual(["admin", "password", "0000", "12345"]);
  });
});

describe("laika (Laika4)", () => {
  it("emits the whole dog-name dictionary in order", () => {
    const attempts = collectAttempts(laika, details());
    expect(attempts).toEqual(["fido", "spot", "rover", "max"]);
  });
});

describe("eurozone (EuroZone Free)", () => {
  it("emits all 27 EU countries, including the tricky ones", () => {
    const attempts = collectAttempts(eurozone, details());
    expect(attempts).toHaveLength(27);
    expect(attempts).toContain("Republic of Cyprus");
    expect(attempts).toContain("Czech Republic");
    expect(new Set(attempts).size).toBe(27);
  });
});

describe("top-pass (TopPass)", () => {
  it("emits the whole common-password dictionary in order", () => {
    const attempts = collectAttempts(topPass, details());
    expect(attempts[0]).toBe("123456");
    expect(attempts).toHaveLength(93);
    expect(new Set(attempts).size).toBe(93);
  });
});

describe("cloudblare (CloudBlare(tm))", () => {
  it("strips filler characters from the hint data, leaving only digits", () => {
    // Modeled on getCaptchaConfig: every char but the last gets 1-3 filler
    // chars appended, drawn from a set with no digits.
    const data = "9/[].7-()4*~1:;>2<#3";
    const state = cloudblare.start(details({ data }));
    const step = cloudblare.next(state, null);
    expect(step).toMatchObject({ attempt: "974123" });
  });

  it("recovers a known password from filler-interleaved data", () => {
    const password = "482";
    const data = "4/[]8╬()2";
    const state = cloudblare.start(details({ data }));
    const step = cloudblare.next(state, null);
    expect(step).toMatchObject({ attempt: password });
  });
});

describe("binary (110100100)", () => {
  it("decodes a known 8-bit binary string", () => {
    // "ABC" -> 01000001 01000010 01000011
    const data = "01000001 01000010 01000011";
    const state = binary.start(details({ data }));
    const step = binary.next(state, null);
    expect(step).toMatchObject({ attempt: "ABC" });
  });
});

describe("ordo-xenos (OrdoXenos)", () => {
  it("XOR round-trips a known encrypted string and mask list", () => {
    const password = "cat";
    const masks = [5, 12, 31]; // arbitrary 0-31 xor masks, as the game generates
    let encrypted = "";
    for (let i = 0; i < password.length; i++) {
      encrypted += String.fromCharCode(password.charCodeAt(i) ^ masks[i]);
    }
    const data = `${encrypted};${masks.map((m) => m.toString(2).padStart(8, "0")).join(" ")}`;

    const state = ordoXenos.start(details({ data }));
    const step = ordoXenos.next(state, null);
    expect(step).toMatchObject({ attempt: password });
  });
});

describe("proverflo (Pr0verFl0)", () => {
  it.each([4, 5, 6, 7])("emits a single character repeated 2x passwordLength for length %d", (passwordLength) => {
    const state = proverflo.start(details({ passwordLength }));
    const step = proverflo.next(state, null);
    if ("giveUp" in step) throw new Error("expected an attempt");
    expect(step.attempt).toHaveLength(2 * passwordLength);
    expect(new Set(step.attempt.split("")).size).toBe(1);
  });
});
