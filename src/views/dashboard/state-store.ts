/**
 * Dashboard State Store
 *
 * Module-level state that persists across React re-renders (printRaw calls).
 * Now reads status from ports (published by daemons) instead of calling
 * controller functions directly. This eliminates heavy RAM imports.
 *
 * Uses NetscriptPort for React→MainLoop communication to avoid click loss issues.
 */
import { NetscriptPort, NS } from "@ns";
import { peekStatus } from "/lib/ports";
import { setConfigValue, getConfigString, getConfigBool, readConfig } from "/lib/config";
import { TRADING_PROFILES, profileConfigValues, TradingProfileName } from "/controllers/stocks";
import {
  ToolName,
  DashboardState,
  TOOL_SCRIPTS,
  KILL_TIERS,
  STATUS_PORTS,
  COMMAND_PORT,
  INFILTRATION_CONTROL_PORT,
  GANG_CONTROL_PORT,
  CONTRACTS_CONTROL_PORT,
  BUDGET_CONTROL_PORT,
  CORP_CONTROL_PORT,
  STOCKS_CONTROL_PORT,
  FOCUS_CONTROL_PORT,
  NukeStatus,
  PservStatus,
  ShareStatus,
  RepStatus,
  HackStatus,
  HackStrategy,
  DarkwebStatus,
  WorkStatus,
  BitnodeStatus,
  FactionStatus,
  FleetAllocation,
  InfiltrationStatus,
  GangStatus,
  GangStrategy,
  AugmentsStatus,
  AdvisorStatus,
  ContractsStatus,
  BudgetStatus,
  StocksStatus,
  CasinoStatus,
  HomeStatus,
  CorpStatus,
  BladeburnerStatus,
  HacknetStatus,
  FocusStatus,
  FocusControlMessage,
  HashSpendStrategy,
  StartupConfigEntry,
  Command,
  DarknetStatus,
} from "/types/ports";

// === COMMAND PORT ===

let commandPort: NetscriptPort | null = null;

/**
 * Initialize the command port for React→MainLoop communication.
 */
export function initCommandPort(ns: NS): void {
  commandPort = ns.getPortHandle(COMMAND_PORT);
  commandPort.clear();
}

/**
 * Write a command to the port.
 */
export function writeCommand(
  tool: ToolName,
  action: Command["action"],
  scriptPath?: string,
  scriptArgs?: string[]
): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool, action, scriptPath, scriptArgs }));
}

/**
 * Open tail for a running tool.
 */
export function openToolTail(tool: ToolName): void {
  writeCommand(tool, "open-tail");
}

/**
 * Run a one-off script.
 */
export function runScript(tool: ToolName, scriptPath: string, scriptArgs: string[] = []): void {
  writeCommand(tool, "run-script", scriptPath, scriptArgs);
}

/**
 * Send a control message to the stocks daemon.
 */
export function sendStocksControl(action: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "stocks", action: "stocks-control", stocksControlAction: action }));
}

/**
 * Reset stocks P&L and trade history.
 */
export function resetStocksPnl(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "stocks", action: "reset-stocks-pnl" }));
}

/**
 * Set stocks trading profile.
 */
export function setStocksProfile(profile: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "stocks", action: "set-stocks-profile", stocksProfile: profile }));
}

/**
 * Start optimal faction work with focus.
 */
export function startFactionWork(factionName: string, workType: "hacking" | "field" | "security" = "hacking"): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "rep", action: "start-faction-work", factionName, workType }));
}

/**
 * Set work focus for training.
 */
export function writeWorkFocusCommand(focus: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "work", action: "set-focus", focus }));
}

/**
 * Start training based on current focus.
 */
export function writeStartTrainingCommand(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "work", action: "start-training" }));
}

/**
 * Install all pending augmentations (triggers a soft reset).
 */
export function installAugments(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "augments", action: "install-augments" }));
}

/**
 * Buy only selected augmentations by name.
 */
export function buySelectedAugments(augNames: string[]): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "augments", action: "buy-selected-augments", selectedAugs: augNames }));
}

/**
 * Run backdoors with auto-fallback to manual tool if RAM is insufficient.
 */
export function runBackdoors(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "rep", action: "run-backdoors" }));
}

/**
 * Claim focus priority for a daemon, or pass "none" to park all daemons
 * so nothing tries to take the player's focus.
 */
export function claimFocus(target: "work" | "rep" | "blade" | "none"): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "focus", action: "claim-focus", focusTarget: target }));
}

/**
 * `Command` plus the sleeve index for claim-sleeve-focus. Lives here rather
 * than in `Command` (types/ports.ts) so this change stays inside the focus
 * types; fold `focusSleeveIndex` into `Command` when that file is next edited.
 */
type FocusSleeveCommand = Command & { focusSleeveIndex?: number };

/**
 * Claim sleeve focus for a daemon, letting it run actions via a sleeve
 * in parallel with the primary focus holder. Omit `sleeveIndex` to assign
 * every sleeve (the daemon then writes the bare `sleeveHolder` fallback).
 */
export function claimSleeveFocus(target: "work" | "rep" | "blade" | "none", sleeveIndex?: number): void {
  if (!commandPort) return;
  const cmd: FocusSleeveCommand = { tool: "focus", action: "claim-sleeve-focus", focusSleeveTarget: target, focusSleeveIndex: sleeveIndex };
  commandPort.write(JSON.stringify(cmd));
}

/**
 * Focus config keys that direct a sleeve to `daemon`: the bare `sleeveHolder`
 * fallback and every per-index `sleeveHolder.<i>`. Pure; used when a daemon
 * takes primary focus or is stopped, so no sleeve keeps pointing at it.
 */
export function conflictingSleeveKeys(config: Map<string, string>, daemon: string): string[] {
  const keys: string[] = [];
  for (const [key, value] of config) {
    if (value !== daemon) continue;
    if (key === "sleeveHolder" || key.startsWith("sleeveHolder.")) keys.push(key);
  }
  return keys;
}

/** Config key for one sleeve's daemon; the bare key when no index is given (all sleeves). */
export function sleeveHolderKey(sleeveIndex?: number): string {
  return sleeveIndex === undefined ? "sleeveHolder" : `sleeveHolder.${sleeveIndex}`;
}

/**
 * Buy a Bladeburner skill upgrade via the blade daemon.
 */
export function buyBladeSkill(skillName: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "blade", action: "blade-buy-skill", bladeSkillName: skillName }));
}

/**
 * Keep buying the best recommended skill until SP is exhausted.
 * The daemon loops internally, re-evaluating after each purchase so
 * that increasing costs are accounted for.
 */
export function buyAllBladeSkills(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "blade", action: "blade-buy-all-skills" }));
}

/**
 * Set a Bladeburner config value.
 */
export function setBladeConfig(key: string, value: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "blade", action: "set-blade-config", bladeConfigKey: key, bladeConfigValue: String(value) }));
}

/**
 * Reset /config/start.txt to defaults.
 */
export function sendResetStartConfig(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "nuke", action: "reset-start-config" }));
}

/**
 * Toggle pserv auto-buy mode.
 */
export function togglePservAutoBuy(enabled: boolean): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "pserv", action: "toggle-pserv-autobuy", pservAutoBuy: enabled }));
}

/**
 * Set pserv max RAM cap (0 = game max, positive = power of 2 cap).
 */
export function setPservMaxRam(ram: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "pserv", action: "set-pserv-max-ram", pservMaxRam: ram }));
}

/**
 * Restart the rep daemon, optionally with a faction focus override.
 */
export function restartRepDaemon(factionFocus?: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "rep", action: "restart-rep-daemon", factionFocus }));
}

/**
 * Join a faction via the command port (dispatches to join-faction action).
 */
export function joinFactionCommand(factionName: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "faction", action: "join-faction", factionName }));
}

/**
 * Restart the faction daemon, optionally with a preferred city override.
 */
export function restartFactionDaemon(cityFaction?: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "faction", action: "restart-faction-daemon", cityFaction }));
}

