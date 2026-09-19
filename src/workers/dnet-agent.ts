/**
 * Darknet Agent Worker
 *
 * The self-propagating crawler that runs ON darknet servers
 * (docs/design/2026-09-19-darknet.md Section 2). Each tick: peeks the
 * coordinator's policy, probes its neighbours, restores sessions from the
 * vault or drives a solver to crack the ones it doesn't have a session
 * with, replicates itself onto anything it cracks, launches this host's
 * local workers per policy, and reports everything it saw back home.
 *
 * There is no home-side round trip per attempt -- home can only reach
 * `darkweb`, and `authenticate`/`heartbleed`/`connectToSession` all require
 * the calling script's own host to be (in most cases) directly connected to
 * the target -- so all of this has to happen from here.
 *
 * Usage: run workers/dnet-agent.js <self>
 */
import type { NS } from "@ns";
import {
  AGENT_VERSION,
  CODE,
  DNET_BUNDLE,
  DNET_WORKERS,
  DNET_WORKER_RAM,
  LAB_MODEL_ID,
  Policy,
  ReportBatch,
  ReportEvent,
  SeenDetails,
  WorkerFlags,
  fingerprintOf,
  sameFingerprint,
} from "/lib/darknet/protocol";
import { peekPolicy, tryWriteBatch } from "/lib/darknet/wire";
import { solverFor } from "/lib/darknet/solvers/index";
import { ParsedFeedback, Solver, SolverDetails } from "/lib/darknet/solvers/types";
import { AttemptDecision, capBacklog, chooseAttempt, findFeedbackLine, parseLeaksFromLogs } from "/lib/darknet/agent-logic";

// RAM budget (pinned, not tiered -- every ns call below is cheap and fixed):
//   base 1.6 + probe 0.2 + getServerDetails 0.1 + connectToSession 0.05
//   + authenticate 0.4 + heartbleed 0.6 + scp 0.6 + exec 1.3 + run 1.0
//   + getServerMaxRam 0.05 + getServerUsedRam 0.05 + hasRootAccess 0.05
//   + unleashStormSeed 0.1 = 6.10, ~0.15 headroom under the 6.25 pin
//   (measured with `npm run ram -- workers/dnet-agent.js`).
/** @ram 6.25 */
export function main(ns: NS): Promise<void> {
  ns.ramOverride(6.25);
  return agentLoop(ns);
}

/** Consecutive `RequestTimeOut`s tolerated on one neighbour before giving up on it for this tick. */
const MAX_CONSECUTIVE_TIMEOUTS = 5;

async function agentLoop(ns: NS): Promise<void> {
  const self = ns.args[0] as string;
  let backlog: ReportEvent[] = [];
  // Guards unleashStormSeed() to fire at most once per process lifetime: the
  // coordinator only sets workers[self].storm when it has decided to trigger
  // one, and a script only lives until this host restarts or is deleted, so
  // "once per seed" and "once per agent process" coincide in practice.
  let stormFired = false;

  for (;;) {
    const policy = peekPolicy(ns);
    if (!policy) {
      // No coordinator yet.
      await ns.sleep(2000);
      continue;
    }
    if (policy.version !== AGENT_VERSION) return; // coordinator will re-exec the new bundle
    if (policy.pause) {
      await ns.sleep(policy.agentIntervalMs);
      continue;
    }

    const events: ReportEvent[] = [];

    let neighbours: string[] = [];
    try {
      neighbours = ns.dnet.probe();
    } catch {
      neighbours = [];
    }

    for (const n of neighbours) {
      try {
        await handleNeighbour(ns, self, n, policy, events);
      } catch {
        // Defensive: a vanished neighbour yields a 503 result rather than a
        // throw, but don't let one unexpected exception on one neighbour
        // take down the rest of this tick.
      }
    }

    launchLocalWorkers(ns, self, policy);

    const flags = policy.workers[self];
    if (flags && flags.storm && !stormFired) {
      stormFired = true;
      try {
        ns.dnet.unleashStormSeed();
      } catch {
        // No STORM_SEED.exe on this host; nothing to report.
      }
    }

    const combined = capBacklog([...backlog, ...events]);
    const batch: ReportBatch = { from: self, pid: ns.pid, depth: 0, at: Date.now(), events: combined };
    const sent = tryWriteBatch(ns, batch);
    backlog = sent ? [] : combined;

    await ns.sleep(policy.agentIntervalMs);
  }
}

/**
 * `probe` only lists the CURRENT server's neighbours, so a `seen` report
 * about a neighbour `N` cannot know N's own neighbours from here -- push an
 * empty `neighbours` list; the coordinator builds the map's edges from each
 * host's own agent's `seen` report about *itself*, not about others.
 */
async function handleNeighbour(ns: NS, self: string, n: string, policy: Policy, events: ReportEvent[]): Promise<void> {
  const raw = ns.dnet.getServerDetails(n);
  const details: SeenDetails = {
    ...raw,
    maxRam: ns.getServerMaxRam(n),
    usedRam: ns.getServerUsedRam(n),
    hasAdmin: ns.hasRootAccess(n),
  };

  events.push({ t: "seen", host: n, details, neighbours: [] });

  if (!details.isOnline) return;
  if (details.modelId === LAB_MODEL_ID) return; // walked by dnet-lab.js, not cracked here
  if (details.hasSession) return; // nothing to do -- already have a session

  const vaultEntry = policy.vault[n];
  if (vaultEntry && sameFingerprint(vaultEntry.fingerprint, fingerprintOf(details))) {
    const restored = await restoreSession(ns, n, vaultEntry.password, details, events);
    if (restored) return;
    // else: password was correct but stale (reported), fall through to solving
  }

  await crackNeighbour(ns, self, n, details, policy, events);
}

