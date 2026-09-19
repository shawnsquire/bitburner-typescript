/**
 * Minimal TS module loader shared by the offline test harnesses.
 *
 * Transpiles a TypeScript file to CommonJS with the `typescript` compiler
 * API and evaluates it with a custom `require` so game/repo source can be
 * loaded outside the game (no bundler, no React/UI dependency tree).
 *
 * The caller supplies:
 * - `resolve(spec, fromFile)`: maps an import specifier to either an
 *   absolute `.ts` path to load for real, or a stub key present in `stubs`.
 * - `stubs`: a map from stub key to the module object returned in its place.
 *
 * `createLoader` returns `load(absFile)`. Each loaded module is cached
 * by its resolved key (stub key or absolute path) and registered in the
 * cache *before* evaluation, so import cycles resolve to the in-progress
 * `module.exports` object instead of recursing forever.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

export function createLoader({ resolve, stubs }) {
  const cache = new Map();

  function load(file) {
    if (Object.prototype.hasOwnProperty.call(stubs, file)) return stubs[file];
    if (cache.has(file)) return cache.get(file).exports;

    const source = readFileSync(file, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
    });

    const module = { exports: {} };
    cache.set(file, module); // register before evaluating so import cycles resolve

    const req = (spec) => load(resolve(spec, file));
    new Function("require", "module", "exports", outputText)(req, module, module.exports);
    return module.exports;
  }

  return load;
}
