/**
 * Darknet Harvest Worker
 *
 * Liberates a host's blocked RAM, opens its cache files, and surfaces
 * coding contracts and storm seeds it finds along the way
 * (docs/design/2026-09-19-darknet.md Section 5). Launched locally by
 * `dnet-agent.js` per `policy.workers[host].harvest`.
 *
 * `memoryReallocation` operates on the calling script's own host and scales
 * the RAM freed per call off the script's own thread count
 * (`getRamBlockRemoved`, `src/DarkNet/effects/ramblock.ts`), which is set by
 * the agent's `ns.run(..., {threads})` -- not an argument to the call. The
 * thread count the agent chose rides along as `ns.args[1]` for the agent's
 * own bookkeeping only; this worker never needs to read it back.
 *
 * A big block can take many rounds to clear (each round is a multi-second
 * `netscriptDelay`), so progress is reported as `ramfreed` periodically
 * during the loop, not just once it empties. `.cct` files are only
 * reported, never opened -- the coordinator forwards them to the contracts
 * daemon, which can't reach darknet hosts itself. `STORM_SEED.exe` is only
 * reported too; storms fire per policy, never from here.
 *
 * Usage: run workers/dnet-harvest.js <self> <threads>
 */
import type { NS } from "@ns";
import { CODE, ReportBatch, ReportEvent } from "/lib/darknet/protocol";
import { tryWriteBatch } from "/lib/darknet/wire";

/** Rounds between progress `ramfreed` reports while a big block is being cleared. */
const RAMFREED_REPORT_INTERVAL = 10;

// RAM budget (pinned, not tiered): base 1.6 + memoryReallocation 1 + openCache 2
// + ls 0.2 + fileExists 0.1 = 4.9 (measured with `npm run ram -- workers/dnet-harvest.js`).
/** @ram 4.9 */
export function main(ns: NS): Promise<void> {
  ns.ramOverride(4.9);
  return harvestLoop(ns);
}

async function harvestLoop(ns: NS): Promise<void> {
  const self = ns.args[0] as string;

  for (;;) {
    // 1. Reallocate this host's blocked RAM down to zero. Self-targeting
    // skips every checkDarknetServer admin/session gate (always authed to
    // our own host), so the only realistic failure here is the host
    // vanishing out from under this script (ServiceUnavailable) -- report
    // and give up on that rather than spinning against a host that's gone.
    let rounds = 0;
    for (;;) {
      const res = await ns.dnet.memoryReallocation();
      const remaining = ns.dnet.getBlockedRam();

      if (res.code === CODE.NoBlockRAM || remaining <= 0) {
        sendReport(ns, self, [{ t: "ramfreed", host: self, remaining }]);
        break;
      }

      if (!res.success) {
        sendReport(ns, self, [
          { t: "error", host: self, op: "memoryReallocation", code: res.code, message: res.message },
        ]);
        return;
      }

      rounds++;
      if (rounds % RAMFREED_REPORT_INTERVAL === 0) {
        sendReport(ns, self, [{ t: "ramfreed", host: self, remaining }]);
      }
      await ns.sleep(1000);
    }

    const events: ReportEvent[] = [];
    let openedAny = false;

    // 2. Open every cache file sitting on this host.
    for (const f of ns.ls(self, ".cache")) {
      try {
        const r = ns.dnet.openCache(f, true);
        events.push({ t: "cache", host: self, file: f, message: r.message, karmaLoss: r.karmaLoss });
        openedAny = true;
      } catch (e) {
        events.push({
          t: "error",
          host: self,
          op: "openCache",
          code: 0,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 3. Coding contracts on this host -- report only, the coordinator forwards them.
    for (const f of ns.ls(self, ".cct")) {
      events.push({ t: "contract", host: self, file: f });
    }

    // 4. A storm seed is fired per policy, never by this worker.
    if (ns.fileExists("STORM_SEED.exe", self)) {
      events.push({ t: "storm-seed", host: self });
    }

    sendReport(ns, self, events);

    // Exit once there's nothing left to do; the agent relaunches this worker
    // when a new cache or a fresh RAM block appears. If a cache is still
    // sitting there but nothing opened this pass (a persistently failing
    // file), stop anyway instead of hammering the report port forever -- the
    // agent's next tick will try again.
    const stillCached = ns.ls(self, ".cache").length > 0;
    if (ns.dnet.getBlockedRam() <= 0 && (!stillCached || !openedAny)) return;
  }
}

function sendReport(ns: NS, self: string, events: ReportEvent[]): void {
  const batch: ReportBatch = { from: self, pid: ns.pid, depth: 0, at: Date.now(), events };
  tryWriteBatch(ns, batch);
}
