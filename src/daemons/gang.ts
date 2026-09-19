/**
 * Gang Daemon (Tiered Architecture)
 *
 * Long-running daemon that manages a combat gang. Operates in graduated tiers:
 *
 *   Tier 0 (Lite):  ~5GB  - Read-only status (inGang, gangInfo, memberNames)
 *   Tier 1 (Basic): ~15GB - Task assignment, recruitment, wanted management
 *   Tier 2 (Full):  ~29GB - Equipment purchasing, ascension automation
 *
 * Loop driver: ns.gang.nextUpdate() (aligns with gang ticks ~2-5s)
 *
 * Usage:
 *   run daemons/gang.js                    # Auto-select best tier
 *   run daemons/gang.js --strategy money   # Force strategy
 *   run daemons/gang.js --no-kill          # Don't kill other scripts
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { calcAvailableAfterKills, freeRamForTarget } from "/lib/ram-utils";
import { writeDefaultConfig, getConfigString, getConfigBool } from "/lib/config";
import { publishStatus, peekStatus } from "/lib/ports";
import {
  STATUS_PORTS,
  GANG_CONTROL_PORT,
  GangStatus,
  GangTerritoryStatus,
  GangStrategy,
  GangTierName,
  GangMemberStatus,
} from "/types/ports";
import {
  getNextRecruitName,
  assignTasks,
  scoreAscension,
  selectAscensionCandidate,
  rankEquipment,
  determineBalancedPhase,
  NATO_NAMES,
  type MemberInfo,
  type GangTaskConfig,
  type TaskStats,
  type GangInfo,
  type EquipmentInfo,
  type AscensionResult,
  type TerritoryContext,
} from "/controllers/gang";
import { getBudgetBalance, notifyPurchase, signalDone } from "/lib/budget";

// === TIER DEFINITIONS ===

interface GangTierConfig {
  tier: number;
  name: GangTierName;
  functions: string[];
  features: string[];
  description: string;
}

const BASE_FUNCTIONS = [
  "getResetInfo",
  "getServerMaxRam",
  "getServerUsedRam",
  "ps",
  "getScriptRam",
  "getPlayer",
  "getPortHandle",
  "fileExists",
];

const GANG_TIERS: GangTierConfig[] = [
  {
    tier: 0,
    name: "lite",
    functions: [
      "gang.inGang",
      "gang.getGangInformation",
      "gang.getMemberNames",
      "gang.getBonusTime",
    ],
    features: ["read-only-status"],
    description: "Read-only gang status",
  },
  {
    tier: 1,
    name: "basic",
    functions: [
      "gang.getMemberInformation",
      "gang.canRecruitMember",
      "gang.getRecruitsAvailable",
      "gang.respectForNextRecruit",
      "gang.getTaskStats",
      "gang.getTaskNames",
      "gang.setMemberTask",
      "gang.recruitMember",
      "gang.renameMember",
      "gang.setTerritoryWarfare",
    ],
    features: ["task-assignment", "recruitment", "wanted-management"],
    description: "Task assignment, recruitment, wanted management",
  },
  {
    tier: 2,
    name: "full",
    functions: [
      "gang.getEquipmentCost",
      "gang.getEquipmentStats",
      "gang.getEquipmentType",
      "gang.getEquipmentNames",
      "gang.purchaseEquipment",
      "gang.getAscensionResult",
      "gang.ascendMember",
    ],
    features: ["equipment", "ascension"],
    description: "Equipment purchasing, ascension automation",
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
    for (const fn of GANG_TIERS[i].functions) {
      ram += ns.getFunctionRamCost(fn);
    }
  }
  ram *= (1 + RAM_BUFFER_PERCENT);
  return Math.ceil(ram * 10) / 10;
}

function calculateAllTierRamCosts(ns: NS): number[] {
  return GANG_TIERS.map((_, i) => calculateTierRam(ns, i));
}

function selectBestTier(
  potentialRam: number,
  tierRamCosts: number[],
): { tier: GangTierConfig; ramCost: number } {
  let bestTierIndex = 0;
  for (let i = GANG_TIERS.length - 1; i >= 0; i--) {
    if (potentialRam >= tierRamCosts[i]) {
      bestTierIndex = i;
      break;
    }
  }
  return { tier: GANG_TIERS[bestTierIndex], ramCost: tierRamCosts[bestTierIndex] };
}

function getAvailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = 0; i <= tier; i++) features.push(...GANG_TIERS[i].features);
  return features;
}

function getUnavailableFeatures(tier: number): string[] {
  const features: string[] = [];
  for (let i = tier + 1; i < GANG_TIERS.length; i++) features.push(...GANG_TIERS[i].features);
  return features;
}

// === CONFIG ===

const CONFIG_FILE = "/data/gang-config.json";

interface GangConfig {
  strategy: GangStrategy;
  pinnedMembers: Record<string, string>;
  purchasingEnabled: boolean;
  wantedThreshold: number;
  ascendAutoThreshold: number;
  ascendReviewThreshold: number;
  trainingThreshold: number;
  growTargetMultiplier: number;
  growRespectReserve: number;
  territoryAutoThreshold: number;
}

const DEFAULT_CONFIG: GangConfig = {
  strategy: "balanced",
  pinnedMembers: {},
  purchasingEnabled: true,
  wantedThreshold: 0.95,
  ascendAutoThreshold: 1.5,
  ascendReviewThreshold: 1.15,
  trainingThreshold: 500,
  growTargetMultiplier: 30,
  growRespectReserve: 2,
  territoryAutoThreshold: 101,
};

function loadConfig(ns: NS): GangConfig {
  if (!ns.fileExists(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    const raw = ns.read(CONFIG_FILE);
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(ns: NS, config: GangConfig): void {
  ns.write(CONFIG_FILE, JSON.stringify(config), "w");
}

// === CONTROL PORT ===

/** Pending ascend requests from dashboard (processed in full mode) */
const pendingAscends: string[] = [];
let pendingForceBuy = false;