/**
 * Restart the hack daemon with new strategy/batch settings.
 * Share% is now auto-detected by hack from the share status port.
 */
export function restartHackDaemon(
  strategy?: HackStrategy,
  maxBatches?: number,
  homeReserve?: number,
): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({
    tool: "hack",
    action: "restart-hack-daemon",
    hackStrategy: strategy,
    hackMaxBatches: maxBatches,
    hackHomeReserve: homeReserve,
  }));
}

/**
 * Restart the share daemon with a target percent cap.
 */
export function restartShareDaemon(targetPercent?: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({
    tool: "share",
    action: "restart-share-daemon",
    shareTargetPercent: targetPercent,
  }));
}

/**
 * Send a configure command to the infiltration daemon.
 */
export function configureInfiltration(rewardMode?: "rep" | "money" | "manual"): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({
    tool: "infiltration",
    action: "configure-infiltration",
    infiltrationRewardMode: rewardMode,
  }));
}

/**
 * Set gang strategy via command port.
 */
export function setGangStrategy(strategy: GangStrategy): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "set-gang-strategy", gangStrategy: strategy }));
}

/**
 * Set hacknet hash spend strategy via command port.
 */
export function setHacknetStrategy(strategy: HashSpendStrategy): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "hacknet", action: "set-hacknet-strategy", hacknetSpendStrategy: strategy }));
}

/**
 * Pin a gang member to a specific task.
 */
export function pinGangMember(memberName: string, task: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "pin-gang-member", gangMemberName: memberName, gangMemberTask: task }));
}

/**
 * Unpin a gang member.
 */
export function unpinGangMember(memberName: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "unpin-gang-member", gangMemberName: memberName }));
}

/**
 * Request ascension for a gang member.
 */
export function ascendGangMember(memberName: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "ascend-gang-member", gangMemberName: memberName }));
}

/**
 * Toggle gang equipment purchases.
 */
export function toggleGangPurchases(enabled: boolean): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "toggle-gang-purchases", gangPurchasesEnabled: enabled }));
}

/**
 * Set gang wanted threshold.
 */
export function setGangWantedThreshold(threshold: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "set-gang-wanted-threshold", gangWantedThreshold: threshold }));
}

/**
 * Set gang training threshold (min avg combat stat before strategy kicks in).
 */
export function setGangTrainingThreshold(threshold: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "set-gang-training-threshold", gangTrainingThreshold: threshold }));
}

/**
 * Set gang ascension thresholds.
 */
export function setGangAscensionThresholds(autoThreshold: number, reviewThreshold: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "set-gang-ascension-thresholds", gangAscendAutoThreshold: autoThreshold, gangAscendReviewThreshold: reviewThreshold }));
}

/**
 * Set gang grow target multiplier.
 */
export function setGangGrowTarget(multiplier: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "set-gang-grow-target", gangGrowTargetMultiplier: multiplier }));
}

/**
 * Set gang grow respect reserve count.
 */
export function setGangGrowRespectReserve(count: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "set-gang-grow-respect-reserve", gangGrowRespectReserve: count }));
}

/**
 * Set gang territory auto-enable threshold (0-101).
 */
export function setGangTerritoryThreshold(threshold: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "set-gang-territory-threshold", gangTerritoryAutoThreshold: threshold }));
}

/**
 * Force-buy all affordable gang equipment (ignores spending cap).
 */
export function forceGangEquipmentBuy(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "force-buy-equipment" }));
}

/**
 * Force-attempt a specific coding contract (bypasses minTries).
 */
export function forceContractAttempt(host: string, file: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "contracts", action: "force-contract-attempt", contractHost: host, contractFile: file }));
}

/**
 * Rush a budget bucket — 100% of income goes to this bucket.
 */
export function rushBudgetBucket(bucket: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "budget", action: "rush-budget-bucket", budgetBucket: bucket }));
}

/**
 * Freeze a budget bucket (saves weight, sets to 0).
 */
export function freezeBudgetBucket(bucket: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "budget", action: "freeze-budget-bucket", budgetBucket: bucket }));
}

/**
 * Unfreeze a budget bucket (restores saved weight).
 */
export function unfreezeBudgetBucket(bucket: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "budget", action: "unfreeze-budget-bucket", budgetBucket: bucket }));
}

/**
 * Cancel budget rush mode.
 */
export function cancelBudgetRush(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "budget", action: "cancel-budget-rush" }));
}

/**
 * Update weight for a budget bucket.
 */
export function updateBudgetWeight(bucket: string, weight: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "budget", action: "update-budget-weight", budgetBucket: bucket, budgetWeight: weight }));
}

/**
 * Reset all budget weights to defaults.
 */
export function resetBudgetWeights(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "budget", action: "reset-budget-weights" }));
}

/**
 * Toggle home server auto-buy mode.
 */
export function toggleHomeAutoBuy(enabled: boolean): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "home", action: "toggle-home-autobuy", homeAutoBuy: enabled }));
}

/**
 * Set corp directive (bootstrap/scale/harvest).
 */
export function setCorpDirective(directive: string): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "corp", action: "set-corp-directive", corpDirective: directive }));
}

/**
 * Cancel pending corp action (countdown banner).
 */
export function cancelCorpPending(): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "corp", action: "cancel-corp-pending" }));
}

/**
 * Pin/unpin corp directive (prevents auto-advance).
 */
export function toggleCorpPin(pinned: boolean): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "corp", action: "toggle-corp-pin", corpPinned: pinned }));
}

/**
 * Toggle corp auto-tea mode.
 */
export function toggleCorpAutoTea(enabled: boolean): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "corp", action: "toggle-corp-auto-tea", corpAutoTea: enabled }));
}

/**
 * Set corp dividend rate.
 */
export function setCorpDividendRate(rate: number): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "corp", action: "set-corp-dividend-rate", corpDividendRate: rate }));
}

/**
 * Toggle corp enabled/disabled state.
 * When disabled: stops daemon, signals budget done, skips on next aug install.
 * When enabled: starts daemon, reactivates budget bucket.
 */
export function toggleCorpEnabled(enabled: boolean): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "corp", action: "toggle-corp-enabled", corpEnabled: enabled }));
}

/**
 * Restart the gang daemon with optional strategy.
 */
export function restartGangDaemon(strategy?: GangStrategy): void {
  if (!commandPort) return;
  commandPort.write(JSON.stringify({ tool: "gang", action: "restart-gang-daemon", gangStrategy: strategy }));
}

/**
 * Read and execute all pending commands from the port.
 */
export function readAndExecuteCommands(ns: NS): void {
  if (!commandPort) return;

  while (!commandPort.empty()) {
    const data = commandPort.read();
    if (data === "NULL PORT DATA") break;

    try {
      const cmd = JSON.parse(data as string) as Command;
      executeCommand(ns, cmd);
    } catch {
      // Invalid command data, skip
    }
  }
}

/**
 * Execute a single command — dispatches to action scripts instead of
 * calling controller functions directly.
 */
