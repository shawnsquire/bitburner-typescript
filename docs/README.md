# Docs

Reference for the Bitburner automation scripts in this repo. Aimed at both the
player and an AI agent working on the code; every page cites the script paths
and config keys it describes so claims can be checked against `src/`.

- [Architecture](architecture.md): layers, ports, queue, config, budget, focus, tiered daemons.
- [Development](development.md): build, test, RAM checks, updating for a new game version.
- [Audit 2026-09-19](audit-2026-09-19.md): findings from the full code audit, what was fixed, what was left as a judgment call.

## Systems

One page per system. Each covers purpose, how to run, config keys with defaults,
ports, dashboard tab, related actions and tools, and the RAM tier table if the
daemon has one.

| Page | Scripts |
|---|---|
| [Hack](systems/hack.md) | `daemons/hack.js`, `scripts/hack/*`, `workers/*` |
| [Nuke](systems/nuke.md) | `daemons/nuke.js`, `tools/network/*` |
| [Darkweb](systems/darkweb.md) | `daemons/darkweb.js`, `actions/buy-*.js` |
| [Personal servers](systems/pserv.md) | `daemons/pserv.js` |
| [Share](systems/share.md) | `daemons/share.js`, `workers/share.js` |
| [Home](systems/home.md) | `daemons/home.js` |
| [Hacknet](systems/hacknet.md) | `daemons/hacknet.js` |
| [Factions](systems/faction.md) | `daemons/faction.js`, `actions/join-faction.js`, `actions/faction-backdoors.js` |
| [Rep](systems/rep.md) | `daemons/rep.js`, `actions/work-for-faction.js` |
| [Augments](systems/augments.md) | `daemons/augments.js`, `actions/purchase-*.js`, `actions/install-augments.js` |
| [Work and focus](systems/work.md) | `daemons/work.js`, `daemons/focus.js`, `actions/start-*.js`, `actions/commit-crime.js` |
| [Budget](systems/budget.md) | `daemons/budget.js` |
| [Stocks](systems/stocks.md) | `daemons/stocks.js`, `actions/scrape-forecasts.js` |
| [Gang](systems/gang.md) | `daemons/gang.js` |
| [Corporation](systems/corp.md) | `daemons/corp.js`, `actions/corp/*` |
| [Bladeburner](systems/blade.md) | `daemons/blade.js` |
| [Infiltration](systems/infiltration.md) | `daemons/infiltration.js` |
| [Casino](systems/casino.md) | `casino.js` |
| [Contracts](systems/contracts.md) | `daemons/contracts.js` |
| [Advisor](systems/advisor.md) | `daemons/advisor.js` |
| [Queue and actions](systems/queue.md) | `daemons/queue.js`, `actions/*` |
| [Dashboard](systems/dashboard.md) | `views/dashboard/*`, `views/status.js` |
| [Tools](systems/tools.md) | `tools/**` |
