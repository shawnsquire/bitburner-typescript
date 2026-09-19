# Nuke

Roots every server you can and deploys the worker scripts to it. Source:
`src/daemons/nuke.ts` (loop), `src/controllers/nuke.ts` (analysis),
`src/controllers/exploit.ts` (port crackers and nuke).

## Run

```
run daemons/nuke.js [--one-shot] [--interval <ms>]
```

Core daemon in `start.js`, about 5 GB, not tiered.

## Config: `/config/nuke.txt`

| Key | Default | Meaning |
|---|---|---|
| `interval` | `30000` | Scan interval (ms). |
| `oneShot` | `false` | One scan and exit. |

## Behaviour

- Each scan walks the network, opens every port it has a cracker for
  (BruteSSH, FTPCrack, relaySMTP, HTTPWorm, SQLInject) and calls `nuke`.
- In v3 the crackers and `nuke` return `false` on failure instead of throwing; the controller treats a false as a failure and keeps going.
- Newly rooted servers with RAM get `workers/hack.js`, `grow.js`, `weaken.js` and `share.js` copied to them.
- After rooting, the shared server cache is invalidated so other daemons see the new server.
- Servers you cannot root yet are bucketed by reason (need hacking level, need more port crackers). The "potential targets" list uses an either-or test: within 50 hacking levels or within one port cracker.

## Ports and dashboard

Publishes `NukeStatus` on `STATUS_PORTS.nuke`: ready, need-hacking, need-ports
and rooted lists, plus fleet RAM totals. Rooted and total counts exclude your
purchased servers; the RAM aggregate includes them. Dashboard: Servers group,
Nuke tab. The contracts daemon uses this port for its server list.

## Standalone

```
run controllers/exploit.js <host>
```

Opens ports and nukes one server.
