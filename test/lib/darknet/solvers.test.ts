import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SOLVERS, solverFor } from "/lib/darknet/solvers/index";

describe("SOLVERS registry", () => {
  it("has exactly 24 entries, each keyed by its own id", () => {
    const keys = Object.keys(SOLVERS);
    expect(keys.length).toBe(24);
    for (const key of keys) {
      expect(SOLVERS[key].id).toBe(key);
    }
  });

  it("solverFor returns null for an unknown modelId", () => {
    expect(solverFor("nope")).toBeNull();
  });

  it("solverFor returns the matching solver for a known modelId", () => {
    expect(solverFor("ZeroLogon")?.id).toBe("ZeroLogon");
  });

  // Cross-check the registry's keys against the game's own ModelIds values.
  // Skips (does not fail) if the checkout isn't present — see test/lib/contracts.test.ts.
  const GAME = process.env.BITBURNER_SRC ?? join(homedir(), "documents/apps/games/bitburner");
  const enumsFile = join(GAME, "src/DarkNet/Enums.ts");
  const hasGameCheckout = existsSync(enumsFile);

  it.runIf(hasGameCheckout)("matches the game's ModelIds values exactly (minus the labyrinth)", () => {
    const src = readFileSync(enumsFile, "utf8");
    const body = src.match(/ModelIds\s*=\s*\{([\s\S]*?)\}\s*as const/);
    expect(body).not.toBeNull();
    const values = [...body![1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);

    const gameNames = values.filter((v) => v !== "(The Labyrinth)").sort();
    const solverKeys = Object.keys(SOLVERS).sort();

    for (const key of solverKeys) {
      expect(gameNames).toContain(key);
    }
    expect(solverKeys).toEqual(gameNames);
  });
});
