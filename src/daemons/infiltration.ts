/**
 * Infiltration Daemon
 *
 * Automated infiltration state machine that navigates UI, solves mini-games,
 * and collects rewards. Triggered on-demand from the dashboard (not part of bootstrap).
 *
 * Fixed single-tier RAM model. No tiered pattern.
 * Uses DOM manipulation for game interaction, NS API for data and status publishing.
 */
import { NS, FactionName } from "@ns";
import { publishStatus, peekStatus } from "/lib/ports";
import { getConfigString, setConfigValue } from "/lib/config";
import {
  STATUS_PORTS,
  INFILTRATION_CONTROL_PORT,
  InfiltrationStatus,
  InfiltrationState,
  InfiltrationLogEntry,
  InfiltrationLocationInfo,
  RepStatus,
} from "/types/ports";
import { domUtils, installTrustBypass } from "/lib/dom";
import { SOLVERS, detectAndSolve } from "/lib/infiltration/solvers/index";
import { InfiltrationConfig, DEFAULT_CONFIG } from "/lib/infiltration/types";
import {
  navigateToCity,
  navigateToCompany,
  clickInfiltrateButton,
  clickStartButton,
  selectReward,
  isOnIntroScreen,
  isOnVictoryScreen,
  isOnCountdown,
  isInGame,
} from "/lib/infiltration/navigation";

// === SESSION STATE ===

let state: InfiltrationState = "IDLE";
let config: InfiltrationConfig = { ...DEFAULT_CONFIG };
let stopRequested = false;
let manualRewardPending = false;

// Current run tracking
let currentTarget: string | undefined;
let currentCity: string | undefined;
let currentGame = 0;
let totalGames = 0;
let currentSolver: string | undefined;

// Session stats
let runsCompleted = 0;
let runsFailed = 0;
let totalRepEarned = 0;
let totalCashEarned = 0;
const rewardBreakdown = { factionRep: 0, money: 0 };
const companyStats: Record<string, { attempts: number; successes: number; failures: number }> = {};

// Cached data
let locations: InfiltrationLocationInfo[] = [];

// Log buffer
const logBuffer: InfiltrationLogEntry[] = [];
const LOG_MAX = 100;

// Rep verification
let consecutiveZeroDeltas = 0;
let lastActualDelta = 0;
let lastExpectedDelta = 0;
let totalVerifiedRep = 0;

// Reward efficiency tracking
let observedMultiplier: number | null = null;

// Cached reward label for overlay (updated each publishCurrentStatus)
let overlayRewardLabel = "";

// Error state
let errorInfo: { message: string; solver?: string; timestamp: number } | undefined;

// NS reference for logging
let _ns: NS | null = null;

// === LOGGING ===

function log(level: InfiltrationLogEntry["level"], message: string): void {
  logBuffer.push({ timestamp: Date.now(), level, message });
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  // Also print to tail window for live debugging
  if (_ns) {
    const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN " : "INFO ";
    _ns.print(`[${prefix}] ${message}`);
  }
}

// === FORMATTING ===

function formatCompact(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(1) + "t";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toFixed(0);
}

// === STATUS PUBLISHING ===

