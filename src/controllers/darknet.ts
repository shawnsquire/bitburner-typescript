/**
 * Darknet Coordinator Controller
 *
 * Pure logic for the home-side darknet coordinator (`daemons/darknet.ts`,
 * a later task): owns the in-memory map of known darknet cells, the
 * password vault, income tallies, and the policy published to agents.
 * No `ns` import — the daemon calls `ns.dnet.*`, reads `/config/darknet.txt`
 * and reads/writes the vault (`lib/darknet/vault.ts`), then hands the
 * results in here as plain data.
 *
 * Import with: import { ... } from "/controllers/darknet";
 */
import type {
  Fingerprint,
  Policy,
  ReportBatch,
  SeenDetails,
  Vault,
  VaultEntry,
  WorkerFlags,
} from "/lib/darknet/protocol";
import { AGENT_VERSION, DNET_WORKER_RAM, LAB_HOSTS, LAB_MODEL_ID, fingerprintOf, sameFingerprint } from "/lib/darknet/protocol";
import type { DarknetCell, DarknetCellState, DarknetStatus } from "/types/ports";

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
}

export interface DarknetModel {
  cells: Record<string, CellRecord>;
  edges: Set<string>; // "a|b" with a < b lexically
  vault: Vault;
  stasisHosts: string[];
  stormSeedHost: string | null;
  lab: { name: string; runner: string | null; grid: string[] | null; moves: number; cleared: boolean; password: string | null } | null;
  income: { money: number; since: number; cachesOpened: number; contractsFound: number; augsAwarded: number };
  heartbleedUsedThisNode: boolean;
  stuckSince: number | null;
  pauseUntil: number;
  stormPending: boolean;
  manualStasis: string[];
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

/** Rows at multiples of this depth are air gaps (design section 6). */
const GAP_INTERVAL = 8;

/**
 * How long a reported agent stays "live" without a fresh report before its
 * cell falls back to its non-agent state. `applyReport`/`refreshFromDetails`
 * don't receive `cfg`, so this can't be `cfg.agentIntervalMs`; it's sized to
 * tolerate the agent's own 10s idle sleep (design section 2, step 7) plus
 * one missed/retried batch.
 */
const AGENT_LIVE_WINDOW_MS = 15_000;

export function createModel(vault: Vault): DarknetModel {
  return {
    cells: {},
    edges: new Set<string>(),
    vault,
    stasisHosts: [],
    stormSeedHost: null,
    lab: null,
    // 0 means "not started yet"; applyReport sets it to the first `now` it
    // sees. Keeping this pure (no Date.now()) means createModel is
    // deterministic and buildStatus treats 0 as "no income data yet".
    income: { money: 0, since: 0, cachesOpened: 0, contractsFound: 0, augsAwarded: 0 },
    heartbleedUsedThisNode: false,
    stuckSince: null,
    pauseUntil: 0,
    stormPending: false,
    manualStasis: [],
  };
}

// === SMALL HELPERS ===

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function neighboursOf(m: DarknetModel, host: string): string[] {
  const result: string[] = [];
  for (const e of m.edges) {
    const sep = e.indexOf("|");
    const a = e.slice(0, sep);
    const b = e.slice(sep + 1);
    if (a === host) result.push(b);
    else if (b === host) result.push(a);
  }
  return result;
}

function ensureCell(m: DarknetModel, host: string, now: number): CellRecord {
  let cell = m.cells[host];
  if (!cell) {
    cell = { host, details: null, fingerprint: null, state: "unknown", lastSeen: now, agentPid: 0, agentSeenAt: 0, attempts: 0 };
    m.cells[host] = cell;
  }
  return cell;
}

function isAgentLive(cell: CellRecord, now: number): boolean {
  return cell.agentPid !== 0 && now - cell.agentSeenAt <= AGENT_LIVE_WINDOW_MS;
}

/** True admin-rights predicate, independent of display state (which "agent" can shadow). */
function hasAdminNow(cell: CellRecord): boolean {
  return cell.details?.hasAdmin === true;
}

/**
 * Display state for a cell. A live agent always wins the display (it's the
 * most actionable fact), then admin (as "anchor" if stasis-linked), then
 * frontier for anything a solver could try. Every model has a solver
 * (design section 3) except the labyrinth's special `modelId`, so "a solver
 * could try it" reduces to "isn't the labyrinth model" without needing to
 * import the solver registry (out of scope for this controller's imports).
 */
function deriveState(m: DarknetModel, cell: CellRecord, now: number): DarknetCellState {
  const d = cell.details;
  if (!d || !d.isOnline) return "offline";
  if (isAgentLive(cell, now)) return "agent";
  if (d.hasAdmin) return m.stasisHosts.includes(cell.host) ? "anchor" : "admin";
  if (d.modelId === LAB_MODEL_ID) return "unknown"; // solved by walking, not a password solver
  return "frontier";
}

/** Store fresh details on a cell, resetting it on an identity change. Returns whether the vault line was dropped. */
function upsertDetails(m: DarknetModel, cell: CellRecord, details: SeenDetails, now: number): boolean {
  const fp = fingerprintOf(details);
  const identityChanged = cell.fingerprint !== null && !sameFingerprint(cell.fingerprint, fp);

  cell.details = details;
  cell.fingerprint = fp;
  cell.lastSeen = now;

  let vaultChanged = false;
  if (identityChanged) {
    cell.attempts = 0;
    if (m.vault.entries[cell.host]) {
      delete m.vault.entries[cell.host];
      vaultChanged = true;
    }
  }

  cell.state = deriveState(m, cell, now);
  return vaultChanged;
}

function labMetaFor(name: string): { depth: number; cha: number } | null {
  return (LAB_HOSTS as Record<string, { depth: number; cha: number; offsetStartAndEnd: boolean }>)[name] ?? null;
}

/** The admin host one row above the current lab, from which its walker is reseeded. */
function labHostFor(m: DarknetModel): { host: string; name: string } | null {
  if (!m.lab) return null;
  const meta = labMetaFor(m.lab.name);
  if (!meta) return null;
  const targetDepth = meta.depth - 1;
  const candidates = Object.values(m.cells).filter((c) => hasAdminNow(c) && c.details!.depth === targetDepth);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.host.localeCompare(b.host));
  return { host: candidates[0].host, name: m.lab.name };
}

