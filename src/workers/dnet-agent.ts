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
  // Guards unleashStormSeed() to fire at most once per process lifetime,
  // latched only on a successful call (see below) so a STORM_SEED.exe that
  // doesn't exist here yet gets retried on a later tick instead of being
  // given up on permanently. The coordinator only sets workers[self].storm
  // when it has decided to trigger one, and a script only lives until this
  // host restarts or is deleted, so "once per seed" and "once per agent
  // process" coincide in practice.
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
      try {
        const result = ns.dnet.unleashStormSeed();
        if (result.success) {
          stormFired = true;
          // Acknowledge the fire so the coordinator stops flagging the storm.
          // Without this the flag is published on a timer and a long crack tick
          // here can miss the window; the ack is the reliable signal.
          events.push({ t: "storm-fired", host: self });
        } else {
          // Not latched: e.g. no STORM_SEED.exe here yet -- retry next tick
          // once the coordinator's harvest reports one, rather than
          // permanently giving up on a storm this process could still fire.
          events.push({ t: "error", host: self, op: "unleashStormSeed", code: result.code, message: result.message });
        }
      } catch {
        // No STORM_SEED.exe on this host; nothing to report.
      }
    }

    const combined = capBacklog([...backlog, ...events]);
    const batch: ReportBatch = { from: self, pid: ns.pid, depth: 0, at: Date.now(), events: combined, agent: true };
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
  if (details.modelId === LAB_MODEL_ID) {
    // A lab is WALKED by dnet-lab.js, never cracked. But once it is cleared it
    // has admin rights and holds an unopened `the_great_work` reward cache
    // (design section 7). Home cannot seed an agent there -- it is not directly
    // connected to the lab and a cleared lab has no backdoor -- but this runner
    // is adjacent, so seed it from here: `connectToSession` on a cleared
    // (admin) lab returns Success for any token, and `replicate`'s exec is
    // allowed because it originates from this directly-connected host. The
    // seeded agent then runs a harvest worker that opens the reward cache.
    if (details.hasAdmin && !details.hasSession) {
      const r = ns.dnet.connectToSession(n, policy.vault[n]?.password ?? "");
      if (r.success) await replicate(ns, self, n);
    }
    return;
  }
  if (details.hasSession) return; // nothing to do -- already have a session

  const vaultEntry = policy.vault[n];
  if (vaultEntry && sameFingerprint(vaultEntry.fingerprint, fingerprintOf(details))) {
    const restored = await restoreSession(ns, self, n, vaultEntry.password, details, events);
    if (restored) return;
    // else: password was correct but stale (reported), fall through to solving
  }

  await crackNeighbour(ns, self, n, details, policy, events);
}

/**
 * Reuse a vaulted password to restore access after this agent's session (or
 * a whole prior agent) was lost. A restart clears a server's sessions and
 * backdoor but keeps its admin rights and password, so `connectToSession`
 * with the vaulted password succeeds on the first call; `authenticate` is a
 * fallback only for the rare case where the session port rejects it. Returns
 * true when nothing more should be done this tick (session restored, or a
 * transient failure to retry next tick), false when the password no longer
 * works (a stale vault entry) and the caller should fall through to the solver.
 *
 * On success we re-exec the agent (see the call sites below): a restart kills
 * every script on the host, agent included, and the coordinator only re-seeds
 * darkweb and stasis-linked hosts, so without this a restarted (but not
 * re-fingerprinted) neighbour would silently and permanently drop out of the
 * swarm. `getServerDetails().hasSession` short-circuits `handleNeighbour` once
 * a session exists, so this path runs only when access must be (re)established
 * -- once per neighbour and again after each of its restarts, not every tick.
 */