function publishCurrentStatus(ns: NS): void {
  const successRate = (runsCompleted + runsFailed) > 0
    ? runsCompleted / (runsCompleted + runsFailed)
    : 0;

  // Read rep daemon status for expected reward display
  let expectedReward: InfiltrationStatus["expectedReward"];
  if (currentTarget) {
    const loc = locations.find(l => l.name === currentTarget);
    if (loc) {
      const repStatus = peekStatus<RepStatus>(ns, STATUS_PORTS.rep, config.rewardStaleThresholdMs);
      const faction = repStatus?.targetFaction;
      expectedReward = {
        tradeRep: loc.reward.tradeRep,
        sellCash: loc.reward.sellCash,
        faction: faction || undefined,
      };
    }
  }

  // Cache reward label for overlay
  if (expectedReward) {
    if (config.rewardMode === "money") {
      overlayRewardLabel = `$${ formatCompact(expectedReward.sellCash) } / run`;
    } else if (config.rewardMode === "rep" && expectedReward.faction) {
      overlayRewardLabel = `${formatCompact(expectedReward.tradeRep)} rep → ${expectedReward.faction}`;
    } else if (config.rewardMode === "rep") {
      overlayRewardLabel = `$${ formatCompact(expectedReward.sellCash) } / run (no faction)`;
    } else {
      overlayRewardLabel = "Manual reward";
    }
  } else if (config.rewardMode === "manual") {
    overlayRewardLabel = "Manual reward";
  } else if (config.rewardMode === "money") {
    overlayRewardLabel = "Farming: money";
  } else {
    overlayRewardLabel = "Farming: rep";
  }

  const status: InfiltrationStatus = {
    state,
    paused: stopRequested,
    currentTarget,
    currentCity,
    currentGame: currentGame > 0 ? currentGame : undefined,
    totalGames: totalGames > 0 ? totalGames : undefined,
    currentSolver,
    expectedReward,
    runsCompleted,
    runsFailed,
    successRate,
    totalRepEarned,
    totalCashEarned,
    rewardBreakdown: { ...rewardBreakdown },
    companyStats: { ...companyStats },
    config: {
      targetCompanyOverride: config.targetCompanyOverride,
      rewardMode: config.rewardMode,
      enabledSolvers: Array.from(config.enabledSolvers),
    },
    rewardVerification: {
      lastActualDelta,
      lastExpectedDelta,
      consecutiveZeroDeltas,
      totalVerifiedRep,
      observedMultiplier,
    },
    log: [...logBuffer],
    error: errorInfo,
    locations: [...locations],
  };

  publishStatus(ns, STATUS_PORTS.infiltration, status);
  updateOverlay();
}

// === DATA FETCHING ===

function queryLocations(ns: NS): InfiltrationLocationInfo[] {
  const result: InfiltrationLocationInfo[] = [];

  try {
    const possibleLocations = ns.infiltration.getPossibleLocations();
    for (const loc of possibleLocations) {
      try {
        const data = ns.infiltration.getInfiltration(loc.name);
        result.push({
          name: loc.name,
          city: loc.city,
          difficulty: data.difficulty,
          maxClearanceLevel: data.maxClearanceLevel,
          startingSecurityLevel: data.startingSecurityLevel,
          reward: {
            tradeRep: data.reward.tradeRep,
            sellCash: data.reward.sellCash,
          },
        });
      } catch {
        // Skip locations that error
      }
    }
  } catch {
    // API may not be available
  }

  return result;
}

function selectTarget(): InfiltrationLocationInfo | null {
  if (locations.length === 0) return null;

  if (config.targetCompanyOverride) {
    const override = locations.find(l => l.name === config.targetCompanyOverride);
    if (!override) return null;
    return override;
  }

  // Pick by best reward-per-level for the current reward mode
  const rewardPerLevel = (loc: InfiltrationLocationInfo): number =>
    config.rewardMode === "money"
      ? loc.reward.sellCash / loc.maxClearanceLevel
      : loc.reward.tradeRep / loc.maxClearanceLevel;

  return locations.reduce((best, loc) => {
    const locRpl = rewardPerLevel(loc);
    const bestRpl = rewardPerLevel(best);
    if (locRpl !== bestRpl) return locRpl > bestRpl ? loc : best;
    // Tie-break: prefer more levels (amortizes navigation overhead)
    return loc.maxClearanceLevel > best.maxClearanceLevel ? loc : best;
  });
}

// === REWARD STRATEGY ===

function determineRewardType(ns: NS): { type: "faction-rep" | "money"; faction?: string } {
  if (config.rewardMode === "money") {
    return { type: "money" };
  }

  // Rep mode: use faction rep if a target faction is available, otherwise fall back to money
  const repStatus = peekStatus<RepStatus>(ns, STATUS_PORTS.rep, config.rewardStaleThresholdMs);
  if (repStatus?.targetFaction) {
    return { type: "faction-rep", faction: repStatus.targetFaction };
  }

  return { type: "money" };
}

// === CONTROL PORT ===