/**
 * Gap rows (8, 16, 24, ...) the swarm is currently stuck below, per design
 * section 6: every admin host at the edge of the gap (depth `8k-1`/`8k-2`)
 * has been probed (we know its neighbours), none of those neighbours reach
 * past the gap, and nothing has crossed it another way.
 */
function stuckGapRows(m: DarknetModel): number[] {
  const adminCells = Object.values(m.cells).filter(hasAdminNow);
  const edgeByRow = new Map<number, CellRecord[]>();
  for (const c of adminCells) {
    const depth = c.details!.depth;
    const gapRow = GAP_INTERVAL * (Math.floor(depth / GAP_INTERVAL) + 1);
    if (depth === gapRow - 1 || depth === gapRow - 2) {
      if (!edgeByRow.has(gapRow)) edgeByRow.set(gapRow, []);
      edgeByRow.get(gapRow)!.push(c);
    }
  }

  const stuck: number[] = [];
  for (const [gapRow, edgeAdmins] of edgeByRow) {
    const alreadyCrossed = adminCells.some((c) => c.details!.depth >= gapRow);
    if (alreadyCrossed) continue;

    const probed = edgeAdmins.filter((c) => neighboursOf(m, c.host).length > 0);
    if (probed.length === 0) continue; // haven't even reached the edge yet

    const crossesSomewhere = probed.some((c) =>
      neighboursOf(m, c.host).some((n) => {
        const nc = m.cells[n];
        return nc?.details != null && nc.details.depth >= gapRow;
      }),
    );
    if (!crossesSomewhere) stuck.push(gapRow);
  }
  return stuck.sort((a, b) => a - b);
}