function executeCommand(ns: NS, cmd: Command): void {
  switch (cmd.action) {
    case "start":
      startTool(ns, cmd.tool);
      break;
    case "stop":
      stopTool(ns, cmd.tool);
      break;
    case "open-tail":
      openTail(ns, cmd.tool);
      break;
    case "run-script":
      if (cmd.scriptPath) {
        executeScript(ns, cmd.scriptPath, cmd.scriptArgs || []);
      }
      break;
    case "start-faction-work":
      if (cmd.factionName) {
        const workType = cmd.workType ?? "hacking";
        const pid = ns.exec("actions/work-for-faction.js", "home", 1, "--faction", cmd.factionName, "--type", workType, "--focus");
        if (pid > 0) {
          ns.toast(`Started ${workType} work for ${cmd.factionName}`, "success", 2000);
        } else {
          ns.toast(`Failed to start work for ${cmd.factionName}`, "error", 3000);
        }
      }
      break;
    case "set-focus":
      if (cmd.focus) {
        const pid = ns.exec("actions/set-work-focus.js", "home", 1, "--focus", cmd.focus);
        if (pid > 0) {
          ns.toast(`Work focus: ${cmd.focus}`, "success", 2000);
        } else {
          ns.toast(`Failed to set focus`, "error", 3000);
        }
      }
      break;
    case "start-training":
      {
        // Use the work daemon's published recommendation (gym stat,
        // university course/location, or crime name) instead of always
        // training strength — the daemon derives this from the configured
        // work focus (/data/work-config.json via /config/work.txt "focus").
        const rec = cachedData.workStatus?.recommendation;
        let pid: number;
        if (rec && rec.type === "university") {
          const course = rec.skill === "hacking" ? "Algorithms" : "Leadership";
          pid = ns.exec("actions/start-university.js", "home", 1, "--uni", rec.location, "--course", course);
        } else if (rec && rec.type === "gym") {
          pid = ns.exec("actions/start-gym.js", "home", 1, "--gym", rec.location, "--stat", rec.skill);
        } else if (rec && rec.type === "crime") {
          // For crime focus, recommendation.location holds the crime name.
          pid = ns.exec("actions/commit-crime.js", "home", 1, "--crime", rec.location);
        } else {
          // No recommendation available yet (e.g. work daemon not running).
          pid = ns.exec("actions/start-gym.js", "home", 1, "--stat", "str");
        }
        if (pid > 0) {
          ns.toast("Training started", "success", 2000);
        } else {
          ns.toast("Could not start training (not enough RAM?)", "warning", 3000);
        }
      }
      break;
    case "install-augments":
      {
        const pid = ns.exec("actions/install-augments.js", "home", 1, "--confirm");
        if (pid > 0) {
          ns.toast("Installing augmentations...", "info", 2000);
        } else {
          ns.toast("Failed to launch install-augments (not enough RAM)", "error", 3000);
        }
      }
      break;
    case "run-backdoors":
      {
        const pid = ns.exec("actions/faction-backdoors.js", "home", 1);
        if (pid > 0) {
          ns.toast("Running auto-backdoors...", "success", 2000);
        } else {
          // Fallback to manual tool
          const fallbackPid = ns.exec("tools/network/backdoor.js", "home", 1);
          if (fallbackPid > 0) {
            ns.toast("Auto-backdoor needs more RAM. Opened manual backdoor tool.", "warning", 4000);
          } else {
            ns.toast("Failed to start backdoor tool (not enough RAM)", "error", 3000);
          }
        }
      }
      break;
    case "restart-rep-daemon":
      {
        const currentRepPid = cachedData.pids.rep;
        if (currentRepPid > 0) {
          ns.kill(currentRepPid);
          cachedData.pids.rep = 0;
        }
        setConfigValue(ns, "rep", "faction", cmd.factionFocus ?? "");
        const newPid = ns.exec("daemons/rep.js", "home", 1);
        if (newPid > 0) {
          cachedData.pids.rep = newPid;
          ns.toast(cmd.factionFocus ? `Rep daemon: focusing ${cmd.factionFocus}` : "Rep daemon: auto-select mode", "success", 2000);
        } else {
          ns.toast("Failed to restart rep daemon (not enough RAM)", "error", 3000);
        }
      }
      break;
    case "join-faction":
      if (cmd.factionName) {
        const pid = ns.exec("actions/join-faction.js", "home", 1, "--faction", cmd.factionName);
        if (pid > 0) {
          ns.toast(`Joining ${cmd.factionName}...`, "info", 2000);
        } else {
          ns.toast(`Failed to launch join-faction (not enough RAM)`, "error", 3000);
        }
      }
      break;
    case "restart-faction-daemon":
      {
        const currentFactionPid = cachedData.pids.faction;
        if (currentFactionPid > 0) {
          ns.kill(currentFactionPid);
          cachedData.pids.faction = 0;
        }
        if (cmd.cityFaction) {
          setConfigValue(ns, "faction", "preferredCity", cmd.cityFaction);
        }
        const factionPid = ns.exec("daemons/faction.js", "home", 1);
        if (factionPid > 0) {
          cachedData.pids.faction = factionPid;
          ns.toast(cmd.cityFaction ? `Faction daemon: preferred ${cmd.cityFaction}` : "Faction daemon restarted", "success", 2000);
        } else {
          ns.toast("Failed to restart faction daemon (not enough RAM)", "error", 3000);
        }
      }
      break;
    case "restart-hack-daemon":
      {
        const currentHackPid = cachedData.pids.hack;
        if (currentHackPid > 0) {
          ns.kill(currentHackPid);
          cachedData.pids.hack = 0;
        }
        if (cmd.hackStrategy) setConfigValue(ns, "hack", "strategy", cmd.hackStrategy);
        if (cmd.hackMaxBatches !== undefined) setConfigValue(ns, "hack", "maxBatches", String(cmd.hackMaxBatches));
        if (cmd.hackHomeReserve !== undefined) setConfigValue(ns, "hack", "homeReserve", String(cmd.hackHomeReserve));
        const hackPid = ns.exec("daemons/hack.js", "home", 1);
        if (hackPid > 0) {
          cachedData.pids.hack = hackPid;
          ns.toast(`Hack daemon: ${cmd.hackStrategy ?? "money"} mode`, "success", 2000);
        } else {
          ns.toast("Failed to restart hack daemon (not enough RAM)", "error", 3000);
        }
        saveDashboardSettings(ns);
      }
      break;
    case "restart-share-daemon":
      {
        const currentSharePid = cachedData.pids.share;
        if (currentSharePid > 0) {
          ns.kill(currentSharePid);
          cachedData.pids.share = 0;
        }
        if (cmd.shareTargetPercent !== undefined) {
          setConfigValue(ns, "share", "targetPercent", String(cmd.shareTargetPercent));
        }
        const sharePid = ns.exec("daemons/share.js", "home", 1);
        if (sharePid > 0) {
          cachedData.pids.share = sharePid;
          const label = cmd.shareTargetPercent && cmd.shareTargetPercent > 0
            ? `Share daemon: ${cmd.shareTargetPercent}% cap`
            : "Share daemon: greedy mode";
          ns.toast(label, "success", 2000);
        } else {
          ns.toast("Failed to restart share daemon (not enough RAM)", "error", 3000);
        }
        saveDashboardSettings(ns);
      }
      break;
    case "stop-infiltration":
      {
        // Send stop signal to infiltration daemon via its control port
        const ctrlHandle = ns.getPortHandle(INFILTRATION_CONTROL_PORT);
        ctrlHandle.write(JSON.stringify({ action: "stop" }));
        ns.toast("Infiltration: stop requested (after current run)", "warning", 3000);
      }
      break;
    case "kill-infiltration":
      {
        const infPid = cachedData.pids.infiltration;
        if (infPid > 0) {
          ns.kill(infPid);
          cachedData.pids.infiltration = 0;
          cachedData.infiltrationStatus = null;
          ns.toast("Infiltration daemon killed", "warning", 2000);
        }
      }
      break;
    case "configure-infiltration":
      {
        const ctrlHandle = ns.getPortHandle(INFILTRATION_CONTROL_PORT);
        ctrlHandle.write(JSON.stringify({
          action: "configure",
          target: cmd.infiltrationTarget,
          solvers: cmd.infiltrationSolvers,
          rewardMode: cmd.infiltrationRewardMode,
        }));
        if (cmd.infiltrationRewardMode) {
          setConfigValue(ns, "infiltration", "rewardMode", cmd.infiltrationRewardMode);
          saveDashboardSettings(ns);
        }
        ns.toast("Infiltration config updated", "info", 2000);
      }
      break;
    case "set-gang-strategy":
    case "pin-gang-member":
    case "unpin-gang-member":
    case "ascend-gang-member":
    case "toggle-gang-purchases":
    case "set-gang-wanted-threshold":
    case "set-gang-ascension-thresholds":
    case "set-gang-training-threshold":
    case "set-gang-grow-target":
    case "set-gang-grow-respect-reserve":
    case "set-gang-territory-threshold":
    case "force-buy-equipment":
      {
        // Forward gang commands to the gang control port
        const gangCtrl = ns.getPortHandle(GANG_CONTROL_PORT);
        gangCtrl.write(JSON.stringify(cmd));
        ns.toast(`Gang: ${cmd.action.replace("gang-", "").replace(/-/g, " ")}`, "info", 2000);
      }
      break;
    case "set-hacknet-strategy":
      setConfigValue(ns, "hacknet", "spendStrategy", cmd.hacknetSpendStrategy ?? "money");
      ns.toast(`Hacknet: ${cmd.hacknetSpendStrategy} strategy`, "info", 2000);
      break;
    case "toggle-pserv-autobuy":
      setConfigValue(ns, "pserv", "autoBuy", cmd.pservAutoBuy ? "true" : "false");
      ns.toast(`Pserv: ${cmd.pservAutoBuy ? "auto-buy ON" : "monitor only"}`, "info", 2000);
      break;
    case "set-pserv-max-ram":
      setConfigValue(ns, "pserv", "maxRam", String(cmd.pservMaxRam ?? 0));
      ns.toast(`Pserv: RAM cap ${cmd.pservMaxRam ? ns.format.ram(cmd.pservMaxRam) : "removed (game max)"}`, "info", 2000);
      break;
    case "force-contract-attempt":
      if (cmd.contractHost && cmd.contractFile) {
        const contractsCtrl = ns.getPortHandle(CONTRACTS_CONTROL_PORT);
        contractsCtrl.write(JSON.stringify({ host: cmd.contractHost, file: cmd.contractFile }));
        ns.toast(`Contract: forcing attempt on ${cmd.contractHost}`, "info", 2000);
      }
      break;
    case "claim-focus":
      if (cmd.focusTarget !== undefined) {
        if (cachedData.pids.focus > 0) {
          // Forward to focus daemon via control port
          const focusCtrl = ns.getPortHandle(FOCUS_CONTROL_PORT);
          focusCtrl.write(JSON.stringify({ action: "set-holder", holder: cmd.focusTarget } as FocusControlMessage));
        } else {
          // Fallback: write config directly when focus daemon not running
          setConfigValue(ns, "focus", "holder", cmd.focusTarget);
          for (const key of conflictingSleeveKeys(readConfig(ns, "focus"), cmd.focusTarget)) {
            setConfigValue(ns, "focus", key, "none");
          }
        }
        if (cmd.focusTarget === "none") {
          ns.toast("Focus disabled — all daemons yielding", "info", 2000);
        } else {
          ns.toast(`Focus claimed by ${cmd.focusTarget} daemon`, "success", 2000);
        }
      }
      break;
    case "claim-sleeve-focus":
      if (cmd.focusSleeveTarget !== undefined) {
        const sleeveIndex = (cmd as FocusSleeveCommand).focusSleeveIndex;
        const sleeveLabel = sleeveIndex === undefined ? "All sleeves" : `Sleeve #${sleeveIndex}`;
        if (cachedData.pids.focus > 0) {
          // Forward to focus daemon via control port (no index = every sleeve)
          const focusCtrl = ns.getPortHandle(FOCUS_CONTROL_PORT);
          focusCtrl.write(JSON.stringify({
            action: "set-sleeve",
            sleeveIndex,
            sleeveDaemon: cmd.focusSleeveTarget,
          } as FocusControlMessage));
        } else {
          // Fallback: write config directly when focus daemon not running
          const primaryHolder = getConfigString(ns, "focus", "holder", "");
          if (cmd.focusSleeveTarget !== "none" && cmd.focusSleeveTarget === primaryHolder) {
            ns.toast(`${cmd.focusSleeveTarget} already holds primary focus`, "warning", 2000);
            break;
          }
          setConfigValue(ns, "focus", sleeveHolderKey(sleeveIndex), cmd.focusSleeveTarget);
        }
        if (cmd.focusSleeveTarget === "none") {
          ns.toast(`${sleeveLabel}: focus disabled`, "info", 2000);
        } else {
          ns.toast(`${sleeveLabel}: ${cmd.focusSleeveTarget} daemon`, "success", 2000);
        }
      }
      break;
    case "buy-selected-augments":
      {
        if (cmd.selectedAugs && cmd.selectedAugs.length > 0) {
          const script = "actions/purchase-augments.js";
          const args = ["--only", JSON.stringify(cmd.selectedAugs)];
          const requiredRam = ns.getScriptRam(script, "home");
          let available = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");

          if (available < requiredRam) {
            const safeTiers = KILL_TIERS.slice(0, -1);
            let deficit = requiredRam - available;
            for (const tierScripts of safeTiers) {
              if (deficit <= 0) break;
              const processes = ns.ps("home");
              const tierProcs = processes
                .filter(p => tierScripts.includes(p.filename))
                .sort((a, b) => (ns.getScriptRam(b.filename, "home") * b.threads)
                              - (ns.getScriptRam(a.filename, "home") * a.threads));
              for (const proc of tierProcs) {
                if (deficit <= 0) break;
                ns.kill(proc.pid);
                deficit -= ns.getScriptRam(proc.filename, "home") * proc.threads;
              }
            }
            available = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
          }

          if (available >= requiredRam) {
            const pid = ns.exec(script, "home", 1, ...args);
            if (pid > 0) {
              ns.toast(`Buying ${cmd.selectedAugs.length} selected augments...`, "success", 2000);
            } else {
              ns.toast("Failed to launch purchase-augments", "error", 3000);
            }
          } else {
            ns.toast(
              `Not enough RAM for purchase-augments (need ${ns.format.ram(requiredRam)}, have ${ns.format.ram(available)})`,
              "error", 4000
            );
          }
        }
      }
      break;
    case "restart-stocks-daemon":
      {
        const currentStocksPid = cachedData.pids.stocks;
        if (currentStocksPid > 0) {
          ns.kill(currentStocksPid);
          cachedData.pids.stocks = 0;
        }
        const stocksPid = ns.exec("daemons/stocks.js", "home", 1);
        if (stocksPid > 0) {
          cachedData.pids.stocks = stocksPid;
          ns.toast("Stocks daemon restarted", "success", 2000);
        } else {
          ns.toast("Failed to restart stocks daemon (not enough RAM)", "error", 3000);
        }
      }
      break;
    case "reset-stocks-pnl":
      {
        const stocksCtrl = ns.getPortHandle(STOCKS_CONTROL_PORT);
        stocksCtrl.write(JSON.stringify({ action: "reset-pnl" }));
        ns.toast("Stocks: P&L and trade history reset", "info", 2000);
      }
      break;
    case "stocks-control":
      {
        const stocksCtrl = ns.getPortHandle(STOCKS_CONTROL_PORT);
        stocksCtrl.write(JSON.stringify({ action: cmd.stocksControlAction }));
      }
      break;
    case "set-stocks-profile":
      {
        // Presets come from the controller so the daemon's detectActiveProfile matches
        // exactly what was written.
        const profile = cmd.stocksProfile && cmd.stocksProfile in TRADING_PROFILES
          ? profileConfigValues(cmd.stocksProfile as Exclude<TradingProfileName, "custom">)
          : null;
        if (profile) {
          for (const [key, value] of Object.entries(profile)) {
            setConfigValue(ns, "stocks", key, value);
          }
          const stocksCtrl = ns.getPortHandle(STOCKS_CONTROL_PORT);
          stocksCtrl.write(JSON.stringify({ action: "reload-config" }));
          ns.toast(`Stocks: ${cmd.stocksProfile} profile applied`, "success", 2000);
        }
      }
      break;
    case "restart-gang-daemon":
      {
        const currentGangPid = cachedData.pids.gang;
        if (currentGangPid > 0) {
          ns.kill(currentGangPid);
          cachedData.pids.gang = 0;
        }
        // gang.ts reads strategy from config (not CLI args) — persist before restart.
        if (cmd.gangStrategy) setConfigValue(ns, "gang", "strategy", cmd.gangStrategy);
        const gangPid = ns.exec("daemons/gang.js", "home", 1);
        if (gangPid > 0) {
          cachedData.pids.gang = gangPid;
          ns.toast(cmd.gangStrategy ? `Gang daemon: ${cmd.gangStrategy} strategy` : "Gang daemon restarted", "success", 2000);
        } else {
          ns.toast("Failed to restart gang daemon (not enough RAM)", "error", 3000);
        }
      }
      break;
    case "rush-budget-bucket":
      {
        const budgetCtrl = ns.getPortHandle(BUDGET_CONTROL_PORT);
        budgetCtrl.write(JSON.stringify({ action: "rush", bucket: cmd.budgetBucket }));
        ns.toast(`Budget: rushing ${cmd.budgetBucket}`, "info", 2000);
      }
      break;
    case "cancel-budget-rush":
      {
        const budgetCtrl = ns.getPortHandle(BUDGET_CONTROL_PORT);
        budgetCtrl.write(JSON.stringify({ action: "cancel-rush", bucket: "" }));
        ns.toast("Budget: rush cancelled", "info", 2000);
      }
      break;
    case "update-budget-weight":
      {
        const budgetCtrl = ns.getPortHandle(BUDGET_CONTROL_PORT);
        budgetCtrl.write(JSON.stringify({ action: "update-weight", bucket: cmd.budgetBucket, weight: cmd.budgetWeight }));
        ns.toast(`Budget: ${cmd.budgetBucket} weight → ${cmd.budgetWeight}`, "info", 2000);
      }
      break;
    case "reset-budget-weights":
      {
        const budgetCtrl = ns.getPortHandle(BUDGET_CONTROL_PORT);
        budgetCtrl.write(JSON.stringify({ action: "reset-weights", bucket: "" }));
        ns.toast("Budget: weights reset to defaults", "info", 2000);
      }
      break;
    case "freeze-budget-bucket":
      {
        const budgetCtrl = ns.getPortHandle(BUDGET_CONTROL_PORT);
        budgetCtrl.write(JSON.stringify({ action: "freeze", bucket: cmd.budgetBucket }));
        ns.toast(`Budget: ${cmd.budgetBucket} frozen`, "info", 2000);
      }
      break;
    case "unfreeze-budget-bucket":
      {
        const budgetCtrl = ns.getPortHandle(BUDGET_CONTROL_PORT);
        budgetCtrl.write(JSON.stringify({ action: "unfreeze", bucket: cmd.budgetBucket }));
        ns.toast(`Budget: ${cmd.budgetBucket} unfrozen`, "info", 2000);
      }
      break;
    case "toggle-home-autobuy":
      setConfigValue(ns, "home", "autoBuy", cmd.homeAutoBuy ? "true" : "false");
      ns.toast(`Home: ${cmd.homeAutoBuy ? "auto-buy ON" : "monitor only"}`, "info", 2000);
      break;
    case "set-corp-directive":
      {
        const corpCtrl = ns.getPortHandle(CORP_CONTROL_PORT);
        setConfigValue(ns, "corp", "directive", cmd.corpDirective ?? "bootstrap");
        corpCtrl.write(JSON.stringify({ action: "set-directive", directive: cmd.corpDirective }));
        ns.toast(`Corp: directive → ${cmd.corpDirective}`, "success", 2000);
      }
      break;
    case "cancel-corp-pending":
      {
        const corpCtrl = ns.getPortHandle(CORP_CONTROL_PORT);
        corpCtrl.write(JSON.stringify({ action: "cancel-pending" }));
        ns.toast("Corp: pending action cancelled", "info", 2000);
      }
      break;
    case "toggle-corp-pin":
      {
        const corpCtrl = ns.getPortHandle(CORP_CONTROL_PORT);
        setConfigValue(ns, "corp", "pinDirective", cmd.corpPinned ? "true" : "false");
        corpCtrl.write(JSON.stringify({ action: "pin-directive", pinned: cmd.corpPinned }));
        ns.toast(`Corp: directive ${cmd.corpPinned ? "pinned" : "unpinned"}`, "info", 2000);
      }
      break;
    case "toggle-corp-auto-tea":
      {
        const corpCtrl = ns.getPortHandle(CORP_CONTROL_PORT);
        corpCtrl.write(JSON.stringify({ action: "toggle-auto-tea", autoTea: cmd.corpAutoTea }));
        setConfigValue(ns, "corp", "autoTea", cmd.corpAutoTea ? "true" : "false");
        ns.toast(`Corp: auto-tea ${cmd.corpAutoTea ? "ON" : "OFF"}`, "info", 2000);
      }
      break;
    case "set-corp-dividend-rate":
      {
        const corpCtrl = ns.getPortHandle(CORP_CONTROL_PORT);
        corpCtrl.write(JSON.stringify({ action: "set-dividend-rate", dividendRate: cmd.corpDividendRate }));
        ns.toast(`Corp: dividend rate → ${((cmd.corpDividendRate ?? 0) * 100).toFixed(1)}%`, "info", 2000);
      }
      break;
    case "restart-corp-daemon":
      {
        const currentCorpPid = cachedData.pids.corp;
        if (currentCorpPid > 0) {
          ns.kill(currentCorpPid);
          cachedData.pids.corp = 0;
        }
        const corpPid = ns.exec("daemons/corp.js", "home", 1);
        if (corpPid > 0) {
          cachedData.pids.corp = corpPid;
          ns.toast("Corp daemon restarted", "success", 2000);
        } else {
          ns.toast("Failed to restart corp daemon (not enough RAM)", "error", 3000);
        }
      }
      break;
    case "toggle-corp-enabled":
      {
        const enabled = cmd.corpEnabled ?? true;
        setConfigValue(ns, "corp", "enabled", enabled ? "true" : "false");
        cachedData.corpEnabled = enabled;

        if (enabled) {
          // Remove "corp" from budget done markers
          const markerFile = "/data/budget-done.txt";
          const existing = ns.read(markerFile);
          if (existing) {
            const filtered = existing.split("\n").filter(Boolean).filter(b => b !== "corp");
            ns.write(markerFile, filtered.join("\n"), "w");
          }
          // Reactivate budget bucket
          const budgetCtrl = ns.getPortHandle(BUDGET_CONTROL_PORT);
          budgetCtrl.write(JSON.stringify({ action: "reactivate", bucket: "corp" }));
          // Start daemon
          startTool(ns, "corp");
          ns.toast("Corp enabled — daemon starting", "success", 2000);
        } else {
          // Stop daemon
          stopTool(ns, "corp");
          // Signal budget to deactivate corp bucket
          const markerFile = "/data/budget-done.txt";
          const existing = ns.read(markerFile);
          const doneBuckets = existing ? existing.split("\n").filter(Boolean) : [];
          if (!doneBuckets.includes("corp")) {
            doneBuckets.push("corp");
            ns.write(markerFile, doneBuckets.join("\n"), "w");
          }
          const budgetCtrl = ns.getPortHandle(BUDGET_CONTROL_PORT);
          budgetCtrl.write(JSON.stringify({ action: "done", bucket: "corp" }));
          ns.toast("Corp disabled — will not run on aug install", "warning", 3000);
        }
      }
      break;

    case "restart-blade-daemon":
      {
        const currentBladePid = cachedData.pids.blade;
        if (currentBladePid > 0) {
          ns.kill(currentBladePid);
          cachedData.pids.blade = 0;
        }
        cachedData.bladeburnerStatus = null;
        const bladePid = ns.exec(TOOL_SCRIPTS.blade, "home");
        if (bladePid > 0) {
          cachedData.pids.blade = bladePid;
          ns.toast("Blade daemon restarted", "success", 2000);
        }
      }
      break;

    case "blade-buy-skill":
      if (cmd.bladeSkillName) {
        setConfigValue(ns, "blade", "buySkill", cmd.bladeSkillName);
        ns.toast(`Queued skill purchase: ${cmd.bladeSkillName}`, "info", 2000);
      }
      break;

    case "blade-buy-all-skills":
      setConfigValue(ns, "blade", "buyAllSkills", "true");
      ns.toast("Buying all recommended skills...", "info", 2000);
      break;

    case "set-blade-config":
      if (cmd.bladeConfigKey && cmd.bladeConfigValue !== undefined) {
        setConfigValue(ns, "blade", cmd.bladeConfigKey, cmd.bladeConfigValue);
        ns.toast(`Blade: ${cmd.bladeConfigKey} = ${cmd.bladeConfigValue}`, "info", 2000);
      }
      break;

    case "reset-start-config":
      resetStartupConfig(ns);
      ns.toast("Startup config reset to defaults", "success", 3000);
      break;
  }
}

