# Darknet

Swarm-cracks and replicates across the Darknet grid (Bitburner 3.0's `ns.dnet`
minigame) to harvest `.cache` rewards, phishing income, coding contracts and
labyrinth augmentations. Source: `src/daemons/darknet.ts` (coordinator, runs
on `home`), `src/controllers/darknet.ts` (pure map/policy logic),
`src/lib/darknet/*` (protocol, wire, vault, leak parser, labyrinth grid,
agent decision logic, `solvers/`), `src/workers/dnet-*.ts` (the agent and its
local workers, run on darknet hosts), `src/views/dashboard/tools/darknet.tsx`.
Design: `docs/design/2026-09-19-darknet.md`.

## Run

```
run daemons/darknet.js
```

Optional daemon, started on demand — `daemons/darknet.js` is already listed
under `[optional]` in the default `/config/start.txt` written by `start.js`.
Requires `DarkscapeNavigator.exe` ($50m on the TOR router; `daemons/darkweb.js`
already buys it, no separate unlock code needed). Without it the daemon
publishes `access: "none"` and sleeps 60 s instead of holding RAM. The net is
5 rows deep without full access; air gaps, labyrinths and the deepest rows
only exist in BitNode 15 or with Source-File 15, at which point the daemon
reports `access: "full"`.

Not tiered — every `ns` call the coordinator makes is cheap and fixed, pinned
at 5.3 GB (see the budget comment at the top of `daemons/darknet.ts`).

## Config: `/config/darknet.txt`

| Key | Default | Meaning |
|---|---|---|
| `heartbleed` | `true` | Allow `heartbleed` reads for feedback-based solvers. `false` forfeits nothing new and protects the BN15 "never used heartbleed" achievement, at the cost of every non-blind solver giving up. |
| `harvest` | `true` | Run `dnet-harvest.js` (memory reallocation, cache opening) on agent hosts. |
| `phish` | `true` | Run `dnet-phish.js` on spare RAM after the agent and harvest worker. |
| `phishMaxThreads` | `64` | Per-host cap on phishing threads. |
| `harvestKarmaFloor` | `-1e12` | Stop opening `.cache` files (they cost karma) once karma falls below this. |
| `stasisMode` | `auto` | `auto` picks stasis targets by the priority rules in `computePolicy`; `manual` uses only hosts pinned via the control port / dashboard. |
| `storm` | `manual` | `manual` requires the dashboard button or a `{action:"storm"}` control command; `auto` fires once stuck, no carrier exists, and every stasis link is placed. |
| `lab` | `true` | Run the labyrinth walker (`dnet-lab.js`) when charisma allows. |
| `gapPatienceMs` | `300000` | How long an agent can be stuck at an air gap with no reachable carrier before the coordinator starts charging one. |
| `agentIntervalMs` | `2000` | Agent loop tick period. |
| `maxAttempts` | `120` | Per-neighbour attempt cap before an agent gives up on it for the tick. See "Known limitations". |

## Ports

| Port | Constant | Direction | Content |
|---|---|---|---|
| 34 | `STATUS_PORTS.darknet` | coordinator -> dashboard, advisor | `DarknetStatus`, one value |
| 35 | `DARKNET_CONTROL_PORT` | dashboard -> coordinator | JSON commands, FIFO |
| 36 | `DARKNET_POLICY_PORT` | coordinator -> agents | one `Policy` value, replaced each tick, read with peek |
| 37 | `DARKNET_REPORT_PORT` | agents, workers -> coordinator | batched `Report` events, FIFO |

Control-port command shapes (`readControlCommands` in `daemons/darknet.ts`):

```
{ action: "set", key, value }      // write one /config/darknet.txt key; key must
                                    // already exist in DEFAULT_CONFIG
{ action: "stasis", host, link }   // add/remove host from the manual stasis pin list
{ action: "storm" }                // manually arm the storm-firing state machine
{ action: "reseed" }               // bypass the liveness/throttle check and re-seed
                                    // darkweb + every stasis host immediately
```

## Architecture

The coordinator runs on `home` and owns everything durable: the map
(`DarknetModel.cells`), the password vault (`/data/darknet-vault.json`),
budgets (stasis links, phishing threads) and policy. It can only ever reach
`darkweb` directly, so it never cracks anything itself — it publishes a
`Policy` and reads back batched `Report` events. Agents run *on* darknet
servers, where `authenticate`, `heartbleed` and `memoryReallocation` require
the calling script's own host to be directly connected to the target; each
agent probes its neighbours, restores or cracks them, replicates itself onto
anything it cracks, and launches this host's local workers according to
policy. Death is normal — a restart or hostname recycle silently kills every
resident script, and the coordinator rebuilds the map from `seen` reports and
re-seeds `darkweb` and stasis-linked hosts (which are exempt from restart,
move and delete) from the vault.

