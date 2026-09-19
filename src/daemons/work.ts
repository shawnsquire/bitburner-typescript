/**
 * Work Daemon (Tiered Architecture)
 *
 * Long-running daemon that automatically trains skills via gyms,
 * universities, or crime based on the configured focus. Publishes
 * WorkStatus to the status port for the dashboard.
 *
 * Operates in graduated tiers based on available RAM:
 *
 *   Tier 0 (Monitor):  ~low   - Read-only status (getCurrentWork, isFocused)
 *   Tier 1 (Training): ~mid   - Gym/university training (travelToCity, gymWorkout, universityCourse)
 *   Tier 2 (Crime):    ~high  - Crime modes (commitCrime, getCrimeStats, getCrimeChance)
 *
 * When focus changes require a different tier, the daemon respawns itself.
 *
 * Usage:
 *   run daemons/work.js
 *   run daemons/work.js --focus strength
 *   run daemons/work.js --one-shot
 *   run daemons/work.js --interval 5000
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import {
  setWorkFocus,
  getWorkStatus,
  runWorkCycle,
  getSkillDisplayName,
  WorkFocus,
  TRAVEL_COST,
  readWorkConfig,
} from "/controllers/work";
import { analyzeCrime, CrimeName } from "/controllers/crime";
import { calcAvailableAfterKills, freeRamForTarget } from "/lib/ram-utils";
import { publishStatus } from "/lib/ports";
import { STATUS_PORTS, WorkStatus, WorkTierName } from "/types/ports";
import { writeDefaultConfig, getConfigString, getConfigNumber, getConfigBool, setConfigValue } from "/lib/config";

// === TIER DEFINITIONS ===

interface WorkTierConfig {
  tier: number;
  name: WorkTierName;
  functions: string[];
  features: string[];
  description: string;
}

const BASE_FUNCTIONS = [
  "getServerMaxRam",
  "getServerUsedRam",
  "ps",
  "getScriptRam",
  "getPlayer",
  "getPortHandle",
  "fileExists",
];

const WORK_TIERS: WorkTierConfig[] = [
  {
    tier: 0,
    name: "monitor",
    functions: [
      "singularity.getCurrentWork",
      "singularity.isFocused",
    ],
    features: ["status-display"],
    description: "Read-only status (display only)",
  },
  {
    tier: 1,
    name: "training",
    functions: [
      "singularity.travelToCity",
      "singularity.gymWorkout",
      "singularity.universityCourse",
    ],
    features: ["gym-training", "university-training", "travel"],
    description: "Gym/university training with travel",
  },
  {
    tier: 2,
    name: "crime",
    functions: [
      "singularity.commitCrime",
      "singularity.getCrimeStats",
      "singularity.getCrimeChance",
    ],
    features: ["crime"],
    description: "Crime modes (money, karma, kills, stats)",
  },
];

// === DYNAMIC RAM CALCULATION ===

const BASE_SCRIPT_COST = 1.6;
const RAM_BUFFER_PERCENT = 0.05;

function calculateTierRam(ns: NS, tierIndex: number): number {
  let ram = BASE_SCRIPT_COST;
  for (const fn of BASE_FUNCTIONS) {
    ram += ns.getFunctionRamCost(fn);
  }
  for (let i = 0; i <= tierIndex; i++) {
    for (const fn of WORK_TIERS[i].functions) {
      ram += ns.getFunctionRamCost(fn);
    }
  }
  ram *= (1 + RAM_BUFFER_PERCENT);
  return Math.ceil(ram * 10) / 10;
}

function calculateAllTierRamCosts(ns: NS): number[] {
  return WORK_TIERS.map((_, i) => calculateTierRam(ns, i));
}

function selectBestTier(
  potentialRam: number,
  tierRamCosts: number[],
): { tier: WorkTierConfig; ramCost: number } {
  let bestTierIndex = 0;
  for (let i = WORK_TIERS.length - 1; i >= 0; i--) {
    if (potentialRam >= tierRamCosts[i]) {
      bestTierIndex = i;
      break;
    }
  }
  return { tier: WORK_TIERS[bestTierIndex], ramCost: tierRamCosts[bestTierIndex] };
}

function getAvailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = 0; i <= tier; i++) features.push(...WORK_TIERS[i].features);
  return features;
}

function getUnavailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = tier + 1; i < WORK_TIERS.length; i++) features.push(...WORK_TIERS[i].features);
  return features;
}

/** Determine the minimum tier required for a given focus */
function getRequiredTier(focus: WorkFocus): number {
  if (focus === "crime-money" || focus === "crime-stats" || focus === "crime-karma" || focus === "crime-kills") {
    return 2; // crime
  }
  // All training/balance modes need tier 1
  return 1;
}