/**
 * Open tail for a tool's process.
 */
function openTail(ns: NS, tool: ToolName): void {
  const pid = cachedData.pids[tool];
  if (pid > 0) {
    ns.ui.openTail(pid);
  }
}

/**
 * Execute a one-off script.
 */
function executeScript(ns: NS, scriptPath: string, args: string[]): void {
  const pid = ns.exec(scriptPath, "home", 1, ...args);
  if (pid > 0) {
    ns.toast(`Started ${scriptPath}`, "success", 2000);
  } else {
    ns.toast(`Failed to start ${scriptPath}`, "error", 4000);
  }
}

// === UI STATE ===

export interface TabState {
  group: number; // -1 = Overview, 0..N = index into TAB_GROUPS
  sub: number;   // index within the group's plugins
}

interface UIState {
  activeTab: TabState;
  pluginUIState: Record<ToolName, Record<string, unknown>>;
}

const uiState: UIState = {
  activeTab: { group: -1, sub: 0 },
  pluginUIState: {
    nuke: {},
    pserv: {},
    share: {},
    rep: {},
    hack: {},
    darkweb: {},
    work: {},
    faction: {},
    infiltration: {},
    gang: {},
    augments: {},
    advisor: {},
    contracts: {},
    budget: {},
    stocks: {},
    casino: {},
    home: {},
    corp: {},
    blade: {},
    hacknet: {},
    focus: {},
    darknet: {},
  },
};

