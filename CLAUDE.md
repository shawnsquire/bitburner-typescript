# Bitburner scripts

TypeScript automation for the game Bitburner, compiled to `dist/` and pushed into the game by
`bitburner-filesync`. Targets **Bitburner v3.0.1**. Scripts run inside the game, so every `ns.*`
call has a RAM cost and only the functions in `NetscriptDefinitions.d.ts` exist.

## Docs

`docs/` is the reference; cite it and keep it current when behaviour changes.

| Need | Page |
|---|---|
| Layers, ports, queue, config, budget, focus, tiered daemons | `docs/architecture.md` |
| Build, test, RAM checks, new game version procedure | `docs/development.md` |
| One page per system: run command, config keys and defaults, ports, dashboard tab, related scripts | `docs/systems/<name>.md` (index in `docs/README.md`) |
| What the 2026-09-19 audit found, fixed, and deliberately left alone | `docs/audit-2026-09-19.md` |

When you change a config key, a flag, a port, or a tier table, update the system page in the same change.

## Checks

```
npm test                  # typecheck (src + test), lint, build, unit tests, contract tests, darknet solver tests
npm run test:unit         # vitest only (test/**/*.test.ts)
npm run test:darknet      # darknet solver harness alone (also runs as part of npm test)
npm run ram -- daemons/x.js [--sf4 N | --bn4]
```

- Unit tests live in `test/` (never in `src/`, which ships into the game). Import source with
  game-style paths (`/controllers/foo`); `test/helpers/mock-ns.ts` is the NS stub.
- `test/tooling/ram.test.ts` enforces two invariants: a pinned `ns.ramOverride(N)` literal covers the
  script's static cost, and every RAM-charging function a tiered daemon references appears in one of
  its tier lists. If you add an ns call to a tiered daemon or a lib it imports, add it to the tier list.
- Controllers are the unit-test target. Keep new logic pure and in `controllers/` or `lib/`.

## Game source checkout (source of truth)

A partial clone of `bitburner-official/bitburner-src` lives at `~/documents/apps/games/bitburner`,
checked out at the tag the scripts target. Prefer it over memory or web search for anything about
the game: API names, RAM costs, exact enum strings, contract rules, formulas, balance numbers.

```
git -C ~/documents/apps/games/bitburner fetch --tags        # get newer versions
git -C ~/documents/apps/games/bitburner checkout v3.0.2     # switch to the version you play
git -C ~/documents/apps/games/bitburner log --oneline -S getServer -- src/Netscript   # history search
```

Where to look inside it:

| Question | File |
|---|---|
| API signature, return type, RAM cost | `src/ScriptEditor/NetscriptDefinitions.d.ts` (doc comments say `RAM cost: N GB`) |
| Authoritative RAM table | `src/Netscript/RamCostGenerator.ts` |
| What broke in a release, with migrations | `src/utils/APIBreaks/<version>.ts` |
| Removed functions and their replacements | `setRemovedFunctions(...)` in `src/NetscriptFunctions.ts` |
| Runtime behaviour of an ns function | `src/NetscriptFunctions/*.ts` |
| Exact enum strings (factions, crimes, cities, ...) | `src/Enums.ts` and the per-feature `Enums.ts` files it re-exports |
| Coding contract generators, checkers, reference solutions | `src/CodingContract/contracts/*.ts` |
| Changelog | `src/Documentation/doc/en/changelog.md` |

`NetscriptDefinitions.d.ts` at the repo root is gitignored. filesync writes it from the running game;
for offline type-checking copy it from the checkout: `cp ~/documents/apps/games/bitburner/src/ScriptEditor/NetscriptDefinitions.d.ts .`

## Updating for a new game version

1. Check out the new tag in the game clone and copy `NetscriptDefinitions.d.ts` as above.
2. Read `src/utils/APIBreaks/<version>.ts` and the changelog's BREAKING CHANGES section.
3. `npm install && npx tsc --noEmit` and fix every error. Type errors cover renames and enum
   parameters, but NOT: removed functions referenced by string, changed return values
   (e.g. `nuke` returns false instead of throwing), changed RAM costs, or behaviour changes.
4. `npm run ram:sync <tag>` regenerates the RAM table in `tools/ram-check.mjs`; then `npm run ram -- --all`.
5. `npm run test:contracts` runs every solver against the game's own contract definitions.
6. Grep string-literal function names passed to `ns.getFunctionRamCost` (daemon tier lists); tsc
   does not check them.

## Pitfalls

- **Removed functions throw when called**, not at load. A script can start fine and die minutes later.
- **Enum parameters are exact strings**; v3 removed fuzzy matching. Copy values from the enum files.
- **RAM is charged per statically referenced function**, including identifiers that merely look like
  ns function names (a local variable called `share`, `nuke`, `ps` or `run` costs RAM). Also `window`
  and `document` cost 25 GB each. `tools/ram-check.mjs` replicates the game's scan; `npm run ram <file>`
  before trusting a `@ram` tag or `ns.ramOverride(...)` literal.
- **A launch-time `ns.ramOverride(N)` only works as the first statement of `main` with a numeric
  literal.** A computed value does not lower the launch cost; it can only adjust it afterwards.
- **Dashboard plugins must not call `ns`.** Everything under `views/dashboard/tools/` is bundled into
  `dashboard.js`, so one Singularity import there costs the whole dashboard hundreds of GB. Plugins read
  the state store; daemons publish what the UI needs.
- **Singularity calls throw without Source-File 4**, and the RAM check runs before the throw, so detect
  SF4 through `ns.getResetInfo()` rather than by probing a Singularity function.
- **v3 return values**: `nuke`, the port crackers and `purchaseProgram` return `false` on failure; the
  `sleeve.setTo*` functions return `false` on a bad assignment. Check them.
- **Tiered daemons** (`daemons/*.ts` with `HACKNET_TIERS`-style tables) compute their RAM from
  string lists of function names. Every ns function the daemon calls must appear in a tier list,
  or the game's dynamic RAM check kills it mid-run.
- Singularity functions cost 16x at SF4 level 0-1, 4x at level 2, 1x at level 3 or inside BN4; the RAM checker takes `--sf4 <level>` or `--bn4`.
- Repo-absolute imports (`/lib/...`) resolve inside the game only. Node tooling that loads
  `src/` must map them itself (see `tools/test-contracts.mjs`).

## Coding contracts

- Solvers live in `src/lib/contracts/solvers/`, registered by exact contract name in
  `src/lib/contracts/index.ts`. The contracts daemon warns at startup for any game type without a solver.
- To add one, read the game's definition first. `getAnswer` is the reference implementation, but
  `solver` defines what is accepted (e.g. LZ Compression accepts any encoding no longer than the
  reference; Largest Rectangle accepts any maximal all-zero rectangle).
- `npm run test:contracts` (optionally `--rounds N` or a contract name) must pass before shipping.