// === FOCUS OPTIONS (mirrors dashboard/tools/work.tsx) ===

const FOCUS_OPTIONS: { value: WorkFocus; label: string }[] = [
  { value: "hacking", label: "Training (Hacking)" },
  { value: "balance-combat", label: "Training (Combat)" },
  { value: "balance-all", label: "Training (All)" },
  { value: "charisma", label: "Training (Charisma)" },
  { value: "crime-money", label: "Crime ($)" },
  { value: "crime-karma", label: "Crime (Karma)" },
  { value: "crime-kills", label: "Crime (Kills)" },
  { value: "strength", label: "Strength" },
  { value: "defense", label: "Defense" },
  { value: "dexterity", label: "Dexterity" },
  { value: "agility", label: "Agility" },
  { value: "crime-stats", label: "Crime (Stats)" },
];

// === STATUS COMPUTATION ===

/**
 * Compute the formatted WorkStatus for dashboard consumption.
 * At tier 0 (monitor), skips crime analysis and work cycle.
 * At tier < 2, skips crime-specific status fields.
 */
function computeWorkStatus(
  ns: NS,
  currentTier: number,
  currentTierName: WorkTierName,
  currentRam: number,
  focusYielding = false,
  focusHolder = "",
  sleeveHolder = "",
): WorkStatus {
  const rawStatus = getWorkStatus(ns);

  // Check if player is focused on current work
  const isFocused = ns.singularity.isFocused();

  // Calculate combat stat range
  const combatStats = [
    rawStatus.skills.strength,
    rawStatus.skills.defense,
    rawStatus.skills.dexterity,
    rawStatus.skills.agility,
  ];
  const lowestCombat = Math.min(...combatStats);
  const highestCombat = Math.max(...combatStats);

  // Determine current activity display and type
  let activityDisplay = "Idle";
  let activityType: "gym" | "university" | "crime" | "idle" | "other" = "idle";
  const focusedSuffix = isFocused ? " (focused)" : "";

  if (rawStatus.currentWork) {
    if (rawStatus.currentWork.type === "class") {
      const stat = rawStatus.currentWork.stat ?? "";
      if (stat.toLowerCase().includes("gym")) {
        activityType = "gym";
        activityDisplay = `Gym: ${stat}`;
      } else {
        activityType = "university";
        activityDisplay = `University: ${stat}`;
      }
      if (rawStatus.currentWork.location) {
        activityDisplay += ` @ ${rawStatus.currentWork.location}`;
      }
      activityDisplay += focusedSuffix;
    } else if (rawStatus.currentWork.type === "crime") {
      activityType = "crime";
      activityDisplay = `Crime: ${rawStatus.currentWork.stat ?? "Unknown"}${focusedSuffix}`;
    } else {
      activityType = "other";
      activityDisplay = rawStatus.currentWork.type + focusedSuffix;
    }
  }

  // Build formatted recommendation
  const recommendation = rawStatus.recommendedAction
    ? {
        type: rawStatus.recommendedAction.type as "gym" | "university" | "crime",
        location: rawStatus.recommendedAction.location,
        city: rawStatus.recommendedAction.city,
        skill: rawStatus.recommendedAction.skill,
        skillDisplay: getSkillDisplayName(rawStatus.recommendedAction.skill),
        expMult: rawStatus.recommendedAction.expMult,
        expMultFormatted: rawStatus.recommendedAction.type === "crime"
          ? ns.format.number(rawStatus.recommendedAction.expMult)
          : `${rawStatus.recommendedAction.expMult}x`,
        needsTravel: rawStatus.recommendedAction.needsTravel,
        travelCost: rawStatus.recommendedAction.travelCost,
        travelCostFormatted: ns.format.number(TRAVEL_COST),
      }
    : null;

  // Build formatted balance rotation
  const balanceRotation = rawStatus.balanceRotation
    ? {
        currentSkill: rawStatus.balanceRotation.currentSkill,
        currentSkillDisplay: getSkillDisplayName(rawStatus.balanceRotation.currentSkill),
        currentValue: rawStatus.balanceRotation.currentValue,
        currentValueFormatted: ns.format.number(rawStatus.balanceRotation.currentValue, 0),
        lowestSkill: rawStatus.balanceRotation.lowestSkill,
        lowestSkillDisplay: getSkillDisplayName(rawStatus.balanceRotation.lowestSkill),
        lowestValue: rawStatus.balanceRotation.lowestValue,
        lowestValueFormatted: ns.format.number(rawStatus.balanceRotation.lowestValue, 0),
        timeSinceSwitch: rawStatus.balanceRotation.timeSinceSwitch,
        timeUntilEligible: rawStatus.balanceRotation.timeUntilEligible,
        timeUntilEligibleFormatted: rawStatus.balanceRotation.timeUntilEligible > 0
          ? `${Math.ceil(rawStatus.balanceRotation.timeUntilEligible / 1000)}s`
          : "Ready",
        canSwitch: rawStatus.balanceRotation.canSwitch,
        isTrainingLowest: rawStatus.balanceRotation.isTrainingLowest,
        skillValues: rawStatus.balanceRotation.skillValues.map(sv => ({
          skill: sv.skill,
          display: getSkillDisplayName(sv.skill),
          value: sv.value,
          valueFormatted: ns.format.number(sv.value, 0),
        })),
      }
    : null;

  // Build formatted crime info (only at tier 2)
  const crimeInfo = (currentTier >= 2 && rawStatus.currentCrime)
    ? {
        name: rawStatus.currentCrime.crime,
        chance: rawStatus.currentCrime.chance,
        chanceFormatted: `${(rawStatus.currentCrime.chance * 100).toFixed(1)}%`,
        moneyPerMin: rawStatus.currentCrime.moneyPerMin,
        moneyPerMinFormatted: ns.format.number(rawStatus.currentCrime.moneyPerMin),
        combatExpPerMin:
          rawStatus.currentCrime.strExpPerMin +
          rawStatus.currentCrime.defExpPerMin +
          rawStatus.currentCrime.dexExpPerMin +
          rawStatus.currentCrime.agiExpPerMin,
        karmaPerMin: rawStatus.currentCrime.karmaPerMin,
        karmaPerMinFormatted: ns.format.number(Math.abs(rawStatus.currentCrime.karmaPerMin)),
        killsPerMin: rawStatus.currentCrime.killsPerMin,
        killsPerMinFormatted: ns.format.number(rawStatus.currentCrime.killsPerMin),
      }
    : null;

  // Detect pending crime switch (only at tier 2)
  let pendingCrimeSwitch: WorkStatus["pendingCrimeSwitch"] = null;
  if (currentTier >= 2) {
    const isCrimeMode = rawStatus.currentFocus === "crime-money" || rawStatus.currentFocus === "crime-stats"
      || rawStatus.currentFocus === "crime-karma" || rawStatus.currentFocus === "crime-kills";
    if (isCrimeMode && rawStatus.currentWork?.type === "crime" && rawStatus.currentCrime) {
      const runningCrimeName = rawStatus.currentWork.stat;
      const bestCrimeName = rawStatus.currentCrime.crime;
      if (runningCrimeName && runningCrimeName !== bestCrimeName) {
        const runningAnalysis = analyzeCrime(ns, runningCrimeName as CrimeName);

        const getCrimeMetric = (analysis: typeof runningAnalysis): { value: number; metric: string } => {
          switch (rawStatus.currentFocus) {
            case "crime-money":
              return { value: analysis.moneyPerMin, metric: "$/min" };
            case "crime-stats":
              return {
                value: analysis.strExpPerMin + analysis.defExpPerMin +
                  analysis.dexExpPerMin + analysis.agiExpPerMin,
                metric: "combat exp/min",
              };
            case "crime-karma":
              return { value: Math.abs(analysis.karmaPerMin), metric: "karma/min" };
            case "crime-kills":
              return { value: analysis.killsPerMin, metric: "kills/min" };
            default:
              return { value: analysis.moneyPerMin, metric: "$/min" };
          }
        };

        const current = getCrimeMetric(runningAnalysis);
        const best = getCrimeMetric(rawStatus.currentCrime);

        pendingCrimeSwitch = {
          currentCrime: runningCrimeName,
          bestCrime: bestCrimeName,
          currentValue: current.value,
          bestValue: best.value,
          currentValueFormatted: ns.format.number(current.value),
          bestValueFormatted: ns.format.number(best.value),
          metric: current.metric,
        };
      }
    }
  }

  // Build formatted skill time spent
  const skillTimeSpent = Object.entries(rawStatus.skillTimeSpent).map(([skill, time]) => ({
    skill,
    skillDisplay: getSkillDisplayName(skill),
    timeMs: time as number,
    timeFormatted: `${Math.floor((time as number) / 1000)}s`,
  }));

  // Find the focus label
  const focusLabel = FOCUS_OPTIONS.find(f => f.value === rawStatus.currentFocus)?.label ?? rawStatus.currentFocus;

  return {
    tier: currentTier,
    tierName: currentTierName,
    availableFeatures: getAvailableFeatures(currentTier),
    unavailableFeatures: getUnavailableFeatures(currentTier),
    currentRamUsage: currentRam,
    currentFocus: rawStatus.currentFocus,
    focusLabel,
    playerCity: rawStatus.playerCity,
    playerMoney: rawStatus.playerMoney,
    playerMoneyFormatted: ns.format.number(rawStatus.playerMoney),
    isFocused,
    skills: {
      strength: rawStatus.skills.strength,
      defense: rawStatus.skills.defense,
      dexterity: rawStatus.skills.dexterity,
      agility: rawStatus.skills.agility,
      hacking: rawStatus.skills.hacking,
      charisma: rawStatus.skills.charisma,
      strengthFormatted: ns.format.number(rawStatus.skills.strength, 0),
      defenseFormatted: ns.format.number(rawStatus.skills.defense, 0),
      dexterityFormatted: ns.format.number(rawStatus.skills.dexterity, 0),
      agilityFormatted: ns.format.number(rawStatus.skills.agility, 0),
      hackingFormatted: ns.format.number(rawStatus.skills.hacking, 0),
      charismaFormatted: ns.format.number(rawStatus.skills.charisma, 0),
    },
    activityDisplay,
    activityType,
    isTraining: rawStatus.isTraining,
    recommendation,
    canTravelToBest: rawStatus.canTravelToBest,
    skillTimeSpent,
    lowestCombatStat: lowestCombat,
    highestCombatStat: highestCombat,
    combatBalance: highestCombat > 0 ? lowestCombat / highestCombat : 1,
    balanceRotation,
    crimeInfo,
    pendingCrimeSwitch,
    focusYielding,
  };
}

