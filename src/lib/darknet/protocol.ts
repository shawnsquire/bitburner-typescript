/**
 * Darknet Shared Protocol
 *
 * Types and constants shared between the home-side coordinator
 * (`daemons/darknet.ts`) and the darknet-side agent/worker scripts
 * (`workers/dnet-*.ts`). Zero NS imports, zero RAM cost — safe to import
 * from anything, including scripts that replicate across the darknet.
 *
 * Import with: import { ... } from "/lib/darknet/protocol";
 */
import type { DarknetServerDetails } from "@ns";

/**
 * Bumped whenever the Policy/Report shape or agent behaviour changes in a
 * way that requires every running agent to restart. An agent that sees a
 * mismatched `policy.version` exits so the coordinator can re-exec it with
 * the current bundle.
 */
export const AGENT_VERSION = 1;

/**
 * The three fields that identify a server across restarts and hostname
 * recycling. A vault entry whose fingerprint no longer matches a host's
 * live details is stale and must be dropped.
 */
export interface Fingerprint {
  difficulty: number;
  modelId: string;
  passwordLength: number;
}

/** Copy the three fingerprint fields out of a fuller details object. */
export function fingerprintOf(d: { difficulty: number; modelId: string; passwordLength: number }): Fingerprint {
  return { difficulty: d.difficulty, modelId: d.modelId, passwordLength: d.passwordLength };
}

/** Structural equality of two fingerprints. */
export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.difficulty === b.difficulty && a.modelId === b.modelId && a.passwordLength === b.passwordLength;
}

/** One cracked password, remembered so agents can skip straight to `connectToSession`. */
export interface VaultEntry {
  password: string;
  fingerprint: Fingerprint;
  seenAt: number;
}

/** On-disk shape of `/data/darknet-vault.json`. */
export interface Vault {
  lastNodeReset: number;
  entries: Record<string, VaultEntry>;
}

/** `getServerDetails` result plus the extra fields worth carrying in a `seen` report. */
export type SeenDetails = DarknetServerDetails & { isOnline: boolean; maxRam: number; usedRam: number; hasAdmin: boolean };

/**
 * Per-host worker flags the coordinator publishes in `Policy.workers`, telling
 * an agent on that host which local workers to (re)launch this tick.
 *
 * `stasis`: `true` sets a stasis link on this host, `false` clears it, `null`
 * leaves the current link state alone. `charge`: hostname of a neighbour to
 * push toward migration, or `null` to run no charge worker.
 */
export interface WorkerFlags {
  harvest: boolean;
  phishThreads: number;
  lab: boolean;
  stasis: boolean | null;
  charge: string | null;
  storm: boolean;
}

/**
 * Published to `DARKNET_POLICY_PORT`, one value at a time, replaced every
 * coordinator tick. Agents can only reach `darkweb` from home, so anything
 * they need to know — including config that would otherwise live in
 * `/config/darknet.txt` — rides in here.
 */
export interface Policy {
  version: number;
  pause: boolean;
  heartbleed: boolean;
  charisma: number;
  maxAttempts: number;
  agentIntervalMs: number;
  vault: Record<string, VaultEntry>;
  workers: Record<string, WorkerFlags>;
  stasisTargets: string[];
  migrationTargets: string[];
  labHost: string | null;
  labName: string | null;
  labGrid: string[] | null;
  publishedAt: number;
}

/** Events an agent or worker can report; batched into a `ReportBatch`. */
export type ReportEvent =
  | { t: "seen"; host: string; details: SeenDetails; neighbours: string[] }
  | { t: "cracked"; host: string; password: string; fingerprint: Fingerprint }
  | { t: "stale"; host: string; fingerprint: Fingerprint }
  | { t: "leak"; host: string | null; password?: string; present?: string[]; placed?: string[]; line: string }
  | { t: "gap"; host: string; required: number }
  | { t: "cache"; host: string; file: string; message: string; karmaLoss: number }
  | { t: "ramfreed"; host: string; remaining: number }
  | { t: "contract"; host: string; file: string }
  | { t: "storm-seed"; host: string }
  | { t: "phish"; host: string; money: number; cache: boolean }
  | { t: "lab"; host: string; grid: string[]; pos: [number, number]; moves: number; cleared: boolean; password?: string }
  | { t: "error"; host: string; op: string; code: number; message: string };

/** One batched write to `DARKNET_REPORT_PORT`: every event an agent collected this tick. */
export interface ReportBatch {
  from: string;
  pid: number;
  depth: number;
  at: number;
  events: ReportEvent[];
  /**
   * True only for a batch sent by the agent process itself; the local workers
   * (harvest/phish/stasis/lab/charge) leave it unset. The coordinator uses it
   * to track *agent* liveness specifically: a host whose agent has died but
   * whose phish worker is still looping must not look alive, or its dead agent
   * is never re-seeded and its neighbours are never cracked.
   */
  agent?: boolean;
}

