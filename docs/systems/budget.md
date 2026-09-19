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
| `wseCarveoutMult` | `2` | The `wse-access` carve-out fires once cash is at least this many times the price of the next stock API (see below). Read every tick. `0` disables the carve-out. |
| `stocksWeight4S` | `80` | Weight (percent of net worth) the `stocks` bucket is lifted to while the stocks daemon reports 4S data. Read every tick. Never lowers a weight; a bucket frozen or set to 0 stays at 0. `0` disables the lift. |

`writeDefaultConfig` only creates a missing file, so an existing config without
`wseCarveoutMult` silently uses the default.

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

## The `wse-access` carve-out

At 5 percent of cash the `wse-access` bucket would not cover the 5b TIX API
until 100b cash and the 25b 4S TIX API until 500b, long after the stocks
daemon could have been earning. So the budget daemon makes a one-off exception
for that bucket: it reads `hasTIX` and `has4S` from the stocks status port,
works out the price of the next API (`nextWseApiCost` in
`controllers/budget.ts`), and when cash is at least `wseCarveoutMult` times
that price it grants the full price as that cycle's allowance
(`computeCarveout`, applied inside `computeAllowances`). With the default
multiplier the TIX API is bought at 10b cash and 4S at 50b.

Rules:

- The carve-out only raises an allowance; it never lowers one, and it never
  touches another bucket (weights are independent caps).
- It only applies while the bucket's effective weight is above 0. A bucket that
  is done, frozen, set to 0 from the dashboard, or sidelined by another
  bucket's rush gets nothing.
- Once the stocks daemon owns both APIs it calls `signalDone("wse-access")` and
  the bucket drops out as before. If the stocks status port is silent the
  pending price is treated as 0 and the bucket falls back to its weight.

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