async function restoreSession(
  ns: NS,
  self: string,
  host: string,
  password: string,
  details: SeenDetails,
  events: ReportEvent[],
): Promise<boolean> {
  const r = ns.dnet.connectToSession(host, password);
  if (r.success) {
    // Session (re)established. If the host had restarted, its old agent was
    // killed with it -- re-exec to revive the swarm here. preventDuplicates
    // makes this a no-op when an agent is already running.
    await replicate(ns, self, host);
    return true;
  }
  if (r.code !== CODE.AuthFailure) return true; // e.g. ServiceUnavailable -- try again next tick

  const auth = await ns.dnet.authenticate(host, password);
  if (auth.success) {
    await replicate(ns, self, host);
    return true;
  }
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

  // Design section 2: a neighbour whose requiredCharismaSkill exceeds the
  // player's is reported as `gap` and skipped for heartbleed. Reported once
  // per tick here rather than per attempt inside driveSolver.
  if (!solver.blind && policy.heartbleed && policy.charisma < details.requiredCharismaSkill) {
    events.push({ t: "gap", host, required: details.requiredCharismaSkill });
  }

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
  // Set on a RequestTimeOut so the next iteration re-sends the SAME attempt
  // instead of asking the solver for a new one: the request never reached
  // getAuthResult (the game rolls the timeout before checking the
  // password -- see authenticate() in NetscriptFunctions/Darknet.ts), so no
  // password verdict was ever produced for it. Treating a timeout as a
  // failed guess would feed feedback solvers a verdict they never got --
  // e.g. AccountsManager_4.2 would read "no data" and fall back to
  // counting from 0, NIL would read "no position answered yes" and drop
  // live candidates.
  let pendingAttempt: string | null = null;

  for (;;) {
    let attempt: string;
    if (pendingAttempt !== null) {
      attempt = pendingAttempt;
      pendingAttempt = null;
    } else {
      const decision: AttemptDecision<S> = chooseAttempt(solver, state, feedback, attempts, policy.maxAttempts, details.modelId);
      if (decision.kind === "giveUp") return;
      state = decision.state;
      attempt = decision.attempt;
    }

    const t0 = Date.now();
    const res = await ns.dnet.authenticate(host, attempt);
    const elapsedMs = Date.now() - t0;

    if (res.success) {
      events.push({ t: "cracked", host, password: attempt, fingerprint: fingerprintOf(details) });
      await replicate(ns, self, host);
      return;
    }

    // Never retry this tick: the neighbour vanished (503), or it moved and
    // is no longer directly connected (351) -- a fresh `seen` next tick
    // will tell us if/where it's still reachable from.
    if (res.code === CODE.ServiceUnavailable || res.code === CODE.DirectConnectionRequired) return;

    if (res.code === CODE.RequestTimeOut) {
      consecutiveTimeouts++;
      if (consecutiveTimeouts > MAX_CONSECUTIVE_TIMEOUTS) return; // give up on this neighbour for the tick
      await ns.sleep(Math.min(500 * 2 ** consecutiveTimeouts, 5000)); // back off, then re-send the same attempt
      pendingAttempt = attempt;
      continue;
    }
    consecutiveTimeouts = 0;

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
    // memoryReallocation frees RAM per thread, so a big block clears faster with
    // more threads (sized by the coordinator). The thread count goes in the run
    // options, NOT in args, so preventDuplicates keeps exactly one harvest per
    // host; when the count should change (block cleared -> cache-only pass) the
    // running worker exits on its own and the next launch starts at the new size.
    ns.run(DNET_WORKERS.harvest, { threads: Math.max(1, flags.harvestThreads), preventDuplicates: true }, self);
  }
  if (flags.phishThreads > 0) {
    // Phishing income scales with thread count -- it must run at phishThreads
    // threads, not one. The count also rides along as an argument so the
    // running worker can notice when the coordinator resizes it (e.g. shrinks
    // phishing to free RAM for a newly-needed charge/stasis worker) and exit so
    // this relaunch takes effect -- preventDuplicates alone would keep the old,
    // wrongly-sized worker alive.
    ns.run(DNET_WORKERS.phish, { threads: flags.phishThreads, preventDuplicates: true }, self, flags.phishThreads);
  }
  if (flags.lab && policy.labName) {
    // The walker runs here on `self` (the runner, adjacent to the lab) and
    // authenticates against the labyrinth server itself -- pass labName (the
    // maze hostname), NOT labHost (the runner).
    ns.run(DNET_WORKERS.lab, { threads: 1, preventDuplicates: true }, self, policy.labName);
  }
  if (flags.stasis !== null) {
    ns.run(DNET_WORKERS.stasis, { threads: 1, preventDuplicates: true }, self, flags.stasis ? "on" : "off");
  }
  if (flags.charge !== null) {
    ns.run(DNET_WORKERS.charge, { threads: 1, preventDuplicates: true }, self, flags.charge);
  }
}
