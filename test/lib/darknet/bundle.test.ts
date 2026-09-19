/**
 * Darknet replication bundle invariants (see docs/design/2026-09-19-darknet.md
 * Section 1). There is no bundler — `build` is plain `tsc` — so an agent that
 * replicates itself onto a new host must `scp` its full import closure, not
 * just its entry script. `DNET_BUNDLE` in `lib/darknet/protocol.ts` is that
 * list; this test walks the real import graph of every `workers/dnet-*.ts`
 * script and checks it against that list.
 *
 * No `ns` involved — pure filesystem/regex over `src/`, so this runs even
 * without a build.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { DNET_BUNDLE, DNET_WORKERS, DNET_WORKER_RAM } from "/lib/darknet/protocol";

const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

/** src path (absolute) -> dist path as DNET_BUNDLE spells it ("lib/darknet/protocol.js"). */
function distPath(srcFile: string): string {
  return relative(SRC, srcFile).replace(/\.tsx?$/, ".js").split("\\").join("/");
}

/** Resolve an import specifier from `fromFile` to an absolute .ts source path, or null. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let rel: string;
  if (spec.startsWith("/")) {
    // repo-absolute: "/lib/darknet/protocol" -> src/lib/darknet/protocol.ts
    rel = spec.slice(1);
  } else if (spec.startsWith(".")) {
    // relative to the importing file
    rel = relative(SRC, join(dirname(fromFile), spec));
  } else {
    // bare baseUrl-relative: "lib/darknet/protocol" -> src/lib/darknet/protocol.ts
    rel = spec;
  }

  const candidates = [`${rel}.ts`, `${rel}.tsx`, join(rel, "index.ts")];
  for (const c of candidates) {
    const abs = join(SRC, c);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** Every `from "<spec>"` import specifier in a file, skipping `import type` and `@ns`. */
function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const re = /import\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const isTypeOnly = !!m[1];
    const spec = m[2];
    if (isTypeOnly) continue;
    if (spec === "@ns") continue;
    specs.push(spec);
  }
  return specs;
}

/** Walk the import closure of `entryFile` (absolute path), returning absolute .ts paths (entry excluded). */
function importClosure(entryFile: string): string[] {
  const seen = new Set<string>([entryFile]);
  const closure: string[] = [];
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const text = readFileSync(file, "utf8");
    for (const spec of importSpecifiers(text)) {
      const resolved = resolveSpecifier(spec, file);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      closure.push(resolved);
      queue.push(resolved);
    }
  }

  return closure;
}

const workersDir = join(SRC, "workers");
const workers = existsSync(workersDir)
  ? readdirSync(workersDir).filter((f) => /^dnet-.*\.ts$/.test(f)).map((f) => join(workersDir, f))
  : [];

// Role (agent/harvest/phish/lab/stasis/charge) for a worker's dist path, from DNET_WORKERS.
const roleForDistPath = new Map<string, keyof typeof DNET_WORKERS>(
  (Object.entries(DNET_WORKERS) as [keyof typeof DNET_WORKERS, string][]).map(([role, path]) => [path, role]),
);

describe("darknet replication bundle (DNET_BUNDLE)", () => {
  // No dnet-*.ts workers exist yet, so the three tests below loop over an
  // empty array and never actually exercise the walker. Smoke-test it
  // against a real entry file (wire.ts) that already exists, so a broken
  // regex or resolver is caught now rather than silently passing until
  // the first worker lands.
  it("walker resolves wire.ts's closure to protocol + ports (smoke)", () => {
    const closure = importClosure(join(SRC, "lib/darknet/wire.ts")).map(distPath).sort();
    expect(closure).toEqual(["lib/darknet/protocol.js", "types/ports.js"]);
  });

  it("covers every dnet-*.ts worker's dist path and import closure", () => {
    for (const worker of workers) {
      const workerDist = distPath(worker);
      expect(DNET_BUNDLE, `${workerDist} missing from DNET_BUNDLE`).toContain(workerDist);

      for (const closureFile of importClosure(worker)) {
        const closureDist = distPath(closureFile);
        expect(DNET_BUNDLE, `${closureDist} (imported by ${workerDist}) missing from DNET_BUNDLE`).toContain(closureDist);
      }
    }
  });

  it("keeps every worker's import closure inside lib/darknet/ or types/ports.ts", () => {
    for (const worker of workers) {
      for (const closureFile of importClosure(worker)) {
        const closureDist = distPath(closureFile);
        const allowed = closureDist.startsWith("lib/darknet/") || closureDist === "types/ports.js";
        expect(allowed, `${closureDist} (imported by ${distPath(worker)}) lies outside lib/darknet/ and types/ports.ts`).toBe(true);
      }
    }
  });

  it("matches DNET_WORKER_RAM to each worker's pinned @ram tag", () => {
    for (const worker of workers) {
      const workerDist = distPath(worker);
      const role = roleForDistPath.get(workerDist);
      expect(role, `${workerDist} not listed in DNET_WORKERS`).toBeDefined();
      if (!role) continue;

      const text = readFileSync(worker, "utf8");
      const tagMatch = text.match(/@ram\s+([\d.]+)/);
      expect(tagMatch, `${workerDist} has no @ram tag`).not.toBeNull();
      if (!tagMatch) continue;

      expect(Number(tagMatch[1])).toBe(DNET_WORKER_RAM[role]);
    }
  });

  it("lists only lib/darknet/, types/ports, or workers/ entries for DNET_BUNDLE paths whose source exists", () => {
    for (const entry of DNET_BUNDLE) {
      const srcCandidate = join(SRC, entry.replace(/\.js$/, ".ts"));
      if (!existsSync(srcCandidate)) continue; // created by a later task
      const allowed = entry.startsWith("lib/darknet/") || entry === "types/ports.js" || entry.startsWith("workers/");
      expect(allowed, `${entry} has a source file but is outside lib/darknet/, types/ports, and workers/`).toBe(true);
    }
  });
});
