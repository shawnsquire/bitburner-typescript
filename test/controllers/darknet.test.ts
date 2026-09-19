import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  createModel,
  applyReport,
  refreshFromDetails,
  computePolicy,
  charismaNeed,
  selectCarriers,
  stasisPriority,
  toStatus,
  edgeKey,
  neighboursOf,
  CellRecord,
  DarknetConfig,
  DarknetModel,
  Limits,
  PlayerInfo,
} from "/controllers/darknet";
import { AGENT_VERSION, CODE, ReportBatch, ReportEvent, SeenDetails } from "/lib/darknet/protocol";
import { DarknetCellState } from "/types/ports";

// === FIXTURES ===

function details(overrides: Partial<SeenDetails> = {}): SeenDetails {
  return {
    isConnectedToCurrentServer: false,
    hasSession: false,
    modelId: "ZeroLogon",
    passwordHint: "",
    data: "",
    logTrafficInterval: 20,
    passwordLength: 0,
    passwordFormat: "numeric",
    blockedRam: 0,
    difficulty: 5,
    depth: 1,
    requiredCharismaSkill: 0,
    isStationary: false,
    isOnline: true,
    maxRam: 32,
    usedRam: 0,
    hasAdmin: false,
    ...overrides,
  };
}

function batch(from: string, events: ReportEvent[], overrides: Partial<ReportBatch> = {}): ReportBatch {
  return { from, pid: 111, depth: 1, at: 1000, events, ...overrides };
}

function seenEvent(host: string, overrides: Partial<SeenDetails> = {}, neighbours: string[] = []): ReportEvent {
  return { t: "seen", host, details: details(overrides), neighbours };
}

const player: PlayerInfo = { charisma: 50, karma: -100 };
const noAccess: Limits = { stasisLimit: 0, access: "none", labName: null };
const fullAccess: Limits = { stasisLimit: 2, access: "full", labName: "th3_l4byr1nth" };

/**
 * Directly install a cell in the given state, for fixture setup in tests
 * that target a different function than applyReport/refreshFromDetails
 * (both of which get their own dedicated coverage below, driven through the
 * real report/poll path instead of this shortcut).
 */
function setCell(m: DarknetModel, host: string, state: DarknetCellState, overrides: Partial<SeenDetails> = {}): CellRecord {
  const d = details({ hasAdmin: state === "admin" || state === "agent" || state === "anchor", ...overrides });
  const cell: CellRecord = {
    host,
    details: d,
    fingerprint: { difficulty: d.difficulty, modelId: d.modelId, passwordLength: d.passwordLength },
    state,
    lastSeen: 1,
    agentPid: state === "agent" || state === "anchor" ? 1 : 0,
    agentSeenAt: state === "agent" || state === "anchor" ? 1 : 0,
    attempts: 0,
    cacheSeen: false,
  };
  m.cells[host] = cell;
  return cell;
}

function agentCell(m: DarknetModel, host: string, overrides: Partial<SeenDetails> = {}): CellRecord {
  return setCell(m, host, "agent", overrides);
}

// === createModel ===

describe("createModel", () => {
  it("starts empty, stamped with the given lastNodeReset", () => {
    const m = createModel(999);
    expect(m.cells).toEqual({});
    expect(m.edges.size).toBe(0);
    expect(m.vault).toEqual({ lastNodeReset: 999, entries: {} });
    expect(m.stasisHosts).toEqual([]);
    expect(m.manualStasis).toEqual([]);
    expect(m.income).toEqual({ money: 0, since: 0, cachesOpened: 0, contractsFound: 0, augsAwarded: 0 });
    expect(m.stuckSince).toBeNull();
    expect(m.pauseUntil).toBe(0);
    expect(m.stormPending).toBe(false);
  });
});

// === applyReport ===

describe("applyReport: agent residency", () => {
  it("marks the batch's origin host as a live agent, creating the cell if unknown", () => {
    const m = createModel(0);
    applyReport(m, batch("n00dl3s", []), 1000);
    expect(m.cells["n00dl3s"].state).toBe("agent");
    expect(m.cells["n00dl3s"].agentPid).toBe(111);
    expect(m.cells["n00dl3s"].agentSeenAt).toBe(1000);
  });

  it("marks it anchor instead when the host holds a stasis link", () => {
    const m = createModel(0);
    m.stasisHosts.push("n00dl3s");
    applyReport(m, batch("n00dl3s", []), 1000);
    expect(m.cells["n00dl3s"].state).toBe("anchor");
  });
});

