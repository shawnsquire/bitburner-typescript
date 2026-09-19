/**
 * Darknet Coordinator Controller (Pure Logic)
 *
 * Pure functions over a `DarknetModel`: applying agent/worker reports,
 * refreshing cells from the coordinator's own polling, computing the policy
 * published to agents, and the charisma/carrier/stasis decisions described in
 * `docs/design/2026-09-19-darknet.md` (sections 4, 6 and 7).
 *
 * Zero NS imports — safe to import without RAM cost. The coordinator daemon
 * (`daemons/darknet.ts`) owns every `ns` call and feeds this module plain
 * data; `lib/darknet/vault.ts` is the only piece that touches `ns`, for
 * loading/saving `model.vault`.
 *
 * Several functions here mutate the `DarknetModel` in place rather than
 * returning a new one (matching `applyReport`'s given signature, which
 * returns only the values that don't already live on the model). Per tick,
 * the intended call order is:
 *   1. `applyReport` for every drained report batch.
 *   2. `refreshFromDetails` for every known hostname the daemon polled.
 *   3. `computePolicy` — this also syncs `model.lab` to the current lab and
 *      updates `model.stuckSince`/`model.pauseUntil`/`model.stormPending`,
 *      so it must run before `toStatus` for those fields to be current.
 *   4. `toStatus` to build the published `DarknetStatus`.
 *
 * Import with: import { ... } from "/controllers/darknet";
 */
import type { DarknetCell, DarknetCellState, DarknetStatus } from "/types/ports";
import type { Fingerprint, Policy, ReportBatch, SeenDetails, Vault, WorkerFlags } from "/lib/darknet/protocol";
import { AGENT_VERSION, CODE, DNET_WORKER_RAM, LAB_HOSTS, LAB_MODEL_ID, fingerprintOf, sameFingerprint } from "/lib/darknet/protocol";

/**
 * The deepest the darknet can ever grow (`MAX_NET_DEPTH`,
 * `game:src/DarkNet/Enums.ts:8`). Used as the "keep climbing" upper bound for
 * `netDepthOf` before the current lab (and thus the real depth) is known.
 */
const MAX_NET_DEPTH = 40;

/**
 * How long a resident agent may go without a report before the coordinator
 * treats it as dead and lets a fresh poll demote its cell (and `reseed`
 * revive it). This is deliberately generous: one agent tick crack-loops every
 * neighbour, and a single hard feedback model can burn up to `maxAttempts`
 * multi-second `authenticate` calls, so a busy-but-alive agent can legitimately
 * go minutes between batches. `agentIntervalMs * 3` (6 s at the default) would
 * constantly false-demote such agents -- churning their phish workers and
 * wastefully re-seeding live hosts. A restarted *neighbour* is revived far
 * faster than this by the adjacent agent's `restoreSession`; this floor only
 * bounds how long the coordinator's own `darkweb`/stasis/lab re-seed backstop
 * waits on a genuinely dead agent.
 */
const AGENT_LIVENESS_FLOOR_MS = 300_000;

/**
 * How long the policy keeps flagging the seed host to fire the storm once the
 * pre-storm pause elapses. A window (not a single tick) so the seed host's
 * agent, polling only every `agentIntervalMs`, reliably catches it; firing is
 * latched per agent process, so a multi-tick window still fires exactly once.
 */
const STORM_FIRE_WINDOW_MS = 10_000;

// === MODEL ===

export interface CellRecord {
  host: string;
  details: SeenDetails | null;
  fingerprint: Fingerprint | null;
  state: DarknetCellState;
  lastSeen: number;
  agentPid: number;
  agentSeenAt: number;
  attempts: number;
  cacheSeen: boolean;
}

export interface DarknetModel {
  cells: Record<string, CellRecord>;
  edges: Set<string>; // "a|b" with a < b lexicographically
  vault: Vault;
  stasisHosts: string[]; // as last reported by the game (getStasisLinkedServers)
  manualStasis: string[]; // targets from the control port in manual mode
  stormSeedHost: string | null;
  lab: { name: string; runner: string | null; grid: string[] | null; moves: number; cleared: boolean; password: string | null } | null;
  income: { money: number; since: number; cachesOpened: number; contractsFound: number; augsAwarded: number };
  heartbleedUsedThisNode: boolean;
  stuckSince: number | null;
  pauseUntil: number;
  stormPending: boolean;
  /**
   * While `now < stormFireUntil`, the policy flags the seed host's agent to
   * fire the storm. It is a short *window* rather than a single tick so that
   * the seed host's agent -- which polls only every `agentIntervalMs` and may
   * miss any one publish -- reliably catches it. Firing is latched per agent
   * process, so seeing the flag across several ticks still fires exactly once.
   */
  stormFireUntil: number;
}

export interface DarknetConfig {
  heartbleed: boolean;
  harvest: boolean;
  phish: boolean;
  phishMaxThreads: number;
  harvestKarmaFloor: number;
  stasisMode: "auto" | "manual";
  storm: "manual" | "auto";
  lab: boolean;
  gapPatienceMs: number;
  agentIntervalMs: number;
  maxAttempts: number;
}

