/**
 * Repo-specific RAM invariants (see CLAUDE.md "Pitfalls").
 *
 * These run tools/ram-check.mjs against dist/, so `npx tsc` must have been run
 * first (npm test does this). Two invariants:
 *
 * 1. A script that pins its RAM with a literal `ns.ramOverride(N)` and has no
 *    tier table must statically cost <= N, or the game kills it at launch.
 * 2. A tiered daemon (calls ns.getFunctionRamCost over string lists) must list
 *    every RAM-charging ns function that it, or anything it imports, references.
 *    Otherwise the dynamic RAM check kills it mid-run when that function runs.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

interface RamReport {
  script: string;
  totalRam: number;
  functions: { function: string; cost: number; source: string }[];
}

type Source = { file: string; text: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(p);
  }
  return out;
}

function ramCheck(scripts: string[]): RamReport[] {
  const out = execFileSync("node", [join(ROOT, "tools/ram-check.mjs"), "--json", ...scripts], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(out) as RamReport[];
}

/** src path -> dist script path as ram-check expects it */
function distPath(srcFile: string): string {
  return relative(SRC, srcFile).replace(/\.tsx?$/, ".js");
}

const distExists = existsSync(join(ROOT, "dist"));
const sources = walk(SRC);

describe.skipIf(!distExists)("ramOverride literals", () => {
  const pinned = sources
    .map((f) => ({ file: f, text: readFileSync(f, "utf8") }))
    .filter(({ text }) => /ns\.ramOverride\(\s*[\d.]+\s*\)/.test(text) && !text.includes("getFunctionRamCost("));

  it.each(pinned.map((p): [string, Source] => [distPath(p.file), p]))("%s static RAM fits its override", (_name, p) => {
    const literals = [...p.text.matchAll(/ns\.ramOverride\(\s*([\d.]+)\s*\)/g)].map((m) => Number(m[1]));
    const override = Math.max(...literals);
    const tag = p.text.match(/@ram\s+([\d.]+)/);
    if (tag) expect(Number(tag[1]), "@ram tag must equal the ramOverride literal").toBe(override);
    const [report] = ramCheck([distPath(p.file)]);
    expect(report.totalRam, `static cost ${report.totalRam} exceeds ramOverride(${override})`).toBeLessThanOrEqual(override);
  });
});

describe.skipIf(!distExists)("tiered daemons list every charged function", () => {
  const tiered = sources
    .filter((f) => f.includes("/daemons/"))
    .map((f) => ({ file: f, text: readFileSync(f, "utf8") }))
    .filter(({ text }) => text.includes("getFunctionRamCost("));

  it.each(tiered.map((t): [string, Source] => [distPath(t.file), t]))("%s", (_name, t) => {
    // Every string literal in the daemon that looks like an ns function path
    // counts as "listed". Over-inclusive on purpose: a function name that never
    // appears as a literal anywhere cannot be in any tier list.
    const listed = new Set(
      [...t.text.matchAll(/["']([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*)["']/g)].map((m) => m[1]),
    );
    const [report] = ramCheck([distPath(t.file)]);
    const charged = report.functions.filter((f) => f.cost > 0);
    const missing = charged.filter((f) => !listed.has(f.function));
    expect(
      missing.map((f) => `${f.function} (${f.cost} GB via ${f.source})`),
      "charged ns functions absent from every tier/base list",
    ).toEqual([]);
  });
});
