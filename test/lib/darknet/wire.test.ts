import { describe, it, expect } from "vitest";
import { peekPolicy, publishPolicy, tryWriteBatch, drainReports } from "/lib/darknet/wire";
import { DARKNET_POLICY_PORT, DARKNET_REPORT_PORT } from "/types/ports";
import { Policy, ReportBatch } from "/lib/darknet/protocol";
import { mockNS } from "../../helpers/mock-ns";

function policy(version: number): Policy {
  return {
    version,
    pause: false,
    heartbleed: true,
    charisma: 10,
    maxAttempts: 120,
    agentIntervalMs: 2000,
    vault: {},
    workers: {},
    stasisTargets: [],
    migrationTargets: [],
    labHost: null,
    labName: null,
    labGrid: null,
    publishedAt: version,
  };
}

function batch(from: string): ReportBatch {
  return { from, pid: 1, depth: 1, at: 1, events: [{ t: "seen", host: from, details: {} as never, neighbours: [] }] };
}

describe("peekPolicy / publishPolicy", () => {
  it("keeps exactly one value on the port; peek returns the latest publish", () => {
    const ns = mockNS();
    publishPolicy(ns, policy(1));
    publishPolicy(ns, policy(2));
    const handle = ns.getPortHandle(DARKNET_POLICY_PORT);
    expect(handle.peek()).toContain('"version":2');
    expect(peekPolicy(ns)?.version).toBe(2);
  });

  it("returns null for an empty or invalid port", () => {
    const ns = mockNS();
    expect(peekPolicy(ns)).toBeNull();
    ns.getPortHandle(DARKNET_POLICY_PORT).write("not json");
    expect(peekPolicy(ns)).toBeNull();
  });
});

describe("tryWriteBatch / drainReports", () => {
  it("round-trips a batch", () => {
    const ns = mockNS();
    expect(tryWriteBatch(ns, batch("n00dl3s"))).toBe(true);
    expect(tryWriteBatch(ns, batch("f1sh"))).toBe(true);
    const batches = drainReports(ns);
    expect(batches.map((b) => b.from)).toEqual(["n00dl3s", "f1sh"]);
    // drained: nothing left
    expect(drainReports(ns)).toEqual([]);
  });

  it("skips malformed entries while draining valid ones", () => {
    const ns = mockNS();
    tryWriteBatch(ns, batch("n00dl3s"));
    ns.getPortHandle(DARKNET_REPORT_PORT).write("garbage");
    tryWriteBatch(ns, batch("f1sh"));
    const batches = drainReports(ns);
    expect(batches.map((b) => b.from)).toEqual(["n00dl3s", "f1sh"]);
  });
});
