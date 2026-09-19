/**
 * Work System Library
 *
 * Provides training options via gyms, universities, and crime with
 * travel logic and balance rotation support.
 *
 * Import with: import { ... } from '/lib/work';
 */
import { NS, CityName, GymType, UniversityClassType, CrimeType, GymLocationName, UniversityLocationName } from "@ns";
import { findBestCrime, analyzeAllCrimes, CrimeAnalysis } from "/controllers/crime";

// === CONSTANTS ===

export const TRAVEL_COST = 200_000;
export const WORK_CONFIG_PATH = "/data/work-config.json";
export const BALANCE_ROTATION_INTERVAL = 60_000; // 60 seconds

// Gym data: name -> { city, expMult }
export const GYMS: Record<string, { city: string; expMult: number }> = {
  "Powerhouse Gym": { city: "Sector-12", expMult: 10 },
  "Iron Gym": { city: "Sector-12", expMult: 1 },
  "Crush Fitness Gym": { city: "Aevum", expMult: 2 },
  "Snap Fitness Gym": { city: "Aevum", expMult: 5 },
  "Millenium Fitness Gym": { city: "Volhaven", expMult: 4 },
};

// University data: name -> { city, expMult }
export const UNIVERSITIES: Record<string, { city: string; expMult: number }> = {
  "ZB Institute of Technology": { city: "Volhaven", expMult: 4 },
  "Summit University": { city: "Aevum", expMult: 3 },
  "Rothman University": { city: "Sector-12", expMult: 2 },
};

// Course names for best experience
export const HACKING_COURSES = ["Algorithms"];
export const CHARISMA_COURSES = ["Leadership"];

// Gym stats
export const GYM_STATS = ["str", "def", "dex", "agi"] as const;
export type GymStat = (typeof GYM_STATS)[number];

// === TYPES ===

export type WorkFocus =
  | "strength"
  | "defense"
  | "dexterity"
  | "agility"
  | "hacking"
  | "charisma"
  | "balance-all"
  | "balance-combat"
  | "crime-money"
  | "crime-stats"
  | "crime-karma"
  | "crime-kills";

export interface WorkConfig {
  focus: WorkFocus;
  skillTimeSpent: Record<string, number>;
  lastSkillTrained: string | null;
  lastRotationTime: number;
}

export interface TrainingOption {
  type: "gym" | "university" | "crime";
  location: string;
  city: string;
  skill: string;
  expMult: number;
  needsTravel: boolean;
  travelCost: number;
}

export interface BalanceRotationStatus {
  currentSkill: string;
  currentValue: number;
  lowestSkill: string;
  lowestValue: number;
  timeSinceSwitch: number;
  timeUntilEligible: number;
  canSwitch: boolean;
  isTrainingLowest: boolean;
  skillValues: { skill: string; value: number }[];
}

export interface WorkStatus {
  currentFocus: WorkFocus;
  playerCity: string;
  playerMoney: number;
  skills: {
    strength: number;
    defense: number;
    dexterity: number;
    agility: number;
    hacking: number;
    charisma: number;
  };
  currentWork: { type: string; location: string | null; stat: string | null } | null;
  recommendedAction: TrainingOption | null;
  canTravelToBest: boolean;
  isTraining: boolean;
  skillTimeSpent: Record<string, number>;
  currentCrime: CrimeAnalysis | null;
  balanceRotation: BalanceRotationStatus | null;
}

// === CONFIG PERSISTENCE ===

const DEFAULT_CONFIG: WorkConfig = {
  focus: "balance-combat",
  skillTimeSpent: {},
  lastSkillTrained: null,
  lastRotationTime: 0,
};

/**
 * Read work config from file, returning defaults if not found
 */
