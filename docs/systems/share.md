# Share

Fills spare RAM with `share()` threads to boost faction reputation gain while
the rep daemon is working. Source: `src/daemons/share.ts` (loop),
`src/controllers/share.ts` (capacity and launch), `src/workers/share.js`.

## Run

```
run daemons/share.js [--tier active|monitor] [--one-shot] [--min-free <GB>] [--home-reserve <GB>] [--interval <ms>]
```

Core daemon in `start.js`. Two tiers, chosen from the focus config unless
`--tier` forces one:

| Tier | When | RAM |
|---|---|---|
| monitor | `holder` in `/config/focus.txt` is not `rep` | about 4 GB |
| active | `holder` is `rep` | about 9 GB |

The daemon respawns itself when the holder changes.

## Config: `/config/share.txt`

| Key | Default | Meaning |
|---|---|---|
| `minFree` | `4` | GB to leave free on each server. |
| `homeReserve` | `32` | GB to leave free on home. |
| `targetPercent` | `0` | 0 is greedy (all spare RAM). 1 to 100 caps share threads to that percent of each server's usable RAM, counting threads already running. Used only when the hack daemon has not published a fleet allocation. |
| `interval` | `10000` | Cycle interval (ms). |
| `oneShot` | `false` | One cycle and exit. |

## Behaviour

- If the hack daemon publishes a `FleetAllocation` on `STATUS_PORTS.fleet`,
  share runs only on the servers assigned to it.
- Share workers are the first kill tier, so anything that needs RAM takes it
  from them first.

## Ports and dashboard

Publishes `ShareStatus` on `STATUS_PORTS.share`. Dashboard: Factions group,
Share tab, with a target-percent control that restarts the daemon.
