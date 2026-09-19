/**
 * Focus Daemon
 *
 * Centralized authority for player focus and sleeve assignments.
 * Sole writer to /config/focus.txt. Publishes FocusStatus to port 32.
 *
 * Responsibilities:
 *   - Manages which daemon (work/rep/blade) holds the player's focus
 *   - Manages every sleeve from ns.sleeve.getNumSleeves(); Simulacrum detection
 *     is delegated to actions/check-simulacrum.js (exec'd at startup and on `refresh`)
 *   - Routes sleeve assignments via action scripts
 *   - Receives commands from dashboard via FOCUS_CONTROL_PORT (33)
 *
 * Sleeve config: `sleeveHolder.<i>` per sleeve index, falling back to the bare
 * `sleeveHolder` key for any sleeve without its own entry (so older configs
 * that only set `sleeveHolder` still direct every sleeve).
 *
 * Non-tiered: fixed RAM cost, pinned with ns.ramOverride so the daemon only
 * reserves what its loop needs (ps, exec, sleeve.getNumSleeves, config I/O).
 *
 * Usage:
 *   run daemons/focus.js
 */
import { NS } from "@ns";
import { publishStatus } from "/lib/ports";
import { writeDefaultConfig, readConfig, getConfigString, getConfigBool, setConfigValue } from "/lib/config";
import {
  STATUS_PORTS,
  FOCUS_CONTROL_PORT,
  TOOL_SCRIPTS,
  FocusDaemon,
  FocusStatus,
  FocusControlMessage,
  SleeveAssignment,
} from "/types/ports";

const COLORS = {
  green: "\x1b[38;2;0;255;0m",
  yellow: "\x1b[38;2;255;255;0m",
  cyan: "\x1b[38;2;68;204;255m",
  magenta: "\x1b[38;2;204;102;255m",
  dim: "\x1b[38;2;102;102;102m",
  reset: "\x1b[0m",
};

const SIMULACRUM_ACTION = "actions/check-simulacrum.js";
const ASSIGN_SLEEVE_ACTION = "actions/assign-sleeve.js";
const FOCUS_DAEMONS: FocusDaemon[] = ["work", "rep", "blade"];

function normalizeFocusDaemon(val: string): FocusDaemon {
  if (val === "work" || val === "rep" || val === "blade") return val;
  return "none";
}

/** Config key naming the daemon that directs sleeve `index`. */
function sleeveKey(index: number): string {
  return `sleeveHolder.${index}`;
}

/** Resolve sleeve `index`'s daemon: its own key, else the bare fallback, else none. */
function resolveSleeveDaemon(config: Map<string, string>, index: number): FocusDaemon {
  const raw = config.get(sleeveKey(index)) ?? config.get("sleeveHolder") ?? "none";
  return normalizeFocusDaemon(raw);
}

/** Read the sleeve count; 0 when the Sleeve API is unavailable at this SF level. */
function countSleeves(ns: NS): number {
  try {
    return ns.sleeve.getNumSleeves();
  } catch {
    return 0;
  }
}