export const DEFAULT_CONFIG: DarknetConfig = {
  heartbleed: true,
  harvest: true,
  phish: true,
  phishMaxThreads: 64,
  harvestKarmaFloor: -1e12,
  stasisMode: "auto",
  storm: "manual",
  lab: true,
  gapPatienceMs: 300000,
  agentIntervalMs: 2000,
  maxAttempts: 120,
};

export interface PlayerInfo {
  charisma: number;
  karma: number;
}

export interface Limits {
  stasisLimit: number;
  access: "none" | "basic" | "full";
  labName: string | null;
}

/** Empty model for a fresh coordinator start (or a BitNode reset). */
export function createModel(lastNodeReset: number): DarknetModel {
  return {
    cells: {},
    edges: new Set(),
    vault: { lastNodeReset, entries: {} },
    stasisHosts: [],
    manualStasis: [],
    stormSeedHost: null,
    lab: null,
    income: { money: 0, since: 0, cachesOpened: 0, contractsFound: 0, augsAwarded: 0 },
    heartbleedUsedThisNode: false,
    stuckSince: null,
    pauseUntil: 0,
    stormPending: false,
    stormFireUntil: 0,
  };
}

// === EDGE / CELL HELPERS ===

const LIVE_ADMIN_STATES: DarknetCellState[] = ["admin", "agent", "anchor"];

function isLiveAdmin(state: DarknetCellState): boolean {
  return LIVE_ADMIN_STATES.includes(state);
}

/** Canonical edge key: hostnames sorted lexicographically, joined with "|". */
export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function addEdge(m: DarknetModel, a: string, b: string): void {
  if (a === b) return;
  m.edges.add(edgeKey(a, b));
}

function dropEdgesTouching(m: DarknetModel, host: string): void {
  for (const key of m.edges) {
    const [a, b] = key.split("|");
    if (a === host || b === host) m.edges.delete(key);
  }
}

/**
 * Prune `host`'s edges to exactly its current neighbours. An agent batch's
 * `seen` events enumerate the *complete* set of `host`'s direct neighbours
 * (`probe()` returns them all), so any existing edge from `host` to a server
 * NOT in that set is stale -- the server has since moved (the game reshuffles
 * the net) and is no longer adjacent. Without this the edge graph is
 * append-only, and `selectLabHost`/carrier charging pick a host that used to
 * be adjacent to the lab/carrier, whose `dnet-lab`/`dnet-charge` then fails
 * with DirectConnectionRequired (351) every tick. Called only when at least
 * one neighbour was reported, so a tick where `probe()` threw (no `seen`
 * events) does not wrongly strip every edge.
 */
function pruneEdgesFrom(m: DarknetModel, host: string, current: Set<string>): void {
  for (const key of m.edges) {
    const [a, b] = key.split("|");
    if (a !== host && b !== host) continue;
    const other = a === host ? b : a;
    if (!current.has(other)) m.edges.delete(key);
  }
}

/** Every host directly connected to `host` in the map built from `seen`/probe reports. */
export function neighboursOf(m: DarknetModel, host: string): string[] {
  const out: string[] = [];
  for (const key of m.edges) {
    const [a, b] = key.split("|");
    if (a === host) out.push(b);
    else if (b === host) out.push(a);
  }
  return out;
}

function ensureCell(m: DarknetModel, host: string): CellRecord {
  let cell = m.cells[host];
  if (!cell) {
    cell = {
      host,
      details: null,
      fingerprint: null,
      state: "unknown",
      lastSeen: 0,
      agentPid: 0,
      agentSeenAt: 0,
      attempts: 0,
      cacheSeen: false,
    };
    m.cells[host] = cell;
  }
  return cell;
}

/** Drop a vault entry if present. Returns true when something was actually removed. */
function dropVaultEntry(m: DarknetModel, host: string): boolean {
  if (!(host in m.vault.entries)) return false;
  delete m.vault.entries[host];
  return true;
}

function pickDeepest(cells: CellRecord[]): CellRecord | null {
  let best: CellRecord | null = null;
  for (const c of cells) {
    const d = c.details?.depth ?? -1;
    const bd = best?.details?.depth ?? -1;
    if (best === null || d > bd || (d === bd && c.host < best.host)) best = c;
  }
  return best;
}

/**
 * How deep the darknet extends this run: the current labyrinth's depth
 * (`getNetDepth()` in game = the active lab's depth). Until an agent has
 * probed adjacent to the lab, `limits.labName` is unknown -- and the lab
 * sits at the very bottom of the net, so it can't be seen until the swarm
 * has already crossed every air gap to reach it. Defaulting low would make
 * the carrier and stuck logic (which both bail once
 * `nextGapRow(deepestAdmin) >= netDepth`) treat the very first air gap as
 * the end of the net and halt the swarm there permanently. So with full
 * access but no lab identified yet, assume the maximum possible depth
 * (`MAX_NET_DEPTH`): the swarm keeps crossing gaps until it actually reaches
 * the lab, at which point `labName` is known and this narrows to the exact
 * depth. Reaching the bottom and seeing the lab coincide, so there is no
 * meaningful window where this overshoots a real, shallower frontier.
 */