export function getActiveTab(): TabState {
  return uiState.activeTab;
}

export function setActiveTab(tab: TabState): void {
  uiState.activeTab = tab;
}

export function getPluginUIState<T>(plugin: ToolName, key: string, defaultVal: T): T {
  const pluginState = uiState.pluginUIState[plugin];
  if (pluginState && key in pluginState) {
    return pluginState[key] as T;
  }
  return defaultVal;
}

export function setPluginUIState(plugin: ToolName, key: string, value: unknown): void {
  uiState.pluginUIState[plugin][key] = value;
}

// === PERSISTENT SETTINGS ===

const SETTINGS_FILE = "/data/dashboard-settings.txt";

interface DashboardSettings {
  hack: {
    strategy: string;
    maxBatches: number;
    homeReserve: number;
  };
  share: {
    targetPercent: number;
  };
  infiltration?: {
    rewardMode: string;
  };
}

/**
 * Save current hack/share settings to a file for persistence across restarts.
 */
export function saveDashboardSettings(ns: NS): void {
  const settings: DashboardSettings = {
    hack: {
      strategy: (uiState.pluginUIState.hack.strategy as string) || "money",
      maxBatches: (uiState.pluginUIState.hack.maxBatches as number) || 1,
      homeReserve: (uiState.pluginUIState.hack.homeReserve as number) || 640,
    },
    share: {
      targetPercent: (uiState.pluginUIState.share.targetPercent as number) || 0,
    },
    infiltration: {
      rewardMode: (uiState.pluginUIState.infiltration.rewardMode as string) || "rep",
    },
  };
  ns.write(SETTINGS_FILE, JSON.stringify(settings), "w");
}

