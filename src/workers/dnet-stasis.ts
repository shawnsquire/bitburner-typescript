/**
 * Darknet Stasis-Link Worker
 *
 * One-shot: applies or clears a stasis link on this host, the only host
 * `setStasisLink` accepts. Launched locally by `dnet-agent.js` per
 * `policy.workers[host].stasis` (see docs/design/2026-09-19-darknet.md
 * Section 6) and exits once the call resolves.
 *
 * Usage: run workers/dnet-stasis.js <self> <on|off>
 */
import type { NS } from "@ns";
import { ReportBatch } from "/lib/darknet/protocol";
import { tryWriteBatch } from "/lib/darknet/wire";

/** @ram 13.6 */
export function main(ns: NS): Promise<void> {
  ns.ramOverride(13.6);
  return applyStasis(ns);
}

async function applyStasis(ns: NS): Promise<void> {
  const self = ns.args[0] as string;

  const result = await ns.dnet.setStasisLink(ns.args[1] === "on");
  if (!result.success) {
    const batch: ReportBatch = {
      from: self,
      pid: ns.pid,
      depth: 0,
      at: Date.now(),
      events: [{ t: "error", host: self, op: "setStasisLink", code: result.code, message: result.message }],
    };
    tryWriteBatch(ns, batch);
  }
}
