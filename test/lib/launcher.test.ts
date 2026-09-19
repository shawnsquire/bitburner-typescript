import { describe, it, expect } from "vitest";
import { ensureRamAndExec, dryRunEnsureRamAndExec, queueExec } from "/lib/launcher";
import { KILL_TIERS, PRIORITY, QUEUE_PORT, QueueEntry } from "/types/ports";
import { mockNS } from "../helpers/mock-ns";

const worker = KILL_TIERS[0][0];

function launcherNS(free: number, workerRam: number) {
  const execs: unknown[][] = [];
  const killed: number[] = [];
  const ns = mockNS({
    extra: {
      getScriptRam: (f: string) => (f === "target.js" ? 10 : f === worker ? workerRam : 0),
      getServerMaxRam: () => 100,
      getServerUsedRam: () => 100 - free,
      ps: () => (killed.length ? [] : [{ pid: 7, filename: worker, threads: 1, args: [] }]),
      kill: (pid: number) => { killed.push(pid); return true; },
      exec: (...args: unknown[]) => { execs.push(args); return 42; },
      format: { ram: (n: number) => `${n}GB` },
    },
  });
  return { ns, execs, killed };
}

describe("ensureRamAndExec", () => {
  it("execs directly when RAM is free, passing threads and args", () => {
    const { ns, execs, killed } = launcherNS(50, 5);
    expect(ensureRamAndExec(ns, "target.js", "home", 2, "--x", 1)).toBe(42);
    expect(execs).toEqual([["target.js", "home", 2, "--x", 1]]);
    expect(killed).toEqual([]);
  });

  it("kills workers to make room, then execs", () => {
    const { ns, execs, killed } = launcherNS(5, 20);
    expect(ensureRamAndExec(ns, "target.js", "home")).toBe(42);
    expect(killed).toEqual([7]);
    expect(execs.length).toBe(1);
    expect(ns._log.tprints.join("\n")).toMatch(/Killed 1 process/);
  });

  it("returns 0 and does not exec when RAM cannot be freed", () => {
    const { ns, execs, killed } = launcherNS(5, 1);
    expect(ensureRamAndExec(ns, "target.js", "home")).toBe(0);
    expect(killed).toEqual([7]);
    expect(execs).toEqual([]);
    expect(ns._log.tprints.join("\n")).toMatch(/Could not free enough RAM/);
  });

  it("returns 0 for an unknown script", () => {
    const { ns, execs } = launcherNS(50, 5);
    expect(ensureRamAndExec(ns, "nope.js", "home")).toBe(0);
    expect(execs).toEqual([]);
  });
});

describe("dryRunEnsureRamAndExec", () => {
  it("reports what would be killed without killing", () => {
    const { ns, killed } = launcherNS(5, 20);
    const r = dryRunEnsureRamAndExec(ns, "target.js", "home");
    expect(r.sufficient).toBe(true);
    expect(r.wouldKill.map((k) => k.pid)).toEqual([7]);
    expect(killed).toEqual([]);
  });
});

describe("queueExec", () => {
  it("writes a QueueEntry with defaults", () => {
    const ns = mockNS();
    queueExec(ns, "actions/x.js", ["--a"]);
    const raw = ns.getPortHandle(QUEUE_PORT).read() as string;
    const e = JSON.parse(raw) as QueueEntry;
    expect(e).toMatchObject({
      script: "actions/x.js",
      args: ["--a"],
      priority: PRIORITY.USER_ACTION,
      mode: "queue",
      requester: "launcher",
    });
    expect(typeof e.timestamp).toBe("number");
  });
});