/**
 * Load saved settings from file and populate pluginUIState.
 */
export function loadDashboardSettings(ns: NS): void {
  if (!ns.fileExists(SETTINGS_FILE)) return;

  try {
    const raw = ns.read(SETTINGS_FILE);
    const settings = JSON.parse(raw) as DashboardSettings;

    if (settings.hack) {
      if (settings.hack.strategy) uiState.pluginUIState.hack.strategy = settings.hack.strategy;
      if (settings.hack.maxBatches !== undefined) uiState.pluginUIState.hack.maxBatches = settings.hack.maxBatches;
      if (settings.hack.homeReserve !== undefined) uiState.pluginUIState.hack.homeReserve = settings.hack.homeReserve;
    }
    if (settings.share) {
      if (settings.share.targetPercent !== undefined) uiState.pluginUIState.share.targetPercent = settings.share.targetPercent;
    }
    if (settings.infiltration) {
      if (settings.infiltration.rewardMode) uiState.pluginUIState.infiltration.rewardMode = settings.infiltration.rewardMode;
    }
  } catch {
    // Invalid settings file, ignore
  }
}

// === CACHED DATA ===

interface CachedData {
  pids: Record<ToolName, number>;
  nukeStatus: NukeStatus | null;
  pservStatus: PservStatus | null;
  shareStatus: ShareStatus | null;
  repStatus: RepStatus | null;
  repError: string | null;
  hackStatus: HackStatus | null;
  darkwebStatus: DarkwebStatus | null;
  darkwebError: string | null;
  workStatus: WorkStatus | null;
  workError: string | null;
  bitnodeStatus: BitnodeStatus | null;
  factionStatus: FactionStatus | null;
  factionError: string | null;
  fleetAllocation: FleetAllocation | null;
  infiltrationStatus: InfiltrationStatus | null;
  gangStatus: GangStatus | null;
  augmentsStatus: AugmentsStatus | null;
  advisorStatus: AdvisorStatus | null;
  contractsStatus: ContractsStatus | null;
  budgetStatus: BudgetStatus | null;
  stocksStatus: StocksStatus | null;
  casinoStatus: CasinoStatus | null;
  homeStatus: HomeStatus | null;
  corpStatus: CorpStatus | null;
  corpEnabled: boolean;
  bladeburnerStatus: BladeburnerStatus | null;
  hacknetStatus: HacknetStatus | null;
  focusStatus: FocusStatus | null;
  startupConfig: StartupConfigEntry[];
  darknetStatus: DarknetStatus | null;
}

const cachedData: CachedData = {
  pids: { nuke: 0, pserv: 0, share: 0, rep: 0, hack: 0, darkweb: 0, work: 0, faction: 0, infiltration: 0, gang: 0, augments: 0, advisor: 0, contracts: 0, budget: 0, stocks: 0, casino: 0, home: 0, corp: 0, blade: 0, hacknet: 0, focus: 0, darknet: 0 },
  nukeStatus: null,
  pservStatus: null,
  shareStatus: null,
  repStatus: null,
  repError: null,
  hackStatus: null,
  darkwebStatus: null,
  darkwebError: null,
  workStatus: null,
  workError: null,
  bitnodeStatus: null,
  factionStatus: null,
  factionError: null,
  fleetAllocation: null,
  infiltrationStatus: null,
  gangStatus: null,
  augmentsStatus: null,
  advisorStatus: null,
  contractsStatus: null,
  budgetStatus: null,
  stocksStatus: null,
  casinoStatus: null,
  homeStatus: null,
  corpStatus: null,
  corpEnabled: true,
  bladeburnerStatus: null,
  hacknetStatus: null,
  focusStatus: null,
  startupConfig: [],
  darknetStatus: null,
};

// === PORT-BASED STATUS READING ===

/** Port data older than this is considered stale (e.g. from a previous session). */
const STALE_THRESHOLD_MS = 30_000;