describe("applyReport: seen", () => {
  it("upserts details/fingerprint, sets lastSeen, and derives admin/frontier state", () => {
    const m = createModel(0);
    applyReport(m, batch("home-agent", [seenEvent("target1", { hasAdmin: false })]), 500);
    expect(m.cells["target1"].state).toBe("frontier");
    expect(m.cells["target1"].lastSeen).toBe(500);
    expect(m.cells["target1"].fingerprint).toEqual({ difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 });

    applyReport(m, batch("home-agent", [seenEvent("target1", { hasAdmin: true })]), 600);
    expect(m.cells["target1"].state).toBe("admin");
  });

  it("never downgrades a resident agent/anchor host on a stale neighbour report", () => {
    const m = createModel(0);
    applyReport(m, batch("res1", []), 1); // res1 is now "agent"
    expect(m.cells["res1"].state).toBe("agent");
    applyReport(m, batch("prober", [seenEvent("res1", { hasAdmin: true })]), 2);
    expect(m.cells["res1"].state).toBe("agent");
  });

  it("resets attempts and drops the vault entry + edges when the fingerprint changes", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("target1", { difficulty: 5 }, ["target1"])]), 1);
    m.cells["target1"].attempts = 7;
    m.vault.entries["target1"] = { password: "old", fingerprint: { difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 }, seenAt: 1 };
    expect(m.edges.has(edgeKey("prober", "target1"))).toBe(true);

    const result = applyReport(m, batch("prober", [seenEvent("target1", { difficulty: 9 })]), 2);

    expect(m.cells["target1"].attempts).toBe(0);
    expect(m.vault.entries["target1"]).toBeUndefined();
    expect(result.vaultChanged).toBe(true);
    expect(m.edges.has(edgeKey("prober", "target1"))).toBe(false);
  });

  it("does not touch the vault or attempts when the fingerprint is unchanged", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("target1")]), 1);
    m.cells["target1"].attempts = 3;
    m.vault.entries["target1"] = { password: "pw", fingerprint: { difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 }, seenAt: 1 };

    const result = applyReport(m, batch("prober", [seenEvent("target1")]), 2);

    expect(m.cells["target1"].attempts).toBe(3);
    expect(m.vault.entries["target1"]).toBeDefined();
    expect(result.vaultChanged).toBe(false);
  });

  it("adds edges anchored at the reporting host for every neighbour in the report", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("n1", {}, ["n1", "n2"])]), 1);
    expect(m.edges.has(edgeKey("prober", "n1"))).toBe(true);
    expect(m.edges.has(edgeKey("prober", "n2"))).toBe(true);
    expect(neighboursOf(m, "prober").sort()).toEqual(["n1", "n2"]);
    // n2 gets a bare cell even though only n1 had a "seen" event this tick.
    expect(m.cells["n2"].state).toBe("unknown");
  });
});

describe("applyReport: cracked", () => {
  it("stores the vault entry, sets admin state, and resets attempts", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("target1")]), 1);
    m.cells["target1"].attempts = 5;

    const result = applyReport(
      m,
      batch("prober", [{ t: "cracked", host: "target1", password: "hunter2", fingerprint: { difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 } }]),
      2,
    );

    expect(result.vaultChanged).toBe(true);
    expect(m.vault.entries["target1"]).toEqual({ password: "hunter2", fingerprint: { difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 }, seenAt: 1000 });
    expect(m.cells["target1"].state).toBe("admin");
    expect(m.cells["target1"].attempts).toBe(0);
  });
});

describe("applyReport: stale", () => {
  it("drops the entry when the fingerprint matches", () => {
    const m = createModel(0);
    const fp = { difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 };
    m.vault.entries["target1"] = { password: "pw", fingerprint: fp, seenAt: 1 };
    const result = applyReport(m, batch("agent1", [{ t: "stale", host: "target1", fingerprint: fp }]), 2);
    expect(m.vault.entries["target1"]).toBeUndefined();
    expect(result.vaultChanged).toBe(true);
  });

  it("is a no-op when the fingerprint no longer matches (already replaced)", () => {
    const m = createModel(0);
    const oldFp = { difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 };
    const newFp = { difficulty: 9, modelId: "ZeroLogon", passwordLength: 0 };
    m.vault.entries["target1"] = { password: "pw", fingerprint: newFp, seenAt: 1 };
    const result = applyReport(m, batch("agent1", [{ t: "stale", host: "target1", fingerprint: oldFp }]), 2);
    expect(m.vault.entries["target1"]).toBeDefined();
    expect(result.vaultChanged).toBe(false);
  });

  it("is a no-op when there was no entry to begin with", () => {
    const m = createModel(0);
    const fp = { difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 };
    const result = applyReport(m, batch("agent1", [{ t: "stale", host: "target1", fingerprint: fp }]), 2);
    expect(result.vaultChanged).toBe(false);
  });
});

describe("applyReport: leak", () => {
  it("adds a vault candidate for a known host with a fingerprint and no existing entry", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("target1")]), 1);
    const result = applyReport(m, batch("agent1", [{ t: "leak", host: "target1", password: "leaked", line: "Connecting to target1:leaked" }]), 2);
    expect(m.vault.entries["target1"]?.password).toBe("leaked");
    expect(result.vaultChanged).toBe(true);
  });

  it("does not overwrite an existing vault entry", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("target1")]), 1);
    const fp = m.cells["target1"].fingerprint!;
    m.vault.entries["target1"] = { password: "original", fingerprint: fp, seenAt: 1 };
    applyReport(m, batch("agent1", [{ t: "leak", host: "target1", password: "leaked", line: "" }]), 2);
    expect(m.vault.entries["target1"].password).toBe("original");
  });

  it("ignores a host-less leak line (no cell to attach it to)", () => {
    const m = createModel(0);
    const result = applyReport(m, batch("agent1", [{ t: "leak", host: null, line: "--pw--" }]), 2);
    expect(result.vaultChanged).toBe(false);
    expect(Object.keys(m.vault.entries)).toEqual([]);
  });
});