function checkControlPort(ns: NS): void {
  const handle = ns.getPortHandle(INFILTRATION_CONTROL_PORT);
  while (!handle.empty()) {
    const data = handle.read();
    if (data === "NULL PORT DATA") break;

    try {
      const msg = JSON.parse(data as string) as { action: string; target?: string; solvers?: string[]; rewardMode?: "rep" | "money" | "manual" };

      switch (msg.action) {
        case "stop":
          stopRequested = true;
          log("info", "Stop requested — will finish current run");
          break;
        case "configure":
          if (msg.target !== undefined) {
            config.targetCompanyOverride = msg.target || undefined;
            log("info", `Target override: ${msg.target || "auto"}`);
          }
          if (msg.rewardMode) {
            config.rewardMode = msg.rewardMode;
            log("info", `Reward mode: ${msg.rewardMode}`);
          }
          if (msg.solvers) {
            config.enabledSolvers = new Set(msg.solvers);
            log("info", `Enabled solvers updated: ${msg.solvers.join(", ")}`);
          }
          break;
      }
    } catch {
      // Invalid control message
    }
  }
}

// === FLOATING OVERLAY ===

const OVERLAY_ID = "infiltration-overlay";

function createOverlay(): void {
  const doc = globalThis["document"] as Document;
  if (doc.getElementById(OVERLAY_ID)) return;

  const overlay = doc.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = [
    "position: fixed",
    "bottom: 16px",
    "right: 16px",
    "width: 200px",
    "background: rgba(20, 20, 30, 0.85)",
    "border: 1px solid rgba(100, 200, 255, 0.3)",
    "border-radius: 6px",
    "padding: 10px 12px",
    "color: #c8e6ff",
    "font-family: monospace",
    "font-size: 12px",
    "z-index: 10000",
    "pointer-events: auto",
    "user-select: none",
  ].join("; ");

  const progressLine = doc.createElement("div");
  progressLine.id = `${OVERLAY_ID}-progress`;
  progressLine.style.marginBottom = "8px";
  progressLine.textContent = "Infiltration starting...";

  const btn = doc.createElement("button");
  btn.id = `${OVERLAY_ID}-btn`;
  btn.textContent = "Stop After Run";
  btn.style.cssText = [
    "width: 100%",
    "padding: 4px 8px",
    "background: rgba(255, 100, 100, 0.2)",
    "border: 1px solid rgba(255, 100, 100, 0.5)",
    "border-radius: 4px",
    "color: #ffa0a0",
    "font-family: monospace",
    "font-size: 11px",
    "cursor: pointer",
  ].join("; ");
  btn.addEventListener("click", () => {
    stopRequested = true;
    btn.textContent = "Stopping...";
    btn.style.color = "#ff4444";
    btn.style.borderColor = "#ff4444";
    btn.disabled = true;
  });

  const rewardLine = doc.createElement("div");
  rewardLine.id = `${OVERLAY_ID}-reward`;
  rewardLine.style.cssText = "margin-bottom: 8px; color: #90d080; font-size: 11px;";

  const modeSelect = doc.createElement("select");
  modeSelect.id = `${OVERLAY_ID}-mode`;
  modeSelect.style.cssText = [
    "width: 100%",
    "margin-bottom: 8px",
    "padding: 3px 4px",
    "background: rgba(30, 30, 50, 0.9)",
    "border: 1px solid rgba(100, 200, 255, 0.3)",
    "border-radius: 4px",
    "color: #c8e6ff",
    "font-family: monospace",
    "font-size: 11px",
    "cursor: pointer",
  ].join("; ");
  for (const [value, label] of [["rep", "Rep"], ["money", "Money"], ["manual", "Manual"]] as const) {
    const opt = doc.createElement("option");
    opt.value = value;
    opt.textContent = label;
    opt.style.background = "#1e1e32";
    modeSelect.appendChild(opt);
  }
  modeSelect.value = config.rewardMode;
  modeSelect.addEventListener("change", () => {
    const val = modeSelect.value as "rep" | "money" | "manual";
    config.rewardMode = val;
    if (_ns) {
      setConfigValue(_ns, "infiltration", "rewardMode", val);
      publishCurrentStatus(_ns);
    }
  });

  overlay.appendChild(progressLine);
  overlay.appendChild(rewardLine);
  overlay.appendChild(modeSelect);
  overlay.appendChild(btn);
  doc.body.appendChild(overlay);
}

