# Development

How to build, test, and ship changes. Everything here runs offline against the
game source checkout; nothing needs the game running except the final filesync.

## Prerequisites

- Node 24 (older 18+ works for the build; the test tooling targets 24).
- A checkout of `bitburner-official/bitburner-src` at the targeted tag
  (`~/documents/apps/games/bitburner`, or set `BITBURNER_SRC`). See the
  "Game source checkout" section of `CLAUDE.md` for how to keep it in sync.
- `NetscriptDefinitions.d.ts` in the repo root. filesync writes it from the
  running game; offline, copy it from the checkout:
  `cp ~/documents/apps/games/bitburner/src/ScriptEditor/NetscriptDefinitions.d.ts .`

```
npm install
```

## Commands

| Command | What it does |
|---|---|
| `npm run watch` | Transpile, sync static files, push `dist/` into the game (filesync on port 12525), regenerate the file manifest. Use this while playing. |
| `npm run build` | One-shot `tsc` into `dist/`. The RAM checker and RAM tests read `dist/`, so build before running them. |
| `npm run typecheck` | `tsc --noEmit` for `src/`, then for `test/` via `tsconfig.test.json`. |
| `npm run lint` | eslint over `src/` and `test/`. Warnings are allowed; errors fail. |
| `npm run test:unit` | vitest over `test/**/*.test.ts`. |
| `npm run test:watch` | vitest in watch mode. |
| `npm run test:contracts` | Runs every coding-contract solver against the game's own generator and checker. `-- --rounds N` or `-- "Square Root"` narrows it. |
| `npm run ram -- <dist path>` | Static RAM cost of a compiled script (`npm run ram -- daemons/hack.js`). `--all` for every entry script, `--sf4 <level>` / `--bn4` for singularity multipliers, `--json` for machine output. |
| `npm run ram:sync -- <tag>` | Regenerate the RAM table in `tools/ram-check.mjs` from the game checkout. |
| `npm test` | typecheck, lint, build, unit tests, contract tests, in that order. Run before committing. |

## Test layout

```
test/
  helpers/mock-ns.ts     Minimal NS stub (files, ports, print capture). Throws on
                         any member a test did not provide, so a test cannot pass
                         by calling an undefined ns function.
  lib/                   Tests for src/lib
  controllers/           Tests for src/controllers (pure logic, the main target)
  tooling/ram.test.ts    Repo invariants: ramOverride literals fit static cost;
                         tiered daemons list every RAM-charging function they use.
```

Rules:

- Tests live in `test/`, never in `src/`. Everything under `src/` is compiled
  into `dist/` and pushed into the game, where it would cost RAM.
- Import source the way the game does: `import { x } from "/controllers/foo"`.
  `vitest.config.ts` maps `/lib`, `/types`, `/controllers`, `/views`, the bare
  `lib/...` form, `@ns`, and `@react` into `src/`.
- Test pure functions. Daemon main loops and React components are not unit
  tested; their logic should be pulled into controllers or exported helpers.
- Use `mockNS({ files, extra })` from `test/helpers/mock-ns.ts` for anything
  that takes an `NS`. Pass the ns members the code under test needs in `extra`.
- Coding-contract solvers are covered by `npm run test:contracts`, which is the
  authoritative check because it uses the game's own acceptance logic.

## RAM discipline

The game charges RAM per statically referenced `ns.*` function, and it kills a
script at runtime if a call pushes dynamic usage above its allocation. Two
classes of script manage this explicitly:

- **Pinned scripts** call `ns.ramOverride(N)` with a literal and carry a
  `/** @ram N */` tag. `test/tooling/ram.test.ts` asserts the static cost fits.
- **Tiered daemons** (`daemons/blade`, `corp`, `faction`, `gang`, `hacknet`,
  `home`, `rep`, `share`, `stocks`, `work`) pick a feature tier from free RAM,
  computing the cost from string lists of function names via
  `ns.getFunctionRamCost`. Every RAM-charging function the daemon or its imports
  call must appear in a base list or a tier list; `test/tooling/ram.test.ts`
  checks this against `tools/ram-check.mjs`.

When you add an `ns` call to a tiered daemon or to a `lib/` module that a tiered
daemon imports, add it to the tier list and run `npm run build && npm run test:unit`.

## Updating for a new game version

1. `git -C ~/documents/apps/games/bitburner fetch --tags && git -C ~/documents/apps/games/bitburner checkout <tag>`
2. Copy `NetscriptDefinitions.d.ts` (see above).
3. Read `src/utils/APIBreaks/<version>.ts` in the checkout and the changelog's
   BREAKING CHANGES.
4. `npm run typecheck` and fix every error. Type errors catch renames and enum
   parameters but not removed functions referenced by string, changed return
   values, changed RAM costs, or behaviour changes.
5. `npm run ram:sync -- <tag>`, then `npm run build && npm run ram -- --all`.
6. `npm test`.
7. Grep string-literal function names in tier lists; tsc does not check them,
   `test/tooling/ram.test.ts` only checks that referenced functions are listed,
   not that listed names still exist.

## Conventions

- Commit messages: `topic: message` (`hack: Fix batch desync recovery`).
- One system per daemon, business logic in `controllers/` (no loops, no
  `ns.sleep`), status published to a port, config in `/config/<system>.txt`.
- Enum parameters are exact strings; copy them from the game's `Enums.ts`.
- Do not add dependencies that the game must load; scripts run inside the game
  with only the `ns` API and the React shim in `lib/react.ts`.
