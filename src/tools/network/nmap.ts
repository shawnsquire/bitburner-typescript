import { NS } from "@ns";
import { discoverAllWithDepthAndPath } from "/lib/utils";

interface ServerRow {
  host: string;
  depth: number;
  purchased: boolean;
  backdoor: boolean;
  root: boolean;
  reqHack: number;
  ports: number;
  growth: number;
  ramMax: number;
  ramUsed: number;
  ramFree: number;
  moneyMax: number;
  moneyAvail: number;
  moneyPct: number;
  secMin: number;
  secCur: number;
  secDelta: number;
  path: string;
}

type RowAccessor = (r: ServerRow) => string | number | boolean;
type Comparator = (a: ServerRow, b: ServerRow) => number;

export async function main(ns: NS): Promise<void> {
  const FLAGS = ns.flags([
    ["start", "home"],
    ["depth", -1],
    ["sort", "depth,host"],
    ["limit", 0],
    ["where", ""],
  ]);

  const start = String(FLAGS.start);
  const sortSpec = String(FLAGS.sort ?? "").trim();
  const maxDepth = Number(FLAGS.depth ?? -1);
  const limit = Number(FLAGS.limit) || 0;
  const predicate = buildPredicate(String(FLAGS.where || "").trim());

  const { hosts, depthByHost, parentByHost } = discoverAllWithDepthAndPath(ns, start, maxDepth);

  const rows = hosts.map((h) => toRow(ns, h, depthByHost.get(h) ?? -1, pathToDisplay(parentByHost, h)));
  const comparators = buildComparators(sortSpec);

  const filtered = rows.filter(predicate);
  const sorted = [...filtered].sort(multiSort(comparators));

  ns.tprint(`Network map from ${start} (${sorted.length} servers) | sort=${sortSpec || "depth,host"}`);

  const header = [
    pad("HOST", 20),
    pad("D", 2),
    pad("P", 1),
    pad("BD", 2),
    pad("ROOT", 4),
    pad("REQ", 5),
    pad("PORT", 4),
    pad("RAM(U/F/M)", 17),
    pad("$ (A/M)", 22),
    pad("SEC(C/M)", 13),
    pad("GROW", 6),
    "PATH",
  ].join("  ");

  ns.tprint(header);
  ns.tprint("-".repeat(header.length));

  const out = limit > 0 ? sorted.slice(0, limit) : sorted;
  for (const r of out) {
    if (r.ramMax > 0) ns.tprint(renderRow(r));
  }

  ns.tprint(
    `Sort fields: host,depth,reqHack,ports,ramUsed,ramFree,ramMax,moneyAvail,moneyMax,moneyPct,secCur,secMin,secDelta,growth,purchased,backdoor,root`,
  );
}

/* ------------------------------ discovery ------------------------------ */

function pathToDisplay(parentByHost: Map<string, string | null>, target: string): string {
  const path: string[] = [];
  let cur: string | null | undefined = target;

  while (cur !== null && cur !== undefined) {
    path.push(cur);
    cur = parentByHost.get(cur);
  }

  return path.slice(1).reverse().slice(1).join(" > ");
}

/* ------------------------------- row build ------------------------------ */

function toRow(ns: NS, host: string, depth: number, path: string): ServerRow {
  const s = ns.getServer(host);

  const ramMax = ns.getServerMaxRam(host);
  const ramUsed = ns.getServerUsedRam(host);
  const ramFree = Math.max(0, ramMax - ramUsed);

  const moneyMax = ns.getServerMaxMoney(host);
  const moneyAvail = ns.getServerMoneyAvailable(host);
  const moneyPct = moneyMax > 0 ? moneyAvail / moneyMax : 0;

  const secMin = ns.getServerMinSecurityLevel(host);
  const secCur = ns.getServerSecurityLevel(host);
  const secDelta = secCur - secMin;

  const reqHack = ns.getServerRequiredHackingLevel(host);
  const ports = ns.getServerNumPortsRequired(host);
  const growth = ns.getServerGrowth(host);

  return {
    host,
    depth,
    purchased: !!s.purchasedByPlayer,
    backdoor: !!s.backdoorInstalled,
    root: !!s.hasAdminRights,
    reqHack,
    ports,
    growth,
    ramMax,
    ramUsed,
    ramFree,
    moneyMax,
    moneyAvail,
    moneyPct,
    secMin,
    secCur,
    secDelta,
    path,
  };
}

function renderRow(r: ServerRow): string {
  const ramStr = `${fmtRam(r.ramUsed)}/${fmtRam(r.ramFree)}/${fmtRam(r.ramMax)}`;
  const moneyStr =
    r.moneyMax > 0 ? `${fmtNum(r.moneyAvail)}/${fmtNum(r.moneyMax)}` : "-";
  const secStr = `${r.secCur.toFixed(1)}/${r.secMin.toFixed(1)}`;

  return [
    pad(r.host, 20),
    pad(String(r.depth), 2),
    pad(r.purchased ? "$" : " ", 1),
    pad(r.backdoor ? "B" : " ", 2),
    pad(r.root ? "R" : " ", 4),
    pad(String(r.reqHack), 5),
    pad(String(r.ports), 4),
    pad(ramStr, 17),
    pad(moneyStr, 22),
    pad(secStr, 13),
    pad(String(Math.round(r.growth || 0)), 6),
    r.path,
  ].join("  ");
}

