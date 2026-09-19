import { describe, it, expect } from "vitest";
import type { Server } from "@ns";
import {
  COLORS,
  getAllServers,
  discoverAllWithDepthAndPath,
  pathTo,
  pathToArray,
  determineAction,
  makeBar,
  formatTime,
} from "/lib/utils";
import { mockNS } from "../helpers/mock-ns";

/** home - a - b - c, plus a dead-end d off home and darkweb off home */
const graph: Record<string, string[]> = {
  home: ["a", "d", "darkweb"],
  a: ["home", "b"],
  b: ["a", "c"],
  c: ["b"],
  d: ["home"],
  darkweb: ["home"],
};
const ns = mockNS({ extra: { scan: (h: string) => graph[h] ?? [] } });

describe("server discovery", () => {
  it("getAllServers walks the whole network and skips darkweb", () => {
    expect(getAllServers(ns).sort()).toEqual(["a", "b", "c", "d", "home"]);
  });

  it("discoverAllWithDepthAndPath tracks depth and parent, honours maxDepth", () => {
    const r = discoverAllWithDepthAndPath(ns, "home", -1);
    expect(r.depthByHost.get("c")).toBe(3);
    expect(r.parentByHost.get("c")).toBe("b");
    expect(r.hosts).toEqual(["home", "a", "d", "b", "c"]); // by depth, then name

    const shallow = discoverAllWithDepthAndPath(ns, "home", 2);
    expect(shallow.hosts).toEqual(["home", "a", "d", "b"]);
  });

  it("pathTo and pathToArray reconstruct the route", () => {
    const { parentByHost } = discoverAllWithDepthAndPath(ns, "home", -1);
    expect(pathToArray(parentByHost, "c")).toEqual(["home", "a", "b", "c"]);
    expect(pathTo(parentByHost, "c")).toBe("a > b > c");
    expect(pathTo(parentByHost, "c", true)).toBe("home > a > b > c");
    expect(pathToArray(parentByHost, "unknown")).toEqual(["unknown"]);
  });
});

describe("determineAction", () => {
  const base = { minDifficulty: 10, moneyMax: 1000 } as Server;
  it("weakens first, then grows, then hacks", () => {
    expect(determineAction({ ...base, hackDifficulty: 16, moneyAvailable: 1000 }, 0.9, 5)).toBe("weaken");
    expect(determineAction({ ...base, hackDifficulty: 15, moneyAvailable: 500 }, 0.9, 5)).toBe("grow");
    expect(determineAction({ ...base, hackDifficulty: 15, moneyAvailable: 900 }, 0.9, 5)).toBe("hack");
  });
  it("treats missing fields as zero", () => {
    expect(determineAction({} as Server, 0.9, 5)).toBe("hack");
  });
});

describe("display helpers", () => {
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const strip = (s: string) => s.replace(ansi, "");
  const FULL = "█";
  const EMPTY = "░";

  it("makeBar clamps and sizes correctly", () => {
    expect(strip(makeBar(0.5, 4))).toBe(`[${FULL}${FULL}${EMPTY}${EMPTY}]`);
    expect(strip(makeBar(2, 4))).toBe(`[${FULL.repeat(4)}]`);
    expect(strip(makeBar(-1, 4))).toBe(`[${EMPTY.repeat(4)}]`);
    expect(makeBar(1, 1)).toContain(COLORS.green);
  });

  it("formatTime picks units by magnitude", () => {
    expect(formatTime(5)).toBe("5s");
    expect(formatTime(125)).toBe("2m 5s");
    expect(formatTime(3725)).toBe("1h 2m");
    expect(formatTime(90000)).toBe("1d 1h");
    expect(formatTime(-1)).toBe("???");
    expect(formatTime(Infinity)).toBe("???");
  });
});
