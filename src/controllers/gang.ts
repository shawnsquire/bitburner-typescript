/**
 * Gang Controller - Pure Logic (0 RAM)
 *
 * All decision-making functions for gang management.
 * Zero NS imports - only uses data passed in as arguments.
 *
 * Import with: import { assignTasks, scoreAscension, ... } from '/controllers/gang';
 */
import { GangStrategy } from "/types/ports";

// === CONSTANTS ===

/** NATO phonetic alphabet names for gang members (max 12) */
export const NATO_NAMES = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot",
  "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima",
];

// === TYPES ===

export interface TaskAssignment {
  memberName: string;
  task: string;
  reason: string;
}

export interface MemberInfo {
  name: string;
  task: string;
  str: number;
  def: number;
  dex: number;
  agi: number;
  cha: number;
  hack: number;
  earnedRespect: number;
  strMult: number;
  defMult: number;
  dexMult: number;
  agiMult: number;
}

export interface GangTaskConfig {
  strategy: GangStrategy;
  trainingThreshold: number;
  wantedThreshold: number;
  growTargetMultiplier: number;
  growRespectReserve: number;
}

export interface TaskStats {
  name: string;
  baseMoney: number;
  baseRespect: number;
  baseWanted: number;
  strWeight: number;
  defWeight: number;
  dexWeight: number;
  agiWeight: number;
  chaWeight: number;
  hackWeight: number;
  isHacking: boolean;
  isCombat: boolean;
}

export interface GangInfo {
  respect: number;
  wantedLevel: number;
  wantedPenalty: number;
  territory: number;
  isHacking: boolean;
}

export interface RivalInfo {
  name: string;
  power: number;
  territory: number;
  clashChance: number; // Our win chance against them (0-1)
}

export interface TerritoryContext {
  ourPower: number;
  rivals: RivalInfo[];
  warfareEngaged: boolean;
}

export interface AscensionResult {
  str: number;
  def: number;
  dex: number;
  agi: number;
  cha: number;
  hack: number;
}

export interface EquipmentInfo {
  name: string;
  cost: number;
  type: string;
  stats: {
    str?: number;
    def?: number;
    dex?: number;
    agi?: number;
    cha?: number;
    hack?: number;
  };
}

// === FUNCTIONS ===

/**
 * Get the next unused NATO name for recruiting.
 */
export function getNextRecruitName(existingNames: string[]): string {
  const existing = new Set(existingNames);
  for (const name of NATO_NAMES) {
    if (!existing.has(name)) return name;
  }
  return `Member-${existingNames.length + 1}`;
}

/**
 * Calculate the total combat stats for a member.
 */
function totalCombatStats(m: MemberInfo): number {
  return m.str + m.def + m.dex + m.agi;
}

/**
 * Average ascension multiplier across combat stats.
 */
export function avgCombatMultiplier(m: MemberInfo): number {
  return (m.strMult + m.defMult + m.dexMult + m.agiMult) / 4;
}

/**
 * Calculate member-task stat alignment score.
 * Higher score = member's stats better match task's stat weights.
 */
function memberTaskAlignment(m: MemberInfo, task: TaskStats): number {
  return (
    m.str * task.strWeight +
    m.def * task.defWeight +
    m.dex * task.dexWeight +
    m.agi * task.agiWeight +
    m.cha * task.chaWeight +
    m.hack * task.hackWeight
  );
}

/**
 * Select members for wanted cleanup (Vigilante Justice).
 * Returns weakest members by total stats. Count scales with deficit severity.
 */
export function selectWantedCleaners(
  members: MemberInfo[],
  threshold: number,
  currentPenalty: number,
): string[] {
  if (currentPenalty >= threshold) return [];

  // How far below threshold are we? Scale cleaners accordingly
  const deficit = threshold - currentPenalty;
  const severity = deficit / (1 - threshold); // 0-1 scale
  const cleanerCount = Math.max(1, Math.ceil(members.length * severity * 0.5));

  // Sort by total combat stats ascending (weakest first)
  const sorted = [...members].sort((a, b) => totalCombatStats(a) - totalCombatStats(b));
  return sorted.slice(0, cleanerCount).map(m => m.name);
}