/** @ram 7.1 */
export async function main(ns: NS): Promise<void> {
  ns.ramOverride(7.1);
  ns.disableLog("ALL");

  // Write default config
  writeDefaultConfig(ns, "focus", {
    holder: "work",
    sleeveHolder: "none",
    default: "work",
    simulacrum: "false",
  });

  // Re-read each tick: sleeves can be bought mid-run.
  let numSleeves = countSleeves(ns);

  // Simulacrum detection runs in a short-lived action that writes the
  // `simulacrum` config key (read by the blade daemon). Retry until it launches
  // so a stale value from a previous session never goes unchecked.
  let simulacrumChecked = execSimulacrumCheck(ns);

  // Initialize holder from config, applying default if empty
  let holder = getConfigString(ns, "focus", "holder", "");
  if (!holder) {
    const defaultHolder = getConfigString(ns, "focus", "default", "work");
    holder = defaultHolder;
    setConfigValue(ns, "focus", "holder", holder);
  }

  // Initialize control port
  const controlPort = ns.getPortHandle(FOCUS_CONTROL_PORT);

  ns.print(`${COLORS.cyan}Focus daemon started${COLORS.reset}`);
  ns.print(`  Sleeves: ${numSleeves}`);
  ns.print(`  Simulacrum: ${simulacrumChecked ? "checking" : "check pending (RAM?)"}`);
  ns.print(`  Initial holder: ${holder}`);
  ns.print("");

  while (true) {
    if (!simulacrumChecked) simulacrumChecked = execSimulacrumCheck(ns);
    numSleeves = countSleeves(ns);

    // Process control messages
    while (!controlPort.empty()) {
      const raw = controlPort.read();
      if (raw === "NULL PORT DATA") break;
      try {
        const msg = JSON.parse(raw as string) as FocusControlMessage;
        if (msg.action === "refresh") {
          ns.print(`${COLORS.dim}Focus refresh requested${COLORS.reset}`);
          simulacrumChecked = execSimulacrumCheck(ns);
        } else {
          processControlMessage(ns, msg, numSleeves);
        }
      } catch {
        // Skip invalid messages
      }
    }

    // Re-read config (authoritative source after writes)
    const config = readConfig(ns, "focus");
    const normalizedHolder = normalizeFocusDaemon(config.get("holder") ?? "none");

    // Detect running focus-relevant daemons
    const processes = ns.ps("home");
    const runningDaemons: FocusDaemon[] = [];
    for (const daemon of FOCUS_DAEMONS) {
      if (daemon === "none") continue;
      const script = TOOL_SCRIPTS[daemon as Exclude<FocusDaemon, "none">];
      if (processes.some(p => p.filename === script)) {
        runningDaemons.push(daemon);
      }
    }

    // Build sleeve assignments: one entry per sleeve, "none" included
    const sleeves: SleeveAssignment[] = [];
    for (let i = 0; i < numSleeves; i++) {
      sleeves.push({ sleeveIndex: i, daemon: resolveSleeveDaemon(config, i) });
    }

    // Publish status
    const status: FocusStatus = {
      holder: normalizedHolder,
      sleeves,
      simulacrum: getConfigBool(ns, "focus", "simulacrum", false),
      numSleeves,
      runningDaemons,
      defaultHolder: normalizeFocusDaemon(config.get("default") ?? "work"),
    };
    publishStatus(ns, STATUS_PORTS.focus, status);

    // Print status
    printStatus(ns, status);

    await ns.sleep(2000);
  }
}

