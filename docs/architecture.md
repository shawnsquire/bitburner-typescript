# Architecture

The repo is a set of Netscript scripts that run inside Bitburner. There is no
process outside the game at runtime; `bitburner-filesync` only copies `dist/`
in. Scripts coordinate through the game's numbered ports and through small text
files on `home`.

## Layers

```
src/
  start.ts        Bootstrap: launches the dashboard, then daemons from /config/start.txt
  daemons/        Long-running services. One per system. Publish status, read config.
  controllers/    Pure logic used by daemons and actions. No loops, no sleeps, no
                  side effects beyond the ns calls they are handed. Unit-tested.
  actions/        One-shot scripts (buy X, travel, install augments). Often queued.
  lib/            Infrastructure: config, ports, launcher, RAM utils, budget client,
                  batch math, DOM helpers, React shim, contract and infiltration solvers.
  types/ports.ts  Single source of truth for port numbers, status shapes, commands,
                  queue entries, priorities, kill tiers. Zero ns imports, zero RAM.
  views/          The React dashboard and a terminal status view.
  workers/        Tiny hack/grow/weaken/share executors (plain .js, minimal RAM).
  scripts/        Standalone hacking scripts for early game.
  tools/          CLI utilities (info/, network/, control/, debug/).
```

## Data flow

```
                     reads /config/*.txt          publishes JSON
  /config/<system>.txt ───────────────► daemon ───────────────► status port
          ▲                               ▲                          │
          │ writes                        │ control port             │ peeks
          │                               │ (JSON messages)          ▼
     dashboard ◄──────────────────────────┴───────────────────── dashboard
          │
          │ COMMAND_PORT (Command JSON)
          ▼
     dashboard main loop ──► exec / kill / queueExec ──► QUEUE_PORT ──► daemons/queue.js
```

### Status ports

Each daemon owns one status port (`STATUS_PORTS` in `types/ports.ts`) and keeps
exactly one JSON value on it. `publishStatus` writes the new value first and then
drains older entries, so a reader never sees an empty port between updates. Every
published object carries `_publishedAt`; `peekStatus(ns, port, maxAgeMs)` returns
`null` for stale data, which is how the dashboard and `lib/budget.ts` detect a
daemon that has died.

### Control ports

Systems that accept runtime commands from other scripts have a control port
(`GANG_CONTROL_PORT`, `BUDGET_CONTROL_PORT`, `STOCKS_CONTROL_PORT`,
`CORP_CONTROL_PORT`, `FOCUS_CONTROL_PORT`, `CONTRACTS_CONTROL_PORT`,
`INFILTRATION_CONTROL_PORT`). Messages are JSON, consumed FIFO by the owning daemon.

### Command port and queue

The React UI cannot call `ns` directly, so it writes a `Command` to
`COMMAND_PORT`; the dashboard script's main loop reads it and performs the ns
calls (`views/dashboard/state-store.ts`, `executeCommand`). Anything that needs
significant RAM is not run inline; it is queued.

`QUEUE_PORT` holds `QueueEntry` values. `daemons/queue.js` drains the queue each
tick, sorts by `priority` (`PRIORITY` in `types/ports.ts`: CRITICAL 10,
USER_ACTION 8, STATUS_CHECK 5, NICE_TO_HAVE 3), and runs entries when RAM allows.
`mode: "force"` lets it kill lower-priority processes via the kill tiers. The
queue daemon also rotates a fixed set of status-check actions.

### Kill tiers and the launcher

`KILL_TIERS` (`types/ports.ts`) lists what may be killed to free RAM, in order:
worker scripts, then `daemons/share.js`, then the dashboard. `lib/ram-utils.ts`
walks the tiers; `lib/launcher.ts` wraps it as `ensureRamAndExec` (used by
`start.ts` for core daemons) and `queueExec`.

### Config files

Each system reads `/config/<system>.txt` (`key=value`, `#` comments). Daemons
call `writeDefaultConfig` on startup so the file always exists with every key,
and re-read it periodically so edits in-game or from the dashboard take effect
without a restart. `lib/config.ts` has the accessors. `start.ts` reads
`/config/start.txt`, a list of daemon paths split into `[core]` (launched with
kill-for-RAM) and `[optional]` (launched only if RAM is free).

### Budget

`daemons/budget.js` splits liquid money into weighted buckets (stocks, servers,
gang, hacknet, home, corp). Consumers use `lib/budget.ts`: `getBudgetBalance`
before spending, `notifyPurchase` after, `signalDone` when a bucket has nothing
left to buy (persisted in `/data/budget-done.txt` so it survives restarts),
`reactivateBucket` to undo that, `reportCap` to publish remaining cost. If the
budget daemon is not running, consumers see `Infinity` and spend freely.

### Focus

Only one thing can use the player's "focus" (work, faction rep grinding,
Bladeburner). `daemons/focus.js` is the sole writer of `/config/focus.txt`
(`holder` = work | rep | blade | none) and publishes `FocusStatus` on its status
port; it takes commands on `FOCUS_CONTROL_PORT`. The work, rep and blade daemons
read `holder` and park themselves when they do not hold it. Sleeves are assigned
to a daemon the same way, via `actions/assign-sleeve.js`.

### Tiered daemons

Several daemons scale their feature set to available RAM. They start at a small
`ramOverride`, compute the cost of each tier from lists of ns function names
(`ns.getFunctionRamCost`), pick the highest tier that fits, and `ramOverride` up
to it. The tier lists are the contract with the game's dynamic RAM check; see
`docs/development.md` "RAM discipline".

## Dashboard

`views/dashboard/dashboard.tsx` mounts a React tree into the game's UI using the
game's own React (`lib/react.ts`). Each system has a plugin in
`views/dashboard/tools/<system>.tsx` exposing an overview card and a detail
panel; `state-store.ts` polls the status ports and executes commands. Plugins are
wrapped in error boundaries so one broken panel does not take down the rest.

Tab groups (`TAB_GROUPS` in `dashboard.tsx`): Servers (Home, Nuke, Hack, PServ,
Darkweb), Focus (Focus, Work, Rep, Blade), Factions (Faction, Share, Augs), Money
(Budget, Stocks, Hacknet, Gang, Corp), Tools (Casino, Infiltrate, Contracts). The
Overview tab shows every card with the Advisor's recommendations on top.
