# Advisor

Reads every other system's status port and ranks what to do next. Source:
`src/daemons/advisor.ts`. The rules and the evaluator are exported and unit
tested.

## Run

```
run daemons/advisor.js
```

Optional daemon in `start.js`, 1.6 GB. Config `/config/advisor.txt`: `interval`
(default `5000` ms).

## How it works

Twenty rule functions each look at a context assembled from the nuke, hack,
pserv, share, rep, work, darkweb, bitnode, faction, gang, gang territory and
augments status ports. A rule returns a recommendation with a score from 0 to
100 or nothing. Missing ports simply mean those rules stay quiet. Rules are
isolated: one throwing does not stop the others. Results are sorted by score
and published.

Categories: infrastructure, skills, factions, augmentations, gang, endgame.

Endgame rules key off the rep daemon's BitNode status, which treats the
Daedalus skill requirement as hacking 2500 or all combat skills 1500, matching
the game. "Destroy the Bitnode" additionally waits for `worldDaemonComplete`:
`w0r1d_d43m0n` needs hacking 3000 times the BitNode's `WorldDaemonDifficulty`
(6000 in BN9), which the rep daemon publishes as `worldDaemonRequired` (see
`docs/systems/rep.md`). A status without that field, from an older rep daemon,
never triggers the exit recommendation.

## Ports and dashboard

Publishes `AdvisorStatus` on `STATUS_PORTS.advisor`. The Overview tab shows the
recommendations at the top; the Tools group has an Advisor tab with the full
table and legends.

## Related

`run tools/info/prioritize.js` is an older one-shot that covers only nuke,
darkweb, pserv, hack and share. Prefer the Advisor tab.
