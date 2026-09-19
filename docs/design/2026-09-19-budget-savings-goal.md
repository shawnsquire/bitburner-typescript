# Budget: savings goal and hacknet payback ceiling

Design agreed 2026-09-19. Implemented in commits e5905d6..3e29c7d (budget core, dashboard, consumers, hacknet ceiling).

## Problem

The budget model (`docs/systems/budget.md`) gives every spender bucket an allowance of
`cash × weight` recomputed each tick. That is a cap on current cash, not a fund that
fills. An item of price P under weight w can only be bought once cash reaches P / w:
SQLInject.exe at 250m under the 5 percent `programs` weight needs 5b cash.

At the same time the continuous spenders have no stopping rule. The hacknet daemon
buys the highest-ROI candidate it can afford, re-reads its allowance, and repeats up
to a hundred times per tick with no payback ceiling. Home does the same. Two sinks
each taking a fixed fraction of cash every tick means cash asymptotes and the P / w
threshold never arrives. Rush works only because it turns both problems off by hand.

The `wse-access` carve-out (commit b5c167b) is already the right fix for one bucket:
"when cash covers k times the next price, grant the price". This design generalizes
it and gives the continuous sinks a stopping rule.

Rejected alternatives:

- **Monte Carlo balancing.** Hacknet returns are closed-form
  (`formulas.hacknetServers`), stock returns with 4S are known, program prices are
  fixed. The only uncertain input is the value of an unlock, which is better
  estimated from the server list than by sampling.
- **Common-currency allocator** (every bucket reports payback time, budget funds the
  best next item greedily). Right long term, but a rewrite touching every consumer.
  Commit 79d0986 pulled an earlier ROI allocator because it split cash
  *proportionally* by ROI score (stocks got 91 percent); greedy-with-horizon is a
  different operator, but it is still out of scope here.
- **Per-bucket soft reserves** (`min(price, cash × weight)` for every pending item).
  The reserve never exceeds the weight share, so a 250m item still needs 5b cash.

## Section 1: savings goal in the budget daemon

### Signal

New control action `report-next` on `BUDGET_CONTROL_PORT`:

```ts
{ action: "report-next", bucket: string, amount: number, reason?: string }
```

`lib/budget.ts` gains `reportNext(ns, bucket, cost, label)`. Consumers send it every
cycle; `cost` 0 clears the item. The daemon keeps pending items in memory only,
keyed by bucket, as `{ cost, label, at }`, and drops any entry not refreshed within
`PENDING_STALE_MS` (120 000). Nothing is persisted; a budget restart waits at most one
consumer cycle.

### Selection

Pure, in `controllers/budget.ts`:

```ts
selectGoal(pending: Record<string, PendingItem>, effectiveWeights: Record<string, number>): Goal | null
```

Cheapest pending item among buckets whose effective weight is above zero. Done,
frozen, zeroed, and rush-sidelined buckets can never be the goal. Ties break by
bucket name for determinism.

The wse-access carve-out folds into this path. The budget daemon already derives the
next API price from the stocks status port (`nextWseApiCost`); it injects that as
wse-access's pending item before selection. `computeCarveout` and the `carveouts`
parameter of `computeAllowances` are removed.

### Reserve and grant

One config key in `/config/budget.txt`: `reserveShare` (percent of cash, default 50,
read every tick, 0 disables goals). With `share = reserveShare / 100`:

```
reserve   = goal ? min(goal.cost, cash × share) : 0
granted   = reserve >= goal.cost
```

- Every spender except the goal bucket uses `cash − reserve` as its base:
  `allowance = (cash − reserve) × weight`.
- The goal bucket's allowance is `max(cash × weight, granted ? goal.cost : 0)`.
- The grant therefore fires at `cash = cost / share`, twice the price at the default,
  which reproduces the old `wseCarveoutMult = 2` behaviour. `wseCarveoutMult` is
  retired; if present in an existing config it is ignored with one startup log line.
