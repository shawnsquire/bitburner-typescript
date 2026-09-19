# Dashboard

A React control panel rendered inside the game's UI, plus a terminal status
view. Source: `src/views/dashboard/` (dashboard, state store, components,
one plugin per system under `tools/`), `src/views/status.ts`.

## Run

```
run views/dashboard/dashboard.js
```

Launched by `start.js` first, with kill-for-RAM. No flags. RAM: 29 GB (was 608 GB before the 2026-09-19 audit removed dead Singularity fallbacks).
Of that, 25 GB is the game's fixed charge for touching `window`, which the
React shim needs.

## How it works

- `state-store.ts` polls every status port each tick and keeps module-level state that survives re-renders. Plugins read from it; they never call `ns` themselves.
- The UI cannot call `ns`, so buttons write a `Command` JSON to `COMMAND_PORT`. The dashboard's main loop reads the port and runs the ns calls in `executeCommand`: start or stop a daemon, open a tail, write a config key, send a control-port message, or queue an action script.
- Each plugin is a `ToolPlugin` with an `OverviewCard` and a `DetailPanel`. Every panel is wrapped in an `ErrorBoundary`, so one broken panel does not blank the rest. A tripped boundary stays blank until the dashboard restarts.
- Per-viewer UI settings (hack, share, infiltration inputs) persist to `/data/dashboard-settings.txt`.
- The Overview tab lists every card with the Advisor's recommendations on top and the FL1GHT progress bar.

## Tabs

| Group | Tabs |
|---|---|
| Servers | Home, Nuke, Hack, PServ, Darkweb |
| Focus | Focus, Work, Rep, Blade (with a sticky focus header) |
| Factions | Faction, Share, Augs |
| Money | Budget, Stocks, Hacknet, Gang, Corp |
| Tools | Casino, Infiltrate, Contracts |

The Advisor has a card on the Overview only. The queue daemon has no tab.

## Adding a plugin

1. Add the tool name to `ToolName` and its script to `TOOL_SCRIPTS` in `types/ports.ts`, and a status port to `STATUS_PORTS`.
2. Have the daemon `publishStatus` a typed status object.
3. Read the port in `state-store.ts` and add the status to `DashboardState`.
4. Create `views/dashboard/tools/<name>.tsx` exporting a `ToolPlugin` with `OverviewCard` and `DetailPanel`. Do not add ns calls to plugins; the RAM cost lands on the whole dashboard.
5. Register it in `dashboard.tsx` and place it in `TAB_GROUPS`.
6. For controls, add a `Command["action"]` value, a writer in `state-store.ts`, and a case in `executeCommand`.

## Terminal status view

```
run views/status.js [nuke|hack|pserv|share|rep|work|darkweb|faction|gang] [--live]
```

Prints an overview or one daemon's detail from the status ports, about 4 GB.
`--live` opens a tail that refreshes every 2 s. The start, stop and flag hints
it prints come from `DAEMON_DOCS` in `views/status.ts`, which was checked
against each daemon's flags and config keys.