function netDepthOf(limits: Limits): number {
  if (limits.access !== "full") return 5;
  if (!limits.labName) return MAX_NET_DEPTH;
  return LAB_HOSTS[limits.labName as keyof typeof LAB_HOSTS]?.depth ?? MAX_NET_DEPTH;
}

/** First multiple of 8 strictly greater than `depth` (the next air-gap row to cross). */
function nextGapRow(depth: number): number {
  return (Math.floor(depth / 8) + 1) * 8;
}

function configToRecord(config: DarknetConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) out[k] = String(v);
  return out;
}

// === APPLY REPORT ===

/**
 * Fold one batch of agent/worker reports into the model. Mutates `m`
 * directly (vault, cells, edges, income); returns only the values that have
 * no home elsewhere on the model — contracts to forward to the contracts
 * daemon, and whether the vault changed (so the caller knows to persist it).
 */
export function applyReport(m: DarknetModel, batch: ReportBatch, now: number): { contracts: { host: string; file: string }[]; vaultChanged: boolean } {
  const contracts: { host: string; file: string }[] = [];
  let vaultChanged = false;

  // Start the income clock on the very first report this run ever folds in;
  // `toStatus` divides by `now - m.income.since`, so leaving it at its
  // zero-value default means moneyPerHour is always 0.
  if (m.income.since === 0) m.income.since = now;

  // An *agent* batch proves its origin host currently carries a live agent,
  // regardless of what (if anything) this tick's events say about it. A batch
  // from one of the host's local workers (phish/harvest/stasis/lab/charge)
  // does not: those can outlive a crashed agent, and treating their reports as
  // agent liveness would leave the dead agent un-reseeded and the host's
  // neighbours forever un-probed. Worker batches still fold their events below
  // (income, caches, freed RAM); they just don't refresh agent liveness.
  const fromCell = ensureCell(m, batch.from);
  if (batch.agent) {
    fromCell.agentPid = batch.pid;
    fromCell.agentSeenAt = batch.at;
    fromCell.state = m.stasisHosts.includes(batch.from) ? "anchor" : "agent";
  }

  for (const event of batch.events) {
    switch (event.t) {
      case "seen": {
        const cell = ensureCell(m, event.host);
        const newFp = fingerprintOf(event.details);
        const recycled = cell.fingerprint !== null && !sameFingerprint(cell.fingerprint, newFp);
        if (recycled) {
          cell.attempts = 0;
          if (dropVaultEntry(m, event.host)) vaultChanged = true;
          dropEdgesTouching(m, event.host);
        }
        cell.details = event.details;
        cell.fingerprint = newFp;
        cell.lastSeen = now;
        // A neighbour report can race a live agent's own batch; never let a
        // stale probe demote a host that currently carries an agent.
        if (cell.state !== "agent" && cell.state !== "anchor") {
          cell.state = event.details.hasAdmin ? "admin" : "frontier";
        }
        // A `seen` about `event.host` is emitted by the agent on `batch.from`,
        // and probe() only returns the caller's OWN direct neighbours -- so the
        // report itself proves a `batch.from ~ event.host` edge. This is the
        // sole source of the edge graph that lab-host selection, carrier
        // charging and the stasis auto-bands depend on. The agent cannot know a
        // distant host's neighbours, so `event.neighbours` is normally empty; we
        // still fold in any it provides, anchored at `batch.from`.
        if (batch.from !== event.host) addEdge(m, batch.from, event.host);
        for (const n of event.neighbours) {
          ensureCell(m, n);
          if (batch.from !== n) addEdge(m, batch.from, n);
        }
        break;
      }

      case "cracked": {
        const cell = ensureCell(m, event.host);
        m.vault.entries[event.host] = { password: event.password, fingerprint: event.fingerprint, seenAt: batch.at };
        vaultChanged = true;
        cell.fingerprint = event.fingerprint;
        cell.attempts = 0;
        if (cell.state !== "agent" && cell.state !== "anchor") cell.state = "admin";
        break;
      }

      case "stale": {
        const entry = m.vault.entries[event.host];
        // Only drop the entry the agent actually tried; a report that raced
        // a newer crack (whose fingerprint already changed) is a no-op.
        if (entry && sameFingerprint(entry.fingerprint, event.fingerprint)) {
          if (dropVaultEntry(m, event.host)) vaultChanged = true;
        }
        break;
      }

      case "leak": {
        // Only the { host, password } shape from the leak parser is a vault
        // candidate; `present`/`placed` character hints and the host-less
        // "--pw--" line have no home on the model (a per-cell candidate list
        // isn't part of `CellRecord`, so they're left for the agent's own
        // solver state to consume).
        if (event.host && event.password) {
          const cell = m.cells[event.host];
          if (cell?.fingerprint && !(event.host in m.vault.entries)) {
            m.vault.entries[event.host] = { password: event.password, fingerprint: cell.fingerprint, seenAt: now };
            vaultChanged = true;
          }
        }
        break;
      }

      case "gap": {
        // Informational: `requiredCharismaSkill` already lives on the cell's
        // `details` from a "seen" report, which is all `charismaNeed` needs.
        break;
      }

      case "cache": {
        ensureCell(m, event.host).cacheSeen = false;
        m.income.cachesOpened += 1;
        // The labyrinth reward cache is named `the_great_work_<nnn>.cache`
        // (a random 3-digit suffix, `generateCacheFilename` in
        // `game:src/DarkNet/effects/cacheFiles.ts`), possibly with a path
        // prefix -- match on the stem, not an exact filename, or the queued
        // reward augmentation is never counted and `augPending` never trips.
        if (event.file.includes("the_great_work")) m.income.augsAwarded += 1;
        break;
      }

      case "ramfreed": {
        const cell = ensureCell(m, event.host);
        if (cell.details) cell.details = { ...cell.details, blockedRam: event.remaining };
        if (event.remaining <= 0) cell.cacheSeen = true;
        break;
      }

      case "contract": {
        contracts.push({ host: event.host, file: event.file });
        m.income.contractsFound += 1;
        break;
      }

      case "storm-seed": {
        m.stormSeedHost = event.host;
        break;
      }

      case "phish": {
        m.income.money += event.money;
        if (event.cache) ensureCell(m, event.host).cacheSeen = true;
        break;
      }

      case "lab": {
        if (!m.lab) {
          // computePolicy hasn't synced a lab target yet this run; keep the
          // report rather than drop it, under a placeholder name.
          m.lab = { name: "", runner: event.host, grid: event.grid, moves: event.moves, cleared: event.cleared, password: event.password ?? null };
        } else {
          m.lab.runner = event.host;
          m.lab.grid = event.grid;
          m.lab.moves = event.moves;
          m.lab.cleared = event.cleared;
          if (event.password) m.lab.password = event.password;
        }
        if (event.password && m.lab.name) {
          const labCell = ensureCell(m, m.lab.name);
          labCell.fingerprint = labCell.fingerprint ?? { difficulty: labCell.details?.difficulty ?? 0, modelId: LAB_MODEL_ID, passwordLength: event.password.length };
          m.vault.entries[m.lab.name] = { password: event.password, fingerprint: labCell.fingerprint, seenAt: batch.at };
          vaultChanged = true;
          if (labCell.state !== "agent" && labCell.state !== "anchor") labCell.state = "admin";
          // Clearing a lab drops a `the_great_work` reward cache onto the lab
          // server (design section 7). Flag it so that once the coordinator
          // re-seeds an agent onto the now-admin lab, `computePolicy` runs a
          // harvest worker there to `openCache` it and queue the reward aug.
          // The lab has no blocked RAM and reports no other cache, so without
          // this flag the harvest gate never fires and the reward is stranded.
          if (event.cleared) labCell.cacheSeen = true;
        }
        break;
      }

      case "error": {
        const cell = ensureCell(m, event.host);
        if (event.code !== CODE.NotEnoughCharisma) cell.attempts += 1;
        if (cell.state === "frontier") cell.state = "cracking";
        break;
      }
    }
  }

  // An agent batch's `seen` events are `batch.from`'s complete current
  // neighbour set, so prune any now-stale edge from `batch.from` to a host it
  // no longer borders (a moved server). Skip when the batch reported no
  // neighbours (a probe() failure), which would otherwise strip every edge.
  if (batch.agent) {
    const seenHosts = new Set<string>();
    for (const e of batch.events) {
      if (e.t !== "seen") continue;
      seenHosts.add(e.host);
      for (const n of e.neighbours) seenHosts.add(n);
    }
    if (seenHosts.size > 0) pruneEdgesFrom(m, batch.from, seenHosts);
  }

  return { contracts, vaultChanged };
}

