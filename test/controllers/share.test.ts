import { describe, it, expect, beforeEach } from "vitest";
import {
  getShareStatus,
  getAvailableShareRam,
  calculateShareThreads,
  getTotalShareCapacity,
  launchShareThreads,
  DEFAULT_SHARE_SCRIPT,
  ShareConfig,
} from "/controllers/share";
import { invalidateServerCache } from "/lib/server-cache";
import { mockNS } from "../helpers/mock-ns";

beforeEach(() => {
  invalidateServerCache();
});

function makeServerMap(servers: Record<string, Record<string, unknown>>) {
  return (hostname: string) => {
    if (!(hostname in servers)) throw new Error(`no mock server for ${hostname}`);
    return servers[hostname];
  };
}

const SCRIPT_RAM = 4; // matches workers/share.js (1.6 base + 2.4 ns.share())

// ns.ps() reports RunningScript.filename WITHOUT a leading slash (Bitburner's
// internal FilePath type disallows one), even though DEFAULT_SHARE_SCRIPT is
// written repo-absolute ("/workers/share.js"). Mocks below deliberately use
// this slash-less form to match real game behavior.
const RUNNING_SHARE_FILENAME = "workers/share.js";

describe("getAvailableShareRam", () => {
  it("returns 0 for a server without root or without RAM", () => {
    const ns = mockNS({
      extra: {
        getServer: makeServerMap({
          locked: { hasAdminRights: false, maxRam: 64, ramUsed: 0 },
          noRam: { hasAdminRights: true, maxRam: 0, ramUsed: 0 },
        }),
      },
    });
    expect(getAvailableShareRam(ns, "locked", 4, 32)).toBe(0);
    expect(getAvailableShareRam(ns, "noRam", 4, 32)).toBe(0);
  });

  it("reserves homeReserve on home and minFree elsewhere", () => {
    const ns = mockNS({
      extra: {
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 128, ramUsed: 0 },
          worker: { hasAdminRights: true, maxRam: 128, ramUsed: 0 },
        }),
      },
    });
    expect(getAvailableShareRam(ns, "home", 4, 32)).toBe(96); // 128 - 0 - 32
    expect(getAvailableShareRam(ns, "worker", 4, 32)).toBe(124); // 128 - 0 - 4
  });

  it("never goes negative when reserve exceeds free RAM", () => {
    const ns = mockNS({
      extra: {
        getServer: makeServerMap({
          tiny: { hasAdminRights: true, maxRam: 8, ramUsed: 4 },
        }),
      },
    });
    expect(getAvailableShareRam(ns, "tiny", 4, 32)).toBe(0);
  });
});

describe("calculateShareThreads", () => {
  it("returns 0 when the share script can't be found (0 RAM)", () => {
    const ns = mockNS({ extra: { getScriptRam: () => 0, getServer: makeServerMap({}) } });
    expect(calculateShareThreads(ns, "home", DEFAULT_SHARE_SCRIPT, 4, 32)).toBe(0);
  });

  it("floors available RAM divided by script RAM", () => {
    const ns = mockNS({
      extra: {
        getScriptRam: () => SCRIPT_RAM,
        getServer: makeServerMap({ home: { hasAdminRights: true, maxRam: 100, ramUsed: 0 } }),
      },
    });
    // available = 100 - 0 - 32 = 68; 68 / 4 = 17
    expect(calculateShareThreads(ns, "home", DEFAULT_SHARE_SCRIPT, 4, 32)).toBe(17);
  });
});

describe("getTotalShareCapacity", () => {
  it("sums potential threads and RAM across every server", () => {
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["worker"] : []),
        getScriptRam: () => SCRIPT_RAM,
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 100, ramUsed: 0 },
          worker: { hasAdminRights: true, maxRam: 40, ramUsed: 4 },
        }),
      },
    });
    // home: available = 100-0-64=36 -> 9 threads, 36 ram
    // worker: available = 40-4-4=32 -> 8 threads, 32 ram
    const { totalThreads, totalRam } = getTotalShareCapacity(ns, DEFAULT_SHARE_SCRIPT, 4, 64);
    expect(totalThreads).toBe(17);
    expect(totalRam).toBe(68);
  });
});

describe("getShareStatus", () => {
  it("counts running share threads per server and reports total share power", () => {
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["worker", "idle"] : []),
        getScriptRam: () => SCRIPT_RAM,
        getSharePower: () => 1.25,
        getServer: makeServerMap({
          home: { maxRam: 100, ramUsed: 40 },
          worker: { maxRam: 40, ramUsed: 20 },
          idle: { maxRam: 40, ramUsed: 0 },
        }),
        ps: (host: string) =>
          host === "home"
            ? [{ filename: RUNNING_SHARE_FILENAME, threads: 10 }]
            : host === "worker"
              ? [{ filename: RUNNING_SHARE_FILENAME, threads: 5 }]
              : [],
      },
    });

    const status = getShareStatus(ns, DEFAULT_SHARE_SCRIPT);
    expect(status.totalThreads).toBe(15);
    expect(status.serversWithShare).toBe(2);
    expect(status.sharePower).toBe(1.25);
    // Sorted descending by threads.
    expect(status.serverStats.map(s => s.hostname)).toEqual(["home", "worker"]);
  });

  it("reports zero threads when nothing is running", () => {
    const ns = mockNS({
      extra: {
        scan: () => [],
        getScriptRam: () => SCRIPT_RAM,
        getSharePower: () => 1,
        getServer: makeServerMap({ home: { maxRam: 100, ramUsed: 0 } }),
        ps: () => [],
      },
    });
    const status = getShareStatus(ns, DEFAULT_SHARE_SCRIPT);
    expect(status.totalThreads).toBe(0);
    expect(status.serverStats).toEqual([]);
  });
});

