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
| 1 | manage | Employees, sell orders, tea, products, upgrades, materials, research, AdVert, dividends, exports | about 450 GB |
| 2 | invest | Corp creation, division and city expansion, investment rounds, going public, unlocks, shares | about 600 GB |

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
| `corpName` | `NovaCorp` | Name at creation. |
| `interval` | `10000` | Fallback sleep (ms) if `nextUpdate` fails. |

## Budget

The `corp` bucket funds creation; after investment round 2 the daemon signals
the bucket done and the corporation funds itself.

## Ports and dashboard

Publishes `CorpStatus` on `STATUS_PORTS.corp`. `CORP_CONTROL_PORT` accepts
set-directive, cancel-pending, set-dividend-rate, toggle-auto-tea, pin,
restart; most of these take effect through the config file, which the dashboard
writes. Dashboard: Money group, Corp tab, with sections that change per
directive.

## Known gaps

- Office size is never upgraded, so every office stays at three employees.
- Research is selected as a serial chain although the game's tree is mostly
  siblings, so research points can sit unused.

## Manual actions

Each is a standalone one-shot costing 20 to 40 GB, for intervening when the
daemon is off or the directive is pinned.

| Command |
|---|
| `run actions/corp/create-corp.js` |
| `run actions/corp/expand-division.js`, `expand-city.js` (buys the warehouse too) |
| `run actions/corp/hire-employees.js`, `buy-materials.js`, `buy-upgrade.js` |
| `run actions/corp/make-product.js`, `set-dividends.js` |
| `run actions/corp/accept-investment.js`, `go-public.js` |

See each file's header for flags.