describe("applyReport: cache / ramfreed / phish", () => {
  it("cache increments cachesOpened, clears cacheSeen, and counts augsAwarded on the great-work cache", () => {
    const m = createModel(0);
    m.cells["lab1"] = { host: "lab1", details: null, fingerprint: null, state: "admin", lastSeen: 0, agentPid: 0, agentSeenAt: 0, attempts: 0, cacheSeen: true };
    applyReport(m, batch("agent1", [{ t: "cache", host: "lab1", file: "the_great_work.cache", message: "", karmaLoss: 0 }]), 1);
    expect(m.income.cachesOpened).toBe(1);
    expect(m.income.augsAwarded).toBe(1);
    expect(m.cells["lab1"].cacheSeen).toBe(false);
  });

  it("ramfreed updates blockedRam and sets cacheSeen once the block is cleared", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("h1", { blockedRam: 10 })]), 1);
    applyReport(m, batch("agent1", [{ t: "ramfreed", host: "h1", remaining: 3 }]), 2);
    expect(m.cells["h1"].details?.blockedRam).toBe(3);
    expect(m.cells["h1"].cacheSeen).toBe(false);
    applyReport(m, batch("agent1", [{ t: "ramfreed", host: "h1", remaining: 0 }]), 3);
    expect(m.cells["h1"].cacheSeen).toBe(true);
  });

  it("phish adds money to income and flags a cache", () => {
    const m = createModel(0);
    applyReport(m, batch("agent1", [{ t: "phish", host: "h1", money: 500, cache: true }]), 1);
    expect(m.income.money).toBe(500);
    expect(m.cells["h1"].cacheSeen).toBe(true);
  });
});

describe("applyReport: contract / storm-seed", () => {
  it("returns contracts and tallies contractsFound", () => {
    const m = createModel(0);
    const result = applyReport(m, batch("agent1", [{ t: "contract", host: "h1", file: "x.cct" }]), 1);
    expect(result.contracts).toEqual([{ host: "h1", file: "x.cct" }]);
    expect(m.income.contractsFound).toBe(1);
  });

  it("records the storm seed host", () => {
    const m = createModel(0);
    applyReport(m, batch("agent1", [{ t: "storm-seed", host: "h1" }]), 1);
    expect(m.stormSeedHost).toBe("h1");
  });
});

describe("applyReport: error", () => {
  it("increments attempts and flips a frontier host to cracking", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("h1", { hasAdmin: false })]), 1);
    applyReport(m, batch("agent1", [{ t: "error", host: "h1", op: "authenticate", code: CODE.AuthFailure, message: "" }]), 2);
    expect(m.cells["h1"].attempts).toBe(1);
    expect(m.cells["h1"].state).toBe("cracking");
  });

  it("does not count NotEnoughCharisma against the attempt budget", () => {
    const m = createModel(0);
    applyReport(m, batch("agent1", [{ t: "error", host: "h1", op: "heartbleed", code: CODE.NotEnoughCharisma, message: "" }]), 1);
    expect(m.cells["h1"].attempts).toBe(0);
  });
});

describe("applyReport: lab", () => {
  it("records grid/moves/cleared under the synced lab name, and vaults a finishing password", () => {
    const m = createModel(0);
    m.lab = { name: "th3_l4byr1nth", runner: null, grid: null, moves: 0, cleared: false, password: null };
    applyReport(m, batch("walker1", [{ t: "lab", host: "walker1", grid: ["#", "."], pos: [1, 1], moves: 12, cleared: false }]), 1);
    expect(m.lab.runner).toBe("walker1");
    expect(m.lab.moves).toBe(12);

    const result = applyReport(m, batch("walker1", [{ t: "lab", host: "walker1", grid: ["#"], pos: [2, 2], moves: 20, cleared: true, password: "labpw" }]), 2);
    expect(m.lab.cleared).toBe(true);
    expect(m.vault.entries["th3_l4byr1nth"].password).toBe("labpw");
    expect(result.vaultChanged).toBe(true);
  });
});

describe("applyReport: starts the income clock", () => {
  it("sets income.since on the first report, so moneyPerHour reflects money earned since then", () => {
    const m = createModel(0);
    expect(m.income.since).toBe(0);

    const t0 = 1000;
    applyReport(m, batch("agent1", [{ t: "phish", host: "h1", money: 3600, cache: false }]), t0);
    expect(m.income.since).toBe(t0);

    const instability = { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0 };
    const status = toStatus(m, DEFAULT_CONFIG, player, noAccess, instability, t0 + 3_600_000);
    expect(status.income.moneyPerHour).toBe(3600);
  });

  it("does not reset the clock on later reports", () => {
    const m = createModel(0);
    applyReport(m, batch("agent1", [{ t: "phish", host: "h1", money: 100, cache: false }]), 1000);
    applyReport(m, batch("agent1", [{ t: "phish", host: "h1", money: 100, cache: false }]), 5000);
    expect(m.income.since).toBe(1000);
  });
});

