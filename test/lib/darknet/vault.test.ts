import { describe, it, expect } from "vitest";
import { VAULT_PATH, emptyVault, parseVault, serializeVault, loadVault, saveVault } from "/lib/darknet/vault";
import { Vault } from "/lib/darknet/protocol";
import { mockNS } from "../../helpers/mock-ns";

function entry(seenAt = 1) {
  return { password: "hunter2", fingerprint: { difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 }, seenAt };
}

describe("emptyVault", () => {
  it("stamps the given lastNodeReset with no entries", () => {
    expect(emptyVault(42)).toEqual({ lastNodeReset: 42, entries: {} });
  });
});

describe("parseVault", () => {
  it("round-trips a well-formed vault through serializeVault", () => {
    const vault: Vault = { lastNodeReset: 100, entries: { n00dl3s: entry() } };
    expect(parseVault(serializeVault(vault))).toEqual(vault);
  });

  it("returns null for an empty string", () => {
    expect(parseVault("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseVault("{not json")).toBeNull();
  });

  it("returns null when lastNodeReset is missing or the wrong type", () => {
    expect(parseVault(JSON.stringify({ entries: {} }))).toBeNull();
    expect(parseVault(JSON.stringify({ lastNodeReset: "100", entries: {} }))).toBeNull();
  });

  it("returns null when entries is missing", () => {
    expect(parseVault(JSON.stringify({ lastNodeReset: 1 }))).toBeNull();
  });

  it("returns null for a non-object top level", () => {
    expect(parseVault(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseVault(JSON.stringify("just a string"))).toBeNull();
  });

  it("drops malformed individual entries but keeps well-formed ones", () => {
    const raw = JSON.stringify({
      lastNodeReset: 1,
      entries: {
        good: entry(),
        badPassword: { password: 5, fingerprint: entry().fingerprint, seenAt: 1 },
        badFingerprint: { password: "x", fingerprint: { difficulty: 1 }, seenAt: 1 },
        notAnObject: "nope",
      },
    });
    expect(parseVault(raw)).toEqual({ lastNodeReset: 1, entries: { good: entry() } });
  });
});

describe("loadVault / saveVault", () => {
  it("returns a fresh vault when the file doesn't exist", () => {
    const ns = mockNS();
    expect(loadVault(ns, 7)).toEqual(emptyVault(7));
  });

  it("saves then loads back the same vault under a matching lastNodeReset", () => {
    const ns = mockNS();
    const vault: Vault = { lastNodeReset: 7, entries: { n00dl3s: entry() } };
    saveVault(ns, vault);
    expect(ns._files.get(VAULT_PATH)).toBe(serializeVault(vault));
    expect(loadVault(ns, 7)).toEqual(vault);
  });

  it("wipes the vault when lastNodeReset doesn't match a BitNode reset", () => {
    const ns = mockNS();
    saveVault(ns, { lastNodeReset: 7, entries: { n00dl3s: entry() } });
    expect(loadVault(ns, 8)).toEqual(emptyVault(8));
  });

  it("wipes the vault when the file is corrupt", () => {
    const ns = mockNS({ files: { [VAULT_PATH]: "{not json" } });
    expect(loadVault(ns, 1)).toEqual(emptyVault(1));
  });

  it("saveVault overwrites rather than appends", () => {
    const ns = mockNS();
    saveVault(ns, { lastNodeReset: 1, entries: { a: entry() } });
    saveVault(ns, { lastNodeReset: 1, entries: { b: entry() } });
    expect(loadVault(ns, 1)).toEqual({ lastNodeReset: 1, entries: { b: entry() } });
  });
});