// === LOG DISPLAY ===

function printStatus(ns: NS, status: WorkStatus): void {
  const C = COLORS;

  ns.print(`${C.cyan}=== Work Daemon (${status.tierName}) ===${C.reset}`);
  ns.print(
    `${C.dim}Focus:${C.reset} ${C.green}${status.focusLabel}${C.reset}` +
    `  ${C.dim}|${C.reset}  ${C.dim}City:${C.reset} ${C.white}${status.playerCity}${C.reset}` +
    `  ${C.dim}|${C.reset}  ${C.green}$${status.playerMoneyFormatted}${C.reset}` +
    `  ${C.dim}|${C.reset}  ${C.dim}RAM:${C.reset} ${ns.format.ram(status.currentRamUsage)}`
  );
  ns.print("");

  // Skills
  ns.print(`${C.cyan}Skills:${C.reset}`);
  ns.print(
    `  ${C.yellow}STR:${C.reset} ${status.skills.strengthFormatted}  ` +
    `${C.yellow}DEF:${C.reset} ${status.skills.defenseFormatted}  ` +
    `${C.yellow}DEX:${C.reset} ${status.skills.dexterityFormatted}  ` +
    `${C.yellow}AGI:${C.reset} ${status.skills.agilityFormatted}`
  );
  ns.print(
    `  ${C.blue}HACK:${C.reset} ${status.skills.hackingFormatted}  ` +
    `${C.magenta}CHA:${C.reset} ${status.skills.charismaFormatted}`
  );
  ns.print("");

  // Current activity
  const activityColor = status.activityType === "gym" ? C.yellow
    : status.activityType === "university" ? C.blue
    : status.activityType === "crime" ? C.red
    : C.dim;
  ns.print(`${C.dim}Activity:${C.reset} ${activityColor}${status.activityDisplay}${C.reset}`);

  // Pending crime switch
  if (status.pendingCrimeSwitch) {
    const s = status.pendingCrimeSwitch;
    ns.print(
      `${C.yellow}Switching: ${s.currentCrime} → ${s.bestCrime}${C.reset}` +
      `  ${C.dim}(${s.currentValueFormatted} → ${s.bestValueFormatted} ${s.metric})${C.reset}`
    );
  }

  // Recommendation
  if (status.recommendation) {
    ns.print("");
    ns.print(`${C.cyan}Recommended:${C.reset}`);
    if (status.recommendation.type === "crime") {
      ns.print(`  ${C.white}${status.recommendation.location}${C.reset}`);
      if (status.crimeInfo) {
        ns.print(
          `  ${C.dim}Success:${C.reset} ${status.crimeInfo.chanceFormatted}` +
          `  ${C.dim}$/min:${C.reset} ${C.green}${status.crimeInfo.moneyPerMinFormatted}${C.reset}`
        );
      }
    } else {
      ns.print(
        `  ${C.white}${status.recommendation.location}${C.reset}` +
        `  ${C.dim}(${status.recommendation.skillDisplay}, ${status.recommendation.expMultFormatted})${C.reset}`
      );
      if (status.recommendation.needsTravel) {
        const canTravel = status.canTravelToBest;
        ns.print(
          `  ${canTravel ? C.green : C.red}Travel to ${status.recommendation.city}${C.reset}` +
          ` ${C.dim}($${status.recommendation.travelCostFormatted})${C.reset}`
        );
      }
    }
  }

  // Balance rotation info
  if (status.balanceRotation) {
    ns.print("");
    ns.print(`${C.cyan}Balance Rotation:${C.reset}`);
    ns.print(
      `  ${C.dim}Training:${C.reset} ${C.white}${status.balanceRotation.currentSkillDisplay}${C.reset}` +
      ` (${status.balanceRotation.currentValueFormatted})`
    );
    if (!status.balanceRotation.isTrainingLowest) {
      ns.print(
        `  ${C.dim}Lowest:${C.reset} ${C.yellow}${status.balanceRotation.lowestSkillDisplay}${C.reset}` +
        ` (${status.balanceRotation.lowestValueFormatted})` +
        `  ${C.dim}Switch in:${C.reset} ${status.balanceRotation.timeUntilEligibleFormatted}`
      );
    } else {
      ns.print(`  ${C.green}Training lowest skill${C.reset}`);
    }
  }

  // Skill time tracking
  if (status.skillTimeSpent.length > 0) {
    ns.print("");
    ns.print(`${C.dim}Time per skill:${C.reset}`);
    for (const entry of status.skillTimeSpent) {
      ns.print(`  ${C.dim}${entry.skillDisplay}:${C.reset} ${entry.timeFormatted}`);
    }
  }
}