// === refreshFromDetails ===

describe("refreshFromDetails", () => {
  it("tombstones an offline host and clears its edges", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("h1", {}, ["h1"])]), 1);
    expect(m.edges.size).toBeGreaterThan(0);
    refreshFromDetails(m, "h1", details({ isOnline: false }), 2, DEFAULT_CONFIG);
    expect(m.cells["h1"].state).toBe("offline");
    expect(neighboursOf(m, "h1")).toEqual([]);
  });

  it("resets attempts/vault/edges on a recycled fingerprint", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("h1", { difficulty: 5 })]), 1);
    m.vault.entries["h1"] = { password: "old", fingerprint: { difficulty: 5, modelId: "ZeroLogon", passwordLength: 0 }, seenAt: 1 };
    const result = refreshFromDetails(m, "h1", details({ difficulty: 9 }), 2, DEFAULT_CONFIG);
    expect(result.vaultChanged).toBe(true);
    expect(m.cells["h1"].attempts).toBe(0);
    expect(m.vault.entries["h1"]).toBeUndefined();
  });

  it("marks a stasis-linked admin host as anchor", () => {
    const m = createModel(0);
    m.stasisHosts.push("h1");
    refreshFromDetails(m, "h1", details({ hasAdmin: true }), 1, DEFAULT_CONFIG);
    expect(m.cells["h1"].state).toBe("anchor");
  });

  it("demotes a resident agent once its heartbeat has timed out", () => {
    const m = createModel(0);
    applyReport(m, batch("h1", []), 1000);
    expect(m.cells["h1"].state).toBe("agent");
    refreshFromDetails(m, "h1", details({ hasAdmin: true }), 1000 + DEFAULT_CONFIG.agentIntervalMs * 3 + 1, DEFAULT_CONFIG);
    expect(m.cells["h1"].state).toBe("admin");
    expect(m.cells["h1"].agentPid).toBe(0);
  });

  it("keeps a fresh resident agent as agent", () => {
    const m = createModel(0);
    applyReport(m, batch("h1", []), 1000);
    refreshFromDetails(m, "h1", details({ hasAdmin: true }), 1500, DEFAULT_CONFIG);
    expect(m.cells["h1"].state).toBe("agent");
  });
});

// === charismaNeed ===

describe("charismaNeed", () => {
  it("returns null when nothing is gated", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("h1", { requiredCharismaSkill: 10 })]), 1);
    expect(charismaNeed(m, { charisma: 50, karma: 0 }, noAccess)).toBeNull();
  });

  it("targets the lowest gate above the player's charisma and counts unlocks at that gate", () => {
    const m = createModel(0);
    applyReport(m, batch("prober1", [seenEvent("h1", { requiredCharismaSkill: 100 })]), 1);
    applyReport(m, batch("prober2", [seenEvent("h2", { requiredCharismaSkill: 100 })]), 1);
    applyReport(m, batch("prober3", [seenEvent("h3", { requiredCharismaSkill: 200 })]), 1);

    const need = charismaNeed(m, { charisma: 50, karma: 0 }, noAccess);
    expect(need).toEqual({ target: 100, unlocks: 2, reason: "frontier" });
  });

  it("overrides with the lab's threshold when it is the lower ungated target", () => {
    const m = createModel(0);
    applyReport(m, batch("prober", [seenEvent("h1", { requiredCharismaSkill: 1000 })]), 1);
    const need = charismaNeed(m, { charisma: 50, karma: 0 }, { stasisLimit: 1, access: "full", labName: "th3_l4byr1nth" });
    expect(need).toEqual({ target: 300, unlocks: 0, reason: "lab" });
  });
});

// === selectCarriers ===

describe("selectCarriers", () => {
  it("is empty without full access", () => {
    const m = createModel(0);
    expect(selectCarriers(m, noAccess)).toEqual([]);
  });

  it("picks admin hosts in [gap-3, gap-1], excluding stationary and stasis-linked hosts", () => {
    const m = createModel(0);
    // deepest admin at depth 6 -> next gap row is 8 -> band is [5,7]
    setCell(m, "deep", "admin", { depth: 6, difficulty: 8 });
    setCell(m, "carrierOk", "admin", { depth: 5, difficulty: 7 });
    setCell(m, "tooShallow", "admin", { depth: 5, difficulty: 4 });
    setCell(m, "stationary", "admin", { depth: 5, difficulty: 7, isStationary: true });
    setCell(m, "anchored", "admin", { depth: 5, difficulty: 7 });
    m.stasisHosts.push("anchored");

    const carriers = selectCarriers(m, { stasisLimit: 1, access: "full", labName: "cru3l_l4byr1nth" });
    expect(carriers).toEqual(["carrierOk"]);
  });

  it("is empty once the next gap row is at or past the net's depth", () => {
    const m = createModel(0);
    setCell(m, "deep", "admin", { depth: 6, difficulty: 6 });
    // th3_l4byr1nth is depth 7, so the "next gap row" (8) is already >= netDepth.
    expect(selectCarriers(m, { stasisLimit: 1, access: "full", labName: "th3_l4byr1nth" })).toEqual([]);
  });
});