/* ------------------------------- sorting ------------------------------- */

function buildComparators(sortSpec: string): Comparator[] {
  const spec = (sortSpec || "depth,host")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return spec.map((tokenRaw) => {
    const desc = tokenRaw.startsWith("!");
    const token = desc ? tokenRaw.slice(1) : tokenRaw;
    const get = fieldAccessor(token);

    return (a: ServerRow, b: ServerRow) => {
      const av = get(a);
      const bv = get(b);

      let cmp = 0;
      if (typeof av === "number" && typeof bv === "number") {
        cmp = av === bv ? 0 : av < bv ? -1 : 1;
      } else {
        cmp = String(av).localeCompare(String(bv));
      }
      return desc ? -cmp : cmp;
    };
  });
}

function fieldAccessor(field: string): RowAccessor {
  switch (field) {
    case "host":       return (r) => r.host;
    case "depth":      return (r) => r.depth;
    case "reqHack":    return (r) => r.reqHack;
    case "ports":      return (r) => r.ports;
    case "ramUsed":    return (r) => r.ramUsed;
    case "ramFree":    return (r) => r.ramFree;
    case "ramMax":     return (r) => r.ramMax;
    case "moneyAvail": return (r) => r.moneyAvail;
    case "moneyMax":   return (r) => r.moneyMax;
    case "moneyPct":   return (r) => r.moneyPct;
    case "secCur":     return (r) => r.secCur;
    case "secMin":     return (r) => r.secMin;
    case "secDelta":   return (r) => r.secDelta;
    case "growth":     return (r) => r.growth;
    case "purchased":  return (r) => (r.purchased ? 1 : 0);
    case "backdoor":   return (r) => (r.backdoor ? 1 : 0);
    case "root":       return (r) => (r.root ? 1 : 0);
    default:           return (r) => r.host;
  }
}

function multiSort(comparators: Comparator[]): Comparator {
  const comps = comparators?.length ? comparators : [(a: ServerRow, b: ServerRow) => a.host.localeCompare(b.host)];
  return (a, b) => {
    for (const cmp of comps) {
      const v = cmp(a, b);
      if (v !== 0) return v;
    }
    return 0;
  };
}

/* ------------------------------ formatting ----------------------------- */

function pad(s: string, n: number): string {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s.padEnd(n, " ");
}

function fmtRam(gb: number): string {
  if (!isFinite(gb)) return "-";
  if (gb >= 1024) return `${(gb / 1024).toFixed(0)}TB`;
  if (gb >= 1) return `${gb.toFixed(0)}GB`;
  if (gb > 0) return `${(gb * 1024).toFixed(0)}MB`;
  return "0GB";
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return "-";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e15) return `${sign}${(abs / 1e15).toFixed(2)}q`;
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}t`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}b`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}m`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}k`;
  return `${sign}${abs.toFixed(0)}`;
}

/* ------------------------------ predicates ----------------------------- */

function buildPredicate(whereSpec: string): (row: ServerRow) => boolean {
  if (!whereSpec) return () => true;

  const terms = whereSpec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseTerm);

  return (row) => terms.every((t) => t(row));
}

function parseTerm(raw: string): (row: ServerRow) => boolean {
  const negate = raw.startsWith("!");
  const term = negate ? raw.slice(1).trim() : raw;

  const ops = [">=", "<=", "!=", "=", ">", "<"] as const;
  const op = ops.find((o) => term.includes(o));

  if (!op) {
    const get = fieldAccessorForFilter(term);
    const pred = (row: ServerRow) => !!get(row);
    return negate ? (row) => !pred(row) : pred;
  }

  const [left, rightRaw] = term.split(op).map((s) => s.trim());
  const get = fieldAccessorForFilter(left);

  const right: string | number | boolean =
    rightRaw === "true" ? true :
    rightRaw === "false" ? false :
    Number.isFinite(Number(rightRaw)) ? Number(rightRaw) :
    rightRaw;

  const pred = (row: ServerRow) => compare(get(row), op, right);
  return negate ? (row) => !pred(row) : pred;
}

function compare(a: string | number | boolean, op: string, b: string | number | boolean): boolean {
  const an = Number(a), bn = Number(b);
  const numeric = Number.isFinite(an) && Number.isFinite(bn);
  const av = numeric ? an : a;
  const bv = numeric ? bn : b;

  switch (op) {
    case ">=": return av >= bv;
    case "<=": return av <= bv;
    case ">":  return av > bv;
    case "<":  return av < bv;
    case "=":  return av === bv;
    case "!=": return av !== bv;
    default:   return false;
  }
}

function fieldAccessorForFilter(field: string): RowAccessor {
  switch (field) {
    case "rooted": return (r) => r.root;
    case "bd":     return (r) => r.backdoor;
    case "p":      return (r) => r.purchased;
    default:       return fieldAccessor(field);
  }
}
