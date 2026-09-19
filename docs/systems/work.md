# Work and focus

Automated stat training and crime for the player, plus the focus daemon that
decides which system (work, rep, Bladeburner) may use the player's attention.
Source: `src/daemons/work.ts`, `src/daemons/focus.ts`, `src/controllers/work.ts`,
`src/controllers/crime.ts`.

## Work daemon

```
run daemons/work.js [--focus <focus>] [--one-shot] [--interval <ms>]
```

Core daemon in `start.js`. Tiered: it starts small, computes the cost of each
tier from function lists, picks the highest tier that fits, and respawns itself
when enough RAM frees up for a higher one.

| Tier | Name | What it can do | RAM at SF4 level 0 |
|---|---|---|---|
| 0 | monitor | Publish status only | about 15 GB |
| 1 | training | Gym and university | about 116 GB |
| 2 | crime | Everything, plus crimes | about 368 GB |

Singularity costs are 16x at SF4 level 0 or 1, 4x at level 2, 1x at level 3 or
in BitNode 4, so the tiers are roughly a quarter or a sixteenth of those numbers
later.

### Config: `/config/work.txt`

| Key | Default | Meaning |
|---|---|---|
| `focus` | empty | One of the focus values below. Empty means keep what `/data/work-config.json` already holds, else `balance-combat`. |
| `interval` | `5000` | Cycle interval in ms. |
| `oneShot` | `false` | Run one cycle and exit. |

Also reads `holder` and `sleeveHolder` from `/config/focus.txt` and parks itself
when another daemon holds the focus.

### Focus values

Set with `run actions/set-work-focus.js --focus <value>` or from the dashboard.

| Focus | Behaviour |
|---|---|
| `strength`, `defense`, `dexterity`, `agility` | Train one stat at the best reachable gym. |
| `hacking`, `charisma` | Train at the best reachable university. |
| `balance-combat` | Rotate through the four combat stats, always training the lowest. |
| `balance-all` | Rotate through all six stats. |
| `crime-money` | Commit the most profitable crime per minute. |
| `crime-stats` | Commit the best crime for combat XP. |
| `crime-karma` | Commit the crime with the fastest karma loss (for gangs). |
| `crime-kills` | Commit the crime with the most kills per minute. |
| `none` | Sets `holder=none` in the focus config, parking every focus daemon. |

Crime rates count the 25 percent XP and quarter karma the game awards on a
failed attempt, so rankings reflect expected value, not success-only value.

### Ports and dashboard

Publishes `WorkStatus` on `STATUS_PORTS.work`. Dashboard: Focus group, Work tab
(`views/dashboard/tools/work.tsx`).

## Focus daemon

```
run daemons/focus.js
```

Sole writer of `/config/focus.txt`. Not tiered; pinned at 7.1 GB
(`ps`, `exec`, `sleeve.getNumSleeves`, config I/O). The Simulacrum check runs
in `actions/check-simulacrum.js` (2.6 GB, `getResetInfo().ownedAugs`, no
Source-File 4 needed), exec'd once at startup and again on a `refresh` control
message. If the exec fails for lack of RAM the daemon retries every tick.

| Key | Default | Meaning |
|---|---|---|
| `holder` | `work` | Which daemon may use the player's focus: `work`, `rep`, `blade`, `none`. |
| `sleeveHolder` | `none` | Which daemon directs sleeve 0. |
| `default` | `work` | Holder to use at boot when `holder` is empty. |
| `simulacrum` | detected | Whether The Blade's Simulacrum is installed (Bladeburner then needs no focus). Written by `actions/check-simulacrum.js`, not the player. |

Control port `FOCUS_CONTROL_PORT` accepts `set-holder`, `set-sleeve`, and
`refresh` messages. Publishes `FocusStatus` on `STATUS_PORTS.focus`. When the
sleeve holder changes it runs `actions/assign-sleeve.js`. Dashboard: Focus
group, Focus tab, plus the sticky header shown on the other Focus tabs.

Only sleeve 0 is managed. Sleeves are assigned in the city they are already in;
the action does not travel them.

## Actions

| Command | Purpose | RAM |
|---|---|---|
| `run actions/start-gym.js [--gym "Powerhouse Gym"] [--stat str\|def\|dex\|agi] [--focus]` | Start a gym workout. | 34 GB |
| `run actions/start-university.js [--uni "ZB Institute of Technology"] [--course Algorithms] [--focus]` | Start a course. Courses: Computer Science, Data Structures, Networks, Algorithms, Management, Leadership. | 34 GB |
| `run actions/commit-crime.js [--crime Homicide] [--focus]` | Start a crime. | 82 GB |
| `run actions/travel.js --city <city>` | Travel, after checking you have 200k. | 34 GB |
| `run actions/set-work-focus.js --focus <value>` | Change focus without Singularity RAM. | 2 GB |
| `run actions/check-work.js` | Publish a one-shot work status when the daemon is not running. | 12 GB |
| `run actions/assign-sleeve.js --sleeve 0 --daemon work\|rep\|blade\|none` | Route a sleeve to a daemon's current task. Reports a warning if the game rejects the assignment. | 38 GB |
| `run actions/check-simulacrum.js` | Write `simulacrum=true\|false` to `/config/focus.txt` from `getResetInfo().ownedAugs`. Run by the focus daemon at startup and on `refresh`. | 2.6 GB |

The actions hard-code their own valid-value lists instead of importing the
controllers on purpose: importing would pull unrelated Singularity references
into their RAM cost.

## Tools

| Command | Purpose |
|---|---|
| `run tools/info/slum-work.js` | Table of every crime: chance, time, money, XP and karma per minute. |
| `run tools/info/karma.js` | Current karma and kill count. |
