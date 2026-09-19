# Bladeburner

Automates Bladeburner actions, skill purchases and city selection. Source:
`src/daemons/blade.ts` (loop and tiers), `src/controllers/blade.ts`
(decisions, unit tested).

## Run

```
run daemons/blade.js
```

Optional daemon in `start.js`. Tiered; upgrades itself by respawning when
RAM frees up (checked every 6 cycles in monitor, every 10 in analysis).

| Tier | Name | Adds | RAM |
|---|---|---|---|
| 0 | monitor | Rank, stamina, skill points, current action, city stats | about 34 GB |
| 1 | analysis | Action counts and success-chance estimates | about 50 GB |
| 2 | automation | Starts actions, buys skills, switches city | about 74 GB |

The player must already be in Bladeburner; the daemon does not join.

## Config: `/config/blade.txt`

| Key | Default | Meaning |
|---|---|---|
| `interval` | `3000` | Refresh interval (ms); monitor tier uses 5000. |
| `contractThreshold` | `60` | Minimum estimated success percent to run a contract. |
| `operationThreshold` | `80` | Same for operations. |
| `blackOpThreshold` | `95` | Same for Black Ops, which also need the rank. |
| `staminaMinPercent` | `50` | Rest when stamina drops below this percent. |
| `staminaRestoreTo` | `95` | Rest until this percent (hysteresis). |
| `staminaTrainMax` | `0` | Train when max stamina is below this. 0 disables training. |
| `chaosMax` | `50` | Start Diplomacy above this chaos. |
| `chaosTarget` | `40` | Stop Diplomacy below this. |
| `successSpreadMax` | `4` | Shown in the dashboard but not yet used by the decision logic. |
| `populationMin` | `1e9` | Same. |
| `buySkill` | | Write a skill name to buy it once; the daemon clears it. |

Contracts are preferred over operations; Black Ops run when rank and success
allow. Raids move to a quarantine city so they do not drain population where
you earn. There is no control port; the dashboard writes config keys.

## Skills

Auto-purchase follows a priority list of eight skills: Blade's Intuition,
Digital Observer, Overclock, Reaper, Evasive System, Cloak, Short-Circuit,
Hyperdrive. Tracer, Datamancer, Cyber's Edge and Hands of Midas are never
bought automatically; use `buySkill` or the dashboard's per-skill buttons.

## Ports and dashboard

Publishes `BladeburnerStatus` on `STATUS_PORTS.blade`. Dashboard: Focus
group, Blade tab, with threshold controls, skill buy buttons and Buy All.
The blade daemon respects the focus holder unless The Blade's Simulacrum is
installed.