function updateOverlay(): void {
  const doc = globalThis["document"] as Document;
  const progress = doc.getElementById(`${OVERLAY_ID}-progress`);
  if (!progress) return;

  let text: string;
  if (state === "IDLE" || state === "QUERYING") {
    text = "Preparing...";
  } else if (currentTarget && totalGames > 0) {
    text = `${currentGame}/${totalGames} — ${currentTarget}`;
  } else if (currentTarget) {
    text = currentTarget;
  } else {
    text = state;
  }

  if (runsCompleted > 0 || runsFailed > 0) {
    text += `\n✓${runsCompleted} ✗${runsFailed}`;
  }

  if (observedMultiplier !== null) {
    text += `\nEff: ${(observedMultiplier * 100).toFixed(1)}%`;
  }

  progress.textContent = text;
  progress.style.whiteSpace = "pre-line";

  // Update reward info line
  const rewardEl = doc.getElementById(`${OVERLAY_ID}-reward`);
  if (rewardEl) {
    rewardEl.textContent = overlayRewardLabel;
    rewardEl.style.color = config.rewardMode === "money" ? "#e0d080" : "#90d080";
  }

  // Sync mode dropdown (may have been changed via dashboard control port)
  const modeSelect = doc.getElementById(`${OVERLAY_ID}-mode`) as HTMLSelectElement | null;
  if (modeSelect && modeSelect.value !== config.rewardMode) {
    modeSelect.value = config.rewardMode;
  }

  // Reset button between runs if not stopping
  const btn = doc.getElementById(`${OVERLAY_ID}-btn`) as HTMLButtonElement | null;
  if (btn && !stopRequested) {
    btn.textContent = "Stop After Run";
    btn.style.color = "#ffa0a0";
    btn.style.borderColor = "rgba(255, 100, 100, 0.5)";
    btn.disabled = false;
  }
}

function removeOverlay(): void {
  const doc = globalThis["document"] as Document;
  const overlay = doc.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
}

// === SINGLE INFILTRATION RUN ===