function readControlCommands(ns: NS, config: GangConfig): GangConfig {
  const handle = ns.getPortHandle(GANG_CONTROL_PORT);
  let changed = false;

  while (!handle.empty()) {
    const data = handle.read();
    if (data === "NULL PORT DATA") break;

    try {
      const cmd = JSON.parse(data as string);
      switch (cmd.action) {
        case "set-gang-strategy":
          if (cmd.gangStrategy) {
            config.strategy = cmd.gangStrategy;
            changed = true;
          }
          break;
        case "pin-gang-member":
          if (cmd.gangMemberName && cmd.gangMemberTask) {
            config.pinnedMembers[cmd.gangMemberName] = cmd.gangMemberTask;
            changed = true;
          }
          break;
        case "unpin-gang-member":
          if (cmd.gangMemberName) {
            delete config.pinnedMembers[cmd.gangMemberName];
            changed = true;
          }
          break;
        case "toggle-gang-purchases":
          if (cmd.gangPurchasesEnabled !== undefined) {
            config.purchasingEnabled = cmd.gangPurchasesEnabled;
            changed = true;
          }
          break;
        case "set-gang-wanted-threshold":
          if (cmd.gangWantedThreshold !== undefined) {
            config.wantedThreshold = cmd.gangWantedThreshold;
            changed = true;
          }
          break;
        case "set-gang-ascension-thresholds":
          if (cmd.gangAscendAutoThreshold !== undefined) config.ascendAutoThreshold = cmd.gangAscendAutoThreshold;
          if (cmd.gangAscendReviewThreshold !== undefined) config.ascendReviewThreshold = cmd.gangAscendReviewThreshold;
          changed = true;
          break;
        case "set-gang-training-threshold":
          if (cmd.gangTrainingThreshold !== undefined) {
            config.trainingThreshold = cmd.gangTrainingThreshold;
            changed = true;
          }
          break;
        case "set-gang-grow-target":
          if (cmd.gangGrowTargetMultiplier !== undefined) {
            config.growTargetMultiplier = cmd.gangGrowTargetMultiplier;
            changed = true;
          }
          break;
        case "set-gang-grow-respect-reserve":
          if (cmd.gangGrowRespectReserve !== undefined) {
            config.growRespectReserve = cmd.gangGrowRespectReserve;
            changed = true;
          }
          break;
        case "set-gang-territory-threshold":
          if (cmd.gangTerritoryAutoThreshold !== undefined) {
            config.territoryAutoThreshold = cmd.gangTerritoryAutoThreshold;
            changed = true;
          }
          break;
        case "ascend-gang-member":
          // Store the ascend request to be handled in the main loop
          if (cmd.gangMemberName) {
            pendingAscends.push(cmd.gangMemberName);
          }
          break;
        case "force-buy-equipment":
          pendingForceBuy = true;
          break;
      }
    } catch { /* invalid command */ }
  }

  if (changed) saveConfig(ns, config);
  return config;
}

// === TERRITORY AUTO-TOGGLE ===

function autoToggleTerritoryWarfare(
  ns: NS, config: GangConfig,
  territoryData: GangTerritoryStatus | null,
  currentlyEngaged: boolean,
): void {
  if (config.territoryAutoThreshold > 100 || !territoryData) return;
  const checked = territoryData.rivals.filter(r => r.clashChance >= 0);
  if (checked.length === 0) return;
  const avgChance = checked.reduce((s, r) => s + r.clashChance, 0) / checked.length;
  const shouldEngage = avgChance >= config.territoryAutoThreshold / 100;
  if (shouldEngage !== currentlyEngaged) {
    ns.gang.setTerritoryWarfare(shouldEngage);
  }
}

// === TASK STATS HELPERS ===