- Holders (stocks, corp) are unchanged: their cap is a share of net worth.
- Rush is unchanged and overrides the goal (no reserve while a bucket is rushed).
- Weights keep their meaning as independent caps.

Worked example at the screenshot that prompted this (cash 226m, programs wants
SQLInject at 250m, hacknet 15 percent, home 10 percent):

| cash | reserve | hacknet sees | hacknet allowance | programs allowance |
|---|---|---|---|---|
| 226m | 113m | 113m | 17m (was 34m) | 11m |
| 400m | 200m | 200m | 30m | 20m |
| 500m | 250m | 250m | 38m | 250m (granted) |

### Status and dashboard

`BudgetStatus` gains:

```ts
goal: { bucket: string; label: string; cost: number; reserved: number; progress: number } | null;
paybackHorizon: number;   // section 3
```

`BucketState` gains `nextCost: number` and `nextLabel: string | null`. The Budget tab
shows a "Saving for <label> (<bucket>)" line with a progress bar above the allowance
bars, and the next item in each bucket's row.

## Section 2: consumers that report a next item

Each gains one `reportNext` call per cycle; the buying logic is untouched.

| Daemon | Bucket | Reports | Clears |
|---|---|---|---|
| darkweb | programs | cheapest unowned program (`getDarkwebStatus().nextProgram`) | when all programs are owned, before `signalDone` |
| home | home | whichever of the RAM or core upgrade it would buy first, in the daemon's existing order | when both are maxed |
| pserv | servers | cost of the first entry in its upgrade plan, the one it checks `canAfford` against | when the plan is empty |
| (budget daemon) | wse-access | next stock API price, injected internally | when both APIs are owned |

Not reporting: hacknet (many small ROI-ranked items; section 3 instead), gang (cheap,
continuous), corp and stocks (holders).

Rules for reporters:

- Report only the item you would actually buy next, so the dashboard label is always
  the real blocker.
- Keep calling `canAfford` before buying; the grant makes that check pass, nothing
  else changes.
- `reportNext` is a port write like `notifyPurchase`; when the budget daemon is
  absent the consumer sees `Infinity` from `getBudgetBalance` and spends freely, as
  today.

## Section 3: hacknet payback ceiling

### Knob

`paybackHorizon` in `/config/budget.txt`, seconds, default 3600, read every tick,
published on `BudgetStatus.paybackHorizon`. `lib/budget.ts` gains
`getPaybackHorizon(ns)`, returning `Infinity` when the budget daemon is absent so
hacknet behaves exactly as today without it.

### Valuation

New pure helper in `controllers/hacknet.ts`:

```ts
paybackSeconds(cost: number, marginalMoneyPerSec: number): number   // Infinity when rate <= 0
```

- Hacknet servers: marginal hash rate × 250 000 (the "Sell for Money" upgrade costs 4
  hashes and pays 1e6, `src/Hacknet/data/HashUpgradesMetadata.tsx` in the game checkout). Valued at the sell rate regardless of the active
  hash strategy, since hashes are fungible.
- Plain hacknet nodes (outside BN9 without SF9): `formulas.hacknetNodes.moneyGainRate`
  delta. Note the current `evaluateUpgrades` uses `hashGainRate` for both; the node
  branch is added here.
- Without Formulas.exe the existing rough estimate is used.

### Rule

In the buy loop, skip any candidate whose payback exceeds the horizon, with two
exemptions: the first node is always bought, and cache upgrades are exempt while hash
utilisation is above 90 percent (they protect income rather than add it). When every
candidate is over the horizon the daemon buys nothing that tick.

### Status

`HacknetStatus` gains `skippedForPayback: number` and `bestPaybackSec: number | null`
(the shortest payback it declined). The Hacknet tab shows
"waiting: best payback 2.3h > 1h horizon" when nothing was bought for that reason.

## Section 4: tests, docs, rollout

### Unit tests (`test/controllers/budget.test.ts`, new `test/controllers/hacknet-payback.test.ts`)

Budget:

