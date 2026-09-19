/**
 * Darknet Solver Types
 *
 * One pure state machine per `modelId`, registered in `index.ts`. Zero NS
 * imports, zero RAM cost — solvers run inside darknet-side agent scripts.
 *
 * Agent contract:
 * - The agent's first call for a fresh attempt is `next(state, null)`.
 * - After a failed `authenticate`, the agent passes the heartbleed record
 *   whose `passwordAttempted === attempt` (the attempt the solver just
 *   returned), with `elapsedMs` merged in from timing the call — or, when
 *   heartbleed is off or unavailable, the synthetic feedback
 *   `{ code: 401, passwordAttempted, message: "Unauthorized", elapsedMs }`.
 * - A solver that needs `data` (from heartbleed) and receives feedback with
 *   no `data` field returns `{ giveUp: true, reason: "needs heartbleed" }`.
 * - `next` is never called again after a successful authenticate.
 *
 * Import with: import { ... } from "/lib/darknet/solvers/types";
 */

export interface SolverDetails {
  host: string;
  modelId: string;
  passwordHint: string;
  data: string;
  passwordLength: number;
  passwordFormat: "numeric" | "alphabetic" | "alphanumeric" | "ASCII" | "unicode";
  difficulty: number;
  requiredCharismaSkill: number;
}

/** One heartbleed-recovered `PasswordResponse` log line, parsed. */
export interface ParsedFeedback {
  code: number;
  passwordAttempted: string;
  message: string;
  data?: string;
  elapsedMs?: number;
}

export type SolverStep<S> = { attempt: string; state: S } | { giveUp: true; reason: string };

export interface Solver<S = unknown> {
  /** Exact modelId string from the game's ModelIds. */
  id: string;
  /** True: the agent never calls heartbleed for this model. */
  blind: boolean;
  start(details: SolverDetails): S;
  // Methods (not function-typed properties) so TS's bivariant method-parameter
  // checking lets each concrete Solver<S> be assigned into Record<string, Solver>.
  next(state: S, feedback: ParsedFeedback | null): SolverStep<S>;
}

/**
 * Parse one heartbleed-recovered log line into a `PasswordResponse`. Returns
 * null for noise lines, empty strings, or anything that isn't a JSON object
 * with the required fields.
 *
 * Note: the game's BufferOverflow model logs `{code, passwordAttempted,
 * passwordExpected, message}` with no `data` field — that still parses,
 * with `data` left undefined.
 */
export function parseFeedback(line: string): ParsedFeedback | null {
  if (!line) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.code !== "number") return null;
  if (typeof obj.passwordAttempted !== "string") return null;
  if (typeof obj.message !== "string") return null;

  const result: ParsedFeedback = {
    code: obj.code,
    passwordAttempted: obj.passwordAttempted,
    message: obj.message,
  };
  if (typeof obj.data === "string") result.data = obj.data;
  if (typeof obj.elapsedMs === "number") result.elapsedMs = obj.elapsedMs;

  return result;
}
