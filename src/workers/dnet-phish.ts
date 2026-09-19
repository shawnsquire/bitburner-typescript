/**
 * Darknet Phishing Worker
 *
 * Runs `ns.dnet.phishingAttack()` in a loop on its own host
 * (docs/design/2026-09-19-darknet.md Section 5). The call scales its money
 * and charisma XP reward off the calling script's own thread count
 * (`handlePhishingAttack`, `src/DarkNet/effects/phishing.ts`), which is set
 * by the agent's `ns.run(..., {threads: policy.workers[self].phishThreads})`
 * -- there is no thread argument to pass here.
 *
 * The reward is only visible in the result's `message` string, parsed by
 * the pure `parsePhishResult` below. Totals are batched home every
 * `BATCH_INTERVAL` calls, or immediately on a cache hit since those are
 * rare and worth surfacing right away. `peekPolicy` is 0 GB, so the policy
 * is re-checked every call to exit promptly once the coordinator zeroes
 * this host's `phishThreads` or restarts the agent bundle.
 *
 * Usage: run workers/dnet-phish.js <self>
 */
import type { NS } from "@ns";
import { AGENT_VERSION, ReportBatch } from "/lib/darknet/protocol";
import { peekPolicy, tryWriteBatch } from "/lib/darknet/wire";

/** Calls between batched `phish` reports, absent an earlier cache hit. */
const BATCH_INTERVAL = 10;

const MONEY_SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
const MONEY_RE = /^Phishing attack succeeded! \$([\d.]+)([kmbt]?) retrieved\./;
const CACHE_RE = /^Phishing attack succeeded! Found a cache file\./;

/**
 * Parse the game's phishing result message into the reward it describes.
 * Money amounts are rendered with `formatNumber`, so they may carry a
 * k/m/b/t suffix (e.g. "1.23k", "4.5m", "12b", "3t") or none at all below
 * 1000. A non-success or unrecognised message yields no reward.
 */
export function parsePhishResult(message: string): { money: number; cache: boolean } {
  if (CACHE_RE.test(message)) return { money: 0, cache: true };

  const match = message.match(MONEY_RE);
  if (match) {
    const amount = Number(match[1]);
    if (!Number.isNaN(amount)) {
      const scale = MONEY_SCALE[match[2]] ?? 1;
      return { money: amount * scale, cache: false };
    }
  }

  return { money: 0, cache: false };
}

// RAM budget (pinned, not tiered): base 1.6 + phishingAttack 2 = 3.6
// (measured with `npm run ram -- workers/dnet-phish.js`).
/** @ram 3.6 */
export function main(ns: NS): Promise<void> {
  ns.ramOverride(3.6);
  return phishLoop(ns);
}

async function phishLoop(ns: NS): Promise<void> {
  const self = ns.args[0] as string;

  let money = 0;
  let cache = false;
  let sinceReport = 0;

  for (;;) {
    const result = await ns.dnet.phishingAttack();
    const parsed = parsePhishResult(result.message);
    money += parsed.money;
    cache = cache || parsed.cache;
    sinceReport++;

    if (parsed.cache || sinceReport >= BATCH_INTERVAL) {
      sendReport(ns, self, money, cache);
      money = 0;
      cache = false;
      sinceReport = 0;
    }

    const policy = peekPolicy(ns);
    if (!policy || policy.version !== AGENT_VERSION || !policy.workers[self]?.phishThreads) {
      if (sinceReport > 0) sendReport(ns, self, money, cache);
      return;
    }
  }
}

function sendReport(ns: NS, self: string, money: number, cache: boolean): void {
  const batch: ReportBatch = {
    from: self,
    pid: ns.pid,
    depth: 0,
    at: Date.now(),
    events: [{ t: "phish", host: self, money, cache }],
  };
  tryWriteBatch(ns, batch);
}