function getTaskStatsForMember(ns: NS, taskName: string): TaskStats {
  const stats = ns.gang.getTaskStats(taskName);
  return {
    name: taskName,
    baseMoney: stats.baseMoney,
    baseRespect: stats.baseRespect,
    baseWanted: stats.baseWanted,
    strWeight: stats.strWeight,
    defWeight: stats.defWeight,
    dexWeight: stats.dexWeight,
    agiWeight: stats.agiWeight,
    chaWeight: stats.chaWeight,
    hackWeight: stats.hackWeight,
    isHacking: stats.isHacking,
    isCombat: stats.isCombat,
  };
}

function getMemberInfoArray(ns: NS, names: string[]): MemberInfo[] {
  return names.map(name => {
    const info = ns.gang.getMemberInformation(name);
    return {
      name,
      task: info.task,
      str: info.str,
      def: info.def,
      dex: info.dex,
      agi: info.agi,
      cha: info.cha,
      hack: info.hack,
      earnedRespect: info.earnedRespect,
      strMult: info.str_asc_mult,
      defMult: info.def_asc_mult,
      dexMult: info.dex_asc_mult,
      agiMult: info.agi_asc_mult,
    };
  });
}

// === TIER RUN FUNCTIONS ===

/**
 * Tier 0: Read-only status
 */
async function runLiteMode(
  ns: NS,
  currentRam: number,
  tierRamCosts: number[],
  spawnArgs: string[],
): Promise<void> {
  const C = COLORS;
  let cyclesSinceUpgradeCheck = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    ns.clearLog();

    if (!ns.gang.inGang()) {
      const karma = (ns as any).heart.break() as number;
      const karmaRequired = 54000;
      const karmaProgress = Math.min(1, Math.abs(karma) / karmaRequired);
      const status: GangStatus = {
        tier: 0, tierName: "lite",
        availableFeatures: getAvailableFeatures(0),
        unavailableFeatures: getUnavailableFeatures(0),
        currentRamUsage: currentRam,
        nextTierRam: tierRamCosts[1] ?? null,
        canUpgrade: true,
        inGang: false,
        karma,
        karmaRequired,
        karmaProgress,
      };
      publishStatus(ns, STATUS_PORTS.gang, status);
      ns.print(`${C.yellow}Not in a gang. Karma: ${ns.format.number(karma)}/${ns.format.number(-karmaRequired)} (${(karmaProgress * 100).toFixed(1)}%)${C.reset}`);
      await ns.sleep(5000);
      continue;
    }

    const info = ns.gang.getGangInformation();
    const memberNames = ns.gang.getMemberNames();
    const bonusTime = ns.gang.getBonusTime();

    const territoryData = peekStatus<GangTerritoryStatus>(ns, STATUS_PORTS.gangTerritory);

    const status: GangStatus = {
      tier: 0, tierName: "lite",
      availableFeatures: getAvailableFeatures(0),
      unavailableFeatures: getUnavailableFeatures(0),
      currentRamUsage: currentRam,
      nextTierRam: tierRamCosts[1] ?? null,
      canUpgrade: true,
      inGang: true,
      faction: info.faction,
      isHacking: info.isHacking,
      respect: info.respect,
      respectFormatted: ns.format.number(info.respect),
      wantedLevel: info.wantedLevel,
      wantedPenalty: info.wantedPenalty,
      moneyGainRate: info.moneyGainRate * 5,
      moneyGainRateFormatted: ns.format.number(info.moneyGainRate * 5),
      territory: info.territory,
      territoryWarfareEngaged: info.territoryWarfareEngaged,
      bonusTime,
      memberCount: memberNames.length,
      maxMembers: NATO_NAMES.length,
      territoryData: territoryData ?? undefined,
    };

    publishStatus(ns, STATUS_PORTS.gang, status);

    ns.print(`${C.cyan}=== Gang Daemon (lite) ===${C.reset}`);
    ns.print(`${C.dim}${info.faction} | ${memberNames.length} members | ${ns.format.number(info.respect)} respect${C.reset}`);

    // Upgrade check
    cyclesSinceUpgradeCheck++;
    if (cyclesSinceUpgradeCheck >= 10) {
      cyclesSinceUpgradeCheck = 0;
      const potentialRam = calcAvailableAfterKills(ns) + currentRam;
      for (let i = GANG_TIERS.length - 1; i > 0; i--) {
        if (potentialRam >= tierRamCosts[i]) {
          ns.tprint(`INFO: Upgrading gang daemon from lite to ${GANG_TIERS[i].name}`);
          ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 }, ...spawnArgs);
          return;
        }
      }
    }

    await ns.gang.nextUpdate();
  }
}

/**
 * Tier 1: Task assignment, recruitment, wanted management
 */