// === TIER RUN FUNCTIONS ===

const VALID_FOCUSES: WorkFocus[] = [
  "strength", "defense", "dexterity", "agility",
  "hacking", "charisma", "balance-all", "balance-combat",
  "crime-money", "crime-stats", "crime-karma", "crime-kills",
];

/** Read current focus from config, applying it to the work config if valid */
function readAndApplyFocus(ns: NS): WorkFocus | null {
  const focus = getConfigString(ns, "work", "focus", "");
  if (focus && VALID_FOCUSES.includes(focus as WorkFocus)) {
    // Only reset rotation state when focus actually changes
    const workConfig = readWorkConfig(ns);
    if (focus !== workConfig.focus) {
      setWorkFocus(ns, focus as WorkFocus);
    }
    return focus as WorkFocus;
  }
  // Fall back to whatever is in the work config file
  const workConfig = readWorkConfig(ns);
  if (workConfig.focus && VALID_FOCUSES.includes(workConfig.focus)) {
    return workConfig.focus;
  }
  return null;
}

/**
 * Tier 0: Monitor mode — read-only status, no training actions
 */
async function runMonitorMode(
  ns: NS,
  currentRam: number,
  tierRamCosts: number[],
): Promise<void> {
  const C = COLORS;
  let cyclesSinceUpgradeCheck = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const interval = getConfigNumber(ns, "work", "interval", 5000);
    const focusHolder = getConfigString(ns, "focus", "holder", "");
    const sleeveHolder = getConfigString(ns, "focus", "sleeveHolder", "");
    const focusYielding = focusHolder !== "" && focusHolder !== "work" && sleeveHolder !== "work";
    const focus = readAndApplyFocus(ns);

    ns.clearLog();

    // At tier 0 we can't train — just display status
    ns.print(`${C.yellow}Monitor mode (insufficient RAM for training)${C.reset}`);

    const workStatus = computeWorkStatus(ns, 0, "monitor", currentRam, focusYielding, focusHolder, sleeveHolder);
    publishStatus(ns, STATUS_PORTS.work, workStatus);
    printStatus(ns, workStatus);

    // Periodically check if we can upgrade to a higher tier
    cyclesSinceUpgradeCheck++;
    if (cyclesSinceUpgradeCheck >= 6) {
      cyclesSinceUpgradeCheck = 0;
      const requiredTier = focus ? getRequiredTier(focus) : 1;
      const neededRam = tierRamCosts[requiredTier] ?? tierRamCosts[1];
      const potentialRam = calcAvailableAfterKills(ns) + currentRam;
      if (potentialRam >= neededRam) {
        ns.tprint(`INFO: Upgrading work daemon from monitor to ${WORK_TIERS[requiredTier].name}`);
        ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 });
        return;
      }
    }

    ns.print(`\n${C.dim}Next check in ${interval / 1000}s...${C.reset}`);
    await ns.sleep(interval);
  }
}

