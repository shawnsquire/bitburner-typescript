# Hacknet

Buys and upgrades hacknet nodes or servers by return on investment and spends
hashes according to a strategy. Source: `src/daemons/hacknet.ts`.

## Run

```
run daemons/hacknet.js
```

Optional daemon in `start.js`. Tiered; needs 8 GB to launch.

| Tier | Name | Adds | RAM |
|---|---|---|---|
| 0 | monitor | Node stats, hash counts, upgrade costs | about 8 GB |
| 1 | auto-buy | Purchase and upgrade functions | about 11 GB |
| 2 | hash-spender | `hashCost`, `spendHashes` | about 12 GB |

Every hacknet function costs 0.5 GB in v3. Outside BitNode 9 without Source-File
9 there are only money-producing nodes and no hashes; the daemon still runs and
the hash features are no-ops.

## Config: `/config/hacknet.txt`

| Key | Default | Meaning |
|---|---|---|
| `interval` | `5000` | Cycle interval (ms). |
| `autoBuy` | `true` | Buy and upgrade automatically. |
| `maxServers` | `20` | Cap on nodes or servers. |
| `spendStrategy` | `money` | What to buy with hashes: `money`, `study`, `gym`, `bladeburner-rank`, `bladeburner-sp`, `coding-contract`. |
| `spendThreshold` | `0.5` | For strategies other than `money`, wait until hash capacity is this full. `money` sells immediately. |
| `reserveHashes` | `0` | Hashes to keep unspent. |
| `allowWorkers` | `false` | Read by the hack daemon: whether hacknet servers may host hacking workers. |

## Purchasing

Candidates (new node, level, RAM, cores, cache) are ranked by hash rate gained
per dollar using `formulas.hacknetServers`. The first node is bought without
ranking. Spending goes through the `hacknet` budget bucket, and the daemon
reports the remaining cost to fully upgrade as the bucket's cap.

## Ports and dashboard

Publishes `HacknetStatus` on `STATUS_PORTS.hacknet`. Dashboard: Money group,
Hacknet tab, with a strategy selector and the next planned purchase.
