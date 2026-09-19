# Hack

Distributed hack/grow/weaken across every rooted server, with five strategies.
Source: `src/daemons/hack.ts` (loop), `src/controllers/hack.ts` and
`src/lib/batch.ts` (pure logic), `src/workers/*.js` (payloads).

## Run

```
run daemons/hack.js
```

Started by `start.js` as a core daemon. Not tiered; static cost 10.5 GB.
Restart it after changing `strategy` (the dashboard's strategy selector does
this for you).

## Config: `/config/hack.txt`

| Key | Default | Meaning |
|---|---|---|
| `strategy` | `money` | `money`, `xp`, or `drain` (see below). |
| `homeReserve` | `32` | GB of home RAM never used for workers. |
| `maxTargets` | `100` | Upper bound on simultaneous targets. |
| `maxBatches` | `0` | HWGW batches per target. `0` = auto: fleets of 256 GB or more get batch mode capped at 256 batches per target, smaller fleets use legacy parallel mode. Any positive value forces batch mode with that cap. |
| `moneyThreshold` | `0.8` | Legacy mode: grow when money is below this fraction of max. |
| `securityBuffer` | `5` | Legacy mode: weaken when security exceeds min plus this. |
| `hackPercent` | `0.25` | Legacy mode: fraction of money to take per hack. |
| `interval` | `200` | Extra sleep (ms) between cycles. |
| `oneShot` | `false` | Run one cycle and exit. |
| `xpInterval` | `2000` | XP mode tick rate (ms). Read but not written as a default. |

Also reads `allowWorkers` from `/config/hacknet.txt` (default `false`) to decide
whether hacknet servers may host workers.

## Strategies

- **money** (default): prep targets to min security and max money, then run
  HWGW batches when the fleet is large enough, otherwise the legacy parallel
  weaken/grow/hack loop. Targets are scored by money per second per thread.
- **xp**: all threads weaken a single high-XP target.
- **drain**: hack without regrowing, for emptying a server before a reset.

There is no stock-manipulation strategy. The 2026-09-19 analysis
(`sim/stocks/exp-manip`) found that stock-flagged hacks cannot hold a megacap's
forecast against the market's 45%-per-75-tick flip at any sustained rate, and
that the only stocks that respond (small, low-forecast ones) are exactly the ones
the stocks daemon never holds. Workers never pass the `stock` flag, so normal
hacking has no effect on stock prices.

## Ports

| Port | Direction | Payload |
|---|---|---|
| `STATUS_PORTS.hack` | publishes | `HackStatus`: mode, strategy, targets, batch state, income per second, XP target. |
| `STATUS_PORTS.fleet` | publishes | `FleetAllocation`: which servers are hacking versus sharing. |
| `STATUS_PORTS.share` | consumes | Share target percent, to carve fleet RAM out for share workers. |

## Dashboard

Servers group, Hack tab (`views/dashboard/tools/hack.tsx`). Shows the published
status; controls for strategy, max batches and home reserve restart the daemon.
Until the daemon's first publish the tab shows "waiting for data".

## Workers

Plain JavaScript so they cost the minimum. Args: `target, delay, launchTs, batchTag`.

| Script | RAM |
|---|---|
| `workers/hack.js` | 1.70 GB |
| `workers/grow.js` | 1.75 GB |
| `workers/weaken.js` | 1.75 GB |
| `workers/share.js` | 4.00 GB |

Batch planning prices each op at its own worker's cost; the difference between
hack and grow/weaken matters when a server is packed to the last thread.

## Standalone scripts

| Command | Purpose |
|---|---|
| `run scripts/hack/distributed.js [--one-shot] [--interval 200] [--home-reserve 32] [--max-targets 100]` | Legacy parallel mode without the daemon. Fixed thresholds 0.8 / 5 / 0.25. |
| `run scripts/hack/shotgun.js [target\|auto] [--home-reserve 32] [--one-shot]` | Deploy workers once, then flood all fleet RAM at one target with whichever action it needs. `auto` re-picks the target each cycle. |
| `run scripts/hack/simple.js <target> [--money-threshold 0.8] [--security-threshold 1.1]` | Single-thread loop for the first minutes of a BitNode. Note `--security-threshold` is a multiplier on min security, not an additive buffer. |
| `run scripts/hack/hack-only.js <target>` | Hack repeatedly, no grow or weaken. |
| `run tools/control/network-monitor.js` | Live terminal overview of worker threads and expected income. Reads processes directly, not the daemon. |

## Notes

- Batch delays assume weaken time is 4x hack time (the game's formula). The
  hack delay is clamped at zero, which would only misorder a batch if hack time
  fell under about 66 ms.
- Without Formulas.exe the hack-chance estimate for unprepped targets uses
  current security, so early scores are pessimistic until targets are prepped.
- `lib/server-cache.ts` caches the server scan for 10 s; callers that root a
  server must call `invalidateServerCache()`.
