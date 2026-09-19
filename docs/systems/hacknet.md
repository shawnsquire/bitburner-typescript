# Hacknet

Buys and upgrades hacknet nodes or servers by return on investment and spends
hashes according to a strategy. Source: `src/daemons/hacknet.ts`.

## Run

```
run daemons/hacknet.js
```

Optional daemon in `start.js`. Tiered; needs 8 GB to launch.

| Tier | Name | Adds | RAM |
|---|---|---|---|
| 0 | monitor | Node stats, hash counts, upgrade costs | about 8 GB |
| 1 | auto-buy | Purchase and upgrade functions | about 11 GB |
| 2 | hash-spender | `hashCost`, `spendHashes` | about 12 GB |

Every hacknet function costs 0.5 GB in v3. Outside BitNode 9 without Source-File
9 there are only money-producing nodes and no hashes; the daemon still runs and
the hash features are no-ops.

## Config: `/config/hacknet.txt`

| Key | Default | Meaning |
|---|---|---|
| `interval` | `5000` | Cycle interval (ms). |
| `autoBuy` | `true` | Buy and upgrade automatically. |
| `maxServers` | `20` | Cap on nodes or servers. |
| `spendStrategy` | `money` | What to buy with hashes. See the strategy table below. |
| `spendTarget` | empty | Server for `reduce-security` and `increase-money`, company name for `company-favor`. Empty means: server strategies use the hack daemon's primary target; `company-favor` is skipped with a warning. |
| `spendThreshold` | `0.5` | For strategies other than `money`, wait until hash capacity is this full. `money` sells immediately. |
| `reserveHashes` | `0` | Hashes to keep unspent. |
| `allowWorkers` | `false` | Read by the hack daemon: whether hacknet servers may host hacking workers. |

### Hash spend strategies

Every strategy maps to one of the game's eleven hash upgrades (exact names from
`src/Hacknet/Enums.ts`); the mapping lives in `src/controllers/hacknet.ts`.

| Strategy | Upgrade | Target | Notes |
|---|---|---|---|
| `money` | Sell for Money | none | $1m per 4 hashes, flat cost. Sells immediately. |
| `corp-funds` | Sell for Corporation Funds | none | $1b corporation funds. Fails without a corporation. |
| `corp-research` | Exchange for Corporation Research | none | 1k research in every division. Fails without a corporation. |
| `study` | Improve Studying | none | +20% university XP per level, until the next install. |
| `gym` | Improve Gym Training | none | +20% gym XP per level, until the next install. |
| `bladeburner-rank` | Exchange for Bladeburner Rank | none | 100 rank. Fails outside Bladeburner. |
| `bladeburner-sp` | Exchange for Bladeburner SP | none | 10 skill points. Fails outside Bladeburner. |
| `coding-contract` | Generate Coding Contract | none | One random contract somewhere on the network. |
| `reduce-security` | Reduce Minimum Security | server | Min security x0.98 per level, floor 1, until the next install. |
| `increase-money` | Increase Maximum Money | server | Max money x1.02 per level, soft-capped above $10t, until the next install. |
| `company-favor` | Company Favor | company | +5 favor with the company named in `spendTarget`. |

Server upgrades only accept servers you do not own. With `spendTarget` empty the
daemon reads the hack daemon's status port and uses its lowest-ranked target;
if the hack daemon is not running (or its status is over a minute old) spending
is skipped and the status shows why. `company-favor` never falls back; without
`spendTarget` it is a no-op with a warning. All upgrades except `money` raise
their hash cost with every level bought, so the daemon re-reads the cost after
each spend.

## Purchasing

Candidates (new node, level, RAM, cores, cache) are ranked by hash rate gained
per dollar using `formulas.hacknetServers`. The first node is bought without
ranking. Spending goes through the `hacknet` budget bucket, and the daemon
reports the remaining cost to fully upgrade as the bucket's cap.

## Ports and dashboard

Publishes `HacknetStatus` on `STATUS_PORTS.hacknet`, including the resolved
upgrade name, its target and where the target came from (`spendTarget` or the
hack daemon), and a `spendBlocked` reason when spending is skipped. Dashboard:
Money group, Hacknet tab, with a strategy selector, the resolved target, and
the next planned purchase.

## BitNode 9

In BitNode 9 (Hacktocracy) hashes are the main income and the only lever on
server max money and min security: `ScriptHackMoney` is 0.1, `ServerMaxMoney`
0.01, `HackExpGain` 0.05 and `CloudServerLimit` 0 (game source
`src/BitNode/BitNode.tsx`, case 9). Nothing here is automatic; set the policy
in config:

- **Hacknet weight up.** Raise the `hacknet` bucket's weight on the Budget tab
  (weights live in the persisted budget state, not the config file) well above
  the other buckets so node purchases are not starved.
- **Servers bucket off.** Purchased servers cannot be bought (limit 0); the
  pserv daemon detects this, signals the `servers` bucket done and exits, so
  its weight is released automatically. Set it to 0 on the Budget tab too if
  you want the intent visible.
- **Hacknet before pserv in `/config/start.txt`.** The hacknet daemon needs
  its budget share from the first tick; pserv exits immediately anyway.
- **`allowWorkers=false`.** Hash rate scales with free RAM on each hacknet
  server: `calculateHashGainRate` multiplies by `1 - ramUsed / maxRam`
  (`src/Hacknet/formulas/HacknetServers.ts:14`). Hosting hack workers on
  hacknet servers costs hashes one for one with RAM used.
- **Strategy.** Start with `money` to bootstrap, then `increase-money` and
  `reduce-security` against the hack daemon's primary target (leave
  `spendTarget` empty to follow it), which is the only way to raise a server's
  max money in this BitNode. Both effects reset on install.
- **Endgame.** `w0r1d_d43m0n` needs hacking 6000 here (3000 times the
  BitNode's `WorldDaemonDifficulty` of 2); the rep daemon publishes that
  figure and the advisor waits for it before recommending the exit.
