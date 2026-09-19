# Rep

Tracks faction reputation and favor, picks the next augmentation worth working
toward, and at the top tier does the faction work itself. Source:
`src/daemons/rep.ts` (loop), `src/controllers/factions.ts` (augment and
reputation logic, shared with the augments system).

## Run

```
run daemons/rep.js [--tier lite|basic|target|analysis|planning|prereqs|auto-work]
```

Core daemon in `start.js`. Seven tiers, roughly 5, 34, 114, 194, 274, 354 and
415 GB at SF4 level 0. Only the top tier, auto-work, calls `workForFaction`; the
others add progressively more analysis (target selection, prerequisite
planning, donation planning).

## Config: `/config/rep.txt`

| Key | Default | Meaning |
|---|---|---|
| `faction` | empty | Force a target faction instead of the computed one. |
| `noWork` | `false` | Analyse only, never start faction work. |
| `noKill` | `false` | Do not kill other scripts to reach a higher tier. |
| `interval` | `2000` | Cycle interval (ms). |
| `oneShot` | `false` | One cycle and exit. |

Reads `holder` and `sleeveHolder` from `/config/focus.txt`; auto-work yields
when another daemon holds the focus.

## Target selection

The next target is the cheapest augmentation, by reputation gap, from a faction
you can work for. Gang factions and factions with no work are excluded. Work type
(hacking, field, security) is chosen per faction from what the faction offers.
Donation becomes an option at the game's favor threshold, read from
`getFavorToDonate`.

## Ports and dashboard

Publishes `RepStatus` on `STATUS_PORTS.rep` and `BitnodeStatus` on
`STATUS_PORTS.bitnode`. Dashboard: Focus group, Rep tab, with start-work and
restart controls.

## Actions

| Command | Purpose |
|---|---|
| `run actions/work-for-faction.js --faction NAME --type hacking\|field\|security [--focus]` | Start faction work. |
| `run actions/check-faction-rep.js [--faction NAME]` | One-shot partial status for the highest-rep faction when the daemon is off. |
