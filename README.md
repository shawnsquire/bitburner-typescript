# Bitburner Scripts

TypeScript automation for [Bitburner](https://github.com/bitburner-official/bitburner-src),
targeting game version **v3.0.1**. Most features need Source-File 4
(Singularity); the hacking, nuke, share, contracts, stocks, hacknet and gang
systems work without it.

Full reference lives in [`docs/`](docs/README.md): architecture, development
workflow, one page per system, and the latest audit.

## Quick start

```
run start.js
```

Launches the dashboard, then the daemons listed in `/config/start.txt`
(created on first run). Core daemons kill hacking workers for RAM if needed;
optional ones start only when RAM is free. Safe to re-run: it skips anything
already running and never overwrites config you have changed.

## How it fits together

```
  /config/<system>.txt ──► daemon ──► status port ──► dashboard / status view
                             ▲                            │
                             └── control port ◄───────────┘ (commands, queue)
```

- **Daemons** (`daemons/`) are long-running services, one per system, that
  read `/config/<system>.txt` and publish JSON status to a numbered port.
- **Controllers** (`controllers/`) hold the pure logic and are unit tested.
- **Actions** (`actions/`) are one-shot scripts, often run through the queue daemon.
- **Dashboard** (`views/dashboard/dashboard.js`) is a React panel inside the
  game that reads the ports and sends commands back.
- **Tiered daemons** pick a feature tier from free RAM, so most systems run in
  some form early and grow later.

See [docs/architecture.md](docs/architecture.md).

## Systems

| System | Daemon | Docs |
|---|---|---|
| Distributed hacking (money, xp, drain, stocks strategies) | `daemons/hack.js` | [hack](docs/systems/hack.md) |
| Root servers, deploy workers | `daemons/nuke.js` | [nuke](docs/systems/nuke.md) |
| Buy TOR and programs | `daemons/darkweb.js` | [darkweb](docs/systems/darkweb.md) |
| Purchased servers | `daemons/pserv.js` | [pserv](docs/systems/pserv.md) |
| Share RAM for faction rep | `daemons/share.js` | [share](docs/systems/share.md) |
| Home RAM and cores | `daemons/home.js` | [home](docs/systems/home.md) |
| Hacknet nodes and hashes | `daemons/hacknet.js` | [hacknet](docs/systems/hacknet.md) |
| Join factions, travel, backdoors | `daemons/faction.js` | [faction](docs/systems/faction.md) |
| Faction reputation and work | `daemons/rep.js` | [rep](docs/systems/rep.md) |
| Augmentation planning and install | `daemons/augments.js` | [augments](docs/systems/augments.md) |
| Stat training, crime, focus arbitration | `daemons/work.js`, `daemons/focus.js` | [work](docs/systems/work.md) |
| Money allocation between systems | `daemons/budget.js` | [budget](docs/systems/budget.md) |
| Stock trading | `daemons/stocks.js` | [stocks](docs/systems/stocks.md) |
| Gang | `daemons/gang.js` | [gang](docs/systems/gang.md) |
| Corporation | `daemons/corp.js` | [corp](docs/systems/corp.md) |
| Bladeburner | `daemons/blade.js` | [blade](docs/systems/blade.md) |
| Infiltration with mini-game solvers | `daemons/infiltration.js` | [infiltration](docs/systems/infiltration.md) |
| Casino | `casino.js` | [casino](docs/systems/casino.md) |
| Coding contracts | `daemons/contracts.js` | [contracts](docs/systems/contracts.md) |
| Recommendations | `daemons/advisor.js` | [advisor](docs/systems/advisor.md) |
| Queue runner and actions | `daemons/queue.js` | [queue](docs/systems/queue.md) |
| Dashboard and terminal status | `views/dashboard/dashboard.js`, `views/status.js` | [dashboard](docs/systems/dashboard.md) |
| CLI tools | `tools/**` | [tools](docs/systems/tools.md) |

## Cheat sheet

| Goal | Command |
|---|---|
| Start everything | `run start.js` |
| See what is running and why | `run views/status.js` or the dashboard Overview tab |
| Grind hacking XP on day one | `run scripts/hack/simple.js n00dles` |
| Flood one target | `run scripts/hack/shotgun.js auto` |
| Change hack strategy | dashboard Hack tab, or edit `strategy` in `/config/hack.txt` and restart |
| Train stats or commit crime | `run actions/set-work-focus.js --focus balance-combat` (see work docs for values) |
| Work for a faction now | `run actions/work-for-faction.js --faction CyberSec --type hacking` |
| Preview affordable augments | `run actions/purchase-augments.js --dry-run` |
| Buy everything and reset | `run actions/firesale.js`, then `run actions/install-augments.js --confirm` |
| Inspect a status port | `run tools/debug/peek-ports.js 2` |
| Map the network | `run tools/network/nmap.js --where root=0,reqHack<=200 --sort reqHack` |

## Config

Every system reads `/config/<name>.txt` (`key=value`, `#` comments), writes
its defaults on first run, and re-reads periodically, so edits in-game or from
the dashboard apply without a restart. Each system page under
`docs/systems/` lists the keys and defaults.

## Development

```
npm install
npm run watch     # transpile, sync, push into the game
npm test          # typecheck, lint, build, unit tests, contract tests
```

`npm test` runs offline against a checkout of the game source. Setup, the test
layout, RAM discipline and the procedure for a new game version are in
[docs/development.md](docs/development.md). `CLAUDE.md` has the notes for AI
agents working in this repo.

## Project structure

```
src/
  start.ts              Bootstrap
  daemons/              Long-running services
  controllers/          Pure logic (unit tested)
  actions/              One-shot scripts
  lib/                  Config, ports, launcher, RAM utils, budget client, solvers
  types/ports.ts        Ports, status shapes, commands, priorities, kill tiers
  views/                Dashboard (React) and terminal status view
  workers/              hack/grow/weaken/share payloads (plain JS)
  scripts/hack/         Standalone early-game hackers
  tools/                CLI utilities (info, network, control, debug)
test/                   vitest unit tests and repo invariants
tools/                  Node-side RAM checker and contract harness
docs/                   Reference documentation
```
