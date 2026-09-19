# Infiltration

Drives the game's infiltration UI: travels to the company, clicks through,
solves each mini-game from the DOM, and takes the reward. Source:
`src/daemons/infiltration.ts` (state machine), `src/lib/infiltration/navigation.ts`
(UI navigation), `src/lib/infiltration/solvers/*.ts` (one solver per
mini-game, unit tested against a fake DOM), `src/lib/dom.ts` (trusted click
and key helpers shared with the casino script).

## Run

```
run daemons/infiltration.js
```

Started on demand from the dashboard; not in the default start config because
it takes over the screen. Not tiered: about 65 GB below SF4 level 3, about
20 GB at level 3 or in BitNode 4 (the cost is `getFactionRep` and
`travelToCity`).

## Config: `/config/infiltration.txt`

| Key | Default | Meaning |
|---|---|---|
| `rewardMode` | `rep` | `rep` trades the reward for reputation with the rep daemon's current target faction (falls back to `money` when there is none), `money` sells it, `manual` stops at the reward screen. |

Target company and the enabled-solver list are set at runtime through the
control port and are not persisted.

## Solvers

Slash, backward string, brackets, bribe, cheat code, cyberpunk, minesweeper,
wire cutting. Each solver has `detect` and `solve`; they read the game's
React DOM and send trusted key and click events. A ninth entry, remembering,
never matches and exists only to keep an older registry id.

## Ports and dashboard

Publishes `InfiltrationStatus` on `STATUS_PORTS.infiltration`; reads
`STATUS_PORTS.rep` for the target faction. Control port
`INFILTRATION_CONTROL_PORT` accepts `{action:"stop"}` and
`{action:"configure", target?, rewardMode?, solvers?}`. Dashboard: Tools
group, Infiltrate tab. The daemon also draws a small overlay on the game
screen with progress, a reward-mode selector and a stop-after-run button.

## Related

`run tools/info/infiltration-list.js` lists locations by difficulty with rep
per clearance level, about 15 GB.