// === REFRESH FROM POLLED DETAILS ===

/**
 * Fold the coordinator's own `getServerDetails` poll of one known hostname
 * into the model (design doc section 4 step 2). Distinct from the `seen`
 * event: this runs over every known cell each tick, not just this tick's
 * probed neighbours, so it's what actually detects a host going offline.
 */
export function refreshFromDetails(m: DarknetModel, host: string, details: SeenDetails, now: number, config: DarknetConfig): { vaultChanged: boolean } {
  const cell = ensureCell(m, host);
  let vaultChanged = false;

  if (!details.isOnline) {
    cell.state = "offline";
    cell.agentPid = 0;
    dropEdgesTouching(m, host);
    return { vaultChanged };
  }

  const newFp = fingerprintOf(details);
  const recycled = cell.fingerprint !== null && !sameFingerprint(cell.fingerprint, newFp);
  if (recycled) {
    cell.attempts = 0;
    if (dropVaultEntry(m, host)) vaultChanged = true;
    dropEdgesTouching(m, host);
  }
  cell.details = details;
  cell.fingerprint = newFp;
  cell.lastSeen = now;

  const baseState: DarknetCellState = details.hasAdmin ? (m.stasisHosts.includes(host) ? "anchor" : "admin") : "frontier";
  // Death is normal (design doc section 2): a restart or delete kills an
  // agent silently, so a resident marker older than a few missed ticks is
  // stale and should fall back to whatever the fresh poll says.
  const livenessWindow = Math.max(config.agentIntervalMs * 3, AGENT_LIVENESS_FLOOR_MS);
  const agentTimedOut = cell.agentSeenAt > 0 && now - cell.agentSeenAt > livenessWindow;
  if (recycled || agentTimedOut || (cell.state !== "agent" && cell.state !== "anchor")) {
    if (recycled || agentTimedOut) cell.agentPid = 0;
    cell.state = baseState;
  }

  return { vaultChanged };
}

