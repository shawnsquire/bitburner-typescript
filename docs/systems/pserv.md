# Personal servers

Buys and upgrades purchased servers through the v3 `ns.cloud` API. Source:
`src/daemons/pserv.ts` (loop), `src/controllers/pserv.ts` (planning).

## Run

```
run daemons/pserv.js [--one-shot] [--min-ram <GB>] [--reserve <$>] [--interval <ms>]
```

Optional daemon in `start.js`, about 6 GB. Exits when every slot is filled
and every server is at the configured or game maximum. It also exits at
startup, after printing one line and signalling the `servers` budget bucket
done, when the game allows zero purchased servers (`ns.cloud.getServerLimit()`
is 0, as in BitNode 9); `getPservStatus` reports this as `purchasingDisabled`.

## Config: `/config/pserv.txt`

| Key | Default | Meaning |
|---|---|---|
| `autoBuy` | `true` | Buy and upgrade. `false` is monitor mode. `start.js` seeds this on a fresh install; `firesale.js` sets it false. |
| `prefix` | `pserv` | Hostname prefix. |
| `minRam` | `8` | Smallest server to buy (GB). |
| `maxRam` | `0` | RAM cap per server; 0 means the game maximum. |
| `reserve` | `0` | Money to keep untouched. |
| `interval` | `10000` | Cycle interval (ms). |
| `oneShot` | `false` | One cycle and exit. |

## Behaviour

- Batch purchase plan: pick the RAM tier that maximises total RAM across the
  open slots within budget.
- Upgrades target the smallest server first; the cost is the game's upgrade
  cost (price of the new size minus the current one).
- When a cycle cannot afford anything it reports the blocking purchase (the
  next server, or the smallest server's upgrade) with `reportNext`, so the
  budget daemon can save toward it. The `reserve` config key above is cash the
  daemon keeps untouched and is unrelated to the budget daemon's goal reserve.
- Spending goes through the `servers` budget bucket. The daemon reports the
  cost left to reach the cap, and signals done when everything is maxed;
  disabling `autoBuy` releases the bucket's weight.

## Ports and dashboard

Publishes `PservStatus` on `STATUS_PORTS.pserv`. Dashboard: Servers group,
PServ tab, with a 5 by 5 server grid, a RAM cap selector, and the auto or
monitor toggle. The tab reflects the config file.