/** Cap on events an agent keeps buffered across failed batch writes before dropping the oldest. */
export const MAX_BACKLOG = 200;

/** Darknet-side worker entry scripts, by role. */
export const DNET_WORKERS = {
  agent: "workers/dnet-agent.js",
  harvest: "workers/dnet-harvest.js",
  phish: "workers/dnet-phish.js",
  lab: "workers/dnet-lab.js",
  stasis: "workers/dnet-stasis.js",
  charge: "workers/dnet-charge.js",
} as const;

/** Must equal each worker's `@ram` tag; the bundle test enforces it once the workers exist. */
export const DNET_WORKER_RAM: Record<keyof typeof DNET_WORKERS, number> = {
  agent: 6.25,
  harvest: 4.9,
  phish: 3.6,
  lab: 2.1,
  stasis: 13.6,
  charge: 5.6,
};

/**
 * Full closure a darknet-side agent needs: every worker entry script plus
 * every `lib/darknet/*` module (and `types/ports`) they import. There is no
 * bundler — `build` is plain `tsc` — so replication must `scp` every one of
 * these dist paths, not just the entry scripts. `test/lib/darknet/bundle.test.ts`
 * walks the real import graph and fails if a file used by a worker is missing
 * from this list.
 */
export const DNET_BUNDLE: string[] = [
  ...Object.values(DNET_WORKERS),
  "types/ports.js",
  "lib/darknet/protocol.js",
  "lib/darknet/wire.js",
  "lib/darknet/leaks.js",
  "lib/darknet/lab.js",
  "lib/darknet/agent-logic.js",
  "lib/darknet/solvers/types.js",
  "lib/darknet/solvers/index.js",
  "lib/darknet/solvers/zero-logon.js",
  "lib/darknet/solvers/desk-memo.js",
  "lib/darknet/solvers/fresh-install.js",
  "lib/darknet/solvers/laika.js",
  "lib/darknet/solvers/eurozone.js",
  "lib/darknet/solvers/top-pass.js",
  "lib/darknet/solvers/cloudblare.js",
  "lib/darknet/solvers/binary.js",
  "lib/darknet/solvers/ordo-xenos.js",
  "lib/darknet/solvers/proverflo.js",
  "lib/darknet/solvers/octant-voxel.js",
  "lib/darknet/solvers/mathml.js",
  "lib/darknet/solvers/prime-time.js",
  "lib/darknet/solvers/bella-cuore.js",
  "lib/darknet/solvers/accounts-manager.js",
  "lib/darknet/solvers/nil.js",
  "lib/darknet/solvers/rate-my-pix.js",
  "lib/darknet/solvers/deep-green.js",
  "lib/darknet/solvers/cellular-2g.js",
  "lib/darknet/solvers/factori-os.js",
  "lib/darknet/solvers/big-mood.js",
  "lib/darknet/solvers/php54.js",
  "lib/darknet/solvers/king-of-the-hill.js",
  "lib/darknet/solvers/open-web-access-point.js",
];

/** Labyrinth entries: depth, charisma required, and whether start/end are offset. */
export const LAB_HOSTS = {
  th3_l4byr1nth: { depth: 7, cha: 300, offsetStartAndEnd: false },
  cru3l_l4byr1nth: { depth: 12, cha: 600, offsetStartAndEnd: false },
  m3rc1l3ss_l4byr1nth: { depth: 19, cha: 1500, offsetStartAndEnd: false },
  ub3r_l4byr1nth: { depth: 23, cha: 2500, offsetStartAndEnd: true },
  et3rn4l_l4byr1nth: { depth: 29, cha: 3000, offsetStartAndEnd: true },
  end13ss_l4byr1nth: { depth: 31, cha: 3500, offsetStartAndEnd: true },
  f1n4l_l4byr1nth: { depth: 36, cha: 4000, offsetStartAndEnd: true },
  b0nus_l4byr1nth: { depth: 36, cha: 4000, offsetStartAndEnd: true },
} as const;

export const LAB_MODEL_ID = "(The Labyrinth)";

/** Response codes from `ns.dnet` calls (`GenericResponseMessage`/`ResponseCodeEnum` in the game's `DarkNet/Enums.ts`). */
export const CODE = {
  Success: 200,
  DirectConnectionRequired: 351,
  AuthFailure: 401,
  Forbidden: 403,
  NotFound: 404,
  RequestTimeOut: 408,
  NotEnoughCharisma: 451,
  StasisLinkLimitReached: 453,
  NoBlockRAM: 454,
  PhishingFailed: 455,
  ServiceUnavailable: 503,
} as const;
