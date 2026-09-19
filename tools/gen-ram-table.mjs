#!/usr/bin/env node
/**
 * Regenerate the RAM_COSTS table in tools/ram-check.mjs from the game's own
 * RamCostGenerator.ts, so the offline RAM checker tracks a specific game version.
 *
 * Usage:
 *   node tools/gen-ram-table.mjs            # from the local game checkout ($BITBURNER_SRC or ~/documents/apps/games/bitburner)
 *   node tools/gen-ram-table.mjs v3.0.2     # fetch any bitburner-src git ref from GitHub instead
 *
 * Singularity entries are written as base costs; ram-check.mjs applies the
 * SF4 multiplier itself (see lookupCost()).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const target = resolve(process.cwd(), "tools/ram-check.mjs");
const GAME = process.env.BITBURNER_SRC ?? join(homedir(), "documents/apps/games/bitburner");
const localFile = join(GAME, "src/Netscript/RamCostGenerator.ts");

// Prefer the local game checkout (see CLAUDE.md); fall back to GitHub for an explicit tag.
let src;
let tag = process.argv[2];
if (!tag && existsSync(localFile)) {
  tag = execSync("git describe --tags --always", { cwd: GAME, encoding: "utf8" }).trim();
  src = readFileSync(localFile, "utf8");
} else {
  tag ??= "v3.0.1";
  const url = `https://raw.githubusercontent.com/bitburner-official/bitburner-src/${tag}/src/Netscript/RamCostGenerator.ts`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  src = await res.text();
}

// Sanity check: SF4Cost() must only be used inside the singularity block,
// because ram-check.mjs only multiplies chains starting with "singularity".
const blocks = [...src.matchAll(/^const (\w+) = \{([\s\S]*?)^\}( as const)?;/gm)];
const sf4Blocks = blocks.filter((b) => b[2].includes("SF4Cost(")).map((b) => b[1]);
if (sf4Blocks.join(",") !== "singularity") {
  console.error(`SF4Cost() used outside singularity (${sf4Blocks.join(", ")}); update lookupCost() in ram-check.mjs`);
  process.exit(1);
}

// Strip TypeScript down to evaluable JS.
src = src
  .replace(/^import[^\n]*\n/gm, "")
  .replace(/^export type[\s\S]*?\n\};\n/m, "")
  .replace(/^function SF4Cost[\s\S]*?\n\}\n/m, "const SF4Cost = (c) => c;\n")
  .replace(/^type RamTreeGeneric[\s\S]*$/m, "")
  .replace(/: RamCostTree<NSFull>/, "")
  .replace(/ as const;/g, ";")
  .replace(/^export /gm, "");
const table = new Function(`${src}\nreturn RamCosts;`)();

function emit(obj, indent) {
  const pad = "  ".repeat(indent);
  return Object.entries(obj)
    .map(([k, v]) =>
      typeof v === "object" ? `${pad}${k}: {\n${emit(v, indent + 1)}\n${pad}},` : `${pad}${k}: ${Number(v.toFixed(4))},`,
    )
    .join("\n");
}

const header =
  `// ─── RAM Cost Table (generated from Bitburner ${tag} RamCostGenerator.ts) ──\n` +
  `// Singularity entries are base costs; lookupCost() applies SF4_MULT.\n` +
  `// Regenerate with: node tools/gen-ram-table.mjs [tag]\n\n`;
const body = `const RAM_COSTS = {\n${emit(table, 1)}\n};\n`;

const current = readFileSync(target, "utf8");
const re = /\/\/ ─── RAM Cost Table[\s\S]*?\nconst RAM_COSTS = \{[\s\S]*?\n\};\n/;
if (!re.test(current)) {
  console.error("Could not find the RAM_COSTS block in tools/ram-check.mjs");
  process.exit(1);
}
writeFileSync(target, current.replace(re, header + body));
console.log(`Updated ${target} from ${tag} (${Object.keys(table).length} top-level entries)`);
