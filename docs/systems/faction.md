# Factions

Discovers factions, evaluates their requirements, joins safe invitations, and
travels to cities for location-locked factions. Source: `src/daemons/faction.ts`
(loop), `src/controllers/faction-manager.ts` (requirements and decisions).

## Run

```
run daemons/faction.js [--tier lite|join|aug-aware|auto-manage] [--one-shot]
```

Optional daemon in `start.js`. Tiered by free RAM; `--tier` forces one.

| Tier | Name | Adds | RAM at SF4 level 0 |
|---|---|---|---|
| 0 | lite | Status only, no Singularity | about 5 GB |
| 1 | join | `checkFactionInvitations`, `joinFaction` | about 11 GB |
| 2 | aug-aware | Reads faction and owned augs so it skips factions with nothing left | about 19 GB |
| 3 | auto-manage | `travelToCity`, runs `actions/faction-backdoors.js` | about 21 GB |

## Config: `/config/faction.txt`

| Key | Default | Meaning |
|---|---|---|
| `interval` | `10000` | Cycle interval (ms). |
| `preferredCity` | empty | City faction to favour when city factions conflict (Sector-12 versus Chongqing and so on). Empty means never auto-join a city faction. |
| `noKill` | `false` | Do not kill other scripts to reach a higher tier. |
| `oneShot` | `false` | One cycle and exit. |

## Behaviour

- Joins any invitation that cannot lock you out of another faction. City
  factions are joined only when they match `preferredCity`.
- Travel priority for location-locked factions follows the declaration order in
  `LOCATION_LOCKED_FACTIONS`: Tian Di Hui, The Dark Army, The Syndicate, Tetrads,
  Speakers for the Dead, Slum Snakes, Silhouette.
- Requirements come from the game's faction data. Requirements the script cannot
  verify (job titles, being unemployed by CIA/NSA) are shown but not enforced.
- Daedalus' augmentation count is the default 30; some BitNodes change it.

## Ports and dashboard

Publishes `FactionStatus` on `STATUS_PORTS.faction`. Dashboard: Factions group,
Faction tab, with a join button and a requirements tooltip per faction.

## Actions

| Command | Purpose |
|---|---|
| `run actions/join-faction.js --faction NAME` | Join if an invitation is pending. |
| `run actions/check-factions.js` | One-shot status when the daemon is off. Reports installed augs as 0, so Covenant, Daedalus and Illuminati always show as not eligible on this path. |
| `run actions/faction-backdoors.js` | Backdoor CSEC, avmnite-02h, I.I.I.I and run4theh111z where rooted. Continues past a failure. |
| `run tools/network/backdoor.js` | Print the connect chains for the faction servers and the World Daemon. |
| `run tools/network/path-to-backdoors.js` | Same, through `path-to.js`. |
