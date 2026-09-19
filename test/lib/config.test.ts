import { describe, it, expect } from "vitest";
import {
  readConfig,
  writeDefaultConfig,
  getConfigString,
  getConfigNumber,
  getConfigBool,
  setConfigValue,
} from "/lib/config";
import { mockNS } from "../helpers/mock-ns";

describe("readConfig", () => {
  it("parses key=value, skips comments and blanks, splits on first =", () => {
    const ns = mockNS({ files: { "/config/x.txt": "# c\n\na=1\n  b = two = three \nnovalue\n=ignored\n" } });
    const c = readConfig(ns, "x");
    expect([...c.entries()]).toEqual([
      ["a", "1"],
      ["b", "two = three"],
    ]);
  });

  it("returns an empty map when the file is missing", () => {
    expect(readConfig(mockNS(), "missing").size).toBe(0);
  });
});

describe("writeDefaultConfig", () => {
  it("creates the file with a header and every key", () => {
    const ns = mockNS();
    writeDefaultConfig(ns, "sys", { a: "1", b: "x" });
    expect(ns._files.get("/config/sys.txt")).toBe("# sys Config\na=1\nb=x");
  });

  it("never overwrites an existing file", () => {
    const ns = mockNS({ files: { "/config/sys.txt": "a=user" } });
    writeDefaultConfig(ns, "sys", { a: "1" });
    expect(ns._files.get("/config/sys.txt")).toBe("a=user");
  });
});

describe("typed getters", () => {
  const ns = mockNS({ files: { "/config/s.txt": "n=42\nbad=abc\nt=true\none=1\nf=yes" } });

  it("getConfigString falls back when missing", () => {
    expect(getConfigString(ns, "s", "n", "d")).toBe("42");
    expect(getConfigString(ns, "s", "zzz", "d")).toBe("d");
  });

  it("getConfigNumber falls back on missing or NaN", () => {
    expect(getConfigNumber(ns, "s", "n", 0)).toBe(42);
    expect(getConfigNumber(ns, "s", "bad", 7)).toBe(7);
    expect(getConfigNumber(ns, "s", "zzz", 7)).toBe(7);
  });

  it("getConfigBool accepts only 'true' and '1'", () => {
    expect(getConfigBool(ns, "s", "t", false)).toBe(true);
    expect(getConfigBool(ns, "s", "one", false)).toBe(true);
    expect(getConfigBool(ns, "s", "f", true)).toBe(false);
    expect(getConfigBool(ns, "s", "zzz", true)).toBe(true);
  });
});

describe("setConfigValue", () => {
  it("creates the file when missing", () => {
    const ns = mockNS();
    setConfigValue(ns, "s", "k", "v");
    expect(ns._files.get("/config/s.txt")).toBe("# s Config\nk=v");
  });

  it("replaces an existing key in place and preserves other lines", () => {
    const ns = mockNS({ files: { "/config/s.txt": "# hdr\na=1\nk=old\nb=2" } });
    setConfigValue(ns, "s", "k", "new");
    expect(ns._files.get("/config/s.txt")).toBe("# hdr\na=1\nk=new\nb=2");
  });

  it("appends a new key", () => {
    const ns = mockNS({ files: { "/config/s.txt": "a=1" } });
    setConfigValue(ns, "s", "k", "v");
    expect(ns._files.get("/config/s.txt")).toBe("a=1\nk=v");
  });

  it("handles dotted keys such as weight.stocks", () => {
    const ns = mockNS({ files: { "/config/s.txt": "weight.stocks=50\nweight.servers=25" } });
    setConfigValue(ns, "s", "weight.stocks", "10");
    expect(readConfig(ns, "s").get("weight.stocks")).toBe("10");
    expect(readConfig(ns, "s").get("weight.servers")).toBe("25");
  });
});
