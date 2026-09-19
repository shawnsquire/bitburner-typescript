# Home

Monitors and upgrades home RAM and cores. Source: `src/daemons/home.ts`.

## Run

```
run daemons/home.js
```

Optional daemon in `start.js`. Three effective tiers:

| Tier | What | RAM |
|---|---|---|
| no SF4 | Read-only; never calls Singularity | about 5.5 GB |
| monitor | Reads upgrade costs | 8 to 55 GB depending on SF4 level |
| auto | Buys upgrades | 15 to 150 GB depending on SF4 level |

The whole script's static cost is 149 GB at SF4 level 0, 41 GB at level 2 and
14 GB at level 3; the tier logic only reserves what the chosen tier needs.

Exits once RAM and cores are both at their maximum. The BitNode option
`restrictHomePCUpgrade` (128 GB, one core) is respected.

## Config: `/config/home.txt`

| Key | Default | Meaning |
|---|---|---|
| `interval` | `10000` | Cycle interval (ms). |
| `autoBuy` | `true` | Buy upgrades when the `home` budget bucket allows. |

## Ports and dashboard

Publishes `HomeStatus` on `STATUS_PORTS.home`. Reports remaining upgrade cost
to the budget daemon as the bucket cap, and the next upgrade (RAM before cores)
as the bucket's savings goal with `reportNext` while `autoBuy` is on. Dashboard: Servers group, Home tab,
with an auto-buy toggle.
