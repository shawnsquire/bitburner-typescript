/**
 * RAM-Aware Launch Tool
 *
 * CLI wrapper around the launcher library. Launches any script with
 * automatic RAM-freeing by killing low-priority workers.
 *
 * Usage:
 *   run tools/launch.js <script> [--threads N] [--dry-run] [-- script-args...]
 *
 * Examples:
 *   run tools/launch.js auto/auto-rep.js
 *   run tools/launch.js hack/distributed.js --threads 1
 *   run tools/launch.js auto/auto-work.js -- --focus hacking
 *   run tools/launch.js auto/auto-rep.js --dry-run
 *
 * RAM: ~3.8 GB (launcher lib + base)
 */
import { NS, AutocompleteData } from "@ns";
import { ensureRamAndExec, dryRunEnsureRamAndExec } from "/lib/launcher";

export function autocomplete(data: AutocompleteData, args: string[]): string[] {
  // If no script specified yet, suggest scripts
  if (args.length <= 1) {
    return [...data.scripts];
  }
  // After script name, suggest flags
  return ["--threads", "--dry-run", "--"];
}

export async function main(ns: NS): Promise<void> {
  const args = ns.args;

  if (args.length === 0) {
    ns.tprint("ERROR: Usage: run tools/launch.js <script> [--threads N] [--dry-run] [-- script-args...]");
    return;
  }

  // Parse arguments
  const scriptPath = String(args[0]);
  let threads = 1;
  let dryRun = false;
  const scriptArgs: (string | number | boolean)[] = [];
  let passthrough = false;

  for (let i = 1; i < args.length; i++) {
    const arg = String(args[i]);

    if (passthrough) {
      scriptArgs.push(args[i]);
      continue;
    }

    if (arg === "--") {
      passthrough = true;
      continue;
    }

    if (arg === "--threads" && i + 1 < args.length) {
      threads = Number(args[++i]);
      if (!Number.isFinite(threads) || threads < 1) {
        ns.tprint("ERROR: --threads must be a positive integer");
        return;
      }
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    // Unrecognized flag — treat as passthrough arg
    scriptArgs.push(args[i]);
  }

  if (dryRun) {
    const result = dryRunEnsureRamAndExec(ns, scriptPath, "home", threads);
    if (result.wouldKill.length === 0 && result.sufficient) {
      ns.tprint(`SUCCESS: Enough RAM available — no kills needed for ${scriptPath}`);
    } else if (result.wouldKill.length > 0) {
      ns.tprint(`INFO: Would kill ${result.wouldKill.length} process(es) to launch ${scriptPath}:`);
      for (const proc of result.wouldKill) {
        ns.tprint(`  - ${proc.filename} (pid ${proc.pid}, ${ns.format.ram(proc.ram)})`);
      }
      ns.tprint(result.sufficient ? "INFO: This would free enough RAM." : "WARN: Still not enough RAM even after all killable processes.");
    } else {
      ns.tprint(`ERROR: Not enough RAM and no killable processes for ${scriptPath}`);
    }
    return;
  }

  // Actual launch
  const threadStr = threads > 1 ? ` (${threads} threads)` : "";
  ns.tprint(`INFO: Launching ${scriptPath}${threadStr}...`);

  const pid = ensureRamAndExec(ns, scriptPath, "home", threads, ...scriptArgs);
  if (pid > 0) {
    ns.tprint(`SUCCESS: ${scriptPath} launched (pid ${pid})`);
  } else {
    ns.tprint(`ERROR: Failed to launch ${scriptPath} — could not free enough RAM`);
  }
}