// === CHARISMA NEED ===

/**
 * The next charisma gate worth training for: the lowest `requiredCharismaSkill`
 * above the player's own that unblocks at least one frontier host, overridden
 * by the current lab's threshold when that's the lower (and still unmet) gate.
 * Null when nothing is gated.
 */
export function charismaNeed(m: DarknetModel, player: PlayerInfo, limits: Limits): { target: number; unlocks: number; reason: string } | null {
  const frontierGates: number[] = [];
  for (const c of Object.values(m.cells)) {
    if (c.state !== "frontier" || !c.details) continue;
    if (c.details.requiredCharismaSkill > player.charisma) frontierGates.push(c.details.requiredCharismaSkill);
  }

  let target: number | null = frontierGates.length > 0 ? Math.min(...frontierGates) : null;
  let reason = target !== null ? "frontier" : "";

  const labName = limits.labName;
  if (labName) {
    const labCha = LAB_HOSTS[labName as keyof typeof LAB_HOSTS]?.cha;
    if (labCha !== undefined && labCha > player.charisma && (target === null || labCha < target)) {
      target = labCha;
      reason = "lab";
    }
  }

  if (target === null) return null;
  const unlocks = frontierGates.filter((g) => g <= (target as number)).length;
  return { target, unlocks, reason };
}

// === CARRIERS (AIR GAP CROSSING) ===

/**
 * Admin hosts whose induced-migration range `[difficulty - 2, difficulty + 4]`
 * can reach past the next uncrossed air-gap row (design doc section 6).
 * Only meaningful with full darknet access, where air gaps exist at all.
 */
export function selectCarriers(m: DarknetModel, limits: Limits): string[] {
  if (limits.access !== "full") return [];

  let deepestAdmin = 0;
  for (const c of Object.values(m.cells)) {
    if (c.details && isLiveAdmin(c.state) && c.details.depth > deepestAdmin) deepestAdmin = c.details.depth;
  }

  const gap = nextGapRow(deepestAdmin);
  if (gap >= netDepthOf(limits)) return [];

  const carriers: string[] = [];
  for (const c of Object.values(m.cells)) {
    if (!c.details || !isLiveAdmin(c.state)) continue;
    if (c.details.isStationary) continue;
    if (m.stasisHosts.includes(c.host)) continue;
    const d = c.details.difficulty;
    if (d >= gap - 3 && d <= gap - 1) carriers.push(c.host);
  }
  return carriers.sort();
}

// === STASIS PRIORITY ===

function stasisFits(cell: CellRecord): boolean {
  const maxRam = cell.details?.maxRam ?? 0;
  return maxRam - DNET_WORKER_RAM.agent >= DNET_WORKER_RAM.stasis;
}

/**
 * Hostnames to hold a stasis link, best first, at most `limits.stasisLimit`
 * long. Manual mode simply echoes `model.manualStasis` (the dashboard/control
 * port already validated those). Auto mode (design doc section 4 "Budgets"):
 * the deepest agent host adjacent to the current lab, then the deepest agent
 * host in each already-crossed air-gap band, then a darkweb-adjacent host —
 * each only among hosts where the 13.6 GB stasis worker actually fits beside
 * the 6.25 GB resident agent. An existing link is kept unless its host has
 * gone offline or a fresh candidate for its slot is two or more rows deeper.
 */