/**
 * Tier 1: Training mode — gym/university training with travel
 */
async function runTrainingMode(
  ns: NS,
  currentRam: number,
  tierRamCosts: number[],
): Promise<void> {
  const C = COLORS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const interval = getConfigNumber(ns, "work", "interval", 5000);
    const oneShot = getConfigBool(ns, "work", "oneShot", false);
    const focusHolder = getConfigString(ns, "focus", "holder", "");
    const sleeveHolder = getConfigString(ns, "focus", "sleeveHolder", "");
    const focusYielding = focusHolder !== "" && focusHolder !== "work" && sleeveHolder !== "work";
    const focus = readAndApplyFocus(ns);

    ns.clearLog();

    // Check if focus changed to a crime mode — need tier 2
    if (focus && getRequiredTier(focus) > 1) {
      const neededRam = tierRamCosts[2];
      const potentialRam = calcAvailableAfterKills(ns) + currentRam;
      if (potentialRam >= neededRam) {
        ns.tprint(`INFO: Respawning work daemon for crime tier (focus: ${focus})`);
        ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 });
        return;
      }
      // Can't afford crime tier — stay at training, show warning
      ns.print(`${C.yellow}Crime mode requested but insufficient RAM for crime tier${C.reset}`);
    }

    // Run training cycle (skip when yielding focus)
    if (focusYielding) {
      const label = focusHolder === "none" ? "focus disabled" : `${focusHolder} daemon`;
      ns.print(`${C.yellow}Yielding focus to ${label}${C.reset}`);
    } else {
      const started = runWorkCycle(ns, 1);
      if (!started) {
        ns.print(`${C.yellow}Could not start training this cycle${C.reset}`);
      }
    }

    const workStatus = computeWorkStatus(ns, 1, "training", currentRam, focusYielding, focusHolder, sleeveHolder);
    publishStatus(ns, STATUS_PORTS.work, workStatus);
    printStatus(ns, workStatus);

    if (oneShot) break;
    ns.print(`\n${C.dim}Next check in ${interval / 1000}s...${C.reset}`);
    await ns.sleep(interval);
  }
}

