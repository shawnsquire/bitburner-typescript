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

Auto-purchase covers all twelve skills in five priority groups. A group is
only bought from when nothing in a higher group is affordable, so skill
points flow top-down and the lower groups get the change. Within a group the
lowest-level skill is bought first, which alternates the members. Effects,
base cost and per-level cost increase come from the game's
`src/Bladeburner/data/Skills.ts`; each level costs base + level x inc.

| Group | Skills | Why here |
|---|---|---|
| 1 | Blade's Intuition, Digital Observer, Overclock (cap 90) | Success chance and action speed are what the daemon gates on and what earns rank. |
| 2 | Reaper, Evasive System | Combat stats feed success chance and stamina for every action. |
| 3 | Cloak, Short-Circuit, Datamancer, Hands of Midas | Datamancer narrows the success estimate; the daemon thresholds on the low estimate, so accuracy raises the gating number and cuts Field Analysis time. It also has the cheapest scaling of all twelve (inc 1.0). Hands of Midas is +10% contract money and contracts are the preferred action. |
| 4 | Hyperdrive | Experience gain is indirect. |
| 5 | Tracer, Cyber's Edge (both cap 25) | Tracer is +4% contract success, Cyber's Edge +2% max stamina and regen. Both only add throughput the daemon already secures by gating on chance and resting at 50%, and Cyber's Edge has the steepest scaling (inc 3.0). The cap (about 680 SP total for Tracer, 925 for Cyber's Edge at BitNode skill-cost multiplier 1) keeps late-game points from draining into them. |

`buySkill` and the dashboard's per-skill buttons still buy any skill outright,
cap or not.

## Ports and dashboard

Publishes `BladeburnerStatus` on `STATUS_PORTS.blade`. Dashboard: Focus
group, Blade tab, with threshold controls, skill buy buttons and Buy All.
The blade daemon respects the focus holder unless The Blade's Simulacrum is
installed.