/** Gap rows (8, 16, 24, ...) already crossed by at least one admin host. */
function crossedGapRows(m: DarknetModel): number[] {
  const maxAdminDepth = Object.values(m.cells)
    .filter(hasAdminNow)
    .reduce((max, c) => Math.max(max, c.details!.depth), 0);
  const rows: number[] = [];
  for (let g = GAP_INTERVAL; g <= maxAdminDepth; g += GAP_INTERVAL) rows.push(g);
  return rows;
}

/** Recompute `m.stuckSince`: set it the tick the raw stuck condition first holds, clear it once resolved. */
function updateStuckSince(m: DarknetModel, now: number): void {
  const stuckNow = stuckGapRows(m).length > 0;
  if (stuckNow) {
    if (m.stuckSince === null) m.stuckSince = now;
  } else {
    m.stuckSince = null;
  }
}

// === REPORTS ===

export function applyReport(
  m: DarknetModel,
  batch: ReportBatch,
  now: number,
): { contracts: { host: string; file: string }[]; vaultChanged: boolean } {
  let vaultChanged = false;
  const contracts: { host: string; file: string }[] = [];

  if (m.income.since === 0) m.income.since = now;

  const reporter = ensureCell(m, batch.from, now);
  reporter.agentPid = batch.pid;
  reporter.agentSeenAt = batch.at;
  if (reporter.details) reporter.state = deriveState(m, reporter, now);

  for (const ev of batch.events) {
    switch (ev.t) {
      case "seen": {
        const cell = ensureCell(m, ev.host, now);
        if (upsertDetails(m, cell, ev.details, now)) vaultChanged = true;
        // The reporting agent is adjacent to whatever it just probed.
        m.edges.add(edgeKey(batch.from, ev.host));
        for (const neighbour of ev.neighbours) {
          m.edges.add(edgeKey(ev.host, neighbour));
        }
        break;
      }

      case "cracked": {
        const cell = ensureCell(m, ev.host, now);
        cell.state = "admin";
        cell.fingerprint = ev.fingerprint;
        if (cell.details) cell.details = { ...cell.details, hasAdmin: true };
        m.vault.entries[ev.host] = { password: ev.password, fingerprint: ev.fingerprint, seenAt: now };
        vaultChanged = true;
        break;
      }

      case "stale": {
        const entry = m.vault.entries[ev.host];
        if (entry && sameFingerprint(entry.fingerprint, ev.fingerprint)) {
          delete m.vault.entries[ev.host];
          vaultChanged = true;
        }
        break;
      }

      case "leak": {
        // Leak events carry no fingerprint, so a candidate can only be
        // trusted for a host we've already `seen` (and thus fingerprinted);
        // never overwrite a password we already trust.
        if (ev.host && ev.password && !m.vault.entries[ev.host]) {
          const fp = m.cells[ev.host]?.fingerprint;
          if (fp) {
            m.vault.entries[ev.host] = { password: ev.password, fingerprint: fp, seenAt: now };
            vaultChanged = true;
          }
        }
        break;
      }

      case "gap": {
        // No model change: charismaNeed reads details.requiredCharismaSkill
        // directly, which a prior `seen` already stored.
        break;
      }

      case "cache": {
        m.income.cachesOpened++;
        break;
      }

      case "contract": {
        m.income.contractsFound++;
        contracts.push({ host: ev.host, file: ev.file });
        break;
      }

      case "ramfreed": {
        // The task text says "optionally update details.usedRam", but
        // `remaining` is what memoryReallocation shrinks (design section
        // 5) and harvest's own gate reads `blockedRam > 0` — so this
        // updates `blockedRam`, which is the field the rest of the model
        // actually consults. Non-persistent either way (a `seen`/refresh
        // overwrites it next tick).
        const cell = m.cells[ev.host];
        if (cell?.details) cell.details = { ...cell.details, blockedRam: ev.remaining };
        break;
      }

      case "storm-seed": {
        m.stormSeedHost = ev.host;
        break;
      }

      case "phish": {
        m.income.money += ev.money;
        if (ev.cache) m.income.cachesOpened++;
        break;
      }

      case "lab": {
        if (!m.lab || m.lab.name !== ev.host) {
          m.lab = { name: ev.host, runner: batch.from, grid: ev.grid, moves: ev.moves, cleared: false, password: null };
        }
        m.lab.runner = batch.from;
        m.lab.grid = ev.grid;
        m.lab.moves = ev.moves;
        if (ev.cleared && !m.lab.cleared) {
          m.lab.cleared = true;
          m.lab.password = ev.password ?? null;
          m.income.augsAwarded++;
        }
        break;
      }

      case "error": {
        const cell = m.cells[ev.host];
        if (cell) cell.attempts++;
        break;
      }
    }
  }

  updateStuckSince(m, now);
  return { contracts, vaultChanged };
}