// === stasisPriority ===

describe("stasisPriority", () => {
  it("returns [] when the limit is 0", () => {
    const m = createModel(0);
    expect(stasisPriority(m, DEFAULT_CONFIG, { stasisLimit: 0, access: "full", labName: null }, 0)).toEqual([]);
  });

  it("manual mode echoes manualStasis truncated to the limit", () => {
    const m = createModel(0);
    m.manualStasis = ["a", "b", "c"];
    const cfg: DarknetConfig = { ...DEFAULT_CONFIG, stasisMode: "manual" };
    expect(stasisPriority(m, cfg, { stasisLimit: 2, access: "full", labName: null }, 0)).toEqual(["a", "b"]);
  });

  it("excludes an agent host whose RAM is too small for the stasis worker (16 GB)", () => {
    const m = createModel(0);
    agentCell(m, "small", { maxRam: 16 });
    m.edges.add(edgeKey("small", "darkweb"));
    expect(stasisPriority(m, DEFAULT_CONFIG, { stasisLimit: 1, access: "basic", labName: null }, 0)).toEqual([]);
  });

  it("includes an agent host with just enough RAM (20 GB)", () => {
    const m = createModel(0);
    agentCell(m, "fits", { maxRam: 20 });
    m.edges.add(edgeKey("fits", "darkweb"));
    expect(stasisPriority(m, DEFAULT_CONFIG, { stasisLimit: 1, access: "basic", labName: null }, 0)).toEqual(["fits"]);
  });

  it("prefers the deepest agent host adjacent to the lab first", () => {
    const m = createModel(0);
    agentCell(m, "labNeighbour", { maxRam: 32, depth: 6 });
    m.edges.add(edgeKey("labNeighbour", "th3_l4byr1nth"));
    agentCell(m, "elsewhere", { maxRam: 32, depth: 7 });

    const picks = stasisPriority(m, DEFAULT_CONFIG, { stasisLimit: 1, access: "full", labName: "th3_l4byr1nth" }, 0);
    expect(picks).toEqual(["labNeighbour"]);
  });

  it("falls back to a darkweb-adjacent host when nothing else qualifies", () => {
    const m = createModel(0);
    agentCell(m, "atDarkweb", { maxRam: 32 });
    m.edges.add(edgeKey("atDarkweb", "darkweb"));
    const picks = stasisPriority(m, DEFAULT_CONFIG, { stasisLimit: 1, access: "basic", labName: null }, 0);
    expect(picks).toEqual(["atDarkweb"]);
  });

  it("keeps an existing online anchor unless a pick is >=2 rows deeper", () => {
    const m = createModel(0);
    agentCell(m, "oldAnchor", { maxRam: 32, depth: 3 });
    m.stasisHosts.push("oldAnchor");

    // No fresh candidate at all: oldAnchor should be kept.
    let picks = stasisPriority(m, DEFAULT_CONFIG, { stasisLimit: 1, access: "basic", labName: null }, 0);
    expect(picks).toEqual(["oldAnchor"]);

    // A darkweb-adjacent candidate 2+ rows deeper replaces it.
    agentCell(m, "deeper", { maxRam: 32, depth: 5 });
    m.edges.add(edgeKey("deeper", "darkweb"));
    picks = stasisPriority(m, DEFAULT_CONFIG, { stasisLimit: 1, access: "basic", labName: null }, 0);
    expect(picks).toEqual(["deeper"]);
  });

  it("keeps a real state-\"anchor\" existing link unless a fresh candidate is >=2 rows deeper", () => {
    // Unlike the fixture above, this uses the actual state a currently-linked
    // host carries in production (applyReport/refreshFromDetails set "anchor"
    // from m.stasisHosts membership) rather than "agent", so it exercises the
    // real candidates-filter bug directly.
    const m = createModel(0);
    setCell(m, "oldAnchor", "anchor", { maxRam: 32, depth: 3 });
    m.stasisHosts.push("oldAnchor");
    const limits: Limits = { stasisLimit: 1, access: "basic", labName: null };

    // A fresh candidate only 1 row deeper must not evict the anchor.
    agentCell(m, "close", { maxRam: 32, depth: 4 });
    m.edges.add(edgeKey("close", "darkweb"));
    expect(stasisPriority(m, DEFAULT_CONFIG, limits, 0)).toEqual(["oldAnchor"]);

    // A fresh candidate >=2 rows deeper does replace it.
    m.edges.delete(edgeKey("close", "darkweb"));
    agentCell(m, "far", { maxRam: 32, depth: 5 });
    m.edges.add(edgeKey("far", "darkweb"));
    expect(stasisPriority(m, DEFAULT_CONFIG, limits, 0)).toEqual(["far"]);
  });

  it("does not let one existing anchor's own reselection count as eviction evidence against another anchor", () => {
    const m = createModel(0);
    const limits: Limits = { stasisLimit: 2, access: "full", labName: "cru3l_l4byr1nth" }; // netDepth 12
    setCell(m, "shallow", "anchor", { maxRam: 32, depth: 3 });
    m.stasisHosts.push("shallow");
    m.edges.add(edgeKey("shallow", "darkweb"));
    // "deep" is itself an existing anchor, picked fresh again via the gap band.
    setCell(m, "deep", "anchor", { maxRam: 32, depth: 10 });
    m.stasisHosts.push("deep");

    // Only 1 row deeper than "shallow" - must not evict it, even though "deep"
    // (an existing anchor, >=2 rows deeper than "shallow") also shows up in
    // the fresh slate for the unrelated gap-band slot.
    agentCell(m, "newcomer", { maxRam: 32, depth: 4 });
    m.edges.add(edgeKey("newcomer", "darkweb"));

    const picks = stasisPriority(m, DEFAULT_CONFIG, limits, 0);
    expect([...picks].sort()).toEqual(["deep", "shallow"]);
  });

  it("picks the deepest host from the band just past a crossed gap, not the band before it", () => {
    const m = createModel(0);
    // Admin at depth 9 proves gap row 8 has been crossed.
    setCell(m, "pastGapAdmin", "admin", { depth: 9, difficulty: 9 });
    // Sits in the OLD (wrong) band (0,8]; must not be picked.
    agentCell(m, "beforeGap", { maxRam: 32, depth: 7 });
    // Sits in the correct band (8,16]; must be picked.
    agentCell(m, "afterGap", { maxRam: 32, depth: 12 });

    const picks = stasisPriority(m, DEFAULT_CONFIG, { stasisLimit: 1, access: "full", labName: "m3rc1l3ss_l4byr1nth" }, 0);
    expect(picks).toEqual(["afterGap"]);
  });
});