async function runSingleInfiltration(ns: NS): Promise<boolean> {
  const doc = globalThis["document"] as Document;

  // QUERYING
  state = "QUERYING";
  publishCurrentStatus(ns);
  log("info", "Querying infiltration data...");

  locations = queryLocations(ns);
  if (locations.length === 0) {
    throw new Error("No infiltratable locations found");
  }

  const target = selectTarget();
  if (!target) {
    throw new Error(config.targetCompanyOverride
      ? `Configured company "${config.targetCompanyOverride}" not found`
      : "No valid target found");
  }

  currentTarget = target.name;
  currentCity = target.city;
  totalGames = target.maxClearanceLevel;
  currentGame = 0;
  log("info", `Target: ${target.name} in ${target.city} (difficulty ${target.difficulty.toFixed(1)}, ${totalGames} levels)`);

  // Record company attempt
  if (!companyStats[target.name]) {
    companyStats[target.name] = { attempts: 0, successes: 0, failures: 0 };
  }
  companyStats[target.name].attempts++;

  // NAVIGATING
  state = "NAVIGATING";
  publishCurrentStatus(ns);
  log("info", `Navigating to ${target.name} in ${target.city}...`);

  // Travel to the target city if not already there
  try {
    const currentCity = ns.getPlayer().city;
    if (currentCity !== target.city) {
      log("info", `Traveling from ${currentCity} to ${target.city}...`);
      const traveled = ns.singularity.travelToCity(target.city as "Aevum");
      if (!traveled) {
        throw new Error(`Could not travel to ${target.city} (need $200k)`);
      }
      await domUtils.sleep(500);
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("Could not travel")) throw e;
    // singularity API may not be available — log and continue, hope we're in the right city
    log("warn", `Travel API unavailable: ${msg}`);
  }

  const MAX_INFILTRATE_ATTEMPTS = 3;
  let infiltrateSuccess = false;

  for (let attempt = 1; attempt <= MAX_INFILTRATE_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        log("info", `Infiltrate attempt ${attempt}/${MAX_INFILTRATE_ATTEMPTS}...`);
        await navigateToCity(domUtils);
        await domUtils.sleep(500);
        await navigateToCompany(domUtils, target.name);
        await domUtils.sleep(500);
      } else {
        await navigateToCity(domUtils);
        await domUtils.sleep(300);
        await navigateToCompany(domUtils, target.name);
        await domUtils.sleep(300);
      }

      await clickInfiltrateButton(domUtils);
      await domUtils.sleep(500);

      // Wait for intro screen to appear (up to 3 seconds)
      const introDeadline = Date.now() + 3000;
      while (Date.now() < introDeadline) {
        if (isOnIntroScreen() || isInGame() || isOnCountdown()) {
          infiltrateSuccess = true;
          break;
        }
        await domUtils.sleep(100);
      }

      if (infiltrateSuccess) break;
      log("warn", `Infiltrate button click did not open infiltration UI (attempt ${attempt})`);
    } catch (e) {
      log("warn", `Navigation attempt ${attempt} failed: ${(e as Error).message}`);
      if (attempt === MAX_INFILTRATE_ATTEMPTS) {
        throw new Error(`Navigation failed after ${MAX_INFILTRATE_ATTEMPTS} attempts: ${(e as Error).message}`);
      }
      await domUtils.sleep(1000);
    }
  }

  if (!infiltrateSuccess) {
    throw new Error("Could not start infiltration — Infiltrate button did not open game UI");
  }

  // Click Start if on intro screen
  if (isOnIntroScreen()) {
    log("info", "On intro screen, clicking Start...");
    await clickStartButton(domUtils);

    // Wait for game to actually start
    const startDeadline = Date.now() + 5000;
    while (Date.now() < startDeadline) {
      if (isInGame() || isOnCountdown()) break;
      if (!isOnIntroScreen()) break;
      await domUtils.sleep(100);
    }
    await domUtils.sleep(300);
  }

  // === MAIN GAME LOOP ===
  state = "IN_GAME";
  publishCurrentStatus(ns);

  const maxGameTime = 120_000; // 2 minutes max for entire infiltration
  const gameStart = Date.now();
  let noUiFrames = 0; // Count consecutive frames with no game UI

  while (Date.now() - gameStart < maxGameTime) {
    // Check for victory
    if (isOnVictoryScreen()) {
      log("info", "Infiltration successful!");
      break;
    }

    // Check for game over (got kicked out)
    // Use a grace period: only bail after several consecutive frames with no UI
    // This prevents false positives during screen transitions
    if (!isInGame() && !isOnCountdown() && !isOnVictoryScreen() && !isOnIntroScreen()) {
      noUiFrames++;
      if (noUiFrames > 20) { // ~2 seconds of no UI
        log("warn", "Game appears to be over (no game UI detected for 2s)");
        companyStats[target.name].failures++;
        return false;
      }
      await domUtils.sleep(100);
      continue;
    }
    noUiFrames = 0; // Reset counter when we see valid UI

    // Wait through countdown
    if (isOnCountdown()) {
      await domUtils.sleep(100);
      continue;
    }

    // Check if a mini-game is active
    const gameContainer = domUtils.getGameContainer();
    if (!gameContainer) {
      await domUtils.sleep(50);
      continue;
    }

    // Check if it's a game screen (not just status bar)
    const h4 = gameContainer.querySelector("h4, h5");
    if (!h4 || !h4.textContent?.trim()) {
      await domUtils.sleep(50);
      continue;
    }

    // Skip if countdown
    if (h4.textContent.toLowerCase().includes("get ready")) {
      await domUtils.sleep(100);
      continue;
    }

    // SOLVING
    state = "SOLVING";
    currentGame++;
    publishCurrentStatus(ns);

    const solveStart = Date.now();
    try {
      const solverId = await detectAndSolve(doc, domUtils, config.enabledSolvers);
      const solveTime = Date.now() - solveStart;

      currentSolver = solverId;
      log("info", `Solved: ${solverId} (${solveTime}ms) [${currentGame}/${totalGames}]`);
    } catch (e) {
      const errMsg = (e as Error).message;
      log("error", `Solver failed: ${errMsg}`);

      // The game may still be running (wrong answer = HP damage, not game over)
      // Continue the loop; the game will either show the next mini-game or end
    }

    state = "IN_GAME";
    currentSolver = undefined;
    publishCurrentStatus(ns);

    // Brief wait for game transition
    await domUtils.sleep(200);
  }

  // === REWARD SELECTION ===
  if (isOnVictoryScreen()) {
    // Manual mode: stop the daemon and let the user pick the reward
    if (config.rewardMode === "manual") {
      log("info", "Victory! Manual reward mode — stopping daemon. Pick your reward.");
      companyStats[target.name].successes++;
      runsCompleted++;
      stopRequested = true;
      manualRewardPending = true;
      state = "COMPLETING";
      publishCurrentStatus(ns);
      return true;
    }

    state = "REWARD_SELECT";
    publishCurrentStatus(ns);

    const reward = determineRewardType(ns);
    log("info", `Selecting reward: ${reward.type}${reward.faction ? ` (${reward.faction})` : ""}`);

    try {
      const loc = locations.find(l => l.name === target.name);

      // Snapshot before reward for verification
      let repBefore: number | null = null;
      let moneyBefore: number | null = null;

      if (reward.type === "faction-rep" && reward.faction) {
        try {
          repBefore = ns.singularity.getFactionRep(reward.faction as FactionName);
        } catch {
          // API unavailable — fall back to estimated tracking
        }
      } else if (reward.type === "money") {
        moneyBefore = ns.getPlayer().money;
      }

      await selectReward(domUtils, reward.type, reward.faction);

      // Unified reward verification
      if (reward.type === "faction-rep" && reward.faction && repBefore !== null) {
        await domUtils.sleep(800); // Wait for rep to apply
        try {
          const repAfter = ns.singularity.getFactionRep(reward.faction as FactionName);
          const actualDelta = repAfter - repBefore;
          const expectedDelta = loc?.reward.tradeRep ?? 0;

          lastActualDelta = actualDelta;
          lastExpectedDelta = expectedDelta;

          if (actualDelta <= 0) {
            consecutiveZeroDeltas++;
            observedMultiplier = 0;
            log("warn", `Rep verification: ZERO delta (expected ~${expectedDelta.toFixed(0)}) — ${consecutiveZeroDeltas} consecutive`);

            if (consecutiveZeroDeltas >= 3) {
              log("error", `3 consecutive zero-delta rep runs — reward not applying. Stopping.`);
              stopRequested = true;
              state = "ERROR";
              errorInfo = {
                message: "Rep not applying — 3 consecutive zero-delta runs detected.",
                timestamp: Date.now(),
              };
            }
          } else {
            const efficiency = expectedDelta > 0 ? actualDelta / expectedDelta : 1;
            observedMultiplier = efficiency;
            totalVerifiedRep += actualDelta;
            totalRepEarned += actualDelta;
            consecutiveZeroDeltas = 0;
            log("info", `Rep verification: +${actualDelta.toFixed(0)} actual vs ~${expectedDelta.toFixed(0)} expected — ${(efficiency * 100).toFixed(1)}% efficiency`);
          }
        } catch {
          // getFactionRep failed after reward — use estimated
          totalRepEarned += loc?.reward.tradeRep ?? 0;
        }

        rewardBreakdown.factionRep++;
      } else if (reward.type === "faction-rep") {
        // No verification available — use estimated
        totalRepEarned += loc?.reward.tradeRep ?? 0;
        rewardBreakdown.factionRep++;
      } else if (reward.type === "money" && moneyBefore !== null) {
        await domUtils.sleep(800); // Wait for money to apply
        const moneyAfter = ns.getPlayer().money;
        const actualDelta = moneyAfter - moneyBefore;
        const expectedDelta = loc?.reward.sellCash ?? 0;

        lastActualDelta = actualDelta;
        lastExpectedDelta = expectedDelta;

        if (actualDelta <= 0) {
          consecutiveZeroDeltas++;
          observedMultiplier = 0;
          log("warn", `Money verification: ZERO delta (expected ~$${expectedDelta.toFixed(0)}) — ${consecutiveZeroDeltas} consecutive`);

          if (consecutiveZeroDeltas >= 3) {
            log("error", `3 consecutive zero-delta money runs — reward not applying. Stopping.`);
            stopRequested = true;
            state = "ERROR";
            errorInfo = {
              message: "Money not applying — 3 consecutive zero-delta runs detected.",
              timestamp: Date.now(),
            };
          }
        } else {
          const efficiency = expectedDelta > 0 ? actualDelta / expectedDelta : 1;
          observedMultiplier = efficiency;
          consecutiveZeroDeltas = 0;
          log("info", `Money verification: +$${actualDelta.toFixed(0)} actual vs ~$${expectedDelta.toFixed(0)} expected — ${(efficiency * 100).toFixed(1)}% efficiency`);
        }

        totalCashEarned += actualDelta > 0 ? actualDelta : 0;
        rewardBreakdown.money++;
      } else {
        totalCashEarned += loc?.reward.sellCash ?? 0;
        consecutiveZeroDeltas = 0;
        rewardBreakdown.money++;
      }

      companyStats[target.name].successes++;
      runsCompleted++;
      log("info", `Run complete! (${runsCompleted} total)`);
    } catch (e) {
      log("error", `Reward selection failed: ${(e as Error).message}`);
      companyStats[target.name].failures++;
      return false;
    }

    // COMPLETING - navigate back to safe state
    state = "COMPLETING";
    publishCurrentStatus(ns);
    await domUtils.sleep(500);

    try {
      await navigateToCity(domUtils);
    } catch {
      // Best effort navigation back
      log("warn", "Could not navigate back to city after reward");
    }

    return true;
  }

  // Timed out or failed
  companyStats[target.name].failures++;
  runsFailed++;
  log("warn", "Infiltration failed or timed out");
  return false;
}