async function runBasicMode(
  ns: NS,
  currentRam: number,
  tierRamCosts: number[],
  config: GangConfig,
  spawnArgs: string[],
): Promise<void> {
  const C = COLORS;
  let cyclesSinceUpgradeCheck = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    ns.clearLog();
    config = readControlCommands(ns, config);

    if (!ns.gang.inGang()) {
      const karma = (ns as any).heart.break() as number;
      const karmaRequired = 54000;
      const karmaProgress = Math.min(1, Math.abs(karma) / karmaRequired);
      publishStatus(ns, STATUS_PORTS.gang, {
        tier: 1, tierName: "basic",
        availableFeatures: getAvailableFeatures(1),
        unavailableFeatures: getUnavailableFeatures(1),
        currentRamUsage: currentRam,
        nextTierRam: tierRamCosts[2] ?? null,
        canUpgrade: true,
        inGang: false,
        karma,
        karmaRequired,
        karmaProgress,
      } as GangStatus);
      await ns.sleep(5000);
      continue;
    }

    const info = ns.gang.getGangInformation();
    const memberNames = ns.gang.getMemberNames();
    const bonusTime = ns.gang.getBonusTime();

    // Auto-recruit
    while (ns.gang.canRecruitMember()) {
      const newName = getNextRecruitName(memberNames);
      if (ns.gang.recruitMember(newName)) {
        memberNames.push(newName);
        ns.tprint(`INFO: Gang: recruited ${newName}`);
      } else {
        // Try with temp name + rename
        const tempName = `recruit-${Date.now()}`;
        if (ns.gang.recruitMember(tempName)) {
          ns.gang.renameMember(tempName, newName);
          memberNames.push(newName);
          ns.tprint(`INFO: Gang: recruited ${newName}`);
        } else {
          break;
        }
      }
    }

    // Get task data
    const taskNames = ns.gang.getTaskNames();
    const taskStatsArray: TaskStats[] = taskNames.map(t => getTaskStatsForMember(ns, t));
    const memberInfoArray = getMemberInfoArray(ns, memberNames);

    const gangInfo: GangInfo = {
      respect: info.respect,
      wantedLevel: info.wantedLevel,
      wantedPenalty: info.wantedPenalty,
      territory: info.territory,
      isHacking: info.isHacking,
    };

    // Assign tasks
    const taskConfig: GangTaskConfig = {
      strategy: config.strategy,
      trainingThreshold: config.trainingThreshold,
      wantedThreshold: config.wantedThreshold,
      growTargetMultiplier: config.growTargetMultiplier,
      growRespectReserve: config.growRespectReserve,
    };

    // Build territory context for smart warfare splits
    const territoryData_peek = peekStatus<GangTerritoryStatus>(ns, STATUS_PORTS.gangTerritory);
    autoToggleTerritoryWarfare(ns, config, territoryData_peek, info.territoryWarfareEngaged);
    let territoryContext: TerritoryContext | null = null;
    if (territoryData_peek && territoryData_peek.rivals) {
      territoryContext = {
        ourPower: territoryData_peek.ourPower,
        rivals: territoryData_peek.rivals.map(r => ({
          name: r.name,
          power: r.power,
          territory: r.territory,
          clashChance: r.clashChance,
        })),
        warfareEngaged: info.territoryWarfareEngaged,
      };
    }

    const assignments = assignTasks(
      memberInfoArray, taskConfig, gangInfo,
      taskStatsArray, config.pinnedMembers,
      territoryContext,  // NEW: pass territory context
    );

    // Build reason lookup for member statuses
    const reasonByMember = new Map(assignments.map(a => [a.memberName, a.reason]));

    for (const a of assignments) {
      const currentTask = memberInfoArray.find(m => m.name === a.memberName)?.task;
      if (currentTask !== a.task) {
        ns.gang.setMemberTask(a.memberName, a.task);
      }
    }

    // Build member status
    const memberStatuses: GangMemberStatus[] = memberNames.map(name => {
      const mi = ns.gang.getMemberInformation(name);
      return {
        name,
        task: mi.task,
        taskReason: reasonByMember.get(name),
        str: mi.str,
        def: mi.def,
        dex: mi.dex,
        agi: mi.agi,
        cha: mi.cha,
        hack: mi.hack,
        strMultiplier: mi.str_asc_mult,
        defMultiplier: mi.def_asc_mult,
        dexMultiplier: mi.dex_asc_mult,
        agiMultiplier: mi.agi_asc_mult,
        avgCombatMultiplier: (mi.str_asc_mult + mi.def_asc_mult + mi.dex_asc_mult + mi.agi_asc_mult) / 4,
        earnedRespect: mi.earnedRespect,
        respectGain: mi.respectGain,
        moneyGain: mi.moneyGain,
        isPinned: !!config.pinnedMembers[name],
        equipmentCount: mi.upgrades.length + mi.augmentations.length,
      };
    });

    const territoryData = peekStatus<GangTerritoryStatus>(ns, STATUS_PORTS.gangTerritory);

    const canRecruit = ns.gang.canRecruitMember();
    const recruitsAvailable = ns.gang.getRecruitsAvailable();
    const respectForNext = ns.gang.respectForNextRecruit();

    // Compute balanced phase for status
    const balancedPhase = config.strategy === "balanced"
      ? determineBalancedPhase(memberInfoArray, gangInfo, config.growTargetMultiplier)
      : undefined;

    const status: GangStatus = {
      tier: 1, tierName: "basic",
      availableFeatures: getAvailableFeatures(1),
      unavailableFeatures: getUnavailableFeatures(1),
      currentRamUsage: currentRam,
      nextTierRam: tierRamCosts[2] ?? null,
      canUpgrade: true,
      inGang: true,
      faction: info.faction,
      isHacking: info.isHacking,
      respect: info.respect,
      respectFormatted: ns.format.number(info.respect),
      respectGainRate: info.respectGainRate * 5,
      respectGainRateFormatted: ns.format.number(info.respectGainRate * 5),
      wantedLevel: info.wantedLevel,
      wantedPenalty: info.wantedPenalty,
      moneyGainRate: info.moneyGainRate * 5,
      moneyGainRateFormatted: ns.format.number(info.moneyGainRate * 5),
      territory: info.territory,
      territoryWarfareEngaged: info.territoryWarfareEngaged,
      bonusTime,
      memberCount: memberNames.length,
      maxMembers: NATO_NAMES.length,
      members: memberStatuses,
      canRecruit,
      recruitsAvailable,
      respectForNextRecruit: respectForNext,
      respectForNextRecruitFormatted: ns.format.number(respectForNext),
      territoryData: territoryData ?? undefined,
      strategy: config.strategy,
      wantedThreshold: config.wantedThreshold,
      ascendAutoThreshold: config.ascendAutoThreshold,
      ascendReviewThreshold: config.ascendReviewThreshold,
      trainingThreshold: config.trainingThreshold,
      territoryAutoThreshold: config.territoryAutoThreshold,
      growTargetMultiplier: config.growTargetMultiplier,
      growRespectReserve: config.growRespectReserve,
      balancedPhase,
    };

    publishStatus(ns, STATUS_PORTS.gang, status);

    // Print status
    ns.print(`${C.cyan}=== Gang Daemon (basic) ===${C.reset}`);
    ns.print(`${C.dim}${info.faction} | ${memberNames.length} members | Strategy: ${config.strategy}${C.reset}`);
    ns.print(`${C.dim}Respect: ${ns.format.number(info.respect)} | Wanted: ${(info.wantedPenalty * 100).toFixed(1)}% | Territory: ${(info.territory * 100).toFixed(1)}%${C.reset}`);
    for (const a of assignments) {
      ns.print(`  ${C.white}${a.memberName.padEnd(10)}${C.reset} → ${C.cyan}${a.task}${C.reset} ${C.dim}(${a.reason})${C.reset}`);
    }

    // Upgrade check
    cyclesSinceUpgradeCheck++;
    if (cyclesSinceUpgradeCheck >= 10) {
      cyclesSinceUpgradeCheck = 0;
      const potentialRam = calcAvailableAfterKills(ns) + currentRam;
      for (let i = GANG_TIERS.length - 1; i > 1; i--) {
        if (potentialRam >= tierRamCosts[i]) {
          ns.tprint(`INFO: Upgrading gang daemon from basic to ${GANG_TIERS[i].name}`);
          ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 }, ...spawnArgs);
          return;
        }
      }
    }

    await ns.gang.nextUpdate();
  }
}

