# Darkweb

Buys the TOR router and then every darkweb program, cheapest first. Source:
`src/daemons/darkweb.ts` (loop), `src/controllers/darkweb.ts` (analysis and
purchase).

## Run

```
run daemons/darkweb.js [--one-shot] [--interval <ms>]
```

Optional daemon in `start.js`. Not tiered; the cost is dominated by the
Singularity multiplier:

| SF4 level | RAM |
|---|---|
| 0 or 1 | about 83 GB |
| 2 | about 23 GB |
| 3, or inside BitNode 4 | about 8 GB |

Without Source-File 4 nothing can be bought, so the daemon logs that and exits
instead of holding the RAM. It also exits once every program is owned.

## Config: `/config/darkweb.txt`

| Key | Default | Meaning |
|---|---|---|
| `interval` | `30000` | Cycle interval (ms). |
| `oneShot` | `false` | One cycle and exit. |

## Behaviour

- TOR costs 200k and is bought first.
- Programs are bought in price order while the `programs` budget bucket allows.
  Program names and prices come from the game's darkweb item table.
- `purchaseProgram` returning `false` is treated as a failed purchase, not a crash.

## Ports and dashboard

Publishes `DarkwebStatus` on `STATUS_PORTS.darkweb`. Dashboard: Servers group,
Darkweb tab. When the daemon is not running, the queue daemon's rotation runs
`actions/check-darkweb.js`, which publishes the same status shape.

## Actions

| Command | Purpose |
|---|---|
| `run actions/buy-tor.js` | Buy the TOR router. Reports "requires Source-File 4" instead of crashing without it. |
| `run actions/buy-program.js --program BruteSSH.exe` | Buy one program. |
| `run actions/check-darkweb.js` | One-shot status. |
