import { describe, it, expect } from "vitest";
import { drainQueue, executeEntry } from "/daemons/queue";
import { QUEUE_PORT, QueueEntry, PRIORITY } from "/types/ports";
import { mockNS } from "../helpers/mock-ns";

function entry(overrides: Partial<QueueEntry>): QueueEntry {
  return {
    script: "actions/check-work.js",
    args: [],
    priority: PRIORITY.STATUS_CHECK,
    mode: "queue",
    timestamp: 0,
    requester: "test",
    ...overrides,
  };
}

describe("drainQueue", () => {
  it("returns an empty array when the queue port is empty", () => {
    const ns = mockNS();
    expect(drainQueue(ns)).toEqual([]);
  });

  it("drains every pending entry, highest priority first", () => {
    const ns = mockNS();
    const handle = ns.getPortHandle(QUEUE_PORT);
    handle.write(JSON.stringify(entry({ script: "a.js", priority: PRIORITY.NICE_TO_HAVE })));
    handle.write(JSON.stringify(entry({ script: "b.js", priority: PRIORITY.CRITICAL })));
    handle.write(JSON.stringify(entry({ script: "c.js", priority: PRIORITY.USER_ACTION })));

    const drained = drainQueue(ns);
    expect(drained.map((e) => e.script)).toEqual(["b.js", "c.js", "a.js"]);
  });

  it("empties the port (a second drain sees nothing left)", () => {
    const ns = mockNS();
    ns.getPortHandle(QUEUE_PORT).write(JSON.stringify(entry({ script: "only.js" })));
    expect(drainQueue(ns).length).toBe(1);
    expect(drainQueue(ns)).toEqual([]);
  });

  it("keeps entries at equal priority in FIFO order (stable sort)", () => {
    const ns = mockNS();
    const handle = ns.getPortHandle(QUEUE_PORT);
    handle.write(JSON.stringify(entry({ script: "first.js", priority: 5 })));
    handle.write(JSON.stringify(entry({ script: "second.js", priority: 5 })));
    expect(drainQueue(ns).map((e) => e.script)).toEqual(["first.js", "second.js"]);
  });
});

// executeEntry: the RAM/priority decision the queue runner makes per entry.
// "force" mode is documented (daemons/queue.ts header) to walk kill tiers
// (lib/ram-utils.ts walkKillTiers, tiers from types/ports.ts KILL_TIERS) to free RAM;
// "queue" mode is documented to skip rather than kill anything.

function baseRuntime(overrides: Record<string, unknown> = {}) {
  return {
    format: { ram: (n: number) => `${n.toFixed(2)}GB` },
    exec: () => 0,
    isRunning: () => false,
    sleep: () => Promise.resolve(),
    ps: () => [],
    kill: () => true,
    ...overrides,
  };
}

describe("executeEntry", () => {
  it("reports failure without launching when the script file doesn't exist", async () => {
    let execCalled = false;
    const ns = mockNS({
      extra: baseRuntime({
        getScriptRam: () => 0, // 0 = script not found, per ns.getScriptRam's contract
        exec: () => { execCalled = true; return 1; },
      }),
    });
    const ok = await executeEntry(ns, entry({ script: "missing.js" }));
    expect(ok).toBe(false);
    expect(execCalled).toBe(false);
  });

  it("treats an already-running script as handled without launching another copy", async () => {
    let execCalled = false;
    const ns = mockNS({
      extra: baseRuntime({
        getScriptRam: () => 4,
        isRunning: () => true,
        exec: () => { execCalled = true; return 1; },
      }),
    });
    const ok = await executeEntry(ns, entry({ script: "actions/check-work.js" }));
    expect(ok).toBe(true);
    expect(execCalled).toBe(false);
  });

  it("skips (does not kill anything) in queue mode when RAM is insufficient", async () => {
    let killed = false;
    const ns = mockNS({
      extra: baseRuntime({
        getScriptRam: () => 10,
        getServerMaxRam: () => 16,
        getServerUsedRam: () => 12, // 4 GB free, need 10
        kill: () => { killed = true; return true; },
        exec: () => 1,
      }),
    });
    const ok = await executeEntry(ns, entry({ script: "big.js", mode: "queue" }));
    expect(ok).toBe(false);
    expect(killed).toBe(false);
  });

  it("kills a lower kill-tier process and executes in force mode when that frees enough RAM", async () => {
    // 4 GB free, need 10; a single tier-1 worker using 8 GB brings it to 12, which is enough.
    let usedRam = 12;
    let launchedPid = 0;
    const ns = mockNS({
      extra: baseRuntime({
        getScriptRam: (script: string) => (script === "big.js" ? 10 : 8),
        getServerMaxRam: () => 16,
        getServerUsedRam: () => usedRam,
        ps: () => [{ filename: "workers/share.js", pid: 42, threads: 1, args: [] }],
        kill: (pid: number) => { if (pid === 42) usedRam -= 8; return true; },
        exec: () => { launchedPid = 99; return 99; },
      }),
    });
    const ok = await executeEntry(ns, entry({ script: "big.js", mode: "force" }));
    expect(ok).toBe(true);
    expect(launchedPid).toBe(99);
  });

  it("gives up and prints the manual fallback when force mode still can't free enough RAM", async () => {
    const ns = mockNS({
      extra: baseRuntime({
        getScriptRam: () => 10,
        getServerMaxRam: () => 16,
        getServerUsedRam: () => 12, // nothing killable will ever close this gap
        ps: () => [], // no killable processes at all
        exec: () => 1,
      }),
    });
    const ok = await executeEntry(ns, entry({
      script: "big.js",
      mode: "force",
      manualFallback: "run big.js manually",
    }));
    expect(ok).toBe(false);
    expect((ns as unknown as { _log: { tprints: string[] } })._log.tprints.join("\n")).toContain("run big.js manually");
  });
});
