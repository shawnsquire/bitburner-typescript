/**
 * Darknet Agent Pure Logic
 *
 * Pulled out of `workers/dnet-agent.ts` so the agent's decision-making is
 * unit-testable without an `ns` stub (docs/design/2026-09-19-darknet.md
 * Section 2): matching a heartbleed log line back to the attempt that
 * produced it, driving one solver step with the per-server attempt cap
 * applied, extracting leaked credentials from a batch of log lines, and
 * capping a backlog of report events that failed to send. Zero NS imports,
 * zero RAM cost — the worker does all the `ns` I/O and timing, and just
 * calls into here for the decisions.
 *
 * Import with: import { ... } from "/lib/darknet/agent-logic";
 */
import { MAX_BACKLOG, ReportEvent } from "/lib/darknet/protocol";
import { parseLeak } from "/lib/darknet/leaks";
import { ParsedFeedback, Solver, parseFeedback } from "/lib/darknet/solvers/types";

/**
 * `Factori-Os` (section 3 of the design doc) asks each small prime and its
 * powers, then the 83 large primes once (or twice above difficulty 24) --
 * up to ~124 attempts, comfortably past the `maxAttempts` config default of
 * 120. Rather than editing `protocol.ts`'s `Policy.maxAttempts` semantics
 * for every model, this one model gets an exempted floor:
 * `max(policy.maxAttempts, FACTORI_OS_MIN_ATTEMPTS)`.
 */
export const FACTORI_OS_MODEL_ID = "Factori-Os";
export const FACTORI_OS_MIN_ATTEMPTS = 130;

/**
 * Find the heartbleed-recovered log line that corresponds to the attempt
 * just sent. Heartbleed logs carry no PID -- and other agents may share the
 * target -- so the only way to identify "the record for this attempt" is by
 * `passwordAttempted` text equal to what was just sent. Returns the first
 * (i.e. most recent, since heartbleed hands back the newest lines first)
 * matching line, or null if none of the captured lines match.
 */
export function findFeedbackLine(logs: string[], attempt: string): ParsedFeedback | null {
  for (const line of logs) {
    const parsed = parseFeedback(line);
    if (parsed && parsed.passwordAttempted === attempt) return parsed;
  }
  return null;
}

export type AttemptDecision<S> = { kind: "attempt"; attempt: string; state: S } | { kind: "giveUp"; reason: string };

/**
 * One step of a solver's state machine, with the per-server attempt cap
 * applied. Kept here (rather than inline in the worker) so the cap policy,
 * including the `Factori-Os` exemption above, is unit-testable without an
 * `ns` stub or a real solver's search logic.
 */
export function chooseAttempt<S>(
  solver: Solver<S>,
  state: S,
  feedback: ParsedFeedback | null,
  attempts: number,
  maxAttempts: number,
  modelId: string,
): AttemptDecision<S> {
  const cap = modelId === FACTORI_OS_MODEL_ID ? Math.max(maxAttempts, FACTORI_OS_MIN_ATTEMPTS) : maxAttempts;
  if (attempts >= cap) return { kind: "giveUp", reason: "attempt cap reached" };

  const step = solver.next(state, feedback);
  if ("giveUp" in step) return { kind: "giveUp", reason: step.reason };
  return { kind: "attempt", attempt: step.attempt, state: step.state };
}

/**
 * Run every heartbleed log line through `parseLeak` and attribute
 * `present`/`placed` hints to `host`. Those two phrasings are per-position
 * feedback about the password the agent is *currently attempting* on
 * `host` (`getRandomCharsInPassword`/`getExactCharactersHint` fire as noise
 * around a real authentication attempt against the server heartbleed was
 * just called on), so, unlike `parseLeak`'s own host-agnostic `null`,
 * attaching the current target here is a fact the agent already knows, not
 * a guess.
 *
 * The `--<password>--` dash leak is left at `host: null`: the game
 * generates it as "a random server's password, host unknown" -- it can
 * name any darknet server, not necessarily the one heartbleed was called
 * on -- so attaching `host` to it would be a guess that could poison the
 * vault with a plausible-looking but wrong password for this host.
 * `Connecting to X:pw ...` leaks already carry their own (different) host
 * from `parseLeak` and are passed through unchanged.
 */
export function parseLeaksFromLogs(logs: string[], host: string): ReportEvent[] {
  const events: ReportEvent[] = [];
  for (const line of logs) {
    const event = parseLeak(line);
    if (!event) continue;
    if (event.t === "leak" && event.host === null && (event.present !== undefined || event.placed !== undefined)) {
      events.push({ ...event, host });
    } else {
      events.push(event);
    }
  }
  return events;
}

/** Cap an event array at `MAX_BACKLOG`, dropping the oldest entries first. */
export function capBacklog(events: ReportEvent[]): ReportEvent[] {
  if (events.length <= MAX_BACKLOG) return events;
  return events.slice(events.length - MAX_BACKLOG);
}