/**
 * Read all status ports and update cached data.
 * Replaces the old updatePluginsIfNeeded() which called controller functions.
 * This is extremely lightweight — just port.peek() + JSON.parse.
 * Uses staleness threshold to auto-expire data from previous sessions.
 */
export function readStatusPorts(ns: NS): void {
  cachedData.nukeStatus = peekStatus<NukeStatus>(ns, STATUS_PORTS.nuke, STALE_THRESHOLD_MS);
  cachedData.hackStatus = peekStatus<HackStatus>(ns, STATUS_PORTS.hack, STALE_THRESHOLD_MS);

  // Sync UI state from daemon's published status (reflects auto-mode changes)
  if (cachedData.hackStatus) {
    const hs = cachedData.hackStatus;
    if (hs.maxBatches !== undefined) {
      uiState.pluginUIState.hack.maxBatches = hs.maxBatches;
    }
    if (hs.strategy) {
      uiState.pluginUIState.hack.strategy = hs.strategy;
    }
  }

  const pserv = peekStatus<PservStatus>(ns, STATUS_PORTS.pserv, STALE_THRESHOLD_MS);
  // Preserve last status when daemon exited after completing (all servers maxed)
  if (pserv || !(cachedData.pservStatus?.allMaxed && cachedData.pservStatus.serverCount >= cachedData.pservStatus.serverCap)) {
    cachedData.pservStatus = pserv;
  }
  cachedData.shareStatus = peekStatus<ShareStatus>(ns, STATUS_PORTS.share, STALE_THRESHOLD_MS);

  const rep = peekStatus<RepStatus>(ns, STATUS_PORTS.rep, STALE_THRESHOLD_MS);
  cachedData.repStatus = rep;
  if (rep) cachedData.repError = null;

  const work = peekStatus<WorkStatus>(ns, STATUS_PORTS.work, STALE_THRESHOLD_MS);
  cachedData.workStatus = work;
  if (work) cachedData.workError = null;

  const darkweb = peekStatus<DarkwebStatus>(ns, STATUS_PORTS.darkweb, STALE_THRESHOLD_MS);
  // Preserve last status when daemon exited after completing (all programs owned)
  if (darkweb || !cachedData.darkwebStatus?.allOwned) {
    cachedData.darkwebStatus = darkweb;
  }
  if (darkweb) cachedData.darkwebError = null;

  cachedData.bitnodeStatus = peekStatus<BitnodeStatus>(ns, STATUS_PORTS.bitnode, STALE_THRESHOLD_MS);

  const faction = peekStatus<FactionStatus>(ns, STATUS_PORTS.faction, STALE_THRESHOLD_MS);
  cachedData.factionStatus = faction;
  if (faction) cachedData.factionError = null;

  cachedData.fleetAllocation = peekStatus<FleetAllocation>(ns, STATUS_PORTS.fleet, STALE_THRESHOLD_MS);

  cachedData.infiltrationStatus = peekStatus<InfiltrationStatus>(ns, STATUS_PORTS.infiltration, STALE_THRESHOLD_MS);

  cachedData.gangStatus = peekStatus<GangStatus>(ns, STATUS_PORTS.gang, STALE_THRESHOLD_MS);

  cachedData.augmentsStatus = peekStatus<AugmentsStatus>(ns, STATUS_PORTS.augments, STALE_THRESHOLD_MS);

  cachedData.advisorStatus = peekStatus<AdvisorStatus>(ns, STATUS_PORTS.advisor, STALE_THRESHOLD_MS);

  cachedData.contractsStatus = peekStatus<ContractsStatus>(ns, STATUS_PORTS.contracts, 120_000);

  cachedData.budgetStatus = peekStatus<BudgetStatus>(ns, STATUS_PORTS.budget, STALE_THRESHOLD_MS);

  cachedData.stocksStatus = peekStatus<StocksStatus>(ns, STATUS_PORTS.stocks, STALE_THRESHOLD_MS);

  cachedData.homeStatus = peekStatus<HomeStatus>(ns, STATUS_PORTS.home, STALE_THRESHOLD_MS);

  cachedData.corpStatus = peekStatus<CorpStatus>(ns, STATUS_PORTS.corp, STALE_THRESHOLD_MS);

  cachedData.corpEnabled = getConfigBool(ns, "corp", "enabled", true);

  cachedData.bladeburnerStatus = peekStatus<BladeburnerStatus>(ns, STATUS_PORTS.blade, STALE_THRESHOLD_MS);

  cachedData.hacknetStatus = peekStatus<HacknetStatus>(ns, STATUS_PORTS.hacknet, STALE_THRESHOLD_MS);

  cachedData.focusStatus = peekStatus<FocusStatus>(ns, STATUS_PORTS.focus, STALE_THRESHOLD_MS);

  // The daemon sleeps 30s when it lacks darknet access, so a longer max-age
  // avoids flicker between polls (precedent: the contracts peek above).
  cachedData.darknetStatus = peekStatus<DarknetStatus>(ns, STATUS_PORTS.darknet, 120_000);

  cachedData.startupConfig = readStartupConfig(ns);
}

// === STARTUP CONFIG ===

const START_CONFIG_PATH = "/config/start.txt";

/**
 * Parse the text contents of /config/start.txt into structured entries.
 * Pure (no ns access) so it can be unit tested directly.
 */
export function parseStartupConfig(raw: string): StartupConfigEntry[] {
  if (!raw) return [];

  const entries: StartupConfigEntry[] = [];
  let inCore = true;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    // Check section markers
    if (trimmed.includes("[core]")) { inCore = true; continue; }
    if (trimmed.includes("[optional]")) { inCore = false; continue; }

    if (trimmed.startsWith("#")) {
      // Commented-out daemon line (not a plain comment)
      const uncommented = trimmed.replace(/^#+\s*/, "");
      if (uncommented.endsWith(".js")) {
        entries.push({ path: uncommented, enabled: false, core: inCore });
      }
      continue;
    }

    if (trimmed.endsWith(".js")) {
      entries.push({ path: trimmed, enabled: true, core: inCore });
    }
  }

  return entries;
}

function readStartupConfig(ns: NS): StartupConfigEntry[] {
  const raw = ns.read(START_CONFIG_PATH);
  return parseStartupConfig(raw);
}

export function resetStartupConfig(ns: NS): void {
  // Import-free: just inline the default config from start.ts
  const defaultConfig = `# Startup Config
# Daemons listed here are launched by start.js in order.
# Comment out a line with # to skip it.
#
# [core] — launched with ensureRamAndExec (will kill workers for RAM)
# [optional] — launched only if free RAM is available

# [core]
daemons/nuke.js
daemons/hack.js
daemons/queue.js
daemons/darkweb.js
daemons/focus.js
daemons/work.js
daemons/rep.js
daemons/share.js

# [optional]
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
daemons/hacknet.js
daemons/darknet.js`;
  ns.write(START_CONFIG_PATH, defaultConfig, "w");
}

// === TOOL CONTROL ===