export function stasisPriority(m: DarknetModel, config: DarknetConfig, limits: Limits, now: number): string[] {
  void now; // reserved for future hysteresis timing; hosts are the only input today
  if (limits.stasisLimit <= 0) return [];

  if (config.stasisMode === "manual") {
    return m.manualStasis.slice(0, limits.stasisLimit);
  }

  // A currently-linked host is "anchor", not "agent" (applyReport/
  // refreshFromDetails derive that from `m.stasisHosts` membership). It must
  // still be eligible to hold its own link, so both states compete here.
  const candidates = Object.values(m.cells).filter((c) => (c.state === "agent" || c.state === "anchor") && c.details && stasisFits(c));
  const used = new Set<string>();
  const picks: string[] = [];

  const labName = limits.labName;
  if (labName) {
    const labAdjacent = candidates.filter((c) => !used.has(c.host) && m.edges.has(edgeKey(c.host, labName)));
    const deepest = pickDeepest(labAdjacent);
    if (deepest) {
      picks.push(deepest.host);
      used.add(deepest.host);
    }
  }

  const netDepth = netDepthOf(limits);
  for (let g = 8; g < netDepth; g += 8) {
    const pastGap = Object.values(m.cells).some((c) => c.details && isLiveAdmin(c.state) && c.details.depth > g);
    if (!pastGap) continue;
    // The band just past this crossed gap (the newly-won foothold), not the
    // band before it.
    const band = candidates.filter((c) => !used.has(c.host) && c.details!.depth > g && c.details!.depth <= g + 8);
    const deepest = pickDeepest(band);
    if (deepest) {
      picks.push(deepest.host);
      used.add(deepest.host);
    }
  }

  if (picks.length < limits.stasisLimit) {
    const darkwebAdjacent = candidates.filter((c) => !used.has(c.host) && m.edges.has(edgeKey(c.host, "darkweb")));
    const deepest = pickDeepest(darkwebAdjacent);
    if (deepest) {
      picks.push(deepest.host);
      used.add(deepest.host);
    }
  }

  // The fresh slate this pass would choose, capped to budget. The three
  // priority bands (lab-adjacent, per-gap, darkweb-fallback) don't carry
  // enough identity to say which slot an existing anchor originally filled,
  // so as a simplification each anchor is compared against the whole fresh
  // slate rather than just "its" slot: any entry >=2 rows deeper can outbid
  // it. Design doc sections 4/6 don't settle this more precisely.
  const freshSlate = picks.slice(0, limits.stasisLimit);

  // Hysteresis: an existing, still-online link is kept unless a fresh
  // candidate is two or more rows deeper. This decision is made for every
  // current anchor before any budget slicing happens below, so simply being
  // "full" from fresh picks alone can never evict an anchor that doesn't
  // meet the >=2-rows bar. Only a genuinely new pick counts as "a candidate"
  // here — another existing anchor reappearing in the fresh slate (it's
  // still a valid candidate for its own slot) must not count as evidence
  // against a *different* anchor; otherwise two anchors could evict each
  // other in a single pass.
  const kept: string[] = [];
  for (const anchor of m.stasisHosts) {
    const anchorCell = m.cells[anchor];
    if (!anchorCell || anchorCell.state === "offline") continue; // moved: host went offline
    const anchorDepth = anchorCell.details?.depth ?? 0;
    const replacedByDeeper = freshSlate.some((p) => !m.stasisHosts.includes(p) && (m.cells[p]?.details?.depth ?? 0) >= anchorDepth + 2);
    if (!replacedByDeeper) kept.push(anchor);
  }

  const final: string[] = [...kept];
  for (const p of freshSlate) {
    if (final.length >= limits.stasisLimit) break;
    if (!final.includes(p)) final.push(p);
  }

  return final.slice(0, limits.stasisLimit);
}

// === LAB HOST SELECTION ===

/** The admin host one row shallower than, and adjacent to, the current lab. */
function selectLabHost(m: DarknetModel, limits: Limits): string | null {
  const labName = limits.labName;
  if (!labName) return null;
  const labDepth = LAB_HOSTS[labName as keyof typeof LAB_HOSTS]?.depth;
  if (labDepth === undefined) return null;

  const candidates = Object.values(m.cells).filter(
    (c) => c.details && c.details.depth === labDepth - 1 && isLiveAdmin(c.state) && m.edges.has(edgeKey(c.host, labName)),
  );
  if (candidates.length === 0) return null;
  const stasisLinked = candidates.find((c) => m.stasisHosts.includes(c.host));
  return (stasisLinked ?? candidates[0]).host;
}

function syncLabTarget(m: DarknetModel, limits: Limits): void {
  if (!limits.labName) return;
  if (!m.lab || m.lab.name !== limits.labName) {
    // Either first sync, or progression moved to a new lab (section 7): the
    // walker starts over on the new target.
    m.lab = { name: limits.labName, runner: null, grid: null, moves: 0, cleared: false, password: null };
  }
}

function updateStuckSince(m: DarknetModel, limits: Limits, now: number): void {
  if (limits.access !== "full") {
    m.stuckSince = null;
    return;
  }

  let deepestAdmin = 0;
  for (const c of Object.values(m.cells)) {
    if (c.details && isLiveAdmin(c.state) && c.details.depth > deepestAdmin) deepestAdmin = c.details.depth;
  }
  const gap = nextGapRow(deepestAdmin);
  if (gap >= netDepthOf(limits)) {
    m.stuckSince = null;
    return;
  }

  // Simplification of "no neighbour lies below row 8k": checked against the
  // whole known map rather than strictly the gap-edge hosts' own neighbours,
  // since every explored host at or past the gap is reachable through some
  // edge back to the frontier anyway.
  const atGapEdge = Object.values(m.cells).some(
    (c) => c.details && isLiveAdmin(c.state) && c.lastSeen > 0 && (c.details.depth === gap - 1 || c.details.depth === gap - 2),
  );
  const pastGap = Object.values(m.cells).some((c) => c.details && c.details.depth >= gap);

  if (atGapEdge && !pastGap) {
    if (m.stuckSince === null) m.stuckSince = now;
  } else {
    m.stuckSince = null;
  }
}

