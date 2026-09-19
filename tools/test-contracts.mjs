#!/usr/bin/env node
/**
 * Coding Contract Solver Test Harness
 *
 * Runs every solver in src/lib/contracts against the game's OWN contract
 * definitions (generate / getData / convertAnswer / validateAnswer / solver),
 * loaded straight from a checkout of bitburner-src. This is the closest thing
 * to a guarantee that a solver is accepted in-game, and it flags contract
 * types the game knows about that we have no solver for.
 *
 * Usage:
 *   node tools/test-contracts.mjs                 # all types, 25 rounds each
 *   node tools/test-contracts.mjs --rounds 100    # more rounds
 *   node tools/test-contracts.mjs "Square Root"   # one type
 *
 * Game source location: $BITBURNER_SRC, else ~/documents/apps/games/bitburner
 * (see CLAUDE.md for how that checkout is kept on the game version you play).
 */

import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLoader } from "./lib/ts-loader.mjs";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const GAME = process.env.BITBURNER_SRC ?? join(homedir(), "documents/apps/games/bitburner");
const CONTRACT_DIR = join(GAME, "src/CodingContract");

const args = process.argv.slice(2);
const roundsIdx = args.indexOf("--rounds");
const ROUNDS = roundsIdx >= 0 ? Number(args[roundsIdx + 1]) : 25;
const only = args.filter((a, i) => !a.startsWith("--") && (roundsIdx < 0 || i !== roundsIdx + 1));

if (!existsSync(join(CONTRACT_DIR, "ContractTypes.ts"))) {
  console.error(`Game source not found at ${GAME}. Clone bitburner-src there or set BITBURNER_SRC.`);
  process.exit(1);
}

// ─── Minimal TS module loader ──────────────────────────────────────────────
// Transpiles each TS file to CommonJS and evaluates it with a custom require so
// we can load game modules without their React/UI dependency tree.

const stubs = {
  "@nsdefs": {}, // type-only import in ContractTypes.ts
  exceptionAlert: { exceptionAlert: (e) => console.error("game exceptionAlert:", e) },
};

function resolveSpecifier(spec, fromFile) {
  if (spec === "@enums") return join(CONTRACT_DIR, "Enums.ts");
  if (spec === "@nsdefs") return "@nsdefs";
  if (spec.endsWith("/exceptionAlert")) return "exceptionAlert";
  if (spec.startsWith("/")) return join(REPO, "src", `${spec.slice(1)}.ts`); // repo-absolute imports
  let p = resolve(dirname(fromFile), spec);
  if (!p.endsWith(".ts")) p += ".ts";
  return p;
}

const loadTs = createLoader({ resolve: resolveSpecifier, stubs });

// ─── Load both sides ───────────────────────────────────────────────────────

const { CodingContractDefinitions } = loadTs(join(CONTRACT_DIR, "ContractTypes.ts"));
const { SOLVERS } = loadTs(join(REPO, "src/lib/contracts/index.ts"));

const gameTypes = Object.keys(CodingContractDefinitions);
const missing = gameTypes.filter((t) => !SOLVERS[t]);
const stale = Object.keys(SOLVERS).filter((t) => !CodingContractDefinitions[t]);

// ─── Run ───────────────────────────────────────────────────────────────────

/** Mirror CodingContract.isValid() + solver() from src/CodingContract/Contract.ts */
function gameAccepts(def, state, answer) {
  if (typeof answer === "string") answer = def.convertAnswer(answer);
  if (!def.validateAnswer(answer)) return { ok: false, why: "invalid format" };
  return { ok: def.solver(state, answer), why: "wrong answer" };
}

let failures = 0;
const types = only.length > 0 ? only : gameTypes;
for (const type of types) {
  const def = CodingContractDefinitions[type];
  const solver = SOLVERS[type];
  if (!def) { console.log(`?? ${type}: unknown to the game`); failures++; continue; }
  if (!solver) { console.log(`-- ${type}: NO SOLVER`); continue; }

  let passed = 0;
  let firstFailure = null;
  const t0 = performance.now();
  for (let i = 0; i < ROUNDS; i++) {
    const state = def.generate();
    const data = def.getData ? def.getData(state) : structuredClone(state);
    let verdict;
    try {
      verdict = gameAccepts(def, state, solver(data));
    } catch (e) {
      verdict = { ok: false, why: `threw: ${e instanceof Error ? e.message : e}` };
    }
    if (verdict.ok) passed++;
    else if (!firstFailure) firstFailure = { why: verdict.why, data: JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 200) };
  }
  const ms = ((performance.now() - t0) / ROUNDS).toFixed(1);
  const ok = passed === ROUNDS;
  if (!ok) failures++;
  console.log(`${ok ? "ok" : "FAIL"} ${type}: ${passed}/${ROUNDS} (${ms} ms/round)`);
  if (firstFailure) console.log(`     first failure: ${firstFailure.why}; data: ${firstFailure.data}`);
}

console.log();
console.log(`Game types: ${gameTypes.length}, solvers: ${Object.keys(SOLVERS).length}`);
if (missing.length) { console.log(`Missing solvers: ${missing.join(", ")}`); failures++; }
if (stale.length) console.log(`Solvers for types the game no longer has: ${stale.join(", ")}`);
process.exit(failures > 0 ? 1 : 0);
