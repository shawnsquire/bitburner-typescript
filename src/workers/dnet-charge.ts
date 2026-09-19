/**
 * Darknet Migration-Charge Worker
 *
 * Repeatedly induces migration on a neighbouring carrier host, riding it
 * across an air gap (docs/design/2026-09-19-darknet.md Section 6). Keeps
 * calling until the induce fails, the coordinator drops the target from
 * `policy.migrationTargets` (the carrier moved past the gap, or the
 * coordinator retargeted), or the policy version changes underneath it.
 *
 * Usage: run workers/dnet-charge.js <self> <target>
 */
import type { NS } from "@ns";
import { AGENT_VERSION, ReportBatch } from "/lib/darknet/protocol";
import { peekPolicy, tryWriteBatch } from "/lib/darknet/wire";

/** @ram 5.6 */
export function main(ns: NS): Promise<void> {
  ns.ramOverride(5.6);
  return chargeLoop(ns);
}

async function chargeLoop(ns: NS): Promise<void> {
  const self = ns.args[0] as string;
  const target = ns.args[1] as string;

  for (;;) {
    const res = await ns.dnet.induceServerMigration(target);
    if (!res.success) {
      const batch: ReportBatch = {
        from: self,
        pid: ns.pid,
        depth: 0,
        at: Date.now(),
        events: [{ t: "error", host: self, op: "induceServerMigration", code: res.code, message: res.message }],
      };
      tryWriteBatch(ns, batch);
      break;
    }

    const policy = peekPolicy(ns);
    if (!policy || policy.version !== AGENT_VERSION || !policy.migrationTargets.includes(target)) break;
  }
}
