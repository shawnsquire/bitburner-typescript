# Gang

Runs a combat gang: task assignment, recruitment, wanted-level control,
equipment, ascension and territory warfare. Source: `src/daemons/gang.ts`
(loop), `src/controllers/gang.ts` (decisions), `src/actions/check-territory.ts`.

## Run

```
run daemons/gang.js [--strategy grow|respect|money|territory|balanced] [--no-kill]
```

Optional daemon in `start.js`. Tiered; re-checks every ten cycles and respawns
into a higher tier when RAM frees up.

| Tier | Name | Adds | RAM |
|---|---|---|---|
| 0 | lite | Read-only gang info | about 5 GB |
| 1 | basic | Tasks, recruiting, wanted cleanup, warfare toggle | about 15 GB |
| 2 | full | Equipment purchase and ascension | about 29 GB |

## Config

`/config/gang.txt` holds only `strategy` (empty means use the JSON config) and
`noKill` (default `false`). Everything else is in `/data/gang-config.json`,
which the dashboard edits:

| Field | Default | Meaning |
|---|---|---|
| `strategy` | `balanced` | `grow` (respect until enough members), `respect`, `money`, `territory`, or `balanced` (phase machine over the others). |
| `pinnedMembers` | `{}` | Member name to task; pinned members are never reassigned. |
| `purchasingEnabled` | `true` | Buy equipment and augmentations. |
| `wantedThreshold` | `0.95` | Wanted penalty below which members are pulled onto vigilante or ethical work. |
| `ascendAutoThreshold` | `1.5` | Ascension multiplier gain that triggers automatic ascension. |
| `ascendReviewThreshold` | `1.15` | Gain that flags a member for manual review. |
| `trainingThreshold` | `500` | Combat stat sum below which a member trains instead of working. |
| `growTargetMultiplier` | `30` | Grow strategy target as a multiple of respect for the next recruit. |
| `growRespectReserve` | `2` | Recruits' worth of respect to keep in reserve. |
| `territoryAutoThreshold` | `101` | Average clash chance (percent) above which warfare is switched on automatically. 101 disables. |

## Territory

Clash chances cost 4 GB per rival to query, so the daemon never computes them.
`actions/check-territory.js` does, round-robin one rival per run (index in
`/data/territory-rr-index.txt`), `--all` for every rival, or `--gang NAME`.
The queue daemon runs it with `--all` as one of its status checks. It publishes
`GangTerritoryStatus` on `STATUS_PORTS.gangTerritory`; the gang daemon reads
it and sizes the warfare squad from clash chance and power ratio.

## Equipment

Ranked by return on investment: the stat bonus over baseline, weighted by the
member's current task stat weights, per dollar. Spending goes through the
`gang` budget bucket, and the bucket is signalled done once every member owns
everything.

## Ports and dashboard

Publishes `GangStatus` on `STATUS_PORTS.gang`. Control port
`GANG_CONTROL_PORT` accepts set-strategy, pin and unpin member, toggle
purchases, toggle warfare, the threshold setters, ascend member, and force-buy.
Dashboard: Money group, Gang tab.