// === computePolicy ===

describe("computePolicy", () => {
  it("publishes workers only for agent/anchor-state hosts", () => {
    const m = createModel(0);
    agentCell(m, "resident", { maxRam: 32 });
    setCell(m, "adminOnly", "admin", { hasAdmin: true });

    const policy = computePolicy(m, DEFAULT_CONFIG, player, noAccess, 0);
    expect(Object.keys(policy.workers)).toEqual(["resident"]);
  });

  it("sizes phishThreads from free RAM after the agent and any other reserved workers", () => {
    const m = createModel(0);
    agentCell(m, "host1", { maxRam: 32, blockedRam: 5 });
    const cfg: DarknetConfig = { ...DEFAULT_CONFIG, phishMaxThreads: 1000 };
    const policy = computePolicy(m, cfg, player, noAccess, 0);
    // reserved = agent(6.25) + harvest(4.9) = 11.15; free = 32-11.15=20.85; /3.6 = 5.79 -> 5
    expect(policy.workers["host1"].phishThreads).toBe(5);
  });

  it("caps phishThreads at phishMaxThreads", () => {
    const m = createModel(0);
    agentCell(m, "host1", { maxRam: 1000 });
    const policy = computePolicy(m, DEFAULT_CONFIG, player, noAccess, 0);
    expect(policy.workers["host1"].phishThreads).toBeLessThanOrEqual(DEFAULT_CONFIG.phishMaxThreads);
  });

  it("echoes the vault and top-level config into the policy", () => {
    const m = createModel(0);
    m.vault.entries["h1"] = { password: "pw", fingerprint: { difficulty: 1, modelId: "ZeroLogon", passwordLength: 0 }, seenAt: 1 };
    const policy = computePolicy(m, DEFAULT_CONFIG, player, noAccess, 1234);
    expect(policy.version).toBe(AGENT_VERSION);
    expect(policy.vault).toEqual(m.vault.entries);
    expect(policy.charisma).toBe(player.charisma);
    expect(policy.publishedAt).toBe(1234);
  });

  it("arms a 30s pause then fires the storm on the seed host, once", () => {
    const m = createModel(0);
    agentCell(m, "seedHost", { maxRam: 32 });
    m.stormSeedHost = "seedHost";
    m.stormPending = true;

    let policy = computePolicy(m, DEFAULT_CONFIG, player, noAccess, 0);
    expect(policy.pause).toBe(true);
    expect(policy.workers["seedHost"].storm).toBe(false);

    policy = computePolicy(m, DEFAULT_CONFIG, player, noAccess, 29_999);
    expect(policy.pause).toBe(true);
    expect(policy.workers["seedHost"].storm).toBe(false);

    policy = computePolicy(m, DEFAULT_CONFIG, player, noAccess, 30_000);
    expect(policy.pause).toBe(false);
    expect(policy.workers["seedHost"].storm).toBe(true);
    expect(m.stormPending).toBe(false);

    // Fires only once; the next tick is back to normal.
    policy = computePolicy(m, DEFAULT_CONFIG, player, noAccess, 30_001);
    expect(policy.workers["seedHost"].storm).toBe(false);
  });

  it("sets heartbleedUsedThisNode once an agent is alive under a heartbleed-enabled config", () => {
    const m = createModel(0);
    expect(m.heartbleedUsedThisNode).toBe(false);
    agentCell(m, "h1", { maxRam: 32 });
    computePolicy(m, DEFAULT_CONFIG, player, noAccess, 0);
    expect(m.heartbleedUsedThisNode).toBe(true);
  });

  it("requests a stasis link (true) then clears it (false) as targets change", () => {
    const m = createModel(0);
    agentCell(m, "host1", { maxRam: 32 });
    const limits: Limits = { stasisLimit: 1, access: "basic", labName: null };
    m.edges.add(edgeKey("host1", "darkweb"));

    let policy = computePolicy(m, DEFAULT_CONFIG, player, limits, 0);
    expect(policy.workers["host1"].stasis).toBe(true);

    m.stasisHosts.push("host1");
    m.edges.delete(edgeKey("host1", "darkweb")); // no longer a valid auto candidate
    policy = computePolicy(m, DEFAULT_CONFIG, player, { ...limits, stasisLimit: 0 }, 0);
    expect(policy.workers["host1"].stasis).toBe(false);
  });

  it("gates harvest on player.karma meeting harvestKarmaFloor even when blockedRam > 0", () => {
    const m = createModel(0);
    agentCell(m, "host1", { maxRam: 32, blockedRam: 5 });
    const cfg: DarknetConfig = { ...DEFAULT_CONFIG, harvestKarmaFloor: -50 };

    let policy = computePolicy(m, cfg, { charisma: 50, karma: -100 }, noAccess, 0);
    expect(policy.workers["host1"].harvest).toBe(false);

    policy = computePolicy(m, cfg, { charisma: 50, karma: -50 }, noAccess, 0);
    expect(policy.workers["host1"].harvest).toBe(true);
  });

  it("does not reserve stasis RAM when sizing phishThreads (dnet-stasis is one-shot and frees RAM on exit)", () => {
    const m = createModel(0);
    agentCell(m, "host1", { maxRam: 32 });
    m.edges.add(edgeKey("host1", "darkweb"));
    const cfg: DarknetConfig = { ...DEFAULT_CONFIG, phishMaxThreads: 1000 };
    const limits: Limits = { stasisLimit: 1, access: "basic", labName: null };

    const policy = computePolicy(m, cfg, player, limits, 0);
    expect(policy.workers["host1"].stasis).toBe(true); // wants a fresh link this tick
    // reserved = agent(6.25) only (no harvest: blockedRam 0, no cache; no charge/lab).
    // free = 32 - 6.25 = 25.75; /3.6 = 7.15 -> 7. The buggy version also
    // reserved stasis(13.6) here, giving free = 12.15 -> 3 threads.
    expect(policy.workers["host1"].phishThreads).toBe(7);
  });

  describe("auto-storm gate", () => {
    // netDepth 12 (cru3l_l4byr1nth) so the first gap row (8) is reachable and
    // "stuck" can actually trip, unlike th3_l4byr1nth's netDepth of 7.
    const stormLimits: Limits = { stasisLimit: 1, access: "full", labName: "cru3l_l4byr1nth" };

    it("does not auto-arm, or livelock, when stuck but no real storm-seed host has reported", () => {
      const m = createModel(0);
      const cfg: DarknetConfig = { ...DEFAULT_CONFIG, storm: "auto", gapPatienceMs: 0 };
      // A single stasis-linked anchor: it both trips "stuck" (an admin host at
      // the gap edge) and is excluded from carrier selection (already
      // stasis-linked), and its own fresh reselection satisfies "every
      // desired stasis link is placed".
      setCell(m, "anchor1", "anchor", { maxRam: 32, depth: 7 });
      m.stasisHosts.push("anchor1");
      m.edges.add(edgeKey("anchor1", "darkweb"));

      let policy = computePolicy(m, cfg, player, stormLimits, 1000);
      expect(policy.pause).toBe(false);
      expect(m.stormPending).toBe(false);

      // A second tick must not toggle pause on/off (no arm/resolve/re-arm loop).
      policy = computePolicy(m, cfg, player, stormLimits, 2000);
      expect(policy.pause).toBe(false);
      expect(m.stormPending).toBe(false);
    });

    it("does not auto-arm when the desired stasis link is picked but not yet actually placed", () => {
      const m = createModel(0);
      const cfg: DarknetConfig = { ...DEFAULT_CONFIG, storm: "auto", gapPatienceMs: 0 };
      // Qualifies as the fresh darkweb-adjacent pick (desired), but is NOT in
      // m.stasisHosts yet (not actually placed). difficulty kept out of the
      // carrier band [5,7] so it doesn't also become a migration target.
      agentCell(m, "candidate1", { maxRam: 32, depth: 7, difficulty: 20 });
      m.edges.add(edgeKey("candidate1", "darkweb"));
      m.stormSeedHost = "seedHost";
      agentCell(m, "seedHost", { maxRam: 32, difficulty: 20 });

      const policy = computePolicy(m, cfg, player, stormLimits, 1000);
      expect(policy.pause).toBe(false);
      expect(m.stormPending).toBe(false);
    });

    it("auto-arms once stuck, a real seed exists, and every desired stasis link is placed, then fires once", () => {
      const m = createModel(0);
      const cfg: DarknetConfig = { ...DEFAULT_CONFIG, storm: "auto", gapPatienceMs: 0 };
      setCell(m, "anchor1", "anchor", { maxRam: 32, depth: 7 });
      m.stasisHosts.push("anchor1");
      m.edges.add(edgeKey("anchor1", "darkweb"));
      m.stormSeedHost = "seedHost";
      agentCell(m, "seedHost", { maxRam: 32, difficulty: 20 });

      let policy = computePolicy(m, cfg, player, stormLimits, 1000);
      expect(m.stormPending).toBe(true);
      expect(policy.pause).toBe(true);
      expect(policy.workers["seedHost"].storm).toBe(false);

      policy = computePolicy(m, cfg, player, stormLimits, 1000 + 29_999);
      expect(policy.pause).toBe(true);

      policy = computePolicy(m, cfg, player, stormLimits, 1000 + 30_000);
      expect(policy.pause).toBe(false);
      expect(policy.workers["seedHost"].storm).toBe(true);
      expect(m.stormPending).toBe(false);
    });

    it("does not arm the pause for a manually-requested storm while no seed host exists", () => {
      const m = createModel(0);
      const cfg: DarknetConfig = { ...DEFAULT_CONFIG, storm: "manual" };
      m.stormPending = true; // e.g. requested via the control port
      expect(m.stormSeedHost).toBeNull();

      const policy = computePolicy(m, cfg, player, noAccess, 0);
      expect(policy.pause).toBe(false);
      expect(m.stormPending).toBe(true); // left pending until a seed appears
    });
  });
});

