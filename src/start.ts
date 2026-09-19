/**
 * Bootstrap Script
 *
 * Launches the dashboard then daemons defined in /config/start.txt.
 * Edit that file to control which daemons start (comment lines with # to disable).
 *
 * Usage: run start.js
 * Also used as the post-augmentation-install entry point.
 *
 * RAM: ~3.8 GB (launcher lib + base)
 */
import { NS } from "@ns";
import { ensureRamAndExec } from "/lib/launcher";
import { readConfig, setConfigValue, getConfigBool } from "/lib/config";

const START_CONFIG_PATH = "/config/start.txt";

/** Check if any instance of a script is running, regardless of arguments. */
function isScriptRunning(ns: NS, path: string, host: string): boolean {
  return ns.ps(host).some(p => p.filename === path);
}

/** Default startup config content. */
const DEFAULT_START_CONFIG = `# Startup Config
# Daemons listed here are launched by start.js in order.
# Comment out a line with # to skip it.
#
# [core] — launched with ensureRamAndExec (will kill workers for RAM)
# [optional] — launched only if free RAM is available

# [core]
daemons/nuke.js
daemons/hack.js
daemons/queue.js
daemons/focus.js
daemons/work.js
daemons/rep.js
daemons/share.js

# [optional]
daemons/darkweb.js
daemons/pserv.js
daemons/faction.js
daemons/augments.js
daemons/advisor.js
daemons/contracts.js
daemons/budget.js
daemons/stocks.js
daemons/gang.js
daemons/home.js
daemons/corp.js
daemons/blade.js
daemons/hacknet.js`;

interface StartEntry {
  path: string;
  core: boolean;
}

/** Parse /config/start.txt into ordered daemon entries. */
function readStartConfig(ns: NS): StartEntry[] {
  let raw = ns.read(START_CONFIG_PATH);
  if (!raw) {
    ns.write(START_CONFIG_PATH, DEFAULT_START_CONFIG, "w");
    raw = DEFAULT_START_CONFIG;
  }

  const entries: StartEntry[] = [];
  let inCore = true; // default to core until we see [optional]

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      // Check for section markers in comments
      if (trimmed.includes("[core]")) inCore = true;
      if (trimmed.includes("[optional]")) inCore = false;
      continue;
    }
    entries.push({ path: trimmed, core: inCore });
  }

  return entries;
}

/** Write the default start config (used by dashboard "Reset" button). */
export function writeDefaultStartConfig(ns: NS): void {
  ns.write(START_CONFIG_PATH, DEFAULT_START_CONFIG, "w");
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  // 1. Launch dashboard
  const dashPath = "views/dashboard/dashboard.js";
  if (isScriptRunning(ns, dashPath, "home")) {
    ns.tprint(`INFO: ${dashPath} already running`);
  } else {
    const dashPid = ensureRamAndExec(ns, dashPath, "home");
    if (dashPid > 0) {
      ns.tprint("SUCCESS: Dashboard launched (pid " + dashPid + ")");
    } else {
      ns.tprint("WARN: Could not launch dashboard");
    }
  }

  // Brief pause to let dashboard initialize
  await ns.sleep(500);

  // Seed default strategies on a fresh bootstrap only. start.js is documented
  // as safe to re-run, so never overwrite a value the player has already set.
  if (!readConfig(ns, "hack").has("strategy")) setConfigValue(ns, "hack", "strategy", "money");
  if (!readConfig(ns, "pserv").has("autoBuy")) setConfigValue(ns, "pserv", "autoBuy", "true");

  // 2. Read startup config
  const entries = readStartConfig(ns);

  // Handle corp disabled flag
  const corpEnabled = getConfigBool(ns, "corp", "enabled", true);
  if (!corpEnabled) {
    const markerFile = "/data/budget-done.txt";
    const existing = ns.read(markerFile);
    const doneBuckets = existing ? existing.split("\n").filter(Boolean) : [];
    if (!doneBuckets.includes("corp")) {
      doneBuckets.push("corp");
      ns.write(markerFile, doneBuckets.join("\n"), "w");
    }
  }

  // 3. Launch daemons in config order
  for (const entry of entries) {
    // Skip corp daemon if disabled in its own config
    if (entry.path === "daemons/corp.js" && !corpEnabled) {
      ns.tprint("INFO: Corp daemon disabled in config — skipping");
      continue;
    }

    if (isScriptRunning(ns, entry.path, "home")) {
      ns.tprint(`INFO: ${entry.path} already running`);
      continue;
    }

    if (entry.core) {
      // Core: use ensureRamAndExec (will kill workers for RAM if needed)
      const pid = ensureRamAndExec(ns, entry.path, "home");
      if (pid > 0) {
        ns.tprint(`SUCCESS: ${entry.path} launched (pid ${pid})`);
      } else {
        ns.tprint(`WARN: Skipping ${entry.path} — could not free enough RAM`);
      }
    } else {
      // Optional: only launch if free RAM available
      const available = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
      const needed = ns.getScriptRam(entry.path);
      if (available >= needed) {
        const pid = ns.exec(entry.path, "home", 1);
        if (pid > 0) {
          ns.tprint(`SUCCESS: ${entry.path} launched (pid ${pid})`);
        }
      } else {
        ns.tprint(`INFO: Skipping optional ${entry.path} — not enough free RAM`);
      }
    }
  }

  ns.tprint("INFO: Bootstrap complete");
}