- `selectGoal`: cheapest wins; ineligible (done, frozen, zero weight, rushed-out)
  buckets never win; empty pending returns null; deterministic tie-break.
- Reserve: capped by share; zero when no goal or share is 0; grant fires exactly at
  `cost / share` and above.
- `computeAllowances` with a goal: non-goal spenders see `cash − reserve`; goal
  bucket gets `max(cash × w, cost)` once granted; holders unchanged; rush overrides
  and zeroes the reserve.
- wse-access via the goal path at share 50 reproduces every case in the existing
  "computeAllowances with the wse-access carve-out" describe block; that block is
  rewritten, not kept.

Hacknet: payback maths, Infinity on non-positive rate, skip over horizon, cache
exemption at high utilisation, first-node exemption, everything bought when the
horizon is Infinity.

`test/tooling/ram.test.ts` invariants: hacknet's tier lists must include any new ns
call (`formulas.hacknetNodes.moneyGainRate` if referenced). `reportNext` in
`lib/budget.ts` uses `ns.getPortHandle` only, already in every consumer's cost.

### Docs

- `docs/systems/budget.md`: `reserveShare` and `paybackHorizon` keys; `wseCarveoutMult`
  listed as retired; the carve-out section replaced by a "Savings goal" section;
  `reportNext` and `getPaybackHorizon` added to the protocol list; status fields.
- `docs/systems/hacknet.md`: horizon, valuation, exemptions, new status fields.
- `docs/systems/darkweb.md`, `home.md`, `pserv.md`: one line each on what they report.
- `docs/architecture.md` budget paragraph: mention the goal.

### Rollout

One change set, no feature flag. Existing state files need no migration (pending
items are not persisted). An existing config with `wseCarveoutMult` logs one line and
continues. Verify in game on BN9: with `reserveShare=50` and the daemons running, the
Budget tab should show "Saving for SQLInject.exe" and cash should climb toward 500m
instead of plateauing; the Hacknet tab should show the waiting reason once its
upgrades pass the horizon.

## Out of scope, noted for later

- Hacknet reporting its best unaffordable upgrade as a goal (big node purchases).
- Applying the horizon to gang equipment and corp spending.
- Deriving the horizon from time-to-next-install once the augments daemon publishes
  an ETA.
- The common-currency allocator.

## Addendum 2026-09-19: goal feasibility

Observed after shipping: with programs and servers done, home's next upgrade
(131 TB, 15.8t) became the goal at 87m cash. The reserve locked half of a cash
pile that would never reach the 31.6t grant point, and hacknet only saw the
other half. The selector had no feasibility check.

Decisions:

- **Income from producers.** The budget daemon sums the rates the producer
  daemons already publish: hack `incomePerSec`, gang `moneyGainRate`, stocks
  `profitPerSec` (realised, so not tricked by buy/sell traffic), plus a new
  hacknet `cashPerSec` (hash rate at the sell rate under the `money` strategy,
  0 otherwise). A stale or missing port contributes 0.
- **Cash-trend fallback.** An exponential moving average (60 s time constant)
  of cash change plus spender-bucket purchases per tick, kept warm every tick
  and used only when no producer port is fresh. Holder purchases are excluded.
  Cash-flow estimation was rejected as the primary source because trading
  flow tricked an earlier version of it.
- **`goalHorizon`** config key, default 7200 s, 0 disables. ETA to the grant
  point is `max(0, cost / share − cash) / income`; an item whose ETA exceeds
  the horizon is skipped and the next cheapest is considered. An item already
  at its grant point always passes, even with zero income. The ETA ignores what
  other spenders take from income and is documented as optimistic.
- **Surface.** `BudgetStatus` gains `incomePerSec`, `incomeSource`
  (`producers` | `cash-trend`) and the goal's `etaSec`; the Budget tab shows the
  ETA on the goal line and the income line in the header.
- Rejected: a cash-multiple cap (refuses the 25b 4S API at 100m cash even when
  income makes it minutes away); reusing `paybackHorizon` (different question).
