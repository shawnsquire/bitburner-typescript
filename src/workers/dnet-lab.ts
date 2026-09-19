/**
 * Darknet Labyrinth Walker
 *
 * Walks the current labyrinth (`docs/design/2026-09-19-darknet.md` Section 7)
 * one `ns.dnet.authenticate(lab, dir)` at a time, building an explored-grid
 * model (`/lib/darknet/lab`) from the 3x3 view each move reveals. Every 20
 * moves once exploration has reached the bottom-right of what's known so
 * far, it pings `ns.dnet.labradar()` (7x7 view, 0 GB) for a longer look; a
 * spotted exit switches it to shortest-path mode. Progress (`grid`, `pos`,
 * `moves`) rides home in a `lab` report every 25 moves so a restarted walker
 * (new PID, so the game resets it to the entrance — position is tracked per
 * PID) can replay its way back to the frontier via known-open cells instead
 * of re-exploring from scratch.
 *
 * The charisma gate is detected by matching `message` (`isCharismaGap`), not
 * `code`: the game's own `code: NotEnoughCharisma` (451) never reaches this
 * script — `authenticate`'s labyrinth branch collapses every failure to 401.
 * A random `RequestTimeOut` (408, independent of the labyrinth logic) is
 * retried without touching the explored grid or spending a move; anything
 * else unparseable is reported as an `error` and ends the walk, rather than
 * guessing and poisoning `explored` with a false wall.
 *
 * Usage: run workers/dnet-lab.js <self> <labHost>
 */
import type { NS } from "@ns";
import { AGENT_VERSION, CODE, LAB_HOSTS, ReportBatch, ReportEvent } from "/lib/darknet/protocol";
import { peekPolicy, tryWriteBatch } from "/lib/darknet/wire";
import {
  Explored,
  allDirs,
  applyMove,
  boundingBox,
  deserializeGrid,
  emptyExplored,
  isCharismaGap,
  nextMove,
  parsePosition,
  parseRadar,
  parseView,
  serializeGrid,
} from "/lib/darknet/lab";

const RADAR_INTERVAL = 20;
const REPORT_INTERVAL = 25;

/** @ram 2.1 */
export function main(ns: NS): Promise<void> {
  ns.ramOverride(2.1);
  return labLoop(ns);
}

async function labLoop(ns: NS): Promise<void> {
  const self = ns.args[0] as string;
  const labHost = ns.args[1] as string;

  const policy = peekPolicy(ns);
  const explored: Explored = policy?.labGrid ? deserializeGrid(policy.labGrid) : emptyExplored();

  // Best-known guess for a fresh entry; corrected from the first response's
  // ground-truth message (offset-start labs randomise the real start).
  let pos: [number, number] = [1, 1];
  let moves = 0;
  let exitTarget: [number, number] | null = null;

  for (;;) {
    const dir = nextMove(explored, pos, exitTarget);
    if (!dir) {
      sendReport(ns, self, [labEvent(labHost, explored, pos, moves, false)]);
      return;
    }

    const res = await ns.dnet.authenticate(labHost, dir);

    if (res.success) {
      // handleLabyrinthPassword always sets data to the real password on
      // success (both the fresh-solve and already-admin branches) — but
      // don't let an unexpected shape here fall through to isCharismaGap /
      // parsePosition and get misreported as a gap or an error while the
      // lab is actually cleared; report cleared unconditionally and treat
      // the password as best-effort.
      const password = typeof res.data === "string" ? res.data : undefined;
      sendReport(ns, self, [labEvent(labHost, explored, pos, moves, true, password)]);
      return;
    }

    if (isCharismaGap(res)) {
      const required = LAB_HOSTS[labHost as keyof typeof LAB_HOSTS]?.cha ?? 0;
      sendReport(ns, self, [{ t: "gap", host: labHost, required }]);
      return;
    }

    if (res.code === CODE.RequestTimeOut) {
      // Transient darknet-instability timeout (unconditional on authenticate,
      // independent of the labyrinth logic) — no message/data to learn from,
      // and nothing moved. Retry the same move next iteration; don't mark a
      // wall or spend a move on it.
    } else {
      const newPos = parsePosition(res.message);
      if (!newPos) {
        // Not a move/bump, not a charisma gap, not a timeout: something this
        // walker doesn't recognise (e.g. lost direct connection to the lab
        // mid-walk). Report and stop rather than guessing at grid state.
        sendReport(ns, self, [{ t: "error", host: labHost, op: "authenticate", code: res.code, message: res.message }]);
        return;
      }

      const view = parseView(typeof res.data === "string" ? res.data : "");
      // The response's view is centered on newPos regardless of whether this
      // move succeeded (unchanged position on a bump) — ingest all four of
      // its neighbouring walls in one shot rather than just the one we tried.
      for (const d of allDirs()) applyMove(explored, newPos, d, view);
      pos = newPos;
      moves++;

      if (moves % RADAR_INTERVAL === 0 && inKnownBottomRight(explored, pos)) {
        const radar = await ns.dnet.labradar();
        if (radar.success) {
          const parsed = parseRadar(radar.message);
          if (parsed.exit) {
            exitTarget = [
              pos[0] - parsed.player[0] + parsed.exit[0],
              pos[1] - parsed.player[1] + parsed.exit[1],
            ];
          }
        }
      }

      if (moves % REPORT_INTERVAL === 0) {
        sendReport(ns, self, [labEvent(labHost, explored, pos, moves, false)]);
      }
    }

    const latest = peekPolicy(ns);
    if (!latest || latest.version !== AGENT_VERSION) return;
  }
}

function labEvent(
  labHost: string,
  explored: Explored,
  pos: [number, number],
  moves: number,
  cleared: boolean,
  password?: string,
): ReportEvent {
  return { t: "lab", host: labHost, grid: serializeGrid(explored), pos, moves, cleared, password };
}

/**
 * Past the halfway point of everything explored so far in both axes — a
 * cheap proxy for "the bottom-right quadrant" without knowing the lab's
 * actual dimensions. Deliberately weak: the east/south exploration bias
 * tends to keep `pos` near the bounding box's own max, so this is usually
 * true once exploration has any width to it, and the 20-move gate is really
 * carrying most of the "don't radar too early" job. Acceptable — labradar is
 * 0 GB, and the cost is one extra auth-delay-equivalent every 20 moves.
 */
function inKnownBottomRight(explored: Explored, pos: [number, number]): boolean {
  const { maxX, maxY } = boundingBox(explored);
  return pos[0] >= maxX / 2 && pos[1] >= maxY / 2;
}

function sendReport(ns: NS, self: string, events: ReportEvent[]): void {
  const batch: ReportBatch = { from: self, pid: ns.pid, depth: 0, at: Date.now(), events };
  tryWriteBatch(ns, batch);
}
