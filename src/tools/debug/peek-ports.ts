/**
 * Port Peek Debug Tool
 *
 * Peek at status port contents for debugging.
 * If a port number is passed, shows the full JSON for that port.
 * If no port is passed, shows a few lines from each status port.
 *
 * Usage:
 *   run tools/debug/peek-ports.js           # Summary of all ports
 *   run tools/debug/peek-ports.js 2         # Full contents of port 2 (hack)
 *   run tools/debug/peek-ports.js 19        # Queue port
 */
import { NS } from "@ns";
import {
  STATUS_PORTS,
  INFILTRATION_CONTROL_PORT,
  GANG_CONTROL_PORT,
  CONTRACTS_CONTROL_PORT,
  BUDGET_CONTROL_PORT,
  STOCKS_CONTROL_PORT,
  CORP_CONTROL_PORT,
  FOCUS_CONTROL_PORT,
  DARKNET_CONTROL_PORT,
  DARKNET_POLICY_PORT,
  DARKNET_REPORT_PORT,
  QUEUE_PORT,
  COMMAND_PORT,
} from "/types/ports";

// Control / special ports not covered by STATUS_PORTS. Kept as a name->number
// map (rather than a hardcoded number range) so adding a new control port to
// types/ports.ts is enough to make it show up here too.
const CONTROL_PORTS: Record<string, number> = {
  "infiltration-ctrl": INFILTRATION_CONTROL_PORT,
  "gang-ctrl": GANG_CONTROL_PORT,
  "contracts-ctrl": CONTRACTS_CONTROL_PORT,
  "budget-ctrl": BUDGET_CONTROL_PORT,
  "stocks-ctrl": STOCKS_CONTROL_PORT,
  "corp-ctrl": CORP_CONTROL_PORT,
  "focus-ctrl": FOCUS_CONTROL_PORT,
  "darknet-ctrl": DARKNET_CONTROL_PORT,
  "darknet-policy": DARKNET_POLICY_PORT,
  "darknet-report": DARKNET_REPORT_PORT,
  "queue": QUEUE_PORT,
  "command": COMMAND_PORT,
};

const PORT_NAMES: Record<number, string> = {
  // Build from STATUS_PORTS (the source of truth)
  ...Object.fromEntries(
    Object.entries(STATUS_PORTS).map(([name, port]) => [port, name]),
  ),
  ...Object.fromEntries(
    Object.entries(CONTROL_PORTS).map(([name, port]) => [port, name]),
  ),
};

// Derive the valid port range from every port number actually assigned in
// types/ports.ts, instead of a hardcoded (and easily stale) upper bound.
const ALL_PORT_NUMBERS = Object.keys(PORT_NAMES).map(Number);
const MIN_PORT = Math.min(...ALL_PORT_NUMBERS);
const MAX_PORT = Math.max(...ALL_PORT_NUMBERS);

function peekRaw(ns: NS, port: number): string | null {
  const handle = ns.getPortHandle(port);
  if (handle.empty()) return null;
  const raw = handle.peek();
  if (raw === "NULL PORT DATA") return null;
  return String(raw);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.substring(0, max) + "...";
}

function printPortDetail(ns: NS, port: number): void {
  const name = PORT_NAMES[port] || `port-${port}`;
  const raw = peekRaw(ns, port);

  ns.tprint(`\n\x1b[36m=== Port ${port} (${name}) ===\x1b[0m`);

  if (raw === null) {
    ns.tprint("  \x1b[2m(empty)\x1b[0m");
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    const pretty = JSON.stringify(parsed, null, 2);
    const lines = pretty.split("\n");
    for (const line of lines) {
      ns.tprint("  " + line);
    }
    ns.tprint(`\n  \x1b[2mSize: ${raw.length} chars\x1b[0m`);
  } catch {
    ns.tprint("  (raw) " + raw);
  }
}

function printPortSummary(ns: NS, port: number): void {
  const name = PORT_NAMES[port] || `port-${port}`;
  const raw = peekRaw(ns, port);

  if (raw === null) {
    ns.tprint(`  \x1b[2m[${String(port).padStart(2)}] ${name.padEnd(18)} (empty)\x1b[0m`);
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed);
    const preview = truncate(JSON.stringify(parsed), 120);
    ns.tprint(`  \x1b[32m[${String(port).padStart(2)}]\x1b[0m ${name.padEnd(18)} \x1b[2m${keys.length} keys, ${raw.length} chars\x1b[0m`);
    ns.tprint(`       ${preview}`);
  } catch {
    ns.tprint(`  \x1b[32m[${String(port).padStart(2)}]\x1b[0m ${name.padEnd(18)} \x1b[2m${raw.length} chars (not JSON)\x1b[0m`);
    ns.tprint(`       ${truncate(raw, 120)}`);
  }
}

export async function main(ns: NS): Promise<void> {
  const args = ns.args;

  if (args.length > 0) {
    const port = Number(args[0]);
    if (isNaN(port) || port < MIN_PORT || port > MAX_PORT) {
      ns.tprint(`ERROR: Port must be a number between ${MIN_PORT} and ${MAX_PORT}`);
      return;
    }
    printPortDetail(ns, port);
    return;
  }

  // Summary of all status ports (derived from STATUS_PORTS)
  ns.tprint(`\n\x1b[36m=== STATUS PORTS ===\x1b[0m`);

  const statusPortNums = Object.values(STATUS_PORTS).sort((a, b) => a - b);
  for (const port of statusPortNums) {
    printPortSummary(ns, port);
  }

  ns.tprint("");
  ns.tprint(`  \x1b[36m--- Control / Special Ports ---\x1b[0m`);
  const controlPortNums = Object.values(CONTROL_PORTS).sort((a, b) => a - b);
  for (const port of controlPortNums) {
    printPortSummary(ns, port);
  }
  ns.tprint("");
}