// === MAIN ENTRY POINT ===

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  ns.ui.openTail();
  _ns = ns;

  // Reset module-level state (persists across restarts in Bitburner)
  state = "IDLE";
  stopRequested = false;
  currentTarget = undefined;
  currentCity = undefined;
  currentGame = 0;
  totalGames = 0;
  currentSolver = undefined;
  runsCompleted = 0;
  runsFailed = 0;
  totalRepEarned = 0;
  totalCashEarned = 0;
  rewardBreakdown.factionRep = 0;
  rewardBreakdown.money = 0;
  for (const key of Object.keys(companyStats)) delete companyStats[key];
  locations = [];
  logBuffer.length = 0;
  consecutiveZeroDeltas = 0;
  lastActualDelta = 0;
  lastExpectedDelta = 0;
  totalVerifiedRep = 0;
  observedMultiplier = null;
  overlayRewardLabel = "";
  errorInfo = undefined;

  // Install the isTrusted bypass before the game registers its keydown handler
  installTrustBypass();

  // Initialize config with all solvers enabled
  config = {
    ...DEFAULT_CONFIG,
    enabledSolvers: new Set(SOLVERS.map(s => s.id)),
  };

  // Read saved config from dashboard
  const savedMode = getConfigString(ns, "infiltration", "rewardMode", DEFAULT_CONFIG.rewardMode);
  if (savedMode === "money" || savedMode === "manual" || savedMode === "rep") {
    config.rewardMode = savedMode;
  }

  // Clear control port
  const controlHandle = ns.getPortHandle(INFILTRATION_CONTROL_PORT);
  controlHandle.clear();

  // Create floating overlay and register cleanup
  createOverlay();
  ns.atExit(() => removeOverlay());

  log("info", "Infiltration daemon started");
  publishCurrentStatus(ns);
  const stayRunning = true;

  // === MAIN LOOP ===
  while (stayRunning) {
    // Check control port
    checkControlPort(ns);

    if (stopRequested) {
      state = "STOPPING";
      publishCurrentStatus(ns);

      if (manualRewardPending) {
        log("info", "Daemon stopped — victory screen left open for manual reward selection.");
      } else {
        log("info", "Stopping daemon...");
        try {
          await navigateToCity(domUtils);
        } catch {
          // Best effort
        }
      }

      log("info", "Daemon stopped");
      removeOverlay();
      publishCurrentStatus(ns);
      return;
    }

    if (state === "ERROR") {
      // Stay in error state, just keep checking control port
      publishCurrentStatus(ns);
      await ns.sleep(1000);
      continue;
    }

    // Start a new infiltration run
    state = "IDLE";
    currentTarget = undefined;
    currentCity = undefined;
    currentGame = 0;
    totalGames = 0;
    currentSolver = undefined;
    publishCurrentStatus(ns);

    try {
      await runSingleInfiltration(ns);
    } catch (e) {
      const errMsg = (e as Error).message;
      log("error", `Fatal error: ${errMsg}`);
      state = "ERROR";
      errorInfo = {
        message: errMsg,
        solver: currentSolver,
        timestamp: Date.now(),
      };
      runsFailed++;
      publishCurrentStatus(ns);

      // Stay in ERROR state — user must stop and restart
      continue;
    }

    // Brief pause between runs
    publishCurrentStatus(ns);
    await ns.sleep(1000);
  }
}
