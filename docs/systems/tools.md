# Tools

One-shot terminal utilities under `src/tools/`. None publish status or read
config unless noted.

## Network (`tools/network/`)

| Command | Purpose |
|---|---|
| `run tools/network/nmap.js [--start home] [--depth N] [--sort keys] [--limit N] [--where terms]` | Network table. `--sort` is a comma list of field names, prefix `!` for descending (default `depth,host`). `--where` is a comma list of terms, each `field`, `!field`, or `field<op>value` with `>= <= != = > <` (all must match). Fields: `host`, `depth`, `reqHack`, `ports`, `ramUsed`, `ramFree`, `ramMax`, `moneyAvail`, `moneyMax`, `moneyPct`, `secCur`, `secMin`, `secDelta`, `growth`, `purchased`, `backdoor`, `root`. |
| `run tools/network/path-to.js HOST [SOURCE]` | Print the connect chain from `SOURCE` (default home) to `HOST`. |
| `run tools/network/path-to-backdoors.js` | Connect chains for the four faction servers. |
| `run tools/network/backdoor.js` | Connect and backdoor command sequences for the faction servers and the World Daemon; prints, does not execute. |
| `run tools/network/pwned.js ls` | List rooted servers. |
| `run tools/network/pwned.js killall` | Kill every script on every rooted server. |
| `run tools/network/pwned.js cp FILE` | Copy a file to every rooted server. |
| `run tools/network/pwned.js run SCRIPT [THREADS] [args...]` | Run a script on every rooted server, filling RAM when `THREADS` is 0. |

## Info (`tools/info/`)

| Command | Purpose |
|---|---|
| `run tools/info/augments.js` | Installed and pending augmentations with stat bonuses. 162 GB at SF4 level 0. |
| `run tools/info/slum-work.js` | Every crime's chance, time, money, XP and karma per minute. 162 GB at SF4 level 0. |
| `run tools/info/karma.js` | Current karma and kills. |
| `run tools/info/infiltration-list.js` | Infiltration locations sorted by difficulty with clearance levels, security and rep reward per challenge. |
| `run tools/info/prioritize.js` | Older one-shot recommendation over nuke, darkweb, pserv, hack and share. The Advisor tab supersedes it. |
| `run tools/info/colors.js` | ANSI colour reference. |

## Control (`tools/control/`)

| Command | Purpose |
|---|---|
| `run tools/control/launch.js SCRIPT [--threads N] [--dry-run] [-- args...]` | Launch a script, killing workers through the kill tiers if RAM is short. `--dry-run` lists what would be killed. |
| `run tools/control/network-monitor.js` | Live terminal overview of hacking workers and expected income. |
| `run tools/control/sell-all-stocks.js` | Close every stock position. |

## Debug (`tools/debug/`)

| Command | Purpose |
|---|---|
| `run tools/debug/peek-ports.js [PORT]` | Summary of every status and control port, or the full JSON of one. The valid range comes from `types/ports.ts`. |
| `run tools/debug/ram-audit.js [--top 30]` | RAM cost of every script on home, by file and folder, also written to `/data/ram-audit.txt`. |
| `run tools/debug/file-diff.js [--delete]` | Compare scripts on home with the build manifest `/data/expected-files.txt`; `--delete` removes orphans. |

## Offline (Node, not in-game)

| Command | Purpose |
|---|---|
| `npm run ram -- <dist path>` | Static RAM cost from `dist/`, replicating the game's scan. See `docs/development.md`. |
| `npm run ram:sync -- <tag>` | Regenerate the RAM table from the game checkout. |
| `npm run test:contracts` | Contract solvers against the game's own checkers. |