/**
 * Tier 2: Crime mode — full functionality including crime
 */
async function runCrimeMode(
  ns: NS,
  currentRam: number,
  _tierRamCosts: number[],
): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const interval = getConfigNumber(ns, "work", "interval", 5000);
    const oneShot = getConfigBool(ns, "work", "oneShot", false);
    const focusHolder = getConfigString(ns, "focus", "holder", "");
    const sleeveHolder = getConfigString(ns, "focus", "sleeveHolder", "");
    const focusYielding = focusHolder !== "" && focusHolder !== "work" && sleeveHolder !== "work";
    readAndApplyFocus(ns);

    ns.clearLog();

    // Run training/crime cycle (skip when yielding focus)
    if (focusYielding) {
      const label = focusHolder === "none" ? "focus disabled" : `${focusHolder} daemon`;
      ns.print(`${COLORS.yellow}Yielding focus to ${label}${COLORS.reset}`);
    } else {
      const started = runWorkCycle(ns, 2);
      if (!started) {
        ns.print(`${COLORS.yellow}Could not start training this cycle${COLORS.reset}`);
      }
    }

    const workStatus = computeWorkStatus(ns, 2, "crime", currentRam, focusYielding, focusHolder, sleeveHolder);
    publishStatus(ns, STATUS_PORTS.work, workStatus);
    printStatus(ns, workStatus);

    if (oneShot) break;
    ns.print(`\n${COLORS.dim}Next check in ${interval / 1000}s...${COLORS.reset}`);
    await ns.sleep(interval);
  }
}

