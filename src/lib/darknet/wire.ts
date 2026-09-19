/**
 * Darknet Port Wire Helpers
 *
 * The only darknet module allowed to touch `ns` — and only `ns.getPortHandle`
 * (0 GB), so it is safe to import from the coordinator, agents and workers
 * alike. Deliberately does not import `/lib/ports`: that module is not part
 * of the darknet bundle (see `DNET_BUNDLE` in protocol.ts), and its
 * `publishStatus`/`peekStatus` inject/expect `_publishedAt`, which the
 * `Policy` type does not use (it carries its own `publishedAt`).
 *
 * Import with: import { ... } from "/lib/darknet/wire";
 */
import type { NS } from "@ns";
import { DARKNET_POLICY_PORT, DARKNET_REPORT_PORT } from "/types/ports";
import { Policy, ReportBatch } from "/lib/darknet/protocol";

/**
 * Peek the current policy without consuming it. Returns null when the port
 * is empty or holds something that doesn't parse as JSON.
 */
export function peekPolicy(ns: NS): Policy | null {
  const handle = ns.getPortHandle(DARKNET_POLICY_PORT);
  const raw = handle.peek();
  if (raw === "NULL PORT DATA") return null;
  if (typeof raw !== "string") return null;

  try {
    return JSON.parse(raw) as Policy;
  } catch {
    return null;
  }
}

/**
 * Publish a new policy. Writes the new value first, then drains older
 * entries from the front, so a reader never observes an empty port between
 * updates (mirrors `publishStatus` in `/lib/ports`, reimplemented here since
 * that module is outside the darknet bundle).
 */
export function publishPolicy(ns: NS, policy: Policy): void {
  const handle = ns.getPortHandle(DARKNET_POLICY_PORT);
  const json = JSON.stringify(policy);
  handle.write(json);
  while (handle.peek() !== json) {
    handle.read();
  }
}

/** Append one report batch to the report queue. Non-blocking: false if the port is full. */
export function tryWriteBatch(ns: NS, batch: ReportBatch): boolean {
  return ns.getPortHandle(DARKNET_REPORT_PORT).tryWrite(JSON.stringify(batch));
}

/** Drain every pending report batch off the queue, skipping malformed entries. */
export function drainReports(ns: NS): ReportBatch[] {
  const handle = ns.getPortHandle(DARKNET_REPORT_PORT);
  const batches: ReportBatch[] = [];

  while (!handle.empty()) {
    const raw = handle.read();
    if (raw === "NULL PORT DATA") break;
    if (typeof raw !== "string") continue;

    try {
      batches.push(JSON.parse(raw) as ReportBatch);
    } catch {
      // skip malformed entry
    }
  }

  return batches;
}
