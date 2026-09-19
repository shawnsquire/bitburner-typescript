import type { NS } from "@ns";

export interface MockNSOptions {
  files?: Record<string, string>;
  /** Extra members merged over the defaults (e.g. { getPlayer: () => player }). */
  extra?: Record<string, unknown>;
}

export interface MockNSLog {
  prints: string[];
  tprints: string[];
}

/**
 * Minimal NS stub for unit tests. Only the surface the pure libraries touch
 * (read/write/ports/log) is implemented; anything else throws so a test
 * fails loudly instead of silently succeeding on an undefined method.
 */
export function mockNS(opts: MockNSOptions = {}): NS & { _files: Map<string, string>; _log: MockNSLog } {
  const files = new Map(Object.entries(opts.files ?? {}));
  const log: MockNSLog = { prints: [], tprints: [] };
  const ports = new Map<number, (string | number)[]>();
  const port = (n: number) => {
    if (!ports.has(n)) ports.set(n, []);
    const q = ports.get(n)!;
    return {
      write: (v: string | number) => { q.push(v); return null; },
      tryWrite: (v: string | number) => { q.push(v); return true; },
      read: () => (q.length ? q.shift()! : "NULL PORT DATA"),
      peek: () => (q.length ? q[0] : "NULL PORT DATA"),
      empty: () => q.length === 0,
      full: () => false,
      clear: () => { q.length = 0; },
      nextWrite: () => Promise.resolve(),
    };
  };
  const impl: Record<string, unknown> = {
    read: (p: string) => files.get(p) ?? "",
    write: (p: string, data = "", mode: "w" | "a" = "a") => {
      files.set(p, mode === "w" ? data : (files.get(p) ?? "") + data);
    },
    fileExists: (p: string) => files.has(p),
    getPortHandle: port,
    print: (...args: unknown[]) => { log.prints.push(args.join(" ")); },
    tprint: (...args: unknown[]) => { log.tprints.push(args.join(" ")); },
    disableLog: (_fn: string) => undefined,
    enableLog: (_fn: string) => undefined,
    _files: files,
    _log: log,
    ...opts.extra,
  };
  return new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      throw new Error(`mockNS: ns.${prop} is not implemented`);
    },
  }) as unknown as NS & { _files: Map<string, string>; _log: MockNSLog };
}
