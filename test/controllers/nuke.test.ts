import { describe, it, expect, beforeEach } from "vitest";
import { analyzeNukableServers, getPotentialTargets, getNukeStatus } from "/controllers/nuke";
import { invalidateServerCache } from "/lib/server-cache";
import { mockNS } from "../helpers/mock-ns";

// analyzeNukableServers/getPotentialTargets/getNukeStatus go through the
// module-level TTL cache in /lib/server-cache; without invalidating it
// between tests, a later test's call could see an earlier test's server list.
beforeEach(() => {
  invalidateServerCache();
});

function makeServerMap(servers: Record<string, Record<string, unknown>>) {
  return (hostname: string) => {
    if (!(hostname in servers)) throw new Error(`no mock server for ${hostname}`);
    return servers[hostname];
  };
}

describe("analyzeNukableServers", () => {
  it("excludes purchased servers, roots the one ready server, and reports reasons for the rest", () => {
    const ns = mockNS({
      files: { "BruteSSH.exe": "" },
      extra: {
        scan: (host: string) => (host === "home" ? ["rooted", "ready", "needPorts", "needHack", "pserv-1"] : []),
        getPlayer: () => ({ skills: { hacking: 100 } }),
        getServer: makeServerMap({
          home: { hasAdminRights: true, purchasedByPlayer: false },
          rooted: { hasAdminRights: true, purchasedByPlayer: false },
          ready: { hasAdminRights: false, purchasedByPlayer: false, numOpenPortsRequired: 1, requiredHackingSkill: 50 },
          needPorts: { hasAdminRights: false, purchasedByPlayer: false, numOpenPortsRequired: 3, requiredHackingSkill: 50 },
          needHack: { hasAdminRights: false, purchasedByPlayer: false, numOpenPortsRequired: 0, requiredHackingSkill: 500 },
          "pserv-1": { hasAdminRights: false, purchasedByPlayer: true, numOpenPortsRequired: 0, requiredHackingSkill: 1 },
        }),
        hasRootAccess: () => false,
        brutessh: () => true,
        ftpcrack: () => false,
        httpworm: () => false,
        sqlinject: () => false,
        relaysmtp: () => false,
        nuke: (host: string) => host === "ready",
      },
    });

    const result = analyzeNukableServers(ns);

    expect(result.totalServers).toBe(5); // home, rooted, ready, needPorts, needHack (pserv-1 excluded)
    expect(result.toolCount).toBe(1);
    expect(result.nuked.map(r => r.hostname)).toEqual(["ready"]);
    expect(result.alreadyRooted).toEqual(["home", "rooted"]);
    expect(result.rootedCount).toBe(3); // home + rooted + newly nuked "ready"
    expect(result.notReady).toEqual([
      { hostname: "needPorts", reason: "need 3 ports (have 1 tools)" },
      { hostname: "needHack", reason: "need hacking 500 (have 100)" },
    ]);
  });

  it("does not count a v3 nuke() false-return as success (v3 nuke returns false instead of throwing)", () => {
    const ns = mockNS({
      files: { "BruteSSH.exe": "" },
      extra: {
        scan: (host: string) => (host === "home" ? ["target"] : []),
        getPlayer: () => ({ skills: { hacking: 100 } }),
        getServer: makeServerMap({
          home: { hasAdminRights: true, purchasedByPlayer: false },
          target: { hasAdminRights: false, purchasedByPlayer: false, numOpenPortsRequired: 1, requiredHackingSkill: 1 },
        }),
        hasRootAccess: () => false,
        brutessh: () => true,
        ftpcrack: () => false,
        httpworm: () => false,
        sqlinject: () => false,
        relaysmtp: () => false,
        nuke: () => false, // simulates not enough ports open
      },
    });

    const result = analyzeNukableServers(ns);
    expect(result.nuked).toEqual([]);
    expect(result.notReady).toEqual([{ hostname: "target", reason: "nuke failed" }]);
  });

  it("skips servers where getServer throws instead of crashing the whole scan", () => {
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["gone", "ok"] : []),
        getPlayer: () => ({ skills: { hacking: 1 } }),
        getServer: (host: string) => {
          if (host === "gone") throw new Error("server deleted mid-scan");
          return { hasAdminRights: true, purchasedByPlayer: false };
        },
      },
    });

    const result = analyzeNukableServers(ns);
    expect(result.totalServers).toBe(2); // "gone" is skipped entirely, not counted
    expect(result.alreadyRooted).toEqual(["home", "ok"]);
  });
});

describe("getPotentialTargets", () => {
  it("includes only unrooted, non-purchased servers within reach of hacking or ports", () => {
    const ns = mockNS({
      files: {},
      extra: {
        scan: (host: string) => (host === "home" ? ["close", "far", "rooted", "pserv-1"] : []),
        getPlayer: () => ({ skills: { hacking: 100 } }),
        getServer: makeServerMap({
          home: { hasAdminRights: true, purchasedByPlayer: false },
          close: { hasAdminRights: false, purchasedByPlayer: false, numOpenPortsRequired: 0, requiredHackingSkill: 140 }, // within +50
          far: { hasAdminRights: false, purchasedByPlayer: false, numOpenPortsRequired: 5, requiredHackingSkill: 9999 }, // out of reach both ways
          rooted: { hasAdminRights: true, purchasedByPlayer: false },
          "pserv-1": { hasAdminRights: false, purchasedByPlayer: true, numOpenPortsRequired: 0, requiredHackingSkill: 1 },
        }),
      },
    });

    const targets = getPotentialTargets(ns);
    expect(targets.map(t => t.hostname)).toEqual(["close"]);
  });

  it("sorts by required hacking ascending", () => {
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["b", "a"] : []),
        getPlayer: () => ({ skills: { hacking: 0 } }),
        getServer: makeServerMap({
          home: { hasAdminRights: true, purchasedByPlayer: false },
          a: { hasAdminRights: false, purchasedByPlayer: false, numOpenPortsRequired: 0, requiredHackingSkill: 30 },
          b: { hasAdminRights: false, purchasedByPlayer: false, numOpenPortsRequired: 0, requiredHackingSkill: 10 },
        }),
      },
    });

    const targets = getPotentialTargets(ns);
    expect(targets.map(t => t.hostname)).toEqual(["b", "a"]);
  });
});

describe("getNukeStatus", () => {
  it("never nukes; reports 'ready to nuke' for servers that could be rooted", () => {
    const ns = mockNS({
      files: { "BruteSSH.exe": "" },
      extra: {
        scan: (host: string) => (host === "home" ? ["ready"] : []),
        getPlayer: () => ({ skills: { hacking: 100 } }),
        getServer: makeServerMap({
          home: { hasAdminRights: true, purchasedByPlayer: false },
          ready: { hasAdminRights: false, purchasedByPlayer: false, numOpenPortsRequired: 1, requiredHackingSkill: 1 },
        }),
        // Deliberately no nuke/brutessh implementations: if getNukeStatus
        // ever tried to root something, the mock would throw.
      },
    });

    const status = getNukeStatus(ns);
    expect(status.nuked).toEqual([]);
    expect(status.notReady).toEqual([{ hostname: "ready", reason: "ready to nuke" }]);
  });
});