/**
 * Calculate how many members should be on Territory Warfare.
 *
 * Logic based on Bitburner source code analysis:
 * - Territory gain per clash = powerBonus * 0.0001 * random(0.5-1.5)
 * - powerBonus = max(1, 1 + log(ourPower/theirPower) / log(50))
 * - powerBonus is logarithmic, so diminishing returns on extra power
 * - Loser's power drops 1% per loss, creating a snowball effect
 * - Therefore: only need enough warfare members to maintain dominance
 *
 * Returns count of members to assign to Territory Warfare (0 to members.length).
 */
export function calculateWarfareCount(
  members: MemberInfo[],
  territory: TerritoryContext | null,
  gangTerritory: number,
): { count: number; reason: string } {
  // No territory data available — conservative default
  if (!territory || territory.rivals.length === 0) {
    return { count: 2, reason: "no rival data, conservative default" };
  }

  // Already at 100% territory — no warfare needed
  if (gangTerritory >= 0.99) {
    return { count: 0, reason: "territory complete" };
  }

  // Find worst clash win chance against gangs that still have territory
  const activeRivals = territory.rivals.filter(r => r.territory > 0.001);
  if (activeRivals.length === 0) {
    // All rivals have ~0 territory, just need a token presence
    return { count: 1, reason: "rivals have no territory" };
  }

  const worstClashChance = Math.min(...activeRivals.map(r => r.clashChance));
  const strongestRivalPower = Math.max(...activeRivals.map(r => r.power));
  const powerRatio = territory.ourPower / Math.max(1, strongestRivalPower);

  // If we're not even winning reliably, commit more to warfare
  if (worstClashChance < 0.55) {
    // Losing or barely winning — need significant warfare commitment
    const count = Math.min(members.length, Math.max(4, Math.ceil(members.length * 0.6)));
    return { count, reason: `low win chance (${(worstClashChance * 100).toFixed(0)}%), need power` };
  }

  if (worstClashChance < 0.70) {
    // Winning but not dominant — moderate commitment
    const count = Math.min(members.length, Math.max(3, Math.ceil(members.length * 0.4)));
    return { count, reason: `moderate win chance (${(worstClashChance * 100).toFixed(0)}%), building power` };
  }

  if (worstClashChance < 0.85) {
    // Comfortably winning — small crew maintains dominance
    // Power ratio check: if we're already 3x+ stronger, fewer members needed
    if (powerRatio > 3) {
      return { count: 2, reason: `winning (${(worstClashChance * 100).toFixed(0)}%), power ratio ${powerRatio.toFixed(1)}x` };
    }
    return { count: 3, reason: `winning (${(worstClashChance * 100).toFixed(0)}%), maintaining power` };
  }

  // Dominant — minimal warfare presence, maximize money
  // The 1% power drain on losers means our advantage grows passively
  if (powerRatio > 5) {
    return { count: 1, reason: `dominant (${(worstClashChance * 100).toFixed(0)}%), ${powerRatio.toFixed(1)}x power ratio` };
  }
  return { count: 2, reason: `dominant (${(worstClashChance * 100).toFixed(0)}%), maintaining lead` };
}

/**
 * Determine the current phase for balanced mode based on gang state.
 * Phases: grow → respect → territory → money
 */
export function determineBalancedPhase(
  members: MemberInfo[],
  gangInfo: GangInfo,
  growTargetMultiplier: number,
): "grow" | "respect" | "territory" | "money" {
  if (members.length === 0) return "grow";

  const avgMult = members.reduce((sum, m) => sum + avgCombatMultiplier(m), 0) / members.length;

  // Phase 1: Grow - if average multiplier is below half the target, keep growing
  if (avgMult < growTargetMultiplier * 0.5) return "grow";

  // Phase 2: Respect - if we don't have max members yet, build respect
  if (members.length < NATO_NAMES.length) return "respect";

  // Phase 3: Territory - if territory < 100% and members are strong
  if (gangInfo.territory < 0.99) return "territory";

  // Phase 4: Money - everything maxed, make money
  return "money";
}

