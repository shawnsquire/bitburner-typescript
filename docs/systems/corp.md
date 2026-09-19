# Corporation

Directive-driven automation of a three-division corporation (Agriculture,
Chemical, Tobacco) from creation to dividends. Source: `src/daemons/corp.ts`
(loop), `src/controllers/corp.ts` (industry data, scoring, planning),
`src/actions/corp/*.ts` (manual one-shots).

## Run

```
run daemons/corp.js
```

Optional daemon in `start.js`, skipped when `enabled=false`. Tiered, capped by
the `tier` config key.

| Tier | Name | Adds | RAM at SF4 level 0 |
|---|---|---|---|
| 0 | monitor | Status and directive evaluation | about 120 GB |
| 1 | manage | Employees, office size, sell orders, tea, products, upgrades, materials, research, AdVert, dividends, exports | about 470 GB |
| 2 | invest | Corp creation, division and city expansion, investment rounds, going public, unlocks, shares | about 620 GB |

## Directives

| Directive | Goal | Advances when |
|---|---|---|
| `bootstrap` | Create the corp, three divisions in all cities, warehouses, unlocks, first investment rounds | divisions and unlocks exist and investment round is at least 2 |
| `scale` | Upgrades, products, research, AdVert | public, profit above 1t/s, Wilson Analytics at level 10 |
| `harvest` | Dividends at `dividendRate`, share management | never regresses |

Set `pinDirective=true` to stop auto-advancing. Expensive one-shot actions
(accept investment, go public) are queued with a countdown so the dashboard can
show and cancel them.

## Config: `/config/corp.txt`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Disable to publish a disabled status and mark the `corp` budget bucket done. |
| `tier` | `2` | Highest tier allowed. |
| `directive` | `bootstrap` | Current directive. |
| `pinDirective` | `false` | Hold the directive. |
| `countdownSeconds` | `60` | Delay before executing a queued pending action. |
| `dividendRate` | `0.1` | Dividend rate during harvest. |
| `productInvestPct` | `0.1` | Fraction of funds per new product, split between design and marketing. |
| `autoTea` | `true` | Buy tea and throw parties when energy or morale drops. |
| `officeUpgradeReserveMult` | `10` | Grow an office only when corporation funds are at least this many times the upgrade cost. |
| `officeMaxSize` | `30` | Stop growing offices at this many seats. |
| `corpName` | `NovaCorp` | Name at creation. |
| `interval` | `10000` | Fallback sleep (ms) if `nextUpdate` fails. |

## Office size

Every office opens with three seats. Each tick at tier 1 or above the daemon
looks at every office below `officeMaxSize`, picks the one with the fewest
seats (ties keep division then city order), and adds three seats (fewer for the
last step up to the cap) when corporation funds are at least
`officeUpgradeReserveMult` times the upgrade cost. One upgrade per tick; the
office is then hired to full and jobs are redistributed in the same tick by the
normal employee logic. `selectOfficeUpgrade` in `controllers/corp.ts` makes the
choice; the cost formula is copied from the game and tested against it.

The upgrade spends corporation funds, never the player budget, and runs in
every directive. It waits for the Smart Supply and Office API unlocks (the API
throws without the latter) and is skipped while spending is frozen for an
investment offer. The reserve multiple is what keeps it from starving
bootstrap: the first step costs about 4.4b, so it needs 44b on hand.

## Budget

The `corp` bucket funds creation; after investment round 2 the daemon signals
the bucket done and the corporation funds itself. Office upgrades do not draw
on the bucket.

## Ports and dashboard

Publishes `CorpStatus` on `STATUS_PORTS.corp`. `CORP_CONTROL_PORT` accepts
set-directive, cancel-pending, set-dividend-rate, toggle-auto-tea, pin,
restart; most of these take effect through the config file, which the dashboard
writes. Dashboard: Money group, Corp tab, with sections that change per
directive.

## Known gaps

- Research is selected as a serial chain although the game's tree is mostly
  siblings, so research points can sit unused.

## Manual actions

Each is a standalone one-shot costing 20 to 65 GB, for intervening when the
daemon is off or the directive is pinned.

| Command |
|---|
| `run actions/corp/create-corp.js` |
| `run actions/corp/expand-division.js`, `expand-city.js` (buys the warehouse too) |
| `run actions/corp/hire-employees.js`, `upgrade-office.js`, `buy-materials.js`, `buy-upgrade.js` |
| `run actions/corp/make-product.js`, `set-dividends.js` |
| `run actions/corp/accept-investment.js`, `go-public.js` |

See each file's header for flags.
