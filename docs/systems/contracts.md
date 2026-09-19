# Contracts

Finds coding contracts on every rooted server and solves them. Source:
`src/daemons/contracts.ts` (scan and attempt loop), `src/lib/contracts/index.ts`
(solver registry), `src/lib/contracts/solvers/*.ts` (one pure solver per type).

## Run

```
run daemons/contracts.js
```

Optional daemon in `start.js`, pinned at 32 GB. Config `/config/contracts.txt`:

| Key | Default | Meaning |
|---|---|---|
| `interval` | `60000` | Scan interval (ms). |
| `oneShot` | `false` | One scan and exit. |
| `minTries` | `1` | Skip a contract with fewer tries left than this. At the default it never triggers, because the game deletes a contract when its last try fails. Raise it to keep a manual safety margin. |

## Behaviour

- The server list comes from the nuke daemon's status port, falling back to home.
- Every contract type the game defines has a solver (30 of 30). The daemon warns at startup if a game type has none.
- A solver that throws, or an answer the game rejects as malformed, is logged as a failure without spending a try.
- The dashboard's Force button writes `{host, file}` to `CONTRACTS_CONTROL_PORT` to attempt a contract regardless of `minTries`.

## Ports and dashboard

Publishes `ContractsStatus` on `STATUS_PORTS.contracts`: solved, failed and
pending counts, the pending table with reasons (`no solver`, `low tries`,
`solver error`, `previously failed`), recent results, and solver coverage.
Dashboard: Tools group, Contracts tab.

## Adding or changing a solver

Read the game's definition in `src/CodingContract/contracts/*.ts` of the game
checkout first. `getAnswer` there is the reference; `solver` defines what the
game accepts, which is sometimes looser (any maximal rectangle, any compression
no longer than the reference). Register the solver by exact contract name in
`src/lib/contracts/index.ts`, then run:

```
npm run test:contracts                # all types, 25 rounds each
npm run test:contracts -- --rounds 200
npm run test:contracts -- "Square Root"
```

That harness runs each solver against the game's own generator and checker and
must pass before shipping.
