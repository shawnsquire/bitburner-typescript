/**
 * Unit tests for the pure agent decision logic pulled out of
 * `workers/dnet-agent.ts` (docs/design/2026-09-19-darknet.md Section 2):
 * matching a heartbleed line back to the attempt that produced it, driving
 * one solver step under the attempt cap (including the `Factori-Os`
 * exemption), leak extraction/host-attachment, and backlog capping.
 */
import { describe, it, expect } from "vitest";
import {
  AttemptDecision,
  MODEL_MIN_ATTEMPTS,
  capBacklog,
  chooseAttempt,
  findFeedbackLine,
  parseLeaksFromLogs,
} from "/lib/darknet/agent-logic";
import { MAX_BACKLOG, ReportEvent } from "/lib/darknet/protocol";
import { ParsedFeedback, Solver } from "/lib/darknet/solvers/types";

describe("findFeedbackLine", () => {
  it("returns null for an empty log batch", () => {
    expect(findFeedbackLine([], "abc")).toBeNull();
  });

  it("returns null when no line matches the attempt", () => {
    const logs = [JSON.stringify({ code: 401, passwordAttempted: "xyz", message: "Unauthorized" })];
    expect(findFeedbackLine(logs, "abc")).toBeNull();
  });

  it("skips noise lines and returns the matching feedback line", () => {
    const logs = [
      "14:32:07: n00dles - heartbeat check (alive)",
      "--sw0rdf1sh--",
      JSON.stringify({ code: 401, passwordAttempted: "abc", message: "Unauthorized", data: "2 correct" }),
    ];
    expect(findFeedbackLine(logs, "abc")).toEqual({
      code: 401,
      passwordAttempted: "abc",
      message: "Unauthorized",
      data: "2 correct",
    });
  });

  it("with several lines for other attempts, returns only the one matching this attempt", () => {
    const logs = [
      JSON.stringify({ code: 401, passwordAttempted: "one", message: "Unauthorized" }),
      JSON.stringify({ code: 401, passwordAttempted: "two", message: "Unauthorized" }),
      JSON.stringify({ code: 401, passwordAttempted: "three", message: "Unauthorized" }),
    ];
    expect(findFeedbackLine(logs, "two")).toEqual({ code: 401, passwordAttempted: "two", message: "Unauthorized" });
  });

  it("returns the first match when multiple lines share the attempted password (other agents sharing the target)", () => {
    const logs = [
      JSON.stringify({ code: 401, passwordAttempted: "abc", message: "Unauthorized", data: "first" }),
      JSON.stringify({ code: 401, passwordAttempted: "abc", message: "Unauthorized", data: "second" }),
    ];
    expect(findFeedbackLine(logs, "abc")?.data).toBe("first");
  });
});

describe("parseLeaksFromLogs", () => {
  it("returns no events for a batch with no recognisable leaks", () => {
    expect(parseLeaksFromLogs(["14:32:07: n00dles - heartbeat check (alive)"], "n00dles")).toEqual([]);
  });

  it("attaches the current host to 'present characters' leaks", () => {
    const events = parseLeaksFromLogs(["There's definitely a x and a y..."], "n00dles");
    expect(events).toEqual([{ t: "leak", host: "n00dles", present: ["x", "y"], line: "There's definitely a x and a y..." }]);
  });

  it("attaches the current host to 'placed characters' leaks", () => {
    const events = parseLeaksFromLogs(["The characters 4, 2 are in the right place. "], "n00dles");
    expect(events).toEqual([
      { t: "leak", host: "n00dles", placed: ["4", "2"], line: "The characters 4, 2 are in the right place. " },
    ]);
  });

  it("leaves the '--pw--' dash leak's host null (could name any darknet server)", () => {
    const events = parseLeaksFromLogs(["--sw0rdf1sh--"], "n00dles");
    expect(events).toEqual([{ t: "leak", host: null, password: "sw0rdf1sh", line: "--sw0rdf1sh--" }]);
  });

  it("passes through a 'Connecting to X:pw ...' leak's own (different) host unchanged", () => {
    const events = parseLeaksFromLogs(["Connecting to foodnstuff:hunter2 ..."], "n00dles");
    expect(events).toEqual([{ t: "leak", host: "foodnstuff", password: "hunter2", line: "Connecting to foodnstuff:hunter2 ..." }]);
  });

  it("processes every line in the batch, mixing recognised and unrecognised", () => {
    const logs = [
      "14:32:07: n00dles - heartbeat check (alive)",
      "--sw0rdf1sh--",
      "There's definitely a x and a y...",
      "some other noise",
    ];
    const events = parseLeaksFromLogs(logs, "n00dles");
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ t: "leak", host: null, password: "sw0rdf1sh", line: "--sw0rdf1sh--" });
    expect(events[1]).toEqual({ t: "leak", host: "n00dles", present: ["x", "y"], line: "There's definitely a x and a y..." });
  });
});

describe("capBacklog", () => {
  function events(n: number): ReportEvent[] {
    return Array.from({ length: n }, (_, i) => ({ t: "gap", host: `h${i}`, required: i }));
  }

  it("returns the array unchanged when at or under the cap", () => {
    const e = events(MAX_BACKLOG);
    expect(capBacklog(e)).toBe(e);
    expect(capBacklog(events(5))).toHaveLength(5);
  });

  it("drops the oldest entries, keeping the newest MAX_BACKLOG", () => {
    const e = events(MAX_BACKLOG + 10);
    const capped = capBacklog(e);
    expect(capped).toHaveLength(MAX_BACKLOG);
    expect(capped[0]).toEqual({ t: "gap", host: "h10", required: 10 });
    expect(capped[capped.length - 1]).toEqual({ t: "gap", host: `h${MAX_BACKLOG + 9}`, required: MAX_BACKLOG + 9 });
  });
});

