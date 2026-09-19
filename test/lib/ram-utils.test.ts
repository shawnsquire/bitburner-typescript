import { describe, it, expect } from "vitest";
import { walkKillTiers, calcAvailableAfterKills, freeRamForTarget } from "/lib/ram-utils";
import { KILL_TIERS } from "/types/ports";
import { mockNS } from "../helpers/mock-ns";

interface Proc { pid: number; filename: string; threads: number; args: string[] }

function ramNS(maxRam: number, usedRam: number, procs: Proc[], ramPerScript: Record<string, number>) {
  const killed: number[] = [];
  const ns = mockNS({
    extra: {
      getServerMaxRam: () => maxRam,
      getServerUsedRam: () => usedRam,
      ps: () => procs.filter((p) => !killed.includes(p.pid)),
      getScriptRam: (f: string) => ramPerScript[f] ?? 0,
      kill: (pid: number) => { killed.push(pid); return true; },
      format: { ram: (n: number) => `${n}GB` },
    },
  });
  return { ns, killed };
}

const worker = KILL_TIERS[0][1]; // workers/hack.js
const shareDaemon = KILL_TIERS[1][0];
const dashboard = KILL_TIERS[2][0];

const procs: Proc[] = [
  { pid: 1, filename: worker, threads: 10, args: [] },
  { pid: 2, filename: worker, threads: 2, args: [] },
  { pid: 3, filename: shareDaemon, threads: 1, args: [] },
  { pid: 4, filename: dashboard, threads: 1, args: [] },
  { pid: 5, filename: "daemons/hack.js", threads: 1, args: [] },
];
const costs = { [worker]: 1.7, [shareDaemon]: 8, [dashboard]: 600, "daemons/hack.js": 10 };

describe("walkKillTiers", () => {
  it("does nothing when RAM is already sufficient", () => {
    const { ns, killed } = ramNS(100, 10, procs, costs);
    expect(walkKillTiers(ns, 50)).toEqual({ killed: [], sufficient: true });
    expect(killed).toEqual([]);
  });

  it("kills the largest worker first and stops as soon as the target fits", () => {
    const { ns, killed } = ramNS(100, 90, procs, costs); // 10 free, need 25
    const r = walkKillTiers(ns, 25);
    expect(r.sufficient).toBe(true);
    expect(r.killed.map((k) => k.pid)).toEqual([1]); // 17 GB from pid 1 is enough
    expect(killed).toEqual([1]);
  });

  it("walks into the next tier and never touches unlisted scripts", () => {
    const { ns, killed } = ramNS(100, 90, procs, costs); // 10 free, need 35
    const r = walkKillTiers(ns, 35);
    expect(r.killed.map((k) => k.pid)).toEqual([1, 2, 3]);
    expect(r.sufficient).toBe(true);
    expect(killed).not.toContain(5);
  });

  it("excludes the dashboard tier by default and includes it on request", () => {
    const { ns } = ramNS(1000, 990, procs, costs); // 10 free, need 500
    expect(walkKillTiers(ns, 500).sufficient).toBe(false);
    const r = walkKillTiers(ns, 500, { excludeDashboard: false, dryRun: true });
    expect(r.sufficient).toBe(true);
    expect(r.killed.map((k) => k.pid)).toContain(4);
  });

  it("dryRun reports without killing", () => {
    const { ns, killed } = ramNS(100, 90, procs, costs);
    const r = walkKillTiers(ns, 25, { dryRun: true });
    expect(r.killed.length).toBe(1);
    expect(killed).toEqual([]);
  });
});

describe("wrappers", () => {
  it("calcAvailableAfterKills sums free RAM plus killable RAM (no dashboard)", () => {
    const { ns } = ramNS(100, 90, procs, costs);
    expect(calcAvailableAfterKills(ns)).toBeCloseTo(10 + 17 + 3.4 + 8);
  });

  it("freeRamForTarget kills and reports", () => {
    const { ns, killed } = ramNS(100, 90, procs, costs);
    expect(freeRamForTarget(ns, 25)).toBe(true);
    expect(killed).toEqual([1]);
    expect(ns._log.tprints[0]).toMatch(/Killed 1 process/);
  });
});