| Script | Role | RAM pin |
|---|---|---|
| `daemons/darknet.js` | Coordinator: map, vault, policy, budgets, re-seeding, status | 5.3 GB |
| `workers/dnet-agent.js` | Probe, restore/crack neighbours, replicate, launch local workers, batch reports | 6.25 GB |
| `workers/dnet-harvest.js` | Memory reallocation, `.cache`/`.cct` opening, contract and storm-seed discovery on its own host | 4.9 GB |
| `workers/dnet-phish.js` | Phishing loop, thread count from policy | 3.6 GB |
| `workers/dnet-lab.js` | Labyrinth walker, runs on the host adjacent to the current lab | 2.1 GB |
| `workers/dnet-stasis.js` | One-shot: set or clear a stasis link on its own host | 13.6 GB |
| `workers/dnet-charge.js` | Charges an induced migration on a neighbouring carrier to cross an air gap | 5.6 GB |

Every darknet-side script pins its RAM with a literal `ns.ramOverride(N)` and
a matching `/** @ram N */` tag, checked by `npm run ram` and
`test/tooling/ram.test.ts`. Worker entry files plus every `lib/darknet/*`
module they import make up `DNET_BUNDLE` (`lib/darknet/protocol.ts`), which is
what gets `scp`'d onto a newly-cracked or re-seeded host — there is no
bundler, so replication has to copy the whole import closure, not just the
entry file.

## Solvers

One pure state machine per `modelId` in `lib/darknet/solvers/<model>.ts`,
registered by exact string in `lib/darknet/solvers/index.ts`. Blind solvers
resolve the password directly from `passwordHint`/`data`, never touching
`heartbleed`; feedback-based solvers need at least one authentication attempt
plus a `heartbleed` read to see the model's response before choosing the next
attempt.

| `modelId` | Blind | Notes |
|---|---|---|
| `ZeroLogon` | yes | Empty string. |
| `DeskMemo_3.1` | yes | Last token of `passwordHint`. |
| `FreshInstall_1.0` | yes | 4-entry dictionary. |
| `Laika4` | yes | 4-entry dictionary. |
| `EuroZone Free` | yes | 27-entry dictionary (`EUCountries`). |
| `TopPass` | yes | 94-entry `commonPasswordDictionary`. |
| `CloudBlare(tm)` | yes | Strip non-digits from `data`. |
| `110100100` | yes | Decode space-separated 8-bit groups. |
| `OrdoXenos` | yes | XOR `data` against its own mask. |
| `OctantVoxel` | yes | Parse a `base,digits` number, fractional part included. |
| `MathML` | yes | Port of the game's simple-arithmetic parser. |
| `PrimeTime 2` | yes | Repeated division by the 25 small primes. |
| `Pr0verFl0` | yes | One repeated character, `2 * passwordLength` long. |
| `BellaCuore` | mixed | Two sub-modes on one solver: exact roman-numeral decode from the hint (blind), or binary search over a roman `min,max` range using `ALTUS NIMIS`/`PARUM BREVIS` feedback (not blind). Registered `blind: false` overall. |
| `AccountsManager_4.2` | no | Binary search on `Higher`/`Lower`; blind fallback counts up from 0 (also works with heartbleed off). |
| `NIL` | no | One candidate character per position in parallel, kept on a `yes`. |
| `RateMyPix.Auth` | no | Exact-match count only: all-same probes recover the multiset, then per-position isolation with an absent filler. |
| `DeepGreen` | no | `exact,misplaced` counts; same two-phase scan-then-place as RateMyPix. |
| `Factori-Os` | no | Ask each small prime and its powers, then the 83 large primes. |
| `BigMo%od` | no | `password % n` for 11 chosen moduli, solved by CRT. |
| `PHP 5.4` | no | Sorted-digit hint; permutation search with swap hill-climbing on RMS deviation. |
| `KingOfTheHill` | no | Coarse scan then golden-section search on the reported hill. |
| `2G_cellular` | no | Confirmed-prefix length from the mismatch-index message (heartbleed on). With heartbleed off it falls back to **relative** response-time timing — the correct next character runs ~50ms slower than the others at each position — since the response-time base is charisma/intelligence-dependent, not a fixed value. Timing carries in-game scheduling jitter the harness does not model, so the blind fallback is best-effort; prefer heartbleed. |
| `OpenWebAccessPoint` | no | Regex match on captured traffic, or longest common substring across captures at higher difficulty. |

`tools/test-darknet.mjs` loads the game's own `ServerGenerator.ts`,
`authentication.ts` (`checkPassword`) and dictionary data from the checkout
at `~/documents/apps/games/bitburner` and drives every solver through 125
rounds (5 difficulties x 25 rounds each) until success or its cap — the
acceptance test for the whole solver set. It requires the game source
checkout (see `CLAUDE.md`, "Game source checkout").

## Dashboard

Servers group, `DARKNET` tab (`views/dashboard/tools/darknet.tsx`).

- **Overview card**: agents alive, admin/seen count, deepest admin row over
  net depth, auth timeout chance (highlighted red above 10%), next charisma
  gate.
- **Detail panel**: header with access level and heartbleed
  allowed/blocked/used-this-node; a depth ladder of cells coloured by state
  (`unknown | frontier | cracking | admin | agent | anchor | offline`) with a
  per-cell stasis pin toggle; stasis (used/limit, mode, linked hosts); lab
  (name, charisma requirement, cleared, moves); income (money/hour, caches
  opened, contracts found, augs awarded); a storm-trigger button (shown only
  once a storm seed exists) and a stuck indicator; a config editor for all 11
  `/config/darknet.txt` keys.