export function refreshFromDetails(m: DarknetModel, host: string, details: SeenDetails | null, now: number): { vaultChanged: boolean } {
  const cell = ensureCell(m, host, now);

  if (details === null) {
    cell.state = "offline";
    cell.agentPid = 0;
    updateStuckSince(m, now);
    return { vaultChanged: false };
  }

  const vaultChanged = upsertDetails(m, cell, details, now);
  updateStuckSince(m, now);
  return { vaultChanged };
}

// === POLICY HELPERS ===

export function charismaNeed(m: DarknetModel, charisma: number): DarknetStatus["charismaNeed"] {
  const blocked = Object.values(m.cells).filter(
    (c) => c.details !== null && (c.state === "frontier" || c.state === "unknown") && c.details.requiredCharismaSkill > charisma,
  );

  let target: number | null = blocked.length > 0 ? Math.min(...blocked.map((c) => c.details!.requiredCharismaSkill)) : null;

  let labCha: number | null = null;
  if (m.lab && !m.lab.cleared) {
    const meta = labMetaFor(m.lab.name);
    if (meta && meta.cha > charisma) labCha = meta.cha;
  }
  if (labCha !== null && (target === null || labCha < target)) target = labCha;

  if (target === null) return null;

  const unlocks = blocked.filter((c) => c.details!.requiredCharismaSkill <= target!).length + (labCha !== null && labCha <= target ? 1 : 0);

  const reason = labCha !== null && target === labCha ? `Charisma ${target} clears the ${m.lab!.name} labyrinth` : `Charisma ${target} unlocks ${unlocks} server${unlocks === 1 ? "" : "s"}`;

  return { target, unlocks, reason };
}

export function selectCarriers(m: DarknetModel, access: "none" | "basic" | "full"): string[] {
  if (access !== "full") return [];
  const gaps = stuckGapRows(m);
  if (gaps.length === 0) return [];

  const result = new Set<string>();
  for (const cell of Object.values(m.cells)) {
    if (!hasAdminNow(cell)) continue;
    if (m.stasisHosts.includes(cell.host)) continue; // stasis hosts are immutable, cannot migrate
    if (cell.details!.isStationary) continue;
    const difficulty = cell.details!.difficulty;
    for (const gapRow of gaps) {
      if (difficulty >= gapRow - 3 && difficulty <= gapRow - 1) {
        result.add(cell.host);
        break;
      }
    }
  }
  return [...result].sort();
}