function processControlMessage(ns: NS, msg: FocusControlMessage, numSleeves: number): void {
  switch (msg.action) {
    case "set-holder": {
      const newHolder = normalizeFocusDaemon(msg.holder ?? "none");
      setConfigValue(ns, "focus", "holder", newHolder);

      // Clear any sleeve key (bare or per-index) that conflicts with the new holder
      if (newHolder !== "none") {
        const cleared = clearSleeveConflicts(ns, newHolder);
        if (cleared.length > 0) {
          ns.print(`${COLORS.yellow}Cleared ${cleared.join(", ")} (conflicts with new holder)${COLORS.reset}`);
        }
      }

      ns.print(`${COLORS.green}Focus holder: ${newHolder}${COLORS.reset}`);
      break;
    }

    case "set-sleeve": {
      const sleeveDaemon = normalizeFocusDaemon(msg.sleeveDaemon ?? "none");
      const currentHolder = getConfigString(ns, "focus", "holder", "none");

      if (numSleeves === 0) {
        ns.toast("No sleeves available", "warning", 2000);
        break;
      }

      // Prevent duplicate of primary holder
      if (sleeveDaemon !== "none" && sleeveDaemon === currentHolder) {
        ns.toast(`${sleeveDaemon} already holds primary focus`, "warning", 2000);
        break;
      }

      // No index = every sleeve: write the bare fallback and each per-index key
      let targets: number[];
      if (msg.sleeveIndex === undefined) {
        targets = Array.from({ length: numSleeves }, (_, i) => i);
        setConfigValue(ns, "focus", "sleeveHolder", sleeveDaemon);
      } else {
        const index = Math.trunc(Number(msg.sleeveIndex));
        if (!Number.isFinite(index) || index < 0 || index >= numSleeves) {
          ns.toast(`Sleeve ${msg.sleeveIndex} out of range (${numSleeves} sleeves)`, "warning", 2000);
          break;
        }
        targets = [index];
      }

      for (const index of targets) {
        setConfigValue(ns, "focus", sleeveKey(index), sleeveDaemon);
        ns.print(`${COLORS.cyan}Sleeve ${index}: ${sleeveDaemon}${COLORS.reset}`);

        // Exec sleeve assignment action script
        if (sleeveDaemon !== "none") {
          const pid = ns.exec(
            ASSIGN_SLEEVE_ACTION,
            "home",
            { threads: 1, temporary: true },
            "--sleeve", String(index),
            "--daemon", sleeveDaemon,
          );
          if (pid === 0) {
            ns.print(`${COLORS.yellow}Could not exec assign-sleeve for #${index} (RAM?)${COLORS.reset}`);
          }
        }
      }
      break;
    }

    case "refresh":
      // Handled in the main loop (re-runs the Simulacrum check)
      break;
  }
}

/**
 * Set every sleeve key (bare `sleeveHolder` and `sleeveHolder.<i>`) whose value
 * is `daemon` to "none". Returns the keys that were cleared.
 */
function clearSleeveConflicts(ns: NS, daemon: FocusDaemon): string[] {
  const cleared: string[] = [];
  for (const [key, value] of readConfig(ns, "focus")) {
    if (value !== daemon) continue;
    if (key === "sleeveHolder" || key.startsWith("sleeveHolder.")) {
      setConfigValue(ns, "focus", key, "none");
      cleared.push(key);
    }
  }
  return cleared;
}

/** Launch the Simulacrum check action. Returns true if it started. */
function execSimulacrumCheck(ns: NS): boolean {
  const pid = ns.exec(SIMULACRUM_ACTION, "home", { threads: 1, temporary: true });
  if (pid === 0) {
    ns.print(`${COLORS.yellow}Could not exec ${SIMULACRUM_ACTION} (RAM?); will retry${COLORS.reset}`);
    return false;
  }
  return true;
}

function printStatus(ns: NS, status: FocusStatus): void {
  ns.clearLog();
  ns.print(`${COLORS.cyan}=== FOCUS DAEMON ===${COLORS.reset}`);
  ns.print("");

  const holderColor = status.holder === "none" ? COLORS.yellow : COLORS.green;
  ns.print(`Active: ${holderColor}${status.holder}${COLORS.reset}`);

  if (status.numSleeves > 0) {
    const assigned = status.sleeves.filter(s => s.daemon !== "none");
    const sleeveLabel = assigned.length > 0
      ? assigned.map(s => `#${s.sleeveIndex}→${s.daemon}`).join(", ")
      : "none";
    ns.print(`Sleeves (${status.numSleeves}): ${COLORS.cyan}${sleeveLabel}${COLORS.reset}`);
  }

  if (status.simulacrum) {
    ns.print(`Simulacrum: ${COLORS.magenta}ACTIVE${COLORS.reset} (blade exempt)`);
  }

  ns.print("");
  const running = status.runningDaemons.length > 0
    ? status.runningDaemons.join(", ")
    : "none";
  ns.print(`${COLORS.dim}Running: ${running}${COLORS.reset}`);
  ns.print(`${COLORS.dim}Default: ${status.defaultHolder}${COLORS.reset}`);
}