## Related

`docs/design/2026-09-19-darknet.md` — the authoritative design doc (problem,
decisions, and one section per subsystem).

## Known limitations

- **Heartbleed permanently forfeits the BN15 "never used heartbleed"
  achievement.** The game latches `DarknetState.hasUsedHeartbleed` the first
  time any script calls `heartbleed`, and that cannot be undone for the rest
  of the BitNode. Set `heartbleed=false` in `/config/darknet.txt` before
  starting the daemon in a BN15 run if the achievement matters — every
  non-blind solver then gives up instead (`2G_cellular` and
  `AccountsManager_4.2` are the two exceptions with a blind fallback:
  `AccountsManager_4.2` counts up from 0, and `2G_cellular` uses relative
  response-time timing — best-effort in-game, see its solver-table row).
- **The per-neighbour `maxAttempts` cap (default 120) can be too low for the
  hardest feedback-based servers, and the agent does not persist solver state
  across ticks.** `driveSolver` (`workers/dnet-agent.ts`) keeps its solver
  `state` and `attempts` counter as local variables for one `crackNeighbour`
  call; nothing carries that progress into the `Policy`/`Report` protocol or
  the coordinator, so once an agent gives up on a neighbour for the tick, the
  *next* tick starts that neighbour over from attempt 1. A server whose real
  attempt count exceeds `maxAttempts` therefore never converges — it is
  retried from scratch forever rather than resumed. `tools/test-darknet.mjs`'s
  own 125-round sweep across difficulties 1/4/8/18/30 measured worst-case
  attempt counts of up to the low 300s for `2G_cellular` (cap is
  `62 * passwordLength`, i.e. up to 496 at the longest passwords the game
  generates), and up to ~130 for `RateMyPix.Auth` — both of which can exceed
  the 120 default at higher difficulty. `DeepGreen` stayed under 75 in the
  sweep, comfortably inside the default, but shares the same two-phase
  scan-then-place strategy so a harder difficulty than tested could still push
  it over. (`Factori-Os` needs up to ~125 attempts too, but is already
  exempted in `lib/darknet/agent-logic.ts` to a floor of 130 — a higher
  configured `maxAttempts` still applies above that floor.) Raise
  `maxAttempts` in `/config/darknet.txt` to crack these
  deep feedback servers, at the cost of one neighbour's crack loop
  monopolizing that agent's tick — and delaying every other neighbour and
  local worker launch on that host — for longer before giving up or
  succeeding.
- **`parsePhishResult` (`workers/dnet-phish.ts`) assumes the default `en`
  number locale.** It parses the game's `formatNumber` output with
  `/^Phishing attack succeeded! \$([\d.]+)([kmbt]?) retrieved\./`, scaling
  only `k`/`m`/`b`/`t` suffixes with a `.` decimal point. A different locale
  setting (comma decimals, different suffix letters) would silently parse as
  `$0` and undercount phishing income in `DarknetStatus.income.moneyPerHour`.
- **Storms are fired by the resident agent, not the coordinator.**
  `unleashStormSeed()` only works on the host that currently holds
  `STORM_SEED.exe` (a harvest reward), so `dnet-agent.ts` calls it directly
  once `policy.workers[self].storm` is set and latches success for the
  process lifetime; the coordinator only ever decides *when* to arm that flag
  in the policy, it never calls the dnet function itself.
- **A fully RAM-blocked host cannot host an agent, so it is not colonized
  until its owner's processes free some RAM.** The game blocks up to a host's
  entire `maxRam` (`getRamBlock`, `ramblock.ts`), and blocked RAM counts as
  used, so `replicate` (`workers/dnet-agent.ts`) finds `< 6.25 GB` free and
  cannot `exec` an agent there. Freeing the block needs `memoryReallocation`
  run from the adjacent agent, which would push that agent over its 6.25 GB
  pin, so it is not done. The cracking agent still holds a session on the
  blocked host (from `authenticate`), so the vault keeps its password; once the
  owner's processes release RAM the next replication attempt colonizes it.
  Largest hosts (and their biggest caches) can therefore sit idle for a while.
- **A charisma-gated RAM block causes brief harvest churn.** When charisma is
  too low for a host's difficulty, `memoryReallocation` frees ~0 GB/round;
  `dnet-harvest.ts` detects the stall, opens any cache files (which do not need
  the block cleared), reports the remaining block and exits. Because the
  coordinator's harvest gate still sees `blockedRam > 0`, it relaunches harvest
  next tick, which stalls and exits again — a low-cost cycle that continues
  until charisma rises enough to make progress. The reward/data caches are
  collected regardless; only the block clearing waits on charisma.
- **Deferred** (see the design doc's Decisions section, still true of the
  shipped code): terminal backdoors (stasis anchors already give remote
  seeding, and the instability tax from more backdoored hosts is steep);
  stock promotion (the stocks daemon does not model volatility yet); automatic
  storms (`storm=manual` by default — `auto` exists but is opt-in).