/**
 * Try to reuse a vaulted password: `connectToSession` first (cheaper, and
 * works even without a direct connection), falling back to one
 * `authenticate` call if admin rights were cleared by a restart while the
 * password itself is still correct. Returns true when nothing more should
 * be done this tick (session restored, or a transient failure to retry
 * next tick), false when the vault entry is actually stale and the caller
 * should fall through to the solver.
 */
async function restoreSession(
  ns: NS,
  host: string,
  password: string,
  details: SeenDetails,
  events: ReportEvent[],
): Promise<boolean> {
  const r = ns.dnet.connectToSession(host, password);
  if (r.success) return true;
  if (r.code !== CODE.AuthFailure) return true; // e.g. ServiceUnavailable -- try again next tick

  const auth = await ns.dnet.authenticate(host, password);
  if (auth.success) return true;
  if (auth.code !== CODE.AuthFailure) return true; // RequestTimeOut/ServiceUnavailable -- try again next tick

  events.push({ t: "stale", host, fingerprint: fingerprintOf(details) });
  return false;
}

/** Drive a solver against `host` until it succeeds, gives up, or hits the attempt cap. */
async function crackNeighbour(
  ns: NS,
  self: string,
  host: string,
  details: SeenDetails,
  policy: Policy,
  events: ReportEvent[],
): Promise<void> {
  const solver = solverFor(details.modelId);
  if (!solver) return; // no solver registered for this model yet
  await driveSolver(ns, self, host, details, policy, events, solver);
}

/**
 * A separate generic function (rather than inlined in `crackNeighbour`) so
 * `S` is bound once from the `solver` argument, instead of being
 * re-inferred by `chooseAttempt<S>` on every loop iteration from a `let`
 * variable that the loop itself reassigns -- TS can't resolve that
 * self-referentially and falls back to an implicit-any error.
 */
async function driveSolver<S>(
  ns: NS,
  self: string,
  host: string,
  details: SeenDetails,
  policy: Policy,
  events: ReportEvent[],
  solver: Solver<S>,
): Promise<void> {
  const solverDetails: SolverDetails = {
    host,
    modelId: details.modelId,
    passwordHint: details.passwordHint,
    data: details.data,
    passwordLength: details.passwordLength,
    passwordFormat: details.passwordFormat,
    difficulty: details.difficulty,
    requiredCharismaSkill: details.requiredCharismaSkill,
  };

  let state: S = solver.start(solverDetails);
  let feedback: ParsedFeedback | null = null;
  let attempts = 0;
  let consecutiveTimeouts = 0;

  for (;;) {
    const decision: AttemptDecision<S> = chooseAttempt(solver, state, feedback, attempts, policy.maxAttempts, details.modelId);
    if (decision.kind === "giveUp") return;
    state = decision.state;
    const attempt: string = decision.attempt;

    const t0 = Date.now();
    const res = await ns.dnet.authenticate(host, attempt);
    const elapsedMs = Date.now() - t0;

    if (res.success) {
      events.push({ t: "cracked", host, password: attempt, fingerprint: fingerprintOf(details) });
      await replicate(ns, self, host);
      return;
    }

    if (res.code === CODE.ServiceUnavailable) return; // never retry a vanished neighbour this tick

    if (res.code === CODE.RequestTimeOut) {
      consecutiveTimeouts++;
      if (consecutiveTimeouts > MAX_CONSECUTIVE_TIMEOUTS) return; // give up on this neighbour for the tick
      await ns.sleep(Math.min(500 * 2 ** consecutiveTimeouts, 5000)); // back off before the next attempt
    } else {
      consecutiveTimeouts = 0;
    }

    if (!solver.blind && policy.heartbleed && policy.charisma >= details.requiredCharismaSkill) {
      const hb = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 10 });
      events.push(...parseLeaksFromLogs(hb.logs, host));
      feedback = findFeedbackLine(hb.logs, attempt) ?? {
        code: res.code,
        passwordAttempted: attempt,
        message: res.message,
        elapsedMs,
      };
    } else {
      feedback = { code: res.code, passwordAttempted: attempt, message: res.message, elapsedMs };
    }
    feedback.elapsedMs = elapsedMs;

    attempts++;
  }
}

/** scp the agent bundle onto a freshly-cracked neighbour and exec it there, if it has room. */
async function replicate(ns: NS, self: string, host: string): Promise<void> {
  const copied = ns.scp(DNET_BUNDLE, host, self);
  if (!copied) return;

  const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
  if (freeRam < DNET_WORKER_RAM.agent) return;

  ns.exec(DNET_WORKERS.agent, host, { threads: 1, preventDuplicates: true }, host);
}

/** Launch this host's local workers per `policy.workers[self]`. Storm is handled by the caller (once-per-process). */
function launchLocalWorkers(ns: NS, self: string, policy: Policy): void {
  const flags: WorkerFlags | undefined = policy.workers[self];
  if (!flags) return;

  if (flags.harvest) {
    ns.run(DNET_WORKERS.harvest, { threads: 1, preventDuplicates: true }, self);
  }
  if (flags.phishThreads > 0) {
    ns.run(DNET_WORKERS.phish, { threads: 1, preventDuplicates: true }, self, flags.phishThreads);
  }
  if (flags.lab && policy.labHost) {
    ns.run(DNET_WORKERS.lab, { threads: 1, preventDuplicates: true }, self, policy.labHost);
  }
  if (flags.stasis !== null) {
    ns.run(DNET_WORKERS.stasis, { threads: 1, preventDuplicates: true }, self, flags.stasis ? "on" : "off");
  }
  if (flags.charge !== null) {
    ns.run(DNET_WORKERS.charge, { threads: 1, preventDuplicates: true }, self, flags.charge);
  }
}
