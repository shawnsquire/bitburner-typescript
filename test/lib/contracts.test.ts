import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SOLVERS, solve } from "/lib/contracts/index";

describe("SOLVERS registry", () => {
  it("has no empty keys and every entry is a function", () => {
    const keys = Object.keys(SOLVERS);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.length).toBeGreaterThan(0);
      expect(typeof SOLVERS[key]).toBe("function");
    }
  });

  it("has no duplicate-looking keys after trimming", () => {
    const keys = Object.keys(SOLVERS);
    const trimmed = new Set(keys.map((k) => k.trim()));
    expect(trimmed.size).toBe(keys.length);
  });

  // Cross-check the registry's keys against the game's own contract type names.
  // The literal name strings live in src/CodingContract/Enums.ts as the values of
  // the CodingContractName enum (ContractTypes.ts only indexes by that enum, it
  // doesn't repeat the strings) — see CLAUDE.md for how this checkout is kept in
  // sync with the version this repo targets. Skips (does not fail) if the checkout
  // isn't present, per the audit brief.
  const GAME = process.env.BITBURNER_SRC ?? join(homedir(), "documents/apps/games/bitburner");
  const enumsFile = join(GAME, "src/CodingContract/Enums.ts");
  const hasGameCheckout = existsSync(enumsFile);

  it.runIf(hasGameCheckout)("matches the game's CodingContractName values exactly", () => {
    const src = readFileSync(enumsFile, "utf8");
    const enumBody = src.match(/enum CodingContractName\s*{([\s\S]*?)}/);
    expect(enumBody).not.toBeNull();
    const names = [...enumBody![1].matchAll(/=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);

    const solverKeys = Object.keys(SOLVERS).sort();
    const gameNames = [...names].sort();

    // Every solver must be a real contract type the game knows about (a stale/renamed
    // key here is a solver nothing will ever route to).
    for (const key of solverKeys) {
      expect(gameNames).toContain(key);
    }
    // And every contract type the game generates should have a solver — the daemon
    // already warns at startup when this isn't true (missingSolvers in daemons/contracts.ts).
    expect(solverKeys).toEqual(gameNames);
  });
});

describe("solve()", () => {
  it("returns solved:false for an unknown contract type", () => {
    const result = solve("Not A Real Contract Type", [1, 2, 3]);
    expect(result).toEqual({ solved: false, answer: null });
  });

  it("catches a solver throwing on malformed data instead of propagating", () => {
    // caesarCipher destructures `[plaintext, shift] = data`; null blows that up
    // synchronously. solve() must swallow it, not throw out to the daemon loop.
    expect(() => solve("Encryption I: Caesar Cipher", null)).not.toThrow();
    expect(solve("Encryption I: Caesar Cipher", null)).toEqual({ solved: false, answer: null });
  });

  it("returns solved:true with the solver's answer on valid data", () => {
    const result = solve("Find Largest Prime Factor", 91); // 91 = 7 * 13
    expect(result.solved).toBe(true);
    expect(result.answer).toBe(13);
  });
});