// A tiny stub solver for exercising chooseAttempt without any real model's
// search logic: state is just a counter, next() offers attempts "0", "1",
// "2", ... in order and gives up once the counter reaches its own ceiling
// (separate from the agent's attempt cap, so the two limits can be tested
// independently).
interface StubState {
  count: number;
}

function makeStub(ceiling: number): Solver<StubState> {
  return {
    id: "Stub",
    blind: true,
    start: () => ({ count: 0 }),
    next: (state: StubState, _feedback: ParsedFeedback | null) => {
      if (state.count >= ceiling) return { giveUp: true, reason: "stub ceiling" };
      return { attempt: String(state.count), state: { count: state.count + 1 } };
    },
  };
}

describe("chooseAttempt", () => {
  it("returns the solver's next attempt when under the cap", () => {
    const solver = makeStub(100);
    const decision = chooseAttempt(solver, { count: 0 }, null, 0, 10, "SomeModel");
    expect(decision).toEqual({ kind: "attempt", attempt: "0", state: { count: 1 } });
  });

  it("gives up once the agent's attempt count reaches maxAttempts, without calling the solver", () => {
    const solver = makeStub(100);
    const decision = chooseAttempt(solver, { count: 5 }, null, 10, 10, "SomeModel");
    expect(decision).toEqual({ kind: "giveUp", reason: "attempt cap reached" });
  });

  it("passes through the solver's own giveUp", () => {
    const solver = makeStub(2);
    const decision = chooseAttempt(solver, { count: 2 }, null, 2, 10, "SomeModel");
    expect(decision).toEqual({ kind: "giveUp", reason: "stub ceiling" });
  });

  it("raises the cap to a model's floor when maxAttempts is lower", () => {
    for (const [model, floor] of Object.entries(MODEL_MIN_ATTEMPTS)) {
      const solver = makeStub(1000);
      // just under the floor: still allowed even though maxAttempts (120) is lower
      expect(chooseAttempt(solver, { count: 0 }, null, floor - 1, 120, model).kind).toBe("attempt");
      // at the floor: capped
      expect(chooseAttempt(solver, { count: 0 }, null, floor, 120, model)).toEqual({
        kind: "giveUp",
        reason: "attempt cap reached",
      });
    }
  });

  it("covers the two solvers that exceed the default cap in practice", () => {
    // 2G_cellular reaches ~496 attempts and RateMyPix/DeepGreen ~200 -- all above 120.
    expect(MODEL_MIN_ATTEMPTS["2G_cellular"]).toBeGreaterThanOrEqual(496);
    expect(MODEL_MIN_ATTEMPTS["RateMyPix.Auth"]).toBeGreaterThanOrEqual(200);
    expect(MODEL_MIN_ATTEMPTS["DeepGreen"]).toBeGreaterThanOrEqual(200);
  });

  it("lets an operator-raised maxAttempts win over the floor", () => {
    const solver = makeStub(1000);
    // maxAttempts 600 > the 2G floor of 512: the higher value applies
    expect(chooseAttempt(solver, { count: 0 }, null, 599, 600, "2G_cellular").kind).toBe("attempt");
  });

  it("does not raise the cap for models with no floor", () => {
    const solver = makeStub(1000);
    const decision = chooseAttempt(solver, { count: 0 }, null, 120, 120, "TopPass");
    expect(decision).toEqual({ kind: "giveUp", reason: "attempt cap reached" });
  });

  it("steps a stub solver all the way to success, driven by chooseAttempt in a loop", () => {
    const solver = makeStub(100);
    let state: StubState = solver.start({} as never);
    let feedback: ParsedFeedback | null = null;
    let attempts = 0;
    let cracked: string | null = null;

    for (;;) {
      const decision: AttemptDecision<StubState> = chooseAttempt(solver, state, feedback, attempts, 10, "SomeModel");
      if (decision.kind === "giveUp") break;
      state = decision.state;
      if (decision.attempt === "5") {
        cracked = decision.attempt;
        break;
      }
      feedback = { code: 401, passwordAttempted: decision.attempt, message: "Unauthorized" };
      attempts++;
    }

    expect(cracked).toBe("5");
    expect(attempts).toBe(5);
  });

  it("steps a stub solver to giveUp once it exhausts its own candidate list", () => {
    const solver = makeStub(3); // only offers "0", "1", "2"
    let state: StubState = solver.start({} as never);
    let feedback: ParsedFeedback | null = null;
    let attempts = 0;
    let gaveUp = false;

    for (;;) {
      const decision: AttemptDecision<StubState> = chooseAttempt(solver, state, feedback, attempts, 10, "SomeModel");
      if (decision.kind === "giveUp") {
        gaveUp = true;
        break;
      }
      state = decision.state;
      feedback = { code: 401, passwordAttempted: decision.attempt, message: "Unauthorized" };
      attempts++;
    }

    expect(gaveUp).toBe(true);
    expect(attempts).toBe(3);
  });
});
