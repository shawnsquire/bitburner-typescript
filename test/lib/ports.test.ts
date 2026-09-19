import { describe, it, expect, vi, afterEach } from "vitest";
import { publishStatus, peekStatus, queueAction, dequeueAction, peekQueue } from "/lib/ports";
import { QUEUE_PORT, QueueEntry } from "/types/ports";
import { mockNS } from "../helpers/mock-ns";

const entry = (script: string): QueueEntry => ({
  script,
  args: [],
  priority: 5,
  mode: "queue",
  timestamp: 1,
  requester: "test",
});

afterEach(() => vi.useRealTimers());

describe("publishStatus / peekStatus", () => {
  it("keeps exactly one value on the port and stamps _publishedAt", () => {
    const ns = mockNS();
    publishStatus(ns, 1, { a: 1 });
    publishStatus(ns, 1, { a: 2 });
    publishStatus(ns, 1, { a: 3 });
    const h = ns.getPortHandle(1);
    expect(h.peek()).toContain('"a":3');
    h.read();
    expect(h.empty()).toBe(true);
    publishStatus(ns, 1, { a: 4 });
    expect(peekStatus<{ a: number; _publishedAt: number }>(ns, 1)?.a).toBe(4);
    expect(typeof peekStatus<{ _publishedAt: number }>(ns, 1)?._publishedAt).toBe("number");
  });

  it("returns null for empty, invalid, or stale data", () => {
    const ns = mockNS();
    expect(peekStatus(ns, 2)).toBeNull();
    ns.getPortHandle(2).write("not json");
    expect(peekStatus(ns, 2)).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    publishStatus(ns, 3, { x: 1 });
    vi.setSystemTime(1_000_000 + 5_000);
    expect(peekStatus(ns, 3, 10_000)).not.toBeNull();
    expect(peekStatus(ns, 3, 4_000)).toBeNull();
  });
});

describe("queue helpers", () => {
  it("queueAction appends; dequeueAction is FIFO and destructive", () => {
    const ns = mockNS();
    queueAction(ns, entry("a.js"));
    queueAction(ns, entry("b.js"));
    expect(dequeueAction(ns)?.script).toBe("a.js");
    expect(dequeueAction(ns)?.script).toBe("b.js");
    expect(dequeueAction(ns)).toBeNull();
  });

  it("peekQueue returns every entry without consuming, skipping bad JSON", () => {
    const ns = mockNS();
    queueAction(ns, entry("a.js"));
    ns.getPortHandle(QUEUE_PORT).write("garbage");
    queueAction(ns, entry("b.js"));
    expect(peekQueue(ns).map((e) => e.script)).toEqual(["a.js", "b.js"]);
    // order and raw contents preserved, including the invalid item
    expect(peekQueue(ns).map((e) => e.script)).toEqual(["a.js", "b.js"]);
    expect(dequeueAction(ns)?.script).toBe("a.js");
    expect(dequeueAction(ns)).toBeNull(); // garbage
    expect(dequeueAction(ns)?.script).toBe("b.js");
  });
});