export function stasisPriority(m: DarknetModel, cfg: DarknetConfig, limit: number): { set: string[]; clear: string[] } {
  const qualifies = (host: string): boolean => {
    const c = m.cells[host];
    if (!c || !hasAdminNow(c)) return false;
    return c.details!.maxRam - DNET_WORKER_RAM.agent >= DNET_WORKER_RAM.stasis;
  };

  let desired: string[];
  if (cfg.stasisMode === "manual") {
    desired = m.manualStasis.filter(qualifies);
  } else {
    const ranked: string[] = [];

    const lab = labHostFor(m);
    if (lab && qualifies(lab.host)) ranked.push(lab.host);

    for (const gapRow of crossedGapRows(m)) {
      const band = Object.values(m.cells)
        .filter((c) => qualifies(c.host) && c.details!.depth >= gapRow && c.details!.depth < gapRow + GAP_INTERVAL)
        .sort((a, b) => b.details!.depth - a.details!.depth || a.host.localeCompare(b.host));
      if (band.length > 0 && !ranked.includes(band[0].host)) ranked.push(band[0].host);
    }

    const darkwebAdjacent = neighboursOf(m, "darkweb").filter(qualifies).sort();
    if (darkwebAdjacent.length > 0 && !ranked.includes(darkwebAdjacent[0])) ranked.push(darkwebAdjacent[0]);

    desired = ranked;
  }

  const set = desired.slice(0, Math.max(0, limit));
  const clear = m.stasisHosts.filter((h) => !set.includes(h));
  return { set, clear };
}

export function isStuck(m: DarknetModel, cfg: DarknetConfig, now: number): boolean {
  // No `access` parameter: air gaps (and therefore the stuck condition
  // stuckGapRows checks) structurally can't exist below basic access, since
  // the net caps at depth 5 without full access (design section 1).
  if (m.stuckSince === null) return false;
  return now - m.stuckSince >= cfg.gapPatienceMs;
}

// === POLICY ===

export function computePolicy(
  m: DarknetModel,
  cfg: DarknetConfig,
  player: { charisma: number; karma: number },
  limits: { stasisLimit: number; access: "none" | "basic" | "full" },
  now: number,
): Policy {
  const stasis = stasisPriority(m, cfg, limits.stasisLimit);
  const carriers = selectCarriers(m, limits.access);
  const stuck = isStuck(m, cfg, now);
  const labHostInfo = labHostFor(m);

  const allStasisLinksPlaced = stasis.set.every((h) => m.stasisHosts.includes(h));
  const stormRequested = cfg.storm === "auto" && stuck && carriers.length === 0 && allStasisLinksPlaced;
  const stormTrigger = stormRequested || m.stormPending;
  m.stormPending = false; // consumed this tick regardless of whether it actually fires

  const stormFires = stormTrigger && m.stormSeedHost !== null;
  if (stormFires) m.pauseUntil = now + 30_000;
  const pause = now < m.pauseUntil;

  const workers: Record<string, WorkerFlags> = {};
  for (const cell of Object.values(m.cells)) {
    if (!isAgentLive(cell, now) || !cell.details) continue;
    const d = cell.details;

    const harvest = cfg.harvest && d.blockedRam > 0 && player.karma >= cfg.harvestKarmaFloor;
    const freeAfterAgent = d.maxRam - DNET_WORKER_RAM.agent - (harvest ? DNET_WORKER_RAM.harvest : 0);
    const phishThreads = cfg.phish ? Math.max(0, Math.min(cfg.phishMaxThreads, Math.floor(freeAfterAgent / DNET_WORKER_RAM.phish))) : 0;
    const lab = cfg.lab && labHostInfo !== null && cell.host === labHostInfo.host;

    let stasisFlag: boolean | null = null;
    if (stasis.set.includes(cell.host)) {
      if (!m.stasisHosts.includes(cell.host)) stasisFlag = true;
    } else if (stasis.clear.includes(cell.host)) {
      stasisFlag = false;
    }

    let charge: string | null = null;
    for (const carrier of carriers) {
      if (m.edges.has(edgeKey(cell.host, carrier))) {
        charge = carrier;
        break;
      }
    }

    const storm = stormFires && cell.host === m.stormSeedHost;

    workers[cell.host] = { harvest, phishThreads, lab, stasis: stasisFlag, charge, storm };
  }

  if (cfg.heartbleed && Object.keys(workers).length > 0) {
    m.heartbleedUsedThisNode = true;
  }

  return {
    version: AGENT_VERSION,
    pause,
    heartbleed: cfg.heartbleed,
    charisma: player.charisma,
    maxAttempts: cfg.maxAttempts,
    agentIntervalMs: cfg.agentIntervalMs,
    vault: m.vault.entries,
    workers,
    stasisTargets: stasis.set,
    migrationTargets: carriers,
    labHost: labHostInfo?.host ?? null,
    labName: m.lab?.name ?? null,
    labGrid: m.lab?.grid ?? null,
    publishedAt: now,
  };
}