// === toStatus ===

describe("toStatus", () => {
  const instability = { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0 };

  it("tallies counts by state and computes deepestAdmin", () => {
    const m = createModel(0);
    agentCell(m, "agentHost", { maxRam: 32, depth: 4 });
    setCell(m, "adminHost", "admin", { hasAdmin: true, depth: 6 });
    setCell(m, "frontierHost", "frontier", { hasAdmin: false, requiredCharismaSkill: 999, depth: 2 });
    refreshFromDetails(m, "offlineHost", details({ isOnline: false }), 1, DEFAULT_CONFIG);

    const status = toStatus(m, DEFAULT_CONFIG, player, noAccess, instability, 1);
    expect(status.counts.agents).toBe(1);
    expect(status.counts.admin).toBe(2); // agentHost + adminHost
    expect(status.counts.frontier).toBe(1);
    expect(status.counts.blocked).toBe(1);
    expect(status.counts.offline).toBe(1);
    expect(status.deepestAdmin).toBe(6);
  });

  it("computes moneyPerHour from income and elapsed time, 0 before income starts", () => {
    const m = createModel(0);
    expect(toStatus(m, DEFAULT_CONFIG, player, noAccess, instability, 0).income.moneyPerHour).toBe(0);

    m.income.since = 0;
    m.income.money = 3600;
    // since === 0 means "not started" per the model's own convention.
    expect(toStatus(m, DEFAULT_CONFIG, player, noAccess, instability, 3_600_000).income.moneyPerHour).toBe(0);

    m.income.since = 1000;
    const status = toStatus(m, DEFAULT_CONFIG, player, noAccess, instability, 1000 + 3_600_000);
    expect(status.income.moneyPerHour).toBe(3600);
  });

  it("groups the map into rows by depth, sorted by hostname within a row", () => {
    const m = createModel(0);
    setCell(m, "b1", "frontier", { depth: 2 });
    setCell(m, "a1", "frontier", { depth: 2 });
    setCell(m, "c1", "frontier", { depth: 1 });

    const status = toStatus(m, DEFAULT_CONFIG, player, noAccess, instability, 1);
    expect(status.map.rows.map((row) => row.map((c) => c.host))).toEqual([["c1"], ["a1", "b1"]]);
  });

  it("reports netDepth 5 without full access, and the lab's depth with it", () => {
    const m = createModel(0);
    expect(toStatus(m, DEFAULT_CONFIG, player, noAccess, instability, 0).netDepth).toBe(5);
    expect(toStatus(m, DEFAULT_CONFIG, player, fullAccess, instability, 0).netDepth).toBe(7);
  });

  it("augPending is false once the lab clears but before the aug is awarded, true once it is (awaiting install)", () => {
    const m = createModel(0);
    m.lab = { name: "th3_l4byr1nth", runner: null, grid: null, moves: 0, cleared: false, password: null };

    // The walker finishes the maze: cleared flips true, but nothing has been
    // awarded/opened yet.
    applyReport(m, batch("walker1", [{ t: "lab", host: "walker1", grid: ["#"], pos: [1, 1], moves: 30, cleared: true }]), 1);
    let status = toStatus(m, DEFAULT_CONFIG, player, fullAccess, instability, 1);
    expect(status.lab?.cleared).toBe(true);
    expect(status.lab?.augPending).toBe(false);

    // The great-work cache gets opened: the aug is now awarded and awaits install.
    applyReport(m, batch("agent1", [{ t: "cache", host: "th3_l4byr1nth", file: "the_great_work.cache", message: "", karmaLoss: 0 }]), 2);
    status = toStatus(m, DEFAULT_CONFIG, player, fullAccess, instability, 2);
    expect(status.lab?.augPending).toBe(true);
  });
});