/**
 * Tier 2: Full mode - equipment + ascension
 */
async function runFullMode(
  ns: NS,
  currentRam: number,
  tierRamCosts: number[],
  config: GangConfig,
  _spawnArgs: string[],
): Promise<void> {
  const C = COLORS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    ns.clearLog();
    config = readControlCommands(ns, config);

    if (!ns.gang.inGang()) {
      const karma = (ns as any).heart.break() as number;
      const karmaRequired = 54000;
      const karmaProgress = Math.min(1, Math.abs(karma) / karmaRequired);
      publishStatus(ns, STATUS_PORTS.gang, {
        tier: 2, tierName: "full",
        availableFeatures: getAvailableFeatures(2),
        unavailableFeatures: getUnavailableFeatures(2),
        currentRamUsage: currentRam,
        nextTierRam: null,
        canUpgrade: false,
        inGang: false,
        karma,
        karmaRequired,
        karmaProgress,
      } as GangStatus);
      await ns.sleep(5000);
      continue;
    }

    const info = ns.gang.getGangInformation();
    const memberNames = ns.gang.getMemberNames();
    const bonusTime = ns.gang.getBonusTime();

    // Auto-recruit
    while (ns.gang.canRecruitMember()) {
      const newName = getNextRecruitName(memberNames);
      if (ns.gang.recruitMember(newName)) {
        memberNames.push(newName);
        ns.tprint(`INFO: Gang: recruited ${newName}`);
      } else {
        const tempName = `recruit-${Date.now()}`;
        if (ns.gang.recruitMember(tempName)) {
          ns.gang.renameMember(tempName, newName);
          memberNames.push(newName);
          ns.tprint(`INFO: Gang: recruited ${newName}`);
        } else break;
      }
    }

    // 1. ASCENSION (staggered — one per tick to preserve respect)
    const ascensionAlerts: { memberName: string; bestStat: string; bestGain: number }[] = [];

    // In grow mode, use a more aggressive threshold
    const isGrowMode = config.strategy === "grow";
    const effectiveAutoThreshold = isGrowMode
      ? Math.min(config.ascendAutoThreshold, 1.25)
      : config.ascendAutoThreshold;

    // Collect candidates and flags
    const ascCandidates: { name: string; result: AscensionResult }[] = [];
    for (const name of memberNames) {
      const result = ns.gang.getAscensionResult(name);
      if (!result) continue;

      const ascResult: AscensionResult = { str: result.str, def: result.def, dex: result.dex, agi: result.agi, cha: result.cha, hack: result.hack };
      const score = scoreAscension(ascResult, effectiveAutoThreshold, config.ascendReviewThreshold);

      if (score.action === "auto") {
        ascCandidates.push({ name, result: ascResult });
      } else if (score.action === "flag") {
        ascensionAlerts.push({ memberName: name, bestStat: score.bestStat, bestGain: score.bestGain });
      }
    }

    // Ascend at most one per tick (stagger to preserve respect)
    const bestCandidate = selectAscensionCandidate(ascCandidates, effectiveAutoThreshold);
    if (bestCandidate) {
      ns.gang.ascendMember(bestCandidate.name);
      ns.tprint(`INFO: Gang: auto-ascended ${bestCandidate.name} (${bestCandidate.bestStat} x${bestCandidate.bestGain.toFixed(2)})`);
    }

    // Handle pending ascend requests from dashboard
    while (pendingAscends.length > 0) {
      const name = pendingAscends.shift()!;
      if (memberNames.includes(name)) {
        ns.gang.ascendMember(name);
        ns.tprint(`INFO: Gang: ascended ${name} (user request)`);
      }
    }

    // Get task data
    const taskNames = ns.gang.getTaskNames();
    const taskStatsArray: TaskStats[] = taskNames.map(t => getTaskStatsForMember(ns, t));
    const memberInfoArray = getMemberInfoArray(ns, memberNames);

    const gangInfo: GangInfo = {
      respect: info.respect,
      wantedLevel: info.wantedLevel,
      wantedPenalty: info.wantedPenalty,
      territory: info.territory,
      isHacking: info.isHacking,
    };

    // Assign tasks
    const taskConfig: GangTaskConfig = {
      strategy: config.strategy,
      trainingThreshold: config.trainingThreshold,
      wantedThreshold: config.wantedThreshold,
      growTargetMultiplier: config.growTargetMultiplier,
      growRespectReserve: config.growRespectReserve,
    };

    const assignments = assignTasks(
      memberInfoArray, taskConfig, gangInfo,
      taskStatsArray, config.pinnedMembers,
    );

    // Build reason lookup for member statuses
    const reasonByMember = new Map(assignments.map(a => [a.memberName, a.reason]));

    for (const a of assignments) {
      const currentTask = memberInfoArray.find(m => m.name === a.memberName)?.task;
      if (currentTask !== a.task) {
        ns.gang.setMemberTask(a.memberName, a.task);
      }
    }

    // 2. EQUIPMENT PURCHASING (after ascension, budget-constrained)
    let availableUpgrades = 0;
    const purchasableEquipment: { member: string; name: string; cost: number; type: string }[] = [];
    const isForceBuy = pendingForceBuy;
    const shouldBuy = config.purchasingEnabled || isForceBuy;
    if (shouldBuy) {
      const equipNames = ns.gang.getEquipmentNames();

      // Spending cap: budget balance (or Infinity for force-buy)
      let spendingCap: number;
      if (isForceBuy) {
        spendingCap = Infinity;
        pendingForceBuy = false;
      } else {
        spendingCap = getBudgetBalance(ns, "gang");
      }

      for (const name of memberNames) {
        const mi = ns.gang.getMemberInformation(name);
        const owned = new Set([...mi.upgrades, ...mi.augmentations]);

        const equipment: EquipmentInfo[] = equipNames.map(eName => ({
          name: eName,
          cost: ns.gang.getEquipmentCost(eName),
          type: ns.gang.getEquipmentType(eName),
          stats: ns.gang.getEquipmentStats(eName),
        }));

        // Find member's current task stats for ROI weighting
        const memberTask = taskStatsArray.find(t => t.name === mi.task) ?? null;
        const ranked = rankEquipment(equipment, memberTask, owned);
        availableUpgrades += ranked.length;

        // Collect purchasable items for status display
        for (const item of ranked) {
          purchasableEquipment.push({ member: name, name: item.name, cost: item.cost, type: item.type });
        }

        // Buy best ROI items we can afford
        for (const item of ranked) {
          if (item.cost <= spendingCap) {
            if (ns.gang.purchaseEquipment(name, item.name)) {
              notifyPurchase(ns, "gang", item.cost, `${item.name} for ${name}`);
              ns.tprint(`INFO: Gang: bought ${item.name} for ${name} (-$${ns.format.number(item.cost)})`);
            }
          }
        }
      }
    }

    // Build member status with ascension data
    const memberStatuses: GangMemberStatus[] = memberNames.map(name => {
      const mi = ns.gang.getMemberInformation(name);
      const ascResult = ns.gang.getAscensionResult(name);
      let ascensionData: GangMemberStatus["ascensionResult"];

      if (ascResult) {
        const score = scoreAscension(
          { str: ascResult.str, def: ascResult.def, dex: ascResult.dex, agi: ascResult.agi, cha: ascResult.cha, hack: ascResult.hack },
          effectiveAutoThreshold,
          config.ascendReviewThreshold,
        );
        ascensionData = {
          str: ascResult.str,
          def: ascResult.def,
          dex: ascResult.dex,
          agi: ascResult.agi,
          cha: ascResult.cha,
          hack: ascResult.hack,
          bestStat: score.bestStat,
          bestGain: score.bestGain,
          action: score.action,
        };
      }

      return {
        name,
        task: mi.task,
        taskReason: reasonByMember.get(name),
        str: mi.str,
        def: mi.def,
        dex: mi.dex,
        agi: mi.agi,
        cha: mi.cha,
        hack: mi.hack,
        strMultiplier: mi.str_asc_mult,
        defMultiplier: mi.def_asc_mult,
        dexMultiplier: mi.dex_asc_mult,
        agiMultiplier: mi.agi_asc_mult,
        avgCombatMultiplier: (mi.str_asc_mult + mi.def_asc_mult + mi.dex_asc_mult + mi.agi_asc_mult) / 4,
        earnedRespect: mi.earnedRespect,
        respectGain: mi.respectGain,
        moneyGain: mi.moneyGain,
        isPinned: !!config.pinnedMembers[name],
        equipmentCount: mi.upgrades.length + mi.augmentations.length,
        ascensionResult: ascensionData,
      };
    });

    const territoryData = peekStatus<GangTerritoryStatus>(ns, STATUS_PORTS.gangTerritory);
    autoToggleTerritoryWarfare(ns, config, territoryData, info.territoryWarfareEngaged);

    const canRecruit = ns.gang.canRecruitMember();
    const recruitsAvailable = ns.gang.getRecruitsAvailable();
    const respectForNext = ns.gang.respectForNextRecruit();

    // Compute balanced phase for status
    const balancedPhase = config.strategy === "balanced"
      ? determineBalancedPhase(memberInfoArray, gangInfo, config.growTargetMultiplier)
      : undefined;

    const status: GangStatus = {
      tier: 2, tierName: "full",
      availableFeatures: getAvailableFeatures(2),
      unavailableFeatures: getUnavailableFeatures(2),
      currentRamUsage: currentRam,
      nextTierRam: null,
      canUpgrade: false,
      inGang: true,
      faction: info.faction,
      isHacking: info.isHacking,
      respect: info.respect,
      respectFormatted: ns.format.number(info.respect),
      respectGainRate: info.respectGainRate * 5,
      respectGainRateFormatted: ns.format.number(info.respectGainRate * 5),
      wantedLevel: info.wantedLevel,
      wantedPenalty: info.wantedPenalty,
      moneyGainRate: info.moneyGainRate * 5,
      moneyGainRateFormatted: ns.format.number(info.moneyGainRate * 5),
      territory: info.territory,
      territoryWarfareEngaged: info.territoryWarfareEngaged,
      bonusTime,
      memberCount: memberNames.length,
      maxMembers: NATO_NAMES.length,
      members: memberStatuses,
      canRecruit,
      recruitsAvailable,
      respectForNextRecruit: respectForNext,
      respectForNextRecruitFormatted: ns.format.number(respectForNext),
      ascensionAlerts: ascensionAlerts.length > 0 ? ascensionAlerts : undefined,
      purchasingEnabled: config.purchasingEnabled,
      availableUpgrades,
      purchasableEquipment: purchasableEquipment.length > 0 ? purchasableEquipment : undefined,
      territoryData: territoryData ?? undefined,
      strategy: config.strategy,
      wantedThreshold: config.wantedThreshold,
      ascendAutoThreshold: config.ascendAutoThreshold,
      ascendReviewThreshold: config.ascendReviewThreshold,
      trainingThreshold: config.trainingThreshold,
      territoryAutoThreshold: config.territoryAutoThreshold,
      growTargetMultiplier: config.growTargetMultiplier,
      growRespectReserve: config.growRespectReserve,
      balancedPhase,
    };

    publishStatus(ns, STATUS_PORTS.gang, status);

    // Print status
    const phaseLabel = balancedPhase ? ` (${balancedPhase})` : "";
    ns.print(`${C.cyan}=== Gang Daemon (full) ===${C.reset}`);
    ns.print(`${C.dim}${info.faction} | ${memberNames.length} members | Strategy: ${config.strategy}${phaseLabel}${C.reset}`);
    ns.print(`${C.dim}Respect: ${ns.format.number(info.respect)} (+${ns.format.number(info.respectGainRate * 5)}/s)${C.reset}`);
    ns.print(`${C.dim}Wanted: ${(info.wantedPenalty * 100).toFixed(1)}% | Territory: ${(info.territory * 100).toFixed(1)}% | Income: ${ns.format.number(info.moneyGainRate * 5)}/s${C.reset}`);
    if (ascensionAlerts.length > 0) {
      ns.print(`${C.yellow}Ascension alerts: ${ascensionAlerts.map(a => `${a.memberName} (${a.bestStat} x${a.bestGain.toFixed(2)})`).join(", ")}${C.reset}`);
    }
    for (const a of assignments.slice(0, 6)) {
      ns.print(`  ${C.white}${a.memberName.padEnd(10)}${C.reset} → ${C.cyan}${a.task}${C.reset} ${C.dim}(${a.reason})${C.reset}`);
    }
    if (assignments.length > 6) {
      ns.print(`  ${C.dim}... +${assignments.length - 6} more${C.reset}`);
    }

    await ns.gang.nextUpdate();
  }
}

