# Budget

Splits liquid money into weighted buckets so the spending daemons do not fight
over cash. Source: `src/daemons/budget.ts` (loop and message handling),
`src/controllers/budget.ts` (weights and allowances), `src/lib/budget.ts`
(the client helpers every consumer uses).

## Run

```
run daemons/budget.js
```

Optional daemon in `start.js`, fixed 4 GB. Bucket weights live in the persisted
state file, not the config file, and are edited from the dashboard.

## Config: `/config/budget.txt`

| Key | Default | Meaning |
|---|---|---|
| `interval` | `2000` | Tick interval (ms). Read once at startup. |
| `reserveShare` | `50` | Percent of cash the savings goal may reserve (see below). The goal is granted at `cost / reserveShare`, twice the price at the default. Read every tick. `0` disables goals. |
| `goalHorizon` | `7200` | Max seconds the savings goal may take to reach its grant point at the estimated income. Items further away are skipped for the next cheapest. Read every tick. `0` disables the check. |
| `paybackHorizon` | `3600` | Seconds a purchase may take to pay for itself. Published on the status port and read by the hacknet daemon (`docs/systems/hacknet.md`); the budget daemon does not use it itself. Read every tick. `0` disables the ceiling. |
| `stocksWeight4S` | `80` | Weight (percent of net worth) the `stocks` bucket is lifted to while the stocks daemon reports 4S data. Read every tick. Never lowers a weight; a bucket frozen or set to 0 stays at 0. `0` disables the lift. |

`writeDefaultConfig` only creates a missing file, so an existing config without
`reserveShare` or `paybackHorizon` silently uses the defaults. `wseCarveoutMult`
is retired: if it is still in the file the daemon prints one line at startup and
ignores it.

## Buckets and default weights

| Bucket | Weight | Consumer | Kind |
|---|---|---|---|
| `stocks` | 30, lifted to `stocksWeight4S` (80) with 4S data | stocks daemon | holder: allowance is a share of net worth minus what it already holds |
| `servers` | 25 | pserv daemon | spender: share of cash |
| `corp` | 22 | corp daemon | holder |
| `home` | 15 | home daemon | spender |
| `gang` | 10 | gang daemon | spender |
| `hacknet` | 5 | hacknet daemon | spender |
| `programs` | 5 | darkweb daemon | spender |
| `wse-access` | 5 | stocks daemon (API purchases) | spender |

Weights are independent caps, not shares: each spender may use up to
`weight` percent of cash on its own, and the weights deliberately sum to more
than 100. A bucket that signals done is inactive and gets weight 0. Rushing a
bucket gives it 100 percent and every other bucket 0 until cancelled. Freezing
saves a bucket's weight and sets it to 0 until unfrozen.

## Why stocks get most of net worth with 4S

With the 4S TIX API the stocks daemon's expected return is known exactly and its
positions unwind in one market tick for the cost of the spread, so the measured
return scales almost linearly with the share of net worth deployed
(`sim/stocks/exp-4s`: 0.016 log-return per 100 ticks at the 30 percent default,
0.047 with all cash). Before 4S the estimated forecast is noisy, so the base
weight stays. Nothing else needs to change for a reset: `actions/install-augments.js`
sells every position before installing, because the game re-initialises the market
on install and would otherwise discard them.

## Savings goal

A spender's allowance is a cap on *current* cash, so an item priced far above its
share could never be bought while the continuous spenders (hacknet, home) keep
taking their cut every tick: SQLInject.exe at 250m under the 5 percent
`programs` weight would need 5b cash. The goal mechanism fixes that without
changing what weights mean.

1. **Signal.** A consumer calls `reportNext(ns, bucket, cost, label)` every cycle
   with the price of the purchase it would make next (`report-next` on the
   control port). Cost 0 clears it. Items live in the daemon's memory only and
   are dropped if not refreshed within two minutes, so a killed consumer stops
   reserving cash and a budget restart waits at most one consumer cycle.
2. **Selection** (`selectGoal`). The cheapest pending item among buckets whose
   effective weight is above zero. Done, frozen, zeroed and rush-sidelined
   buckets can never be the goal. Ties break by bucket name.
3. **Feasibility** (`goalEtaSeconds`, `isGoalFeasible`). Each candidate's ETA is
   the gap between cash and its grant point divided by the estimated income;
   an item further away than `goalHorizon` is skipped for the next cheapest, so
   a 15.8t home upgrade never blocks a 250m program. An item already at its
   grant point always passes. The ETA is optimistic: it ignores what the other
   spenders take from income meanwhile.
