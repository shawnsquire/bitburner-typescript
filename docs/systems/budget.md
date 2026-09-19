# Budget

Splits liquid money into weighted buckets so the spending daemons do not fight
over cash. Source: `src/daemons/budget.ts` (loop and message handling),
`src/controllers/budget.ts` (weights and allowances), `src/lib/budget.ts`
(the client helpers every consumer uses).

## Run

```
run daemons/budget.js
```

Optional daemon in `start.js`, fixed 4 GB. Config `/config/budget.txt` has one
key, `interval` (default `2000` ms). Bucket weights live in the persisted state
file, not the config file, and are edited from the dashboard.

## Buckets and default weights

| Bucket | Weight | Consumer | Kind |
|---|---|---|---|
| `stocks` | 30 | stocks daemon | holder: allowance is a share of net worth minus what it already holds |
| `servers` | 25 | pserv daemon | spender: share of cash |
| `corp` | 22 | corp daemon | holder |
| `home` | 15 | home daemon | spender |
| `gang` | 10 | gang daemon | spender |
| `hacknet` | 5 | hacknet daemon | spender |
| `programs` | 5 | darkweb daemon | spender |
| `wse-access` | 5 | stocks daemon (API purchases) | spender |

Weights are normalised over active buckets only. A bucket that signals done is
inactive and its weight is redistributed. Rushing a bucket routes every active
weight to it until cancelled. Freezing keeps a bucket's weight but stops
recomputation.

## Protocol for consumers (`lib/budget.ts`)

- `getBudgetBalance(ns, bucket)` or `canAfford(ns, bucket, amount)` before spending. Returns `Infinity` when the budget daemon is not publishing, so consumers keep working without it.
- `notifyPurchase(ns, bucket, amount, reason)` after a successful purchase.
- `signalDone(ns, bucket)` when there is nothing left to buy. Also appends the bucket to `/data/budget-done.txt` so the state survives a restart or startup-order race; `reactivateBucket` reverses it.
- `reportCap(ns, bucket, remainingCost)` to publish the total cost left to fully upgrade.
- `setBudgetWeight(ns, bucket, weight)` to change a weight, 0 to release it while pausing.

All consumers in the repo (pserv, gang, corp, home, darkweb, hacknet, stocks)
were checked against this protocol and match.

## State and reset detection

Persisted to `/data/budget-balances.json`: lifetime spend per bucket, weights,
active flags, caps, rush bucket, frozen weights. A cash drop of more than 90
percent between ticks is treated as an augmentation reset and zeroes the
lifetime counters. `start.js` marks the `corp` bucket done when the corp system
is disabled.

## Ports and dashboard

Publishes `BudgetStatus` on `STATUS_PORTS.budget`. Listens on
`BUDGET_CONTROL_PORT` for `purchased`, `done`, `report-cap`, `rush`,
`cancel-rush`, `update-weight`, `reset-weights`, `reactivate`, `freeze`,
`unfreeze`. Dashboard: Money group, Budget tab, with weight sliders, rush,
freeze, and a Firesale button that runs `actions/firesale.js`. The tab does not
yet show reported caps.
