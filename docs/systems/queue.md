# Queue and actions

The queue daemon runs one-shot action scripts on behalf of the dashboard and
other daemons, freeing RAM for them when asked, and rotates a set of status
checks while idle. Source: `src/daemons/queue.ts`, `src/lib/ports.ts` (queue
helpers), `src/lib/launcher.ts` (`queueExec`), `src/types/ports.ts`
(`QueueEntry`, `PRIORITY`, `KILL_TIERS`).

## Run

```
run daemons/queue.js
```

Core daemon in `start.js`, about 4 GB. Config `/config/queue.txt`:

| Key | Default | Meaning |
|---|---|---|
| `interval` | `2000` | Sleep between ticks (ms). |
| `scriptTimeout` | `30000` | How long to wait for a queued script before moving on (ms). |

## Queue entries

Anything can enqueue by writing a `QueueEntry` JSON to `QUEUE_PORT`, usually
through `queueExec(ns, script, args, priority, mode, requester, manualFallback)`
in `lib/launcher.ts` or `queueAction` in `lib/ports.ts`.

| Field | Meaning |
|---|---|
| `script`, `args` | What to run on home with one thread. |
| `priority` | `PRIORITY.CRITICAL` 10 (install or purchase augments), `USER_ACTION` 8, `STATUS_CHECK` 5, `NICE_TO_HAVE` 3. Higher runs first. |
| `mode` | `queue`: skip this tick if RAM is short. `force`: kill lower-priority processes through the kill tiers, run, then relaunch what was killed. |
| `requester` | Shown in the log. |
| `manualFallback` | Command printed to the terminal if RAM cannot be freed. |

Each tick drains the whole queue, sorts by priority, and runs entries one at a
time, waiting up to `scriptTimeout` for each. A script that is already running
with the same arguments counts as handled.

## Kill tiers

`KILL_TIERS` lists what may be sacrificed for RAM, in order: hack, grow, weaken
and share workers; then `daemons/share.js`; then the dashboard. `force` mode
walks all three tiers. `start.js` and `tools/control/launch.js` use the same
walker.

## Status-check rotation

When the queue is empty the daemon runs one of these per tick, in order:

| Script | Publishes |
|---|---|
| `actions/check-work.js` | `STATUS_PORTS.work` when the work daemon is not running. |
| `actions/check-darkweb.js` | `STATUS_PORTS.darkweb` when the darkweb daemon is not running. |
| `actions/check-factions.js` | `STATUS_PORTS.faction` when the faction daemon is not running. |
| `actions/check-territory.js --all` | `STATUS_PORTS.gangTerritory` for the gang daemon. |

## Actions

One-shot scripts under `src/actions/`. Each page under `docs/systems/` lists
the actions for its system with flags and RAM. The general rules:

- Actions hard-code the enum strings they need rather than importing controllers, to keep their RAM down.
- Actions that spend money or reset the game take `--confirm` or `--dry-run`.
- Actions never loop; if you need something repeated, it belongs in a daemon.