/** Clear cached status for a tool (used when stopping or when daemon dies). */
function clearToolStatus(tool: ToolName): void {
  switch (tool) {
    case "nuke":    cachedData.nukeStatus = null; break;
    case "hack":    cachedData.hackStatus = null; break;
    case "pserv":
      // Preserve status if daemon exited after completing (all servers maxed)
      if (!(cachedData.pservStatus?.allMaxed && cachedData.pservStatus.serverCount >= cachedData.pservStatus.serverCap)) {
        cachedData.pservStatus = null;
      }
      break;
    case "share":   cachedData.shareStatus = null; break;
    case "rep":     cachedData.repStatus = null; cachedData.repError = null; break;
    case "work":    cachedData.workStatus = null; cachedData.workError = null; break;
    case "darkweb":
      // Preserve status if daemon exited after completing (all programs owned)
      if (!cachedData.darkwebStatus?.allOwned) {
        cachedData.darkwebStatus = null;
      }
      cachedData.darkwebError = null;
      break;
    case "faction": cachedData.factionStatus = null; cachedData.factionError = null; break;
    case "infiltration": cachedData.infiltrationStatus = null; break;
    case "gang": cachedData.gangStatus = null; break;
    case "augments": cachedData.augmentsStatus = null; break;
    case "advisor": cachedData.advisorStatus = null; break;
    case "contracts": cachedData.contractsStatus = null; break;
    case "budget": cachedData.budgetStatus = null; break;
    case "stocks": cachedData.stocksStatus = null; break;
    case "casino": cachedData.casinoStatus = null; break;
    case "home": cachedData.homeStatus = null; break;
    case "corp": cachedData.corpStatus = null; break;
    case "blade": cachedData.bladeburnerStatus = null; break;
    case "hacknet": cachedData.hacknetStatus = null; break;
    case "focus": cachedData.focusStatus = null; break;
    case "darknet": cachedData.darknetStatus = null; break;
  }
}

function startTool(ns: NS, tool: ToolName): void {
  const currentPid = cachedData.pids[tool];
  if (currentPid > 0 && ns.isRunning(currentPid)) {
    return;
  }

  const script = TOOL_SCRIPTS[tool];
  const requiredRam = ns.getScriptRam(script, "home");
  if (requiredRam <= 0) {
    ns.toast(`Unknown script: ${script}`, "error", 4000);
    return;
  }

  let available = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");

  // If not enough RAM, walk kill tiers but SKIP the last tier (dashboard itself)
  if (available < requiredRam) {
    const safeTiers = KILL_TIERS.slice(0, -1);
    let deficit = requiredRam - available;

    for (const tierScripts of safeTiers) {
      if (deficit <= 0) break;
      const processes = ns.ps("home");
      const tierProcs = processes
        .filter(p => tierScripts.includes(p.filename))
        .sort((a, b) => (ns.getScriptRam(b.filename, "home") * b.threads)
                      - (ns.getScriptRam(a.filename, "home") * a.threads));
      for (const proc of tierProcs) {
        if (deficit <= 0) break;
        ns.kill(proc.pid);
        deficit -= ns.getScriptRam(proc.filename, "home") * proc.threads;
      }
    }

    available = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
  }

  if (available < requiredRam) {
    ns.toast(
      `Not enough RAM for ${tool} (need ${ns.format.ram(requiredRam)}, ` +
      `have ${ns.format.ram(available)}). Launch from CLI: run ${script}`,
      "error", 6000
    );
    return;
  }

  let pid: number;
  if (tool === "hack") {
    const hackState = uiState.pluginUIState.hack;
    const strategy = (hackState.strategy as string) || "money";
    const batches = (hackState.maxBatches as number) || 1;
    const reserve = (hackState.homeReserve as number) || 640;
    setConfigValue(ns, "hack", "strategy", strategy);
    setConfigValue(ns, "hack", "maxBatches", String(batches));
    setConfigValue(ns, "hack", "homeReserve", String(reserve));
    pid = ns.exec(script, "home", 1);
  } else if (tool === "share") {
    const shareState = uiState.pluginUIState.share;
    const targetPercent = (shareState.targetPercent as number) || 0;
    setConfigValue(ns, "share", "targetPercent", String(targetPercent));
    pid = ns.exec(script, "home", 1);
  } else if (tool === "infiltration") {
    const infState = uiState.pluginUIState.infiltration;
    const rewardMode = (infState.rewardMode as string) || "rep";
    setConfigValue(ns, "infiltration", "rewardMode", rewardMode);
    pid = ns.exec(script, "home");
  } else if (tool === "gang") {
    // gang.ts reads strategy from config (not CLI args).
    const gangState = uiState.pluginUIState.gang;
    const strategy = (gangState.strategy as string) || "";
    if (strategy) setConfigValue(ns, "gang", "strategy", strategy);
    pid = ns.exec(script, "home", 1);
  } else {
    pid = ns.exec(script, "home");
  }

  if (pid > 0) {
    cachedData.pids[tool] = pid;
    ns.toast(`Started ${tool}`, "success", 2000);
  } else {
    ns.toast(`Failed to start ${tool}`, "error", 4000);
  }
}

function stopTool(ns: NS, tool: ToolName): void {
  const pid = cachedData.pids[tool];
  if (pid > 0) {
    ns.kill(pid);
    cachedData.pids[tool] = 0;
    clearToolStatus(tool);
    // Clear focus holder if the stopped tool was holding focus
    if (tool === "work" || tool === "rep" || tool === "blade") {
      const currentHolder = getConfigString(ns, "focus", "holder", "");
      if (currentHolder === tool) {
        setConfigValue(ns, "focus", "holder", "");
      }
      for (const key of conflictingSleeveKeys(readConfig(ns, "focus"), tool)) {
        setConfigValue(ns, "focus", key, "none");
      }
    }
    ns.toast(`Stopped ${tool}`, "warning", 2000);
  }
}

export function getFleetAllocation(): FleetAllocation | null {
  return cachedData.fleetAllocation;
}

export function isCorpEnabled(): boolean {
  return cachedData.corpEnabled;
}

export function isToolRunning(tool: ToolName): boolean {
  return cachedData.pids[tool] > 0;
}

export function getToolPid(tool: ToolName): number {
  return cachedData.pids[tool];
}

export function setToolPid(tool: ToolName, pid: number): void {
  cachedData.pids[tool] = pid;
}

// === RUNNING TOOL DETECTION ===

export function detectRunningTools(ns: NS): void {
  const processes = ns.ps("home");
  for (const tool of Object.keys(TOOL_SCRIPTS) as ToolName[]) {
    const script = TOOL_SCRIPTS[tool];
    const proc = processes.find(p => p.filename === script);
    if (proc) {
      cachedData.pids[tool] = proc.pid;
    } else if (cachedData.pids[tool] > 0 && !ns.isRunning(cachedData.pids[tool])) {
      cachedData.pids[tool] = 0;
      clearToolStatus(tool);
    }
  }
}

export function syncPidState(ns: NS): void {
  for (const tool of Object.keys(cachedData.pids) as ToolName[]) {
    if (cachedData.pids[tool] > 0 && !ns.isRunning(cachedData.pids[tool])) {
      cachedData.pids[tool] = 0;
    }
  }
}

// === STATE SNAPSHOT ===

export function getStateSnapshot(): DashboardState {
  return {
    pids: { ...cachedData.pids },
    nukeStatus: cachedData.nukeStatus,
    pservStatus: cachedData.pservStatus,
    shareStatus: cachedData.shareStatus,
    repStatus: cachedData.repStatus,
    repError: cachedData.repError,
    hackStatus: cachedData.hackStatus,
    darkwebStatus: cachedData.darkwebStatus,
    darkwebError: cachedData.darkwebError,
    workStatus: cachedData.workStatus,
    workError: cachedData.workError,
    bitnodeStatus: cachedData.bitnodeStatus,
    factionStatus: cachedData.factionStatus,
    factionError: cachedData.factionError,
    fleetAllocation: cachedData.fleetAllocation,
    infiltrationStatus: cachedData.infiltrationStatus,
    gangStatus: cachedData.gangStatus,
    augmentsStatus: cachedData.augmentsStatus,
    advisorStatus: cachedData.advisorStatus,
    contractsStatus: cachedData.contractsStatus,
    budgetStatus: cachedData.budgetStatus,
    stocksStatus: cachedData.stocksStatus,
    casinoStatus: cachedData.casinoStatus,
    homeStatus: cachedData.homeStatus,
    corpStatus: cachedData.corpStatus,
    corpEnabled: cachedData.corpEnabled,
    bladeburnerStatus: cachedData.bladeburnerStatus,
    hacknetStatus: cachedData.hacknetStatus,
    focusStatus: cachedData.focusStatus,
    startupConfig: cachedData.startupConfig,
    darknetStatus: cachedData.darknetStatus,
  };
}
