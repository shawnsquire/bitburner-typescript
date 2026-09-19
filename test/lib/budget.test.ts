import { describe, it, expect } from "vitest";
import {
  getBudgetBalance,
  canAfford,
  notifyPurchase,
  signalDone,
  reactivateBucket,
  setBudgetWeight,
  reportCap,
} from "/lib/budget";
import { STATUS_PORTS, BUDGET_CONTROL_PORT, BudgetStatus, BudgetControlMessage } from "/types/ports";
import { mockNS } from "../helpers/mock-ns";

function seedBudgetStatus(ns: ReturnType<typeof mockNS>, buckets: BudgetStatus["buckets"]): void {
  const status: Partial<BudgetStatus> = { buckets };
  ns.getPortHandle(STATUS_PORTS.budget).write(JSON.stringify({ ...status, _publishedAt: Date.now() }));
}

function readControlMessages(ns: ReturnType<typeof mockNS>): BudgetControlMessage[] {
  const handle = ns.getPortHandle(BUDGET_CONTROL_PORT);
  const out: BudgetControlMessage[] = [];
  while (!handle.empty()) {
    out.push(JSON.parse(handle.read() as string));
  }
  return out;
}

describe("getBudgetBalance", () => {
  it("returns Infinity when the budget daemon isn't publishing status", () => {
    expect(getBudgetBalance(mockNS(), "stocks")).toBe(Infinity);
  });

  it("returns Infinity for a bucket the budget daemon doesn't know about", () => {
    const ns = mockNS();
    seedBudgetStatus(ns, {});
    expect(getBudgetBalance(ns, "stocks")).toBe(Infinity);
  });

  it("returns the published allowance for a known bucket", () => {
    const ns = mockNS();
    seedBudgetStatus(ns, {
      stocks: { bucket: "stocks", allowance: 12345 } as BudgetStatus["buckets"][string],
    });
    expect(getBudgetBalance(ns, "stocks")).toBe(12345);
  });
});

describe("canAfford", () => {
  it("is always true when the budget daemon is absent (graceful fallback)", () => {
    expect(canAfford(mockNS(), "stocks", 1_000_000_000_000)).toBe(true);
  });

  it("compares the requested amount against the bucket's allowance", () => {
    const ns = mockNS();
    seedBudgetStatus(ns, {
      stocks: { bucket: "stocks", allowance: 1000 } as BudgetStatus["buckets"][string],
    });
    expect(canAfford(ns, "stocks", 999)).toBe(true);
    expect(canAfford(ns, "stocks", 1000)).toBe(true);
    expect(canAfford(ns, "stocks", 1001)).toBe(false);
  });
});

describe("notifyPurchase", () => {
  it("writes a 'purchased' control message with the bucket, amount, and reason", () => {
    const ns = mockNS();
    notifyPurchase(ns, "hacknet", 5000, "New node");
    expect(readControlMessages(ns)).toEqual([
      { action: "purchased", bucket: "hacknet", amount: 5000, reason: "New node" },
    ]);
  });
});

describe("signalDone", () => {
  it("writes a persistent marker file and a 'done' control message", () => {
    const ns = mockNS();
    signalDone(ns, "wse-access");
    expect(ns._files.get("/data/budget-done.txt")).toBe("wse-access");
    expect(readControlMessages(ns)).toEqual([{ action: "done", bucket: "wse-access" }]);
  });

  it("does not duplicate an already-marked bucket in the marker file", () => {
    const ns = mockNS({ files: { "/data/budget-done.txt": "wse-access" } });
    signalDone(ns, "wse-access");
    expect(ns._files.get("/data/budget-done.txt")).toBe("wse-access");
  });

  it("appends additional buckets to the marker file", () => {
    const ns = mockNS({ files: { "/data/budget-done.txt": "wse-access" } });
    signalDone(ns, "programs");
    expect(ns._files.get("/data/budget-done.txt")).toBe("wse-access\nprograms");
  });
});

describe("reactivateBucket", () => {
  it("removes the bucket from the marker file and sends a reactivate message", () => {
    const ns = mockNS({ files: { "/data/budget-done.txt": "wse-access\nprograms" } });
    reactivateBucket(ns, "wse-access");
    expect(ns._files.get("/data/budget-done.txt")).toBe("programs");
    expect(readControlMessages(ns)).toEqual([{ action: "reactivate", bucket: "wse-access" }]);
  });

  it("is a no-op on the marker file when nothing was marked done", () => {
    const ns = mockNS();
    reactivateBucket(ns, "wse-access");
    expect(ns._files.has("/data/budget-done.txt")).toBe(false);
  });
});

describe("setBudgetWeight", () => {
  it("writes an update-weight control message", () => {
    const ns = mockNS();
    setBudgetWeight(ns, "gang", 0);
    expect(readControlMessages(ns)).toEqual([{ action: "update-weight", bucket: "gang", weight: 0 }]);
  });
});

describe("reportCap", () => {
  it("writes a report-cap control message with the remaining cost", () => {
    const ns = mockNS();
    reportCap(ns, "hacknet", 42_000);
    expect(readControlMessages(ns)).toEqual([{ action: "report-cap", bucket: "hacknet", cap: 42_000 }]);
  });
});