4. **Reserve** (`computeReserve`). `reserve = min(cost, cash × reserveShare)`.
   Every spender except the goal bucket gets `(cash − reserve) × weight`.
5. **Grant** (`computeAllowances`). The goal bucket keeps `cash × weight` and is
   lifted to the full price once `reserve >= cost`, which happens at
   `cash = cost / reserveShare`. The consumer's usual `canAfford` then passes.

Worked example at 226m cash with `programs` wanting SQLInject.exe (250m),
hacknet 15 percent, home 10 percent, `reserveShare` 50:

| cash | reserve | hacknet sees | hacknet allowance | programs allowance |
|---|---|---|---|---|
| 226m | 113m | 113m | 17m (34m without a goal) | 11m |
| 400m | 200m | 200m | 30m | 20m |
| 500m | 250m | 250m | 38m | 250m, granted |

Income for the feasibility check comes from the producer daemons' own status
ports, summed each tick (`sumProducerIncome`): hack `incomePerSec`, hacknet
`cashPerSec` (hash rate at the sell rate while the strategy is `money`, else
0), gang `moneyGainRate` and stocks `profitPerSec` (realised profit, so not
tricked by buy and sell traffic). A stale or missing port contributes 0. When
no producer is publishing at all the daemon falls back to a cash trend
(`updateCashTrend`): an exponential moving average, 60 s time constant, of cash
change plus spender-bucket purchases per tick, kept warm every tick. Holder
purchases are excluded from it. The status reports `incomePerSec` and which
`incomeSource` is in force.

Rules:

- Holders (`stocks`, `corp`) are untouched; their cap is a share of net worth.
- A rush overrides everything: while a bucket is rushed there is no goal and no
  reserve.
- Weights keep their meaning as independent caps. The reserve only shrinks the
  cash the other spenders see.
- `wse-access` does not come from a consumer. The budget daemon reads `hasTIX`
  and `has4S` from the stocks status port and injects the next API price
  (`nextWseApiCost`, `nextWseApiLabel`) as that bucket's pending item, so the
  TIX API is bought at 10b cash and 4S at 50b at the default share, as the old
  carve-out did. Once both are owned the stocks daemon signals the bucket done.

Reporters:

| Daemon | Bucket | Reports |
|---|---|---|
| darkweb | `programs` | the TOR router, then the cheapest unowned program |
| home | `home` | the RAM upgrade, then the core upgrade |
| pserv | `servers` | the server it is waiting to buy or upgrade |
| budget (internal) | `wse-access` | the next stock API |

Hacknet, gang, corp and stocks do not report. Hacknet's purchases are many
small ROI-ranked items and use the payback ceiling instead (`paybackHorizon`
above; see `docs/systems/hacknet.md`).

## Protocol for consumers (`lib/budget.ts`)

- `getBudgetBalance(ns, bucket)` or `canAfford(ns, bucket, amount)` before spending. Returns `Infinity` when the budget daemon is not publishing, so consumers keep working without it.
- `notifyPurchase(ns, bucket, amount, reason)` after a successful purchase.
- `signalDone(ns, bucket)` when there is nothing left to buy. Also appends the bucket to `/data/budget-done.txt` so the state survives a restart or startup-order race; `reactivateBucket` reverses it.
- `reportCap(ns, bucket, remainingCost)` to publish the total cost left to fully upgrade.
- `reportNext(ns, bucket, cost, label)` every cycle with the next purchase, so the daemon can save toward it; `0` clears it.
- `getPaybackHorizon(ns)` returns the configured `paybackHorizon` in seconds, or `Infinity` when the budget daemon is not publishing or the ceiling is disabled.
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

Publishes `BudgetStatus` on `STATUS_PORTS.budget`: cash, net worth, holdings,
one `BucketState` per bucket (including `nextCost` and `nextLabel`), the
`rushBucket`, the current `goal` (bucket, label, cost, reserved, progress,
granted, `etaSec`), `incomePerSec` with its `incomeSource`, `goalHorizon` and
`paybackHorizon`. Listens on `BUDGET_CONTROL_PORT` for
`purchased`, `done`, `report-cap`, `report-next`, `rush`, `cancel-rush`,
`update-weight`, `reset-weights`, `reactivate`, `freeze`, `unfreeze`.
Dashboard: Money group, Budget tab, with the income estimate in the header, a
"Saving for" progress bar with the ETA, a Next column in the details table, weight sliders, rush, freeze, and a Firesale
button that runs `actions/firesale.js`. The tab does not yet show reported
caps.