// === MAIN ===

export async function main(ns: NS): Promise<void> {
  ns.ramOverride(5);
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "work", {
    focus: "",
    interval: "5000",
    oneShot: "false",
  });

  // Set focus from config on startup
  const initialFocus = getConfigString(ns, "work", "focus", "");
  if (initialFocus) {
    if (VALID_FOCUSES.includes(initialFocus as WorkFocus)) {
      setWorkFocus(ns, initialFocus as WorkFocus);
      ns.print(`${COLORS.green}Set focus to: ${initialFocus}${COLORS.reset}`);
    } else {
      ns.tprint(`${COLORS.red}Invalid focus in config: ${initialFocus}${COLORS.reset}`);
      ns.tprint(`Valid options: ${VALID_FOCUSES.join(", ")}`);
      return;
    }
  }

  // Calculate tier RAM costs
  const tierRamCosts = calculateAllTierRamCosts(ns);
  const currentScriptRam = 5;

  // Determine required tier from current focus
  const focus = initialFocus as WorkFocus || readWorkConfig(ns).focus;
  const requiredTierIndex = focus ? getRequiredTier(focus) : 1;

  // Calculate available RAM
  const potentialRam = calcAvailableAfterKills(ns) + currentScriptRam;

  // Try to get the required tier, fall back to best available
  let selectedTier: WorkTierConfig;
  let requiredRam: number;

  if (potentialRam >= tierRamCosts[requiredTierIndex]) {
    selectedTier = WORK_TIERS[requiredTierIndex];
    requiredRam = tierRamCosts[requiredTierIndex];
  } else {
    // Fall back to best tier we can afford
    const best = selectBestTier(potentialRam, tierRamCosts);
    selectedTier = best.tier;
    requiredRam = best.ramCost;
  }

  // Free RAM if needed
  const currentlyAvailable = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam;
  if (requiredRam > currentlyAvailable) {
    ns.tprint(`INFO: Killing lower-priority scripts for work ${selectedTier.name} tier`);
    freeRamForTarget(ns, requiredRam);
  }

  // Upgrade RAM allocation
  if (selectedTier.tier > 0) {
    const actual = ns.ramOverride(requiredRam);
    if (actual < requiredRam) {
      ns.tprint(`WARN: Could not allocate ${ns.format.ram(requiredRam)} RAM for work daemon`);
      const fallback = selectBestTier(actual, tierRamCosts);
      ns.ramOverride(fallback.ramCost);
      requiredRam = fallback.ramCost;
      selectedTier = fallback.tier;
    }
  }

  ns.tprint(`INFO: Work daemon: ${selectedTier.name} tier (${ns.format.ram(requiredRam)} RAM)`);

  if (selectedTier.tier === 0) {
    await runMonitorMode(ns, requiredRam, tierRamCosts);
  } else if (selectedTier.tier === 1) {
    await runTrainingMode(ns, requiredRam, tierRamCosts);
  } else {
    await runCrimeMode(ns, requiredRam, tierRamCosts);
  }
}