// === MAIN ===

function buildSpawnArgs(): string[] {
  return [];
}

export async function main(ns: NS): Promise<void> {
  ns.ramOverride(5);
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "gang", {
    strategy: "",
    noKill: "false",
  });

  const noKill = getConfigBool(ns, "gang", "noKill", false);
  const spawnArgs = buildSpawnArgs();

  // Load config and apply config file overrides
  const config = loadConfig(ns);
  const strategyOverride = getConfigString(ns, "gang", "strategy", "");
  if (strategyOverride && ["respect", "money", "territory", "balanced", "grow"].includes(strategyOverride)) {
    config.strategy = strategyOverride as GangStrategy;
    saveConfig(ns, config);
  }

  // Calculate tier RAM costs
  const tierRamCosts = calculateAllTierRamCosts(ns);
  const currentScriptRam = 5;

  let potentialRam: number;
  if (noKill) {
    potentialRam = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam;
  } else {
    potentialRam = calcAvailableAfterKills(ns) + currentScriptRam;
  }

  // Select tier
  const { tier: selectedTier, ramCost: requiredRam } = selectBestTier(potentialRam, tierRamCosts);

  // Free RAM if needed
  const currentlyAvailable = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + currentScriptRam;
  if (requiredRam > currentlyAvailable && !noKill) {
    ns.tprint(`INFO: Killing lower-priority scripts for gang ${selectedTier.name} tier`);
    freeRamForTarget(ns, requiredRam);
  }

  // Upgrade RAM allocation
  if (selectedTier.tier > 0) {
    const actual = ns.ramOverride(requiredRam);
    if (actual < requiredRam) {
      ns.tprint(`WARN: Could not allocate ${ns.format.ram(requiredRam)} RAM for gang daemon`);
      const fallback = selectBestTier(actual, tierRamCosts);
      ns.ramOverride(fallback.ramCost);
      ns.tprint(`INFO: Gang daemon: ${fallback.tier.name} tier (${ns.format.ram(fallback.ramCost)} RAM)`);
      if (fallback.tier.tier === 0) {
        await runLiteMode(ns, fallback.ramCost, tierRamCosts, spawnArgs);
      } else if (fallback.tier.tier === 1) {
        await runBasicMode(ns, fallback.ramCost, tierRamCosts, config, spawnArgs);
      } else {
        await runFullMode(ns, fallback.ramCost, tierRamCosts, config, spawnArgs);
      }
      return;
    }
  }

  ns.tprint(`INFO: Gang daemon: ${selectedTier.name} tier (${ns.format.ram(requiredRam)} RAM)`);

  if (selectedTier.tier === 0) {
    await runLiteMode(ns, requiredRam, tierRamCosts, spawnArgs);
  } else if (selectedTier.tier === 1) {
    await runBasicMode(ns, requiredRam, tierRamCosts, config, spawnArgs);
  } else {
    await runFullMode(ns, requiredRam, tierRamCosts, config, spawnArgs);
  }
}
