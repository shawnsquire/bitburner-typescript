import { describe, it, expect } from "vitest";
import {
  parseStartupConfig,
  getActiveTab,
  setActiveTab,
  getPluginUIState,
  setPluginUIState,
} from "/views/dashboard/state-store";

describe("parseStartupConfig", () => {
  it("returns an empty list for empty input", () => {
    expect(parseStartupConfig("")).toEqual([]);
  });

  it("parses core and optional sections", () => {
    const raw = [
      "# Startup Config",
      "# [core]",
      "daemons/nuke.js",
      "daemons/hack.js",
      "",
      "# [optional]",
      "daemons/pserv.js",
    ].join("\n");

    expect(parseStartupConfig(raw)).toEqual([
      { path: "daemons/nuke.js", enabled: true, core: true },
      { path: "daemons/hack.js", enabled: true, core: true },
      { path: "daemons/pserv.js", enabled: true, core: false },
    ]);
  });

  it("treats lines before any section marker as core", () => {
    const raw = "daemons/nuke.js\n# [optional]\ndaemons/pserv.js";
    expect(parseStartupConfig(raw)).toEqual([
      { path: "daemons/nuke.js", enabled: true, core: true },
      { path: "daemons/pserv.js", enabled: true, core: false },
    ]);
  });

  it("marks a commented-out .js line as disabled but keeps its section", () => {
    const raw = "# [optional]\n# daemons/gang.js\ndaemons/corp.js";
    expect(parseStartupConfig(raw)).toEqual([
      { path: "daemons/gang.js", enabled: false, core: false },
      { path: "daemons/corp.js", enabled: true, core: false },
    ]);
  });

  it("supports multiple leading '#' characters and surrounding whitespace", () => {
    const raw = "##   daemons/blade.js";
    expect(parseStartupConfig(raw)).toEqual([
      { path: "daemons/blade.js", enabled: false, core: true },
    ]);
  });

  it("ignores plain comments and blank lines that are not .js entries", () => {
    const raw = "# just a note\n\n   \ndaemons/rep.js";
    expect(parseStartupConfig(raw)).toEqual([
      { path: "daemons/rep.js", enabled: true, core: true },
    ]);
  });

  it("ignores non-.js lines entirely", () => {
    expect(parseStartupConfig("some text\nnotascript.txt")).toEqual([]);
  });

  it("re-enters core mode if a later [core] marker appears again", () => {
    const raw = "# [optional]\ndaemons/pserv.js\n# [core]\ndaemons/work.js";
    expect(parseStartupConfig(raw)).toEqual([
      { path: "daemons/pserv.js", enabled: true, core: false },
      { path: "daemons/work.js", enabled: true, core: true },
    ]);
  });
});

describe("plugin UI state", () => {
  it("returns the default value when the key has not been set", () => {
    expect(getPluginUIState("hack", "someUnsetKey", "fallback")).toBe("fallback");
  });

  it("round-trips a value written with setPluginUIState", () => {
    setPluginUIState("hack", "strategy", "xp");
    expect(getPluginUIState<string>("hack", "strategy", "money")).toBe("xp");
  });

  it("keeps state isolated per plugin", () => {
    setPluginUIState("share", "targetPercent", 50);
    setPluginUIState("gang", "targetPercent", 10);
    expect(getPluginUIState<number>("share", "targetPercent", 0)).toBe(50);
    expect(getPluginUIState<number>("gang", "targetPercent", 0)).toBe(10);
  });
});

describe("active tab state", () => {
  it("has the expected shape", () => {
    const tab = getActiveTab();
    expect(tab).toHaveProperty("group");
    expect(tab).toHaveProperty("sub");
  });

  it("round-trips a value written with setActiveTab", () => {
    setActiveTab({ group: 2, sub: 3 });
    expect(getActiveTab()).toEqual({ group: 2, sub: 3 });
  });
});