export function readWorkConfig(ns: NS): WorkConfig {
  try {
    const content = ns.read(WORK_CONFIG_PATH);
    if (content) {
      const parsed = JSON.parse(content);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Write work config to file
 */
export function writeWorkConfig(ns: NS, config: WorkConfig): void {
  ns.write(WORK_CONFIG_PATH, JSON.stringify(config, null, 2), "w");
}

/**
 * Update focus and reset balance timers
 */
export function setWorkFocus(ns: NS, focus: WorkFocus): void {
  const config = readWorkConfig(ns);
  config.focus = focus;
  config.skillTimeSpent = {};
  config.lastSkillTrained = null;
  config.lastRotationTime = Date.now();
  writeWorkConfig(ns, config);
}

// === SKILL MAPPING ===

/**
 * Get the skills to train for a given focus
 */
export function getSkillsForFocus(focus: WorkFocus): string[] {
  switch (focus) {
    case "strength":
      return ["str"];
    case "defense":
      return ["def"];
    case "dexterity":
      return ["dex"];
    case "agility":
      return ["agi"];
    case "hacking":
      return ["hacking"];
    case "charisma":
      return ["charisma"];
    case "balance-combat":
      return ["str", "def", "dex", "agi"];
    case "balance-all":
      return ["str", "def", "dex", "agi", "hacking", "charisma"];
    case "crime-money":
    case "crime-stats":
    case "crime-karma":
    case "crime-kills":
      return []; // Crimes don't target specific skills
    default:
      return [];
  }
}

/**
 * Convert short skill names to full names for display
 */
export function getSkillDisplayName(skill: string): string {
  const map: Record<string, string> = {
    str: "Strength",
    def: "Defense",
    dex: "Dexterity",
    agi: "Agility",
    hacking: "Hacking",
    charisma: "Charisma",
  };
  return map[skill] ?? skill;
}

/**
 * Get player skill value by short name
 */
export function getSkillValue(ns: NS, skill: string): number {
  const player = ns.getPlayer();
  const skillMap: Record<string, number> = {
    str: player.skills.strength,
    def: player.skills.defense,
    dex: player.skills.dexterity,
    agi: player.skills.agility,
    hacking: player.skills.hacking,
    charisma: player.skills.charisma,
  };
  return skillMap[skill] ?? 0;
}

/**
 * Get the next skill to train in balance mode.
 * Trains the lowest skill. Only switches when:
 * 1. Current skill exceeds the lowest skill's value, AND
 * 2. At least BALANCE_ROTATION_INTERVAL (60s) has passed since last switch
 * This prevents rapid flip-flopping and accounts for travel time/costs.
 */
export function getNextBalanceSkill(ns: NS, config: WorkConfig): string | null {
  const skills = getSkillsForFocus(config.focus);
  if (skills.length === 0) return null;
  if (skills.length === 1) return skills[0];

  // Get skill values and sort ascending
  const skillValues = skills.map(skill => ({
    skill,
    value: getSkillValue(ns, skill),
  })).sort((a, b) => a.value - b.value);

  const lowest = skillValues[0];

  // If no skill is currently being trained, start with the lowest
  if (!config.lastSkillTrained || !skills.includes(config.lastSkillTrained)) {
    return lowest.skill;
  }

  // If we're already training the lowest, keep training it
  if (config.lastSkillTrained === lowest.skill) {
    return lowest.skill;
  }

  // We're training a skill that's not the lowest - check if we should switch
  const currentValue = getSkillValue(ns, config.lastSkillTrained);
  const timeSinceSwitch = Date.now() - config.lastRotationTime;

  // Only switch if current skill exceeds lowest AND enough time has passed
  if (currentValue > lowest.value && timeSinceSwitch >= BALANCE_ROTATION_INTERVAL) {
    return lowest.skill;
  }

  // Keep training current skill
  return config.lastSkillTrained;
}

// === TRAINING OPTIONS ===

/**
 * Get all training options for a skill, sorted by expMult descending
 */
export function getTrainingOptions(
  ns: NS,
  targetSkill: string,
  playerCity: string,
): TrainingOption[] {
  const options: TrainingOption[] = [];

  if (["str", "def", "dex", "agi"].includes(targetSkill)) {
    // Gym training
    for (const [gymName, gymData] of Object.entries(GYMS)) {
      const needsTravel = gymData.city !== playerCity;
      const travelCost = needsTravel ? TRAVEL_COST : 0;

      options.push({
        type: "gym",
        location: gymName,
        city: gymData.city,
        skill: targetSkill,
        expMult: gymData.expMult,
        needsTravel,
        travelCost,
      });
    }
  } else if (targetSkill === "hacking") {
    // University training - Algorithms course
    for (const [uniName, uniData] of Object.entries(UNIVERSITIES)) {
      const needsTravel = uniData.city !== playerCity;
      const travelCost = needsTravel ? TRAVEL_COST : 0;

      options.push({
        type: "university",
        location: uniName,
        city: uniData.city,
        skill: "hacking",
        expMult: uniData.expMult,
        needsTravel,
        travelCost,
      });
    }
  } else if (targetSkill === "charisma") {
    // University training - Leadership course
    for (const [uniName, uniData] of Object.entries(UNIVERSITIES)) {
      const needsTravel = uniData.city !== playerCity;
      const travelCost = needsTravel ? TRAVEL_COST : 0;

      options.push({
        type: "university",
        location: uniName,
        city: uniData.city,
        skill: "charisma",
        expMult: uniData.expMult,
        needsTravel,
        travelCost,
      });
    }
  }

  // Sort by expMult descending
  return options.sort((a, b) => b.expMult - a.expMult);
}

/**
 * Find the best affordable training option with travel fallback
 */
export function findBestTrainingOption(
  ns: NS,
  skill: string,
  playerCity: string,
  playerMoney: number
): TrainingOption | null {
  const options = getTrainingOptions(ns, skill, playerCity);
  if (options.length === 0) return null;

  // Best option (highest expMult)
  const best = options[0];

  // If best is local or we can afford travel, use it
  if (!best.needsTravel || playerMoney >= TRAVEL_COST) {
    return best;
  }

  // Find best local option as fallback
  const localOption = options.find((opt) => !opt.needsTravel);
  return localOption ?? null;
}

// === CRIME HANDLING ===

/**
 * Find the best crime for money
 */
export function getBestCrimeForMoney(ns: NS): CrimeAnalysis {
  return findBestCrime(ns, "moneyPerMin");
}

/**
 * Find the best crime for karma loss (highest karma per minute).
 * stats.karma is positive — it represents how much karma the player loses per success.
 */
export function getBestCrimeForKarma(ns: NS): CrimeAnalysis {
  return findBestCrime(ns, "karmaPerMin");
}

/**
 * Find the best crime for kills per minute
 */
export function getBestCrimeForKills(ns: NS): CrimeAnalysis {
  return findBestCrime(ns, "killsPerMin");
}

/**
 * Find the best crime for combat stats exp
 */
export function getBestCrimeForStats(ns: NS): CrimeAnalysis {
  const crimes = analyzeAllCrimes(ns, "moneyPerMin");

  // Calculate total combat exp per min for each crime
  const withCombatExp = crimes.map((crime) => ({
    crime,
    totalCombatExp:
      crime.strExpPerMin + crime.defExpPerMin + crime.dexExpPerMin + crime.agiExpPerMin,
  }));

  // Sort by total combat exp descending
  withCombatExp.sort((a, b) => b.totalCombatExp - a.totalCombatExp);

  return withCombatExp[0].crime;
}

// === TRAINING EXECUTION ===

/**
 * Start training at a gym, university, or commit crime
 * Handles travel if needed and preserves focus state
 */
export function startTraining(
  ns: NS,
  option: TrainingOption,
  preserveFocus: boolean
): boolean {
  const player = ns.getPlayer();

  // Travel if needed
  if (option.needsTravel && option.city !== player.city) {
    const traveled = ns.singularity.travelToCity(option.city as CityName);
    if (!traveled) {
      return false;
    }
    ns.tprint(`INFO: Work: traveled to ${option.city} (-$${ns.format.number(TRAVEL_COST)})`);
  }

  // Start the appropriate training
  if (option.type === "gym") {
    const started = ns.singularity.gymWorkout(option.location as GymLocationName, option.skill as GymType, preserveFocus);
    if (started) {
      ns.tprint(`INFO: Work: started ${option.skill} training at ${option.location}`);
    }
    return started;
  } else if (option.type === "university") {
    const course = option.skill === "hacking" ? HACKING_COURSES[0] : CHARISMA_COURSES[0];
    const started = ns.singularity.universityCourse(option.location as UniversityLocationName, course as UniversityClassType, preserveFocus);
    if (started) {
      ns.tprint(`INFO: Work: started ${course} at ${option.location}`);
    }
    return started;
  }

  return false;
}

/**
 * Start committing a crime
 */
export function startCrime(ns: NS, crimeName: string, preserveFocus: boolean): number {
  return ns.singularity.commitCrime(crimeName as CrimeType, preserveFocus);
}

// === STATUS RETRIEVAL ===

/**
 * Get complete work status for display
 */
export function getWorkStatus(ns: NS): WorkStatus {
  const config = readWorkConfig(ns);
  const player = ns.getPlayer();
  const currentWork = ns.singularity.getCurrentWork();

  // Determine current work info
  let workInfo: WorkStatus["currentWork"] = null;
  if (currentWork) {
    if (currentWork.type === "CLASS") {
      const classWork = currentWork as { type: string; location: string; classType: string };
      workInfo = {
        type: "class",
        location: classWork.location,
        stat: classWork.classType,
      };
    } else if (currentWork.type === "CRIME") {
      const crimeWork = currentWork as { type: string; crimeType: string };
      workInfo = {
        type: "crime",
        location: null,
        stat: crimeWork.crimeType,
      };
    } else {
      workInfo = {
        type: currentWork.type.toLowerCase(),
        location: null,
        stat: null,
      };
    }
  }

  // Get recommended action based on focus
  let recommendedAction: TrainingOption | null = null;
  let currentCrime: CrimeAnalysis | null = null;

  if (config.focus === "crime-money") {
    currentCrime = getBestCrimeForMoney(ns);
    recommendedAction = {
      type: "crime",
      location: currentCrime.crime,
      city: player.city,
      skill: "money",
      expMult: currentCrime.moneyPerMin,
      needsTravel: false,
      travelCost: 0,
    };
  } else if (config.focus === "crime-stats") {
    currentCrime = getBestCrimeForStats(ns);
    recommendedAction = {
      type: "crime",
      location: currentCrime.crime,
      city: player.city,
      skill: "combat",
      expMult:
        currentCrime.strExpPerMin +
        currentCrime.defExpPerMin +
        currentCrime.dexExpPerMin +
        currentCrime.agiExpPerMin,
      needsTravel: false,
      travelCost: 0,
    };
  } else if (config.focus === "crime-karma") {
    currentCrime = getBestCrimeForKarma(ns);
    recommendedAction = {
      type: "crime",
      location: currentCrime.crime,
      city: player.city,
      skill: "karma",
      expMult: Math.abs(currentCrime.karmaPerMin),
      needsTravel: false,
      travelCost: 0,
    };
  } else if (config.focus === "crime-kills") {
    currentCrime = getBestCrimeForKills(ns);
    recommendedAction = {
      type: "crime",
      location: currentCrime.crime,
      city: player.city,
      skill: "kills",
      expMult: currentCrime.killsPerMin,
      needsTravel: false,
      travelCost: 0,
    };
  } else {
    // Gym/University training
    const skills = getSkillsForFocus(config.focus);
    let targetSkill: string | null = null;

    if (skills.length === 1) {
      targetSkill = skills[0];
    } else if (skills.length > 1) {
      // Balance mode - train lowest skill
      targetSkill = getNextBalanceSkill(ns, config);
    }

    if (targetSkill) {
      recommendedAction = findBestTrainingOption(ns, targetSkill, player.city, player.money);
    }
  }

  const isTraining =
    workInfo !== null && (workInfo.type === "class" || workInfo.type === "crime");

  // Compute balance rotation status for balance modes
  let balanceRotation: BalanceRotationStatus | null = null;
  const isBalanceMode = config.focus === "balance-combat" || config.focus === "balance-all";

  if (isBalanceMode) {
    const skills = getSkillsForFocus(config.focus);
    const skillValues = skills.map(skill => ({
      skill,
      value: getSkillValue(ns, skill),
    })).sort((a, b) => a.value - b.value);

    const lowest = skillValues[0];
    const currentSkill = config.lastSkillTrained ?? lowest.skill;
    const currentValue = getSkillValue(ns, currentSkill);
    const now = Date.now();
    const timeSinceSwitch = config.lastRotationTime > 0 ? now - config.lastRotationTime : 0;
    const timeUntilEligible = Math.max(0, BALANCE_ROTATION_INTERVAL - timeSinceSwitch);
    const isTrainingLowest = currentSkill === lowest.skill;
    const canSwitch = !isTrainingLowest && currentValue > lowest.value && timeUntilEligible === 0;

    balanceRotation = {
      currentSkill,
      currentValue,
      lowestSkill: lowest.skill,
      lowestValue: lowest.value,
      timeSinceSwitch,
      timeUntilEligible,
      canSwitch,
      isTrainingLowest,
      skillValues,
    };
  }

  return {
    currentFocus: config.focus,
    playerCity: player.city,
    playerMoney: player.money,
    skills: {
      strength: player.skills.strength,
      defense: player.skills.defense,
      dexterity: player.skills.dexterity,
      agility: player.skills.agility,
      hacking: player.skills.hacking,
      charisma: player.skills.charisma,
    },
    currentWork: workInfo,
    recommendedAction,
    canTravelToBest: recommendedAction?.needsTravel
      ? player.money >= TRAVEL_COST
      : true,
    isTraining,
    skillTimeSpent: config.skillTimeSpent,
    currentCrime,
    balanceRotation,
  };
}

// === TRAINING LOOP LOGIC ===

/**
 * Run one cycle of work training
 * Returns true if training was started/continued
 */
export function runWorkCycle(ns: NS, currentTier = 2): boolean {
  const config = readWorkConfig(ns);
  const status = getWorkStatus(ns);
  const hasWork = ns.singularity.getCurrentWork() !== null;
  const preserveFocus = hasWork ? ns.singularity.isFocused() : true;

  // Handle crime modes
  const isCrimeMode = config.focus === "crime-money" || config.focus === "crime-stats"
    || config.focus === "crime-karma" || config.focus === "crime-kills";
  if (isCrimeMode) {
    if (currentTier < 2) {
      ns.print("Crime mode requires Tier 2 — waiting for RAM...");
      return false;
    }
    const getBest = () => {
      switch (config.focus) {
        case "crime-money": return getBestCrimeForMoney(ns);
        case "crime-stats": return getBestCrimeForStats(ns);
        case "crime-karma": return getBestCrimeForKarma(ns);
        case "crime-kills": return getBestCrimeForKills(ns);
        default: return getBestCrimeForMoney(ns);
      }
    };

    const currentWork = ns.singularity.getCurrentWork();

    // If already doing crime, check if a better one is available
    if (currentWork?.type === "CRIME") {
      const crimeWork = currentWork as { type: string; crimeType: string };
      const runningCrime = crimeWork.crimeType;
      const bestCrime = getBest();

      if (bestCrime.crime !== runningCrime) {
        // Switch to better crime immediately (crimes auto-repeat, so we must interrupt)
        const timeMs = startCrime(ns, bestCrime.crime, preserveFocus);
        return timeMs > 0;
      }
      return true;
    }

    // Start the appropriate crime
    const crime = getBest();
    const timeMs = startCrime(ns, crime.crime, preserveFocus);
    return timeMs > 0;
  }

  // Handle gym/university training
  const skills = getSkillsForFocus(config.focus);
  if (skills.length === 0) return false;

  // Get target skill
  let targetSkill: string;
  if (skills.length === 1) {
    targetSkill = skills[0];
  } else {
    // Balance mode - train lowest skill until it exceeds next lowest
    const now = Date.now();
    targetSkill = getNextBalanceSkill(ns, config) ?? skills[0];

    // Track time spent (for display) and update config if skill changed
    if (targetSkill !== config.lastSkillTrained) {
      // Skill changed - update elapsed time for previous skill
      if (config.lastSkillTrained && config.lastRotationTime > 0) {
        const elapsed = now - config.lastRotationTime;
        config.skillTimeSpent[config.lastSkillTrained] =
          (config.skillTimeSpent[config.lastSkillTrained] ?? 0) + elapsed;
      }
      config.lastSkillTrained = targetSkill;
      config.lastRotationTime = now;
      writeWorkConfig(ns, config);
    }
  }

  // Check if already training the right thing
  const currentWork = ns.singularity.getCurrentWork();
  if (currentWork?.type === "CLASS") {
    const classWork = currentWork as { classType: string };
    const currentStat = classWork.classType.toLowerCase();

    // Map class types to our skill names
    const classToSkill: Record<string, string> = {
      "gym strength": "str",
      "gym defense": "def",
      "gym dexterity": "dex",
      "gym agility": "agi",
      "study computer science basics": "hacking",
      "taking algorithms": "hacking",
      algorithms: "hacking",
      "study leadership": "charisma",
      "taking leadership": "charisma",
      leadership: "charisma",
    };

    const mappedSkill = classToSkill[currentStat] ?? currentStat;
    if (mappedSkill === targetSkill) {
      return true; // Already training what we want
    }
  }

  // Start training
  const option = findBestTrainingOption(ns, targetSkill, status.playerCity, status.playerMoney);
  if (!option) return false;

  return startTraining(ns, option, preserveFocus);
}