describe("launchShareThreads", () => {
  function config(overrides: Partial<ShareConfig> = {}): ShareConfig {
    return {
      minFree: 4,
      homeReserve: 32,
      interval: 10000,
      oneShot: true,
      shareScript: DEFAULT_SHARE_SCRIPT,
      targetPercent: 0,
      ...overrides,
    };
  }

  it("launches max threads on every rooted server with RAM, greedy mode", () => {
    const execCalls: { script: string; host: string; threads: number }[] = [];
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["worker"] : []),
        getScriptRam: () => SCRIPT_RAM,
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 100, ramUsed: 0 },
          worker: { hasAdminRights: true, maxRam: 40, ramUsed: 0 },
        }),
        ps: () => [],
        exec: (script: string, host: string, threads: number) => {
          execCalls.push({ script, host, threads });
          return 123;
        },
      },
    });

    const result = launchShareThreads(ns, config());
    // home: available = 100-0-32=68 -> 17 threads; worker: available = 40-0-4=36 -> 9 threads
    expect(result).toEqual({ launchedThreads: 26, serversUsed: 2 });
    expect(execCalls).toEqual([
      { script: DEFAULT_SHARE_SCRIPT, host: "home", threads: 17 },
      { script: DEFAULT_SHARE_SCRIPT, host: "worker", threads: 9 },
    ]);
  });

  it("skips servers without root or without RAM", () => {
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["locked", "empty"] : []),
        getScriptRam: () => SCRIPT_RAM,
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 40, ramUsed: 0 },
          locked: { hasAdminRights: false, maxRam: 64, ramUsed: 0 },
          empty: { hasAdminRights: true, maxRam: 0, ramUsed: 0 },
        }),
        ps: () => [],
        exec: () => 1,
      },
    });

    const result = launchShareThreads(ns, config());
    expect(result.serversUsed).toBe(1); // only "home"
  });

  it("only uses servers in allowedServers when a fleet allocation is provided", () => {
    const execHosts: string[] = [];
    const ns = mockNS({
      extra: {
        scan: (host: string) => (host === "home" ? ["a", "b"] : []),
        getScriptRam: () => SCRIPT_RAM,
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 40, ramUsed: 0 },
          a: { hasAdminRights: true, maxRam: 40, ramUsed: 0 },
          b: { hasAdminRights: true, maxRam: 40, ramUsed: 0 },
        }),
        ps: () => [],
        exec: (_s: string, host: string) => { execHosts.push(host); return 1; },
      },
    });

    launchShareThreads(ns, config(), new Set(["a"]));
    expect(execHosts).toEqual(["a"]);
  });

  it("caps launched RAM to targetPercent of usable capacity when no fleet allocation is set", () => {
    let launchedThreads = 0;
    const ns = mockNS({
      extra: {
        scan: () => [],
        getScriptRam: () => SCRIPT_RAM,
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 100, ramUsed: 0 },
        }),
        ps: () => [],
        exec: (_s: string, _h: string, threads: number) => { launchedThreads = threads; return 1; },
      },
    });

    // totalUsable = 100 - 32(homeReserve) = 68; targetPercent 50% -> 34 GB allowed -> floor(34/4) = 8 threads.
    // (Greedy would have allowed floor((100-0-32)/4) = 17 threads.)
    const result = launchShareThreads(ns, config({ homeReserve: 32, targetPercent: 50 }));
    expect(launchedThreads).toBe(8);
    expect(result.launchedThreads).toBe(8);
  });

  it("subtracts already-running share threads from the targetPercent allocation (regression: leading-slash filename mismatch)", () => {
    // Before the fix, this filter compared ps().filename (no leading slash)
    // against config.shareScript ("/workers/share.js", with leading slash)
    // and never matched, so already-running share threads were never
    // subtracted and every cycle re-launched a full new batch on top.
    let launchedThreads = 0;
    const ns = mockNS({
      extra: {
        scan: () => [],
        getScriptRam: () => SCRIPT_RAM,
        getServer: makeServerMap({
          home: { hasAdminRights: true, maxRam: 100, ramUsed: 32 }, // 8 threads * 4GB already running
        }),
        ps: () => [{ filename: RUNNING_SHARE_FILENAME, threads: 8 }],
        exec: (_s: string, _h: string, threads: number) => { launchedThreads = threads; return 1; },
      },
    });

    // totalUsable = 100 - 32(homeReserve) = 68; targetPercent 50% -> 34 GB allowed.
    // 8 threads (32GB) already running -> only 2GB of allocation left -> 0 more threads.
    const result = launchShareThreads(ns, config({ homeReserve: 32, targetPercent: 50 }));
    expect(launchedThreads).toBe(0);
    expect(result.launchedThreads).toBe(0);
  });

  it("returns nothing launched when the share script can't be found", () => {
    const ns = mockNS({ extra: { getScriptRam: () => 0 } });
    expect(launchShareThreads(ns, config())).toEqual({ launchedThreads: 0, serversUsed: 0 });
  });
});
