# Augments

Plans augmentation purchases, NeuroFlux Governor levels and donations, and
installs. Source: `src/daemons/augments.ts` (status daemon),
`src/controllers/factions.ts` (purchase math), `src/actions/*augment*.ts`.

## Daemon

```
run daemons/augments.js [--interval ms] [--one-shot]
```

Optional daemon in `start.js`. Requires SF4; exits with a warning otherwise.
Not tiered, so it needs its full static cost up front:

| SF4 level | RAM |
|---|---|
| 0 or 1 | about 437 GB |
| 2 | about 109 GB |
| 3, or inside BitNode 4 | about 32 GB |

Config `/config/augments.txt`: `interval` (default `3000`), `oneShot` (default
`false`). Publishes `AugmentsStatus` on `STATUS_PORTS.augments`. Dashboard:
Factions group, Augs tab, with a buy-selected control.

## Purchase order

Augmentations are bought most expensive first, because every purchase raises
the price of the next by 1.9x and the multiplier compounds. The planner shows
the adjusted price at each position in the queue. Prerequisites are ordered
before dependants and sequential-faction chains are respected.

NeuroFlux Governor level is read from `getResetInfo().ownedAugs`, which is the
per-augmentation level the game uses.

## Actions

| Command | Purpose |
|---|---|
| `run actions/purchase-augments.js [--dry-run] [--max-spend N] [--only '["A","B"]']` | Buy affordable augmentations in priority order. `--only` restricts the set and recomputes the multiplier chain for it. |
| `run actions/purchase-neuroflux.js [--faction NAME] [--dry-run] [--max-levels N]` | Buy as many NFG levels as rep and money allow. `--faction` restricts eligibility and the plan to that faction. |
| `run actions/neuroflux-donate.js [--confirm] [--reserve N]` | Donate for rep at a faction past the favor threshold, then buy NFG. Dry-run without `--confirm`. |
| `run actions/install-augments.js [--confirm] [--script NAME]` | Install and reset. Sells every stock position first (the game re-initialises the market on install, which would discard them), then seeds `hack.strategy=money`, `work.focus=hacking`, `focus.holder=work`, `pserv.autoBuy=true` for the next run. About 91 GB at SF4.1. |
| `run actions/firesale.js` | Pre-install liquidation: sells stocks, sells hacknet hashes for money, stops spending daemons, sets `hack.strategy=drain` and `pserv.autoBuy=false`. |
| `run tools/info/augments.js` | Installed and pending augmentations with their stat bonuses. |