// === STATUS ===

function buildMapRows(m: DarknetModel): DarknetCell[][] {
  const byDepth = new Map<number, DarknetCell[]>();
  const unknownBucket: DarknetCell[] = [];

  for (const c of Object.values(m.cells)) {
    const cell: DarknetCell = {
      host: c.host,
      model: c.details?.modelId ?? "?",
      difficulty: c.details?.difficulty ?? 0,
      cha: c.details?.requiredCharismaSkill ?? 0,
      depth: c.details?.depth ?? -1,
      state: c.state,
    };
    if (c.details) {
      const depth = c.details.depth;
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth)!.push(cell);
    } else {
      unknownBucket.push(cell);
    }
  }

  const rows = [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.sort((a, b) => a.host.localeCompare(b.host)));
  if (unknownBucket.length > 0) {
    rows.push(unknownBucket.sort((a, b) => a.host.localeCompare(b.host)));
  }
  return rows;
}

export function buildStatus(
  m: DarknetModel,
  cfg: DarknetConfig,
  player: { charisma: number },
  limits: { stasisLimit: number; access: "none" | "basic" | "full" },
  instability: { authenticationDurationMultiplier: number; authenticationTimeoutChance: number },
  now: number,
): DarknetStatus {
  const cells = Object.values(m.cells);
  const admin = cells.filter(hasAdminNow);
  const agentsLive = cells.filter((c) => isAgentLive(c, now));
  const frontier = cells.filter((c) => c.state === "frontier");
  const blocked = cells.filter((c) => c.details !== null && (c.state === "frontier" || c.state === "unknown") && c.details.requiredCharismaSkill > player.charisma);
  const offline = cells.filter((c) => c.state === "offline");

  const deepestAdmin = admin.reduce((max, c) => Math.max(max, c.details!.depth), 0);
  const netDepth = cells.reduce((max, c) => (c.details ? Math.max(max, c.details.depth) : max), 0);

  const moneyPerHour = m.income.since === 0 ? 0 : m.income.money / Math.max((now - m.income.since) / 3_600_000, 1 / 3600);

  const configRecord: Record<string, string> = Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, String(v)]));

  const edges: [string, string][] = [...m.edges].map((e) => {
    const sep = e.indexOf("|");
    return [e.slice(0, sep), e.slice(sep + 1)] as [string, string];
  });

  const labMeta = m.lab ? labMetaFor(m.lab.name) : null;

  return {
    access: limits.access,
    heartbleedAllowed: cfg.heartbleed,
    heartbleedUsedThisNode: m.heartbleedUsedThisNode,
    charisma: player.charisma,
    counts: { seen: cells.length, admin: admin.length, agents: agentsLive.length, frontier: frontier.length, blocked: blocked.length, offline: offline.length },
    deepestAdmin,
    netDepth,
    instability,
    stasis: { used: m.stasisHosts.length, limit: limits.stasisLimit, hosts: m.stasisHosts, mode: cfg.stasisMode },
    charismaNeed: charismaNeed(m, player.charisma),
    lab: m.lab
      ? {
          name: m.lab.name,
          runner: m.lab.runner,
          cha: labMeta?.cha ?? 0,
          // Neither ns nor our reports can see whether a cleared lab's
          // augmentation has been installed yet, so this is just "there's a
          // great-work aug waiting"; the advisor (a later task) refines it.
          augPending: m.lab.cleared,
          cleared: m.lab.cleared,
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
    stuck: isStuck(m, cfg, now),
    config: configRecord,
    map: { rows: buildMapRows(m), edges },
  };
}