// === POLICY ===

/**
 * Build the `Policy` published to every agent this tick. Also mutates the
 * model's own bookkeeping that only this function updates: `model.lab`
 * (synced to the current lab target), `model.stuckSince` (air-gap stall
 * detection), and `model.pauseUntil`/`model.stormPending` (the storm gate).
 * Must run after every `applyReport`/`refreshFromDetails` call for the tick,
 * and before `toStatus`.
 */
export function computePolicy(m: DarknetModel, config: DarknetConfig, player: PlayerInfo, limits: Limits, now: number): Policy {
  syncLabTarget(m, limits);
  updateStuckSince(m, limits, now);

  const migrationTargets = selectCarriers(m, limits);
  const stasisTargets = stasisPriority(m, config, limits, now);

  const stuck = m.stuckSince !== null && now - m.stuckSince >= config.gapPatienceMs;
  // "Every stasis link is placed" (design doc section 6) means every
  // currently *desired* host is actually present in `m.stasisHosts` — not
  // that the desired count has reached the budget limit. A net with fewer
  // qualifying hosts than `stasisLimit` shouldn't block storm forever, and a
  // link can be desired for several ticks before an agent finishes setting
  // it, which is exactly the case this must not race past.
  const desiredStasisPlaced = stasisTargets.every((h) => m.stasisHosts.includes(h));
  if (config.storm === "auto" && !m.stormPending && stuck && migrationTargets.length === 0 && desiredStasisPlaced && m.stormSeedHost !== null) {
    m.stormPending = true;
  }

  // Arming the pause (and firing the storm once it elapses) both require a
  // real seed host. Without one, `stormPending` stays true but inert rather
  // than cycling pause on/off every tick with nothing to fire at.
  if (m.stormPending && m.stormSeedHost !== null) {
    if (m.pauseUntil === 0) {
      m.pauseUntil = now + 30_000;
    } else if (now >= m.pauseUntil) {
      // Open a firing window (see STORM_FIRE_WINDOW_MS) instead of firing for a
      // single tick, so the seed host's agent doesn't miss the flag.
      m.stormFireUntil = now + STORM_FIRE_WINDOW_MS;
      m.stormPending = false;
      m.pauseUntil = 0;
    }
  }
  const pause = now < m.pauseUntil;
  const stormFiring = now < m.stormFireUntil;

  const labHost = selectLabHost(m, limits);
  const labCha = limits.labName ? LAB_HOSTS[limits.labName as keyof typeof LAB_HOSTS]?.cha ?? Infinity : Infinity;

  const workers: Record<string, WorkerFlags> = {};
  let anyAgentAlive = false;

  for (const cell of Object.values(m.cells)) {
    if (cell.state !== "agent" && cell.state !== "anchor") continue;
    anyAgentAlive = true;

    const maxRam = cell.details?.maxRam ?? 0;
    const blockedRam = cell.details?.blockedRam ?? 0;
    const harvest = config.harvest && (blockedRam > 0 || cell.cacheSeen) && player.karma >= config.harvestKarmaFloor;

    const wantsLink = stasisTargets.includes(cell.host);
    const hasLink = m.stasisHosts.includes(cell.host);
    let stasis: boolean | null = null;
    if (wantsLink && !hasLink) stasis = true;
    else if (!wantsLink && hasLink) stasis = false;

    let charge: string | null = null;
    for (const carrier of migrationTargets) {
      if (m.edges.has(edgeKey(cell.host, carrier))) {
        charge = carrier;
        break;
      }
    }

    const lab = config.lab && labHost === cell.host && player.charisma >= labCha && !(m.lab?.cleared ?? false);

    // Reserve for every worker this host will run alongside phishing so that
    // sizing phishThreads to the remainder never starves them at launch.
    // dnet-stasis.js is one-shot (it sets/clears the link then frees its
    // 13.6 GB), but it still needs room the tick it fires, so reserve for it
    // only while we are about to SET a link (stasis === true); once the link
    // is placed the flag goes null and phish reclaims the space next tick.
    let reserved = DNET_WORKER_RAM.agent;
    if (harvest) reserved += DNET_WORKER_RAM.harvest;
    if (charge) reserved += DNET_WORKER_RAM.charge;
    if (lab) reserved += DNET_WORKER_RAM.lab;
    if (stasis === true) reserved += DNET_WORKER_RAM.stasis;

    // Size phishing to the RAM that is actually free right now, not `maxRam`:
    // the game charges a host's blocked RAM as *used* (`applyRamBlocks`), so a
    // phish launch sized to include blocked RAM would exceed the host's real
    // free space and `ns.run` would return pid 0 every tick until the block is
    // cleared -- no phishing income at all on a blocked host. As `dnet-harvest`
    // frees the block, `blockedRam` shrinks and phishing scales up to match.
    const freeForPhish = Math.max(0, maxRam - blockedRam - reserved);
    const phishThreads = config.phish ? Math.min(config.phishMaxThreads, Math.floor(freeForPhish / DNET_WORKER_RAM.phish)) : 0;

    workers[cell.host] = {
      harvest,
      phishThreads,
      lab,
      stasis,
      charge,
      storm: stormFiring && cell.host === m.stormSeedHost,
    };
  }

  // Approximation: the game exposes no flag for "heartbleed has been called
  // this node", so treat it as used once config allows it and at least one
  // agent is resident to potentially call it.
  if (config.heartbleed && anyAgentAlive) m.heartbleedUsedThisNode = true;

  return {
    version: AGENT_VERSION,
    pause,
    heartbleed: config.heartbleed,
    charisma: player.charisma,
    maxAttempts: config.maxAttempts,
    agentIntervalMs: config.agentIntervalMs,
    vault: { ...m.vault.entries },
    workers,
    stasisTargets,
    migrationTargets,
    labHost,
    labName: limits.labName,
    labGrid: m.lab?.grid ?? null,
    publishedAt: now,
  };
}