/**
 * Assign tasks to all members based on strategy.
 * Respects pinned members and handles wanted cleanup.
 */
export function assignTasks(
  members: MemberInfo[],
  config: GangTaskConfig,
  gangInfo: GangInfo,
  taskStats: TaskStats[],
  pinnedMembers: Record<string, string>,
  territoryContext?: TerritoryContext | null,
): TaskAssignment[] {
  const assignments: TaskAssignment[] = [];
  const assigned = new Set<string>();

  // 1. Pinned members keep their tasks
  for (const member of members) {
    if (pinnedMembers[member.name]) {
      assignments.push({
        memberName: member.name,
        task: pinnedMembers[member.name],
        reason: "pinned",
      });
      assigned.add(member.name);
    }
  }

  // 2. Wanted cleanup - assign weakest unpinned members to Vigilante Justice
  const unpinned = members.filter(m => !assigned.has(m.name));
  if (gangInfo.wantedPenalty < config.wantedThreshold && gangInfo.wantedLevel > 1) {
    const cleaners = selectWantedCleaners(unpinned, config.wantedThreshold, gangInfo.wantedPenalty);
    for (const name of cleaners) {
      assignments.push({
        memberName: name,
        task: "Vigilante Justice",
        reason: `wanted cleanup (${(gangInfo.wantedPenalty * 100).toFixed(1)}% < ${(config.wantedThreshold * 100).toFixed(0)}%)`,
      });
      assigned.add(name);
    }
  }

  // 3. Remaining members get strategy-based tasks
  const remaining = members.filter(m => !assigned.has(m.name));
  const combatTasks = taskStats.filter(t => t.isCombat && t.name !== "Vigilante Justice" && t.name !== "Territory Warfare");
  const trainingTask = taskStats.find(t => t.name === "Train Combat");

  // Determine effective strategy (balanced resolves to a phase)
  const effectiveStrategy = config.strategy === "balanced"
    ? determineBalancedPhase(remaining, gangInfo, config.growTargetMultiplier)
    : config.strategy;

  if (effectiveStrategy === "grow") {
    // Grow mode: most members train, reserve some for respect
    assignGrowTasks(remaining, assignments, config, combatTasks, trainingTask);
  } else if (effectiveStrategy === "territory") {
    // Territory mode does a smart split instead of all-warfare
    assignTerritorySplitTasks(remaining, assignments, config, combatTasks, gangInfo, territoryContext ?? null);
  } else {
    // Standard strategies: train weak members, then assign by strategy
    for (const member of remaining) {
      const combatTotal = totalCombatStats(member);
      const trainingTarget = config.trainingThreshold * 4;
      if (combatTotal < trainingTarget && trainingTask) {
        assignments.push({
          memberName: member.name,
          task: trainingTask.name,
          reason: `training (${Math.round(combatTotal)}/${Math.round(trainingTarget)} combat stats)`,
        });
        continue;
      }

      const task = selectTaskForStrategy(member, effectiveStrategy, combatTasks);
      assignments.push(task);
    }
  }

  return assignments;
}

/**
 * Assign territory split tasks — strongest N on warfare, rest on money.
 *
 * This is the key change: instead of putting everyone on Territory Warfare,
 * we calculate how many are actually needed based on clash win chances and
 * power ratios, then let the rest earn money.
 *
 * From source code analysis:
 * - Territory gain is 0.0001 * powerBonus * random(0.5-1.5) per clash
 * - powerBonus is logarithmic (diminishing returns on extra power)
 * - Losers lose 1% power per clash (passive snowball)
 * - Therefore: maintain power dominance with minimal members, maximize income
 */
