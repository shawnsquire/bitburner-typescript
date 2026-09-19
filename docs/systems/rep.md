# Rep

Tracks faction reputation and favor, picks the next augmentation worth working
toward, and at the top tier does the faction work itself. Source:
`src/daemons/rep.ts` (loop), `src/controllers/factions.ts` (augment and
reputation logic, shared with the augments system).

## Run

```
run daemons/rep.js [--tier lite|basic|target|analysis|planning|prereqs|auto-work]
```

Core daemon in `start.js`. Seven tiers, roughly 5, 34, 114, 194, 274, 354 and
415 GB at SF4 level 0. Only the top tier, auto-work, calls `workForFaction`; the
others add progressively more analysis (target selection, prerequisite
planning, donation planning).

## Config: `/config/rep.txt`

| Key | Default | Meaning |
|---|---|---|
| `faction` | empty | Force a target faction instead of the computed one. |
| `noWork` | `false` | Analyse only, never start faction work. |
| `noKill` | `false` | Do not kill other scripts to reach a higher tier. |
| `interval` | `2000` | Cycle interval (ms). |
| `oneShot` | `false` | One cycle and exit. |

Reads `holder` and `sleeveHolder` from `/config/focus.txt`; auto-work yields
when another daemon holds the focus.

## Target selection

The next target is the cheapest augmentation, by reputation gap, from a faction
you can work for. Gang factions and factions with no work are excluded. Work type
(hacking, field, security) is chosen per faction from what the faction offers.
Donation becomes an option at the game's favor threshold, read from
`getFavorToDonate`.

## BitNode status

`BitnodeStatus` tracks two different bars:

- The Daedalus invite: 30 augmentations, $100b, and hacking 2500 or every
  combat skill 1500 (`hackingRequired`, `hackingComplete`, `allComplete`).
- The `w0r1d_d43m0n` requirement (`worldDaemonRequired`,
  `worldDaemonComplete`): the server's `requiredHackingSkill` is 3000 times the
  BitNode's `WorldDaemonDifficulty` (2 in BN9, so 6000; 5 in BN2 and BN14).
  Only hacking counts here. The daemon reads
  `ns.getServerRequiredHackingLevel("w0r1d_d43m0n")` (0.1 GB, in the base
  function list so every tier has it). The game only links that server into
  the network once The Red Pill is installed, and the call throws for an
  unlinked host, so until then the value is estimated as 3000 times a table of
  per-BitNode difficulties copied from the game's `BitNode.tsx`
  (`worldDaemonRequiredLive` is false, the dashboard shows a trailing `?`).
  BN12 uses 1.02 to the power of the Source-File 12 level plus one. After the
  install the live value takes over.

## Ports and dashboard

Publishes `RepStatus` on `STATUS_PORTS.rep` and `BitnodeStatus` on
`STATUS_PORTS.bitnode`. Dashboard: Focus group, Rep tab, with start-work and
restart controls; the FL1GHT.EXE bar on the Overview shows both the Daedalus
skill check (`Hack`) and the world daemon check (`WD`).

## Actions

| Command | Purpose |
|---|---|
| `run actions/work-for-faction.js --faction NAME --type hacking\|field\|security [--focus]` | Start faction work. |
| `run actions/check-faction-rep.js [--faction NAME]` | One-shot partial status for the highest-rep faction when the daemon is off. |