// === STATUS ===

/**
 * Build the `DarknetStatus` published to the dashboard/advisor. Reads
 * `model.stuckSince` and `model.lab`, both of which `computePolicy` keeps in
 * sync — call this after `computePolicy` each tick.
 */
export function toStatus(
  m: DarknetModel,
  config: DarknetConfig,
  player: PlayerInfo,
  limits: Limits,
  instability: { authenticationDurationMultiplier: number; authenticationTimeoutChance: number },
  now: number,
): DarknetStatus {
  const counts = { seen: 0, admin: 0, agents: 0, frontier: 0, blocked: 0, offline: 0 };
  let deepestAdmin = 0;

  for (const c of Object.values(m.cells)) {
    if (c.state === "offline") {
      counts.offline += 1;
      continue;
    }
    counts.seen += 1;
    if (isLiveAdmin(c.state)) {
      counts.admin += 1;
      if (c.details && c.details.depth > deepestAdmin) deepestAdmin = c.details.depth;
    }
    if (c.state === "agent" || c.state === "anchor") counts.agents += 1;
    if (c.state === "frontier") {
      counts.frontier += 1;
      if (c.details && c.details.requiredCharismaSkill > player.charisma) counts.blocked += 1;
    }
  }

  const netDepth = netDepthOf(limits);
  const gap = nextGapRow(deepestAdmin);
  const stuck = limits.access === "full" && gap < netDepth && m.stuckSince !== null && now - m.stuckSince >= config.gapPatienceMs;

  const byDepth = new Map<number, DarknetCell[]>();
  for (const c of Object.values(m.cells)) {
    const depth = c.details?.depth ?? 0;
    const cell: DarknetCell = {
      host: c.host,
      model: c.details?.modelId ?? "",
      difficulty: c.details?.difficulty ?? 0,
      cha: c.details?.requiredCharismaSkill ?? 0,
      depth,
      state: c.state,
    };
    const row = byDepth.get(depth);
    if (row) row.push(cell);
    else byDepth.set(depth, [cell]);
  }
  const rows: DarknetCell[][] = [...byDepth.keys()]
    .sort((a, b) => a - b)
    .map((depth) => byDepth.get(depth)!.sort((a, b) => a.host.localeCompare(b.host)));

  const edges: [string, string][] = [...m.edges]
    .map((key): [string, string] => {
      const [a, b] = key.split("|");
      return [a, b];
    })
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));

  const elapsedHours = m.income.since > 0 ? (now - m.income.since) / 3_600_000 : 0;
  const moneyPerHour = elapsedHours > 0 ? m.income.money / elapsedHours : 0;

  return {
    access: limits.access,
    heartbleedAllowed: config.heartbleed,
    heartbleedUsedThisNode: m.heartbleedUsedThisNode,
    charisma: player.charisma,
    counts,
    deepestAdmin,
    netDepth,
    instability,
    stasis: { used: m.stasisHosts.length, limit: limits.stasisLimit, hosts: m.stasisHosts, mode: config.stasisMode },
    charismaNeed: charismaNeed(m, player, limits),
    lab: m.lab
      ? {
          name: m.lab.name,
          runner: m.lab.runner,
          cha: limits.labName ? LAB_HOSTS[limits.labName as keyof typeof LAB_HOSTS]?.cha ?? 0 : 0,
          cleared: m.lab.cleared,
          // Repo convention (`AugmentsStatus.pendingAugs`): "acquired but not
          // installed." An aug is acquired once its great-work cache is
          // opened (`augsAwarded` bumped by the "cache" event), not merely
          // once the lab is cleared and waiting to be opened.
          augPending: m.lab.cleared && m.income.augsAwarded > 0,
          moves: m.lab.moves,
        }
      : null,
    income: {
      moneyPerHour,
      cachesOpened: m.income.cachesOpened,
      contractsFound: m.income.contractsFound,
      augsAwarded: m.income.augsAwarded,
    },
    stormSeedHost: m.stormSeedHost,
    stuck,
    config: configToRecord(config),
    map: { rows, edges },
  };
}