function assignTerritorySplitTasks(
  members: MemberInfo[],
  assignments: TaskAssignment[],
  config: GangTaskConfig,
  combatTasks: TaskStats[],
  gangInfo: GangInfo,
  territoryContext: TerritoryContext | null,
): void {
  const trainingTask = "Train Combat";
  const trainingTarget = config.trainingThreshold * 4;

  // Separate trainable from ready members
  const trainees: MemberInfo[] = [];
  const ready: MemberInfo[] = [];
  for (const member of members) {
    if (totalCombatStats(member) < trainingTarget) {
      trainees.push(member);
    } else {
      ready.push(member);
    }
  }

  // Assign trainees to training
  for (const member of trainees) {
    assignments.push({
      memberName: member.name,
      task: trainingTask,
      reason: `training (${Math.round(totalCombatStats(member))}/${Math.round(trainingTarget)} combat stats)`,
    });
  }

  // Calculate warfare count from ready members only
  const { count: warfareCount, reason: warfareReason } = calculateWarfareCount(
    ready, territoryContext, gangInfo.territory,
  );

  // Sort ready members by total combat stats descending — strongest go to warfare
  const sorted = [...ready].sort((a, b) => totalCombatStats(b) - totalCombatStats(a));

  const actualWarfare = Math.min(warfareCount, sorted.length);

  for (let i = 0; i < sorted.length; i++) {
    const member = sorted[i];
    if (i < actualWarfare) {
      // Warfare assignment
      assignments.push({
        memberName: member.name,
        task: "Territory Warfare",
        reason: `warfare (${warfareReason})`,
      });
    } else {
      // Money assignment — best money task for this member
      assignments.push(selectBestTask(member, combatTasks, "money", `money while territory grows`));
    }
  }
}

/**
 * Assign tasks in grow mode: train everyone except a respect reserve.
 * Graduated members (multiplier >= target) do respect/money tasks.
 */
function assignGrowTasks(
  members: MemberInfo[],
  assignments: TaskAssignment[],
  config: GangTaskConfig,
  combatTasks: TaskStats[],
  trainingTask: TaskStats | undefined,
): void {
  // Sort by multiplier descending — strongest members are candidates for respect reserve
  const sorted = [...members].sort((a, b) => avgCombatMultiplier(b) - avgCombatMultiplier(a));

  let respectReserveUsed = 0;

  for (const member of sorted) {
    const mult = avgCombatMultiplier(member);
    const graduated = mult >= config.growTargetMultiplier;

    // Graduated members do money tasks (they're strong enough)
    if (graduated) {
      assignments.push(selectBestTask(member, combatTasks, "money", "graduated"));
      continue;
    }

    // Reserve some strong members for respect (maintain recruitment)
    if (respectReserveUsed < config.growRespectReserve) {
      respectReserveUsed++;
      assignments.push(selectBestTask(member, combatTasks, "respect", "respect reserve"));
      continue;
    }

    // Everyone else trains
    if (trainingTask) {
      assignments.push({
        memberName: member.name,
        task: trainingTask.name,
        reason: `grow (x${mult.toFixed(1)} → x${config.growTargetMultiplier} target)`,
      });
    } else {
      assignments.push({
        memberName: member.name,
        task: "Train Combat",
        reason: "grow (training)",
      });
    }
  }
}

/**
 * Select the best task for a member based on a resolved strategy.
 */
function selectTaskForStrategy(
  member: MemberInfo,
  strategy: string,
  combatTasks: TaskStats[],
): TaskAssignment {
  switch (strategy) {
    case "respect":
      return selectBestTask(member, combatTasks, "respect");
    case "money":
      return selectBestTask(member, combatTasks, "money");
    case "territory":
      return {
        memberName: member.name,
        task: "Territory Warfare",
        reason: "territory strategy",
      };
    case "grow":
      // Shouldn't reach here (handled by assignGrowTasks), but fallback
      return selectBestTask(member, combatTasks, "respect");
    default:
      return selectBestTask(member, combatTasks, "respect");
  }
}

/**
 * Select the best task for a member based on optimization target.
 */
function selectBestTask(
  member: MemberInfo,
  tasks: TaskStats[],
  optimize: "respect" | "money",
  reasonOverride?: string,
): TaskAssignment {
  if (tasks.length === 0) {
    return { memberName: member.name, task: "Train Combat", reason: "no tasks available" };
  }

  let bestTask = tasks[0];
  let bestScore = -Infinity;

  for (const task of tasks) {
    const alignment = memberTaskAlignment(member, task);
    const baseValue = optimize === "respect" ? task.baseRespect : task.baseMoney;
    const score = baseValue * alignment;
    if (score > bestScore) {
      bestScore = score;
      bestTask = task;
    }
  }

  return {
    memberName: member.name,
    task: bestTask.name,
    reason: reasonOverride ?? `best ${optimize} (${bestTask.name})`,
  };
}

/**
 * Score an ascension result to determine action.
 */
export function scoreAscension(
  result: AscensionResult,
  autoThreshold: number,
  reviewThreshold: number,
): { action: "auto" | "flag" | "skip"; bestGain: number; bestStat: string } {
  const gains: [string, number][] = [
    ["str", result.str],
    ["def", result.def],
    ["dex", result.dex],
    ["agi", result.agi],
  ];

  // Find the best combat stat gain (multiplier, so >1 means improvement)
  const [bestStat, bestGain] = gains.reduce(
    (best, curr) => (curr[1] > best[1] ? curr : best),
    gains[0],
  );

  if (bestGain >= autoThreshold) {
    return { action: "auto", bestGain, bestStat };
  }
  if (bestGain >= reviewThreshold) {
    return { action: "flag", bestGain, bestStat };
  }
  return { action: "skip", bestGain, bestStat };
}

/**
 * From a list of auto-eligible ascension candidates, pick the single best one.
 * Staggering ascensions (1 per tick) prevents tanking all respect at once.
 */
export function selectAscensionCandidate(
  candidates: { name: string; result: AscensionResult }[],
  autoThreshold: number,
): { name: string; bestGain: number; bestStat: string } | null {
  const scored = candidates
    .map(c => {
      const gains: [string, number][] = [
        ["str", c.result.str], ["def", c.result.def],
        ["dex", c.result.dex], ["agi", c.result.agi],
      ];
      const [bestStat, bestGain] = gains.reduce((best, curr) => curr[1] > best[1] ? curr : best, gains[0]);
      return { name: c.name, bestGain, bestStat };
    })
    .filter(c => c.bestGain >= autoThreshold)
    .sort((a, b) => b.bestGain - a.bestGain);

  return scored.length > 0 ? scored[0] : null;
}

/**
 * Rank equipment by ROI for purchasing priority.
 * ROI = weighted stat delta / cost, using current task's stat weights.
 */
export function rankEquipment(
  equipment: EquipmentInfo[],
  currentTaskStats: TaskStats | null,
  ownedEquipment: Set<string>,
): { name: string; cost: number; roi: number; type: string }[] {
  const available = equipment.filter(e => !ownedEquipment.has(e.name));

  // Default weights if no current task
  const weights = {
    str: currentTaskStats?.strWeight ?? 0.25,
    def: currentTaskStats?.defWeight ?? 0.25,
    dex: currentTaskStats?.dexWeight ?? 0.25,
    agi: currentTaskStats?.agiWeight ?? 0.25,
    cha: currentTaskStats?.chaWeight ?? 0,
    hack: currentTaskStats?.hackWeight ?? 0,
  };

  return available
    .map(e => {
      // Equipment stats are multipliers (e.g. 1.04 = +4%), not additive
      // deltas — subtract the 1.0 baseline so ROI reflects the actual
      // bonus. Missing stats (equipment doesn't affect that stat) default
      // to 1 (no bonus) rather than 0, which would otherwise be double
      // counted against the baseline.
      const statDelta =
        ((e.stats.str ?? 1) - 1) * weights.str +
        ((e.stats.def ?? 1) - 1) * weights.def +
        ((e.stats.dex ?? 1) - 1) * weights.dex +
        ((e.stats.agi ?? 1) - 1) * weights.agi +
        ((e.stats.cha ?? 1) - 1) * weights.cha +
        ((e.stats.hack ?? 1) - 1) * weights.hack;
      const roi = e.cost > 0 ? statDelta / e.cost : 0;
      return { name: e.name, cost: e.cost, roi, type: e.type };
    })
    .filter(e => e.roi > 0)
    .sort((a, b) => b.roi - a.roi);
}
