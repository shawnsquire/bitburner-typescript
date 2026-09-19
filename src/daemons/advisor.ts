/**
 * Advisor Daemon
 *
 * Reads all status ports, scores possible player actions via rule functions,
 * and publishes ranked recommendations to port 17. Provides a "what should I
 * do next?" view of the game state.
 *
 * Usage: run daemons/advisor.js
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { peekStatus, publishStatus } from "/lib/ports";
import { writeDefaultConfig, getConfigNumber } from "/lib/config";
import {
  STATUS_PORTS,
  AdvisorStatus,
  Recommendation,
  NukeStatus,
  HackStatus,
  PservStatus,
  ShareStatus,
  RepStatus,
  DarkwebStatus,
  WorkStatus,
  BitnodeStatus,
  FactionInfo,
  FactionStatus,
  GangStatus,
  GangTerritoryStatus,
  AugmentsStatus,
} from "/types/ports";

const C = COLORS;

// === ADVISOR CONTEXT ===

export interface AdvisorContext {
  nuke: NukeStatus | null;
  hack: HackStatus | null;
  pserv: PservStatus | null;
  share: ShareStatus | null;
  rep: RepStatus | null;
  darkweb: DarkwebStatus | null;
  work: WorkStatus | null;
  bitnode: BitnodeStatus | null;
  faction: FactionStatus | null;
  gang: GangStatus | null;
  gangTerritory: GangTerritoryStatus | null;
  augments: AugmentsStatus | null;
}

function gatherContext(ns: NS): AdvisorContext {
  return {
    nuke: peekStatus<NukeStatus>(ns, STATUS_PORTS.nuke),
    hack: peekStatus<HackStatus>(ns, STATUS_PORTS.hack),
    pserv: peekStatus<PservStatus>(ns, STATUS_PORTS.pserv),
    share: peekStatus<ShareStatus>(ns, STATUS_PORTS.share),
    rep: peekStatus<RepStatus>(ns, STATUS_PORTS.rep),
    darkweb: peekStatus<DarkwebStatus>(ns, STATUS_PORTS.darkweb),
    work: peekStatus<WorkStatus>(ns, STATUS_PORTS.work),
    bitnode: peekStatus<BitnodeStatus>(ns, STATUS_PORTS.bitnode),
    faction: peekStatus<FactionStatus>(ns, STATUS_PORTS.faction),
    gang: peekStatus<GangStatus>(ns, STATUS_PORTS.gang),
    gangTerritory: peekStatus<GangTerritoryStatus>(ns, STATUS_PORTS.gangTerritory),
    augments: peekStatus<AugmentsStatus>(ns, STATUS_PORTS.augments),
  };
}

// === RULE TYPE ===

export type AdvisorRule = (ctx: AdvisorContext) => Recommendation | null;

// === RULES ===

export function ruleBuyTor(ctx: AdvisorContext): Recommendation | null {
  const dw = ctx.darkweb;
  const w = ctx.work;
  if (!dw || dw.hasTorRouter) return null;
  const canAfford = w ? w.playerMoney >= 200000 : false;
  return {
    id: "buy-tor",
    title: "Buy TOR Router",
    reason: canAfford
      ? "Unlocks darkweb programs — you can afford it now"
      : "Unlocks darkweb programs for cracking more servers",
    category: "infrastructure",
    score: canAfford ? 85 : 70,
  };
}

export function ruleBuyProgram(ctx: AdvisorContext): Recommendation | null {
  const dw = ctx.darkweb;
  if (!dw || !dw.hasTorRouter || dw.allOwned || !dw.nextProgram) return null;
  return {
    id: "buy-program",
    title: `Buy ${dw.nextProgram.name}`,
    reason: dw.canAffordNext
      ? `You can afford ${dw.nextProgram.name} (${dw.nextProgram.costFormatted})`
      : `Next program costs ${dw.nextProgram.costFormatted} — need ${dw.moneyUntilNextFormatted} more`,
    category: "infrastructure",
    score: dw.canAffordNext ? 75 : 50,
  };
}

export function ruleRootServers(ctx: AdvisorContext): Recommendation | null {
  const nukeStatus = ctx.nuke;
  if (!nukeStatus || nukeStatus.ready.length === 0) return null;
  return {
    id: "root-servers",
    title: `Root ${nukeStatus.ready.length} Server${nukeStatus.ready.length > 1 ? "s" : ""}`,
    reason: `${nukeStatus.ready.length} server(s) ready to nuke — will expand your fleet`,
    category: "infrastructure",
    score: 70,
  };
}

export function ruleBuyPserv(ctx: AdvisorContext): Recommendation | null {
  const pservStatus = ctx.pserv;
  if (!pservStatus || pservStatus.serverCount >= pservStatus.serverCap) return null;
  return {
    id: "buy-pserv",
    title: "Buy Personal Server",
    reason: `${pservStatus.serverCount}/${pservStatus.serverCap} slots used — more servers increase hacking income`,
    category: "infrastructure",
    score: pservStatus.serverCount < 5 ? 60 : 45,
  };
}

export function ruleUpgradePserv(ctx: AdvisorContext): Recommendation | null {
  const pservStatus = ctx.pserv;
  if (!pservStatus || pservStatus.allMaxed || !pservStatus.nextUpgrade) return null;
  return {
    id: "upgrade-pserv",
    title: "Upgrade Personal Server",
    reason: pservStatus.nextUpgrade.canAfford
      ? `${pservStatus.nextUpgrade.hostname}: ${pservStatus.nextUpgrade.currentRam} → ${pservStatus.nextUpgrade.nextRam} (${pservStatus.nextUpgrade.costFormatted})`
      : `Next upgrade: ${pservStatus.nextUpgrade.costFormatted} for ${pservStatus.nextUpgrade.hostname}`,
    category: "infrastructure",
    score: pservStatus.nextUpgrade.canAfford ? 55 : 40,
  };
}

export function ruleTrainHackingForNuke(ctx: AdvisorContext): Recommendation | null {
  const nukeStatus = ctx.nuke;
  if (!nukeStatus || nukeStatus.needHacking.length === 0) return null;
  const closest = nukeStatus.needHacking[0];
  const gap = closest.required - closest.current;
  if (gap <= 0) return null;
  return {
    id: "train-hack-nuke",
    title: "Train Hacking (Nuke)",
    reason: `Need ${closest.required} hacking for ${closest.hostname} (${gap} more levels)`,
    category: "skills",
    score: gap < 20 ? 60 : 50,
  };
}

export function ruleTrainHackingForTargets(ctx: AdvisorContext): Recommendation | null {
  const hackStatus = ctx.hack;
  if (!hackStatus || !hackStatus.needHigherLevel) return null;
  return {
    id: "train-hack-targets",
    title: "Train Hacking (Targets)",
    reason: `${hackStatus.needHigherLevel.count} hack target(s) need level ${hackStatus.needHigherLevel.nextLevel}`,
    category: "skills",
    score: 65,
  };
}

export function ruleBalanceCombat(ctx: AdvisorContext): Recommendation | null {
  const w = ctx.work;
  if (!w) return null;
  if (w.combatBalance >= 0.9) return null;
  return {
    id: "balance-combat",
    title: "Balance Combat Stats",
    reason: `Combat balance ${(w.combatBalance * 100).toFixed(0)}% — lowest: ${w.lowestCombatStat}, highest: ${w.highestCombatStat}`,
    category: "skills",
    score: w.combatBalance < 0.5 ? 40 : 30,
  };
}

export function ruleJoinFaction(ctx: AdvisorContext): Recommendation | null {
  const f = ctx.faction;
  if (!f || !f.pendingInvitations || f.pendingInvitations.length === 0) return null;

  // Filter to factions that still have augments we don't own
  const worthJoining = f.pendingInvitations.filter(name => {
    const info = f.factions.find(fi => fi.name === name);
    // If we don't have aug info, assume worth joining
    if (!info || info.availableAugCount === undefined) return true;
    return info.availableAugCount > 0;
  });

  if (worthJoining.length === 0) return null;
  return {
    id: "join-faction",
    title: `Join ${worthJoining[0]}`,
    reason: worthJoining.length > 1
      ? `${worthJoining.length} faction invitation(s) with available augments`
      : `Invitation from ${worthJoining[0]} — ${f.factions.find(fi => fi.name === worthJoining[0])?.availableAugCount ?? "?"} augment(s) available`,
    category: "factions",
    score: 70,
  };
}

export function ruleBackdoorServers(ctx: AdvisorContext): Recommendation | null {
  const f = ctx.faction;
  if (!f || !f.pendingBackdoors) return null;
  const ready = f.pendingBackdoors.filter(b => b.rooted && b.haveHacking);
  if (ready.length === 0) return null;
  return {
    id: "backdoor-servers",
    title: `Backdoor ${ready.length} Server${ready.length > 1 ? "s" : ""}`,
    reason: `Ready to backdoor for: ${ready.map(b => b.faction).join(", ")}`,
    category: "factions",
    score: 55,
  };
}

export function ruleStartFactionWork(ctx: AdvisorContext): Recommendation | null {
  const rep = ctx.rep;
  if (!rep) return null;
  if (rep.isWorkingForFaction) return null;
  if (!rep.targetFaction || !rep.nextAugName) return null;
  // repGapPositive is true while a rep DEFICIT remains (repGap = max(0, required - current) > 0,
  // see computeTierNStatus in daemons/rep.ts) — i.e. it means "still need more rep", not
  // "already have enough". Skip only once the gap has closed (repGapPositive is false).
  if (!rep.repGapPositive) return null; // already have enough rep
  return {
    id: "faction-work",
    title: `Work for ${rep.targetFaction}`,
    reason: `Need ${rep.repGapFormatted ?? "?"} more rep for ${rep.nextAugName}`,
    category: "factions",
    score: rep.repProgress !== undefined && rep.repProgress > 0.8 ? 60 : 50,
  };
}

export function ruleStartShare(ctx: AdvisorContext): Recommendation | null {
  const shareStatus = ctx.share;
  const rep = ctx.rep;
  if (!rep || !rep.targetFaction) return null;
  // See ruleStartFactionWork: repGapPositive true means a rep deficit remains.
  if (!rep.repGapPositive) return null; // already have enough rep
  // totalThreads/cycleStatus come from daemons/share.ts: totalThreads is formatted with
  // toLocaleString() (e.g. "1,234"), which Number() cannot parse back (=> NaN) once threads
  // reach four digits. cycleStatus is the reliable "is share currently running" signal instead.
  if (shareStatus && (shareStatus.cycleStatus === "active" || shareStatus.cycleStatus === "cycle")) return null; // already sharing
  return {
    id: "start-share",
    title: "Start Sharing for Rep Boost",
    reason: "Share power multiplies faction rep gain — start share daemon",
    category: "factions",
    score: 35,
  };
}

export function rulePurchaseAugs(ctx: AdvisorContext): Recommendation | null {
  const aug = ctx.augments;
  if (!aug || aug.available.length === 0) return null;
  const affordable = aug.available.filter(a => a.adjustedCost <= aug.playerMoney);
  if (affordable.length === 0) return null;
  return {
    id: "purchase-augs",
    title: `Purchase ${affordable.length} Augmentation${affordable.length > 1 ? "s" : ""}`,
    reason: `${affordable.length} aug(s) affordable — buy before prices increase`,
    category: "augmentations",
    score: affordable.length >= 5 ? 85 : 75,
  };
}

export function ruleInstallAugs(ctx: AdvisorContext): Recommendation | null {
  const aug = ctx.augments;
  if (!aug || aug.pendingAugs === 0) return null;
  // Higher score if many pending or no affordable left
  const affordable = aug.available.filter(a => a.adjustedCost <= aug.playerMoney);
  const nothingLeftToBuy = affordable.length === 0;
  return {
    id: "install-augs",
    title: `Install ${aug.pendingAugs} Augmentation${aug.pendingAugs > 1 ? "s" : ""}`,
    reason: nothingLeftToBuy
      ? `${aug.pendingAugs} aug(s) pending — no more affordable augs to buy`
      : `${aug.pendingAugs} aug(s) pending install`,
    category: "augmentations",
    score: nothingLeftToBuy ? 95 : aug.pendingAugs >= 10 ? 80 : 60,
  };
}

export function findDaedalus(ctx: AdvisorContext): FactionInfo | null {
  if (!ctx.faction) return null;
  return ctx.faction.factions.find(f => f.name === "Daedalus") ?? null;
}

export function ruleDaedalusApproaching(ctx: AdvisorContext): Recommendation | null {
  const bn = ctx.bitnode;
  if (!bn || bn.allComplete) return null;

  const checks = [
    { done: bn.augsComplete, progress: bn.augmentations / bn.augmentationsRequired, label: `${bn.augmentationsRequired - bn.augmentations} more aug(s)` },
    { done: bn.moneyComplete, progress: bn.money / bn.moneyRequired, label: `need ${bn.moneyRequiredFormatted}` },
    { done: bn.hackingComplete, progress: bn.hacking / bn.hackingRequired, label: `need ${bn.hackingRequired} hacking` },
  ];

  const metCount = checks.filter(c => c.done).length;
  const bestUnmet = checks.filter(c => !c.done).sort((a, b) => b.progress - a.progress)[0];
  if (!bestUnmet) return null;

  // Fire when 2/3 met OR closest req is 60%+
  if (metCount < 2 && bestUnmet.progress < 0.6) return null;

  const missing = checks.filter(c => !c.done).map(c => c.label);
  const progress = bestUnmet.progress;
  const score = Math.round(35 + (progress * 20)); // 35-55

  return {
    id: "daedalus-approaching",
    title: "Approaching Daedalus",
    reason: `${metCount}/3 requirements met — ${missing.join(", ")}`,
    category: "endgame",
    score: Math.min(score, 55),
  };
}

export function ruleDaedalusReady(ctx: AdvisorContext): Recommendation | null {
  const bn = ctx.bitnode;
  if (!bn || !bn.allComplete) return null;

  const daedalus = findDaedalus(ctx);
  if (daedalus && daedalus.status === "joined") return null;

  const score = daedalus?.status === "invited" ? 85 : 80;
  const reason = daedalus?.status === "invited"
    ? "Daedalus invitation waiting — join to unlock The Red Pill"
    : "All requirements met — seek Daedalus invitation";

  return {
    id: "daedalus-ready",
    title: "Seek Daedalus Invitation",
    reason,
    category: "endgame",
    score,
  };
}

export function ruleDaedalusWork(ctx: AdvisorContext): Recommendation | null {
  const daedalus = findDaedalus(ctx);
  if (!daedalus || daedalus.status !== "joined") return null;

  // If rep daemon is already targeting Daedalus, let ruleStartFactionWork handle it
  const rep = ctx.rep;
  if (rep?.targetFaction === "Daedalus") return null;

  // If we already have enough rep for Daedalus (repGapPositive false, i.e. no gap remains), skip.
  // We can't check directly here, but if bitnode allComplete + Daedalus joined, defer to ruleBitnodeExit
  const bn = ctx.bitnode;
  if (bn?.allComplete) return null;

  return {
    id: "daedalus-work",
    title: "Earn Rep with Daedalus",
    reason: "Focus rep daemon on Daedalus to unlock The Red Pill augmentation",
    category: "endgame",
    score: 75,
  };
}

export function ruleBitnodeExit(ctx: AdvisorContext): Recommendation | null {
  const bn = ctx.bitnode;
  if (!bn || !bn.allComplete) return null;

  const daedalus = findDaedalus(ctx);
  if (!daedalus || daedalus.status !== "joined") return null;

  // Evidence of sufficient rep: rep daemon targeting Daedalus with the gap closed
  // (repGapPositive false), or rep daemon no longer targeting Daedalus (implies TRP already
  // purchased). Default to "not enough" when unknown so we don't recommend exiting prematurely.
  const rep = ctx.rep;
  const hasEnoughRep = rep?.targetFaction === "Daedalus" ? !(rep?.repGapPositive ?? true) : true;
  if (!hasEnoughRep) return null;

  return {
    id: "bitnode-exit",
    title: "Destroy the Bitnode",
    reason: "Hack w0r1d_d43m0n — all Daedalus requirements met",
    category: "endgame",
    score: 100,
  };
}

export function ruleGangTerritory(ctx: AdvisorContext): Recommendation | null {
  const g = ctx.gang;
  const gt = ctx.gangTerritory;
  if (!g || !g.inGang || !gt) return null;
  if (gt.recommendedAction === "hold") return null;
  const toggle = gt.recommendedAction === "enable" ? "enable" : "disable";
  return {
    id: "gang-territory",
    title: `${toggle === "enable" ? "Enable" : "Disable"} Territory Warfare`,
    reason: toggle === "enable"
      ? `Winning clashes — territory at ${(gt.ourTerritory * 100).toFixed(1)}%`
      : `Losing clashes — disable to protect territory`,
    category: "gang",
    score: toggle === "enable" ? 50 : 45,
  };
}

export function ruleGangAscension(ctx: AdvisorContext): Recommendation | null {
  const g = ctx.gang;
  if (!g || !g.inGang || !g.ascensionAlerts || g.ascensionAlerts.length === 0) return null;
  const best = g.ascensionAlerts[0];
  return {
    id: "gang-ascend",
    title: `Ascend ${best.memberName}`,
    reason: `${best.bestStat} x${best.bestGain.toFixed(2)} multiplier gain`,
    category: "gang",
    score: 55,
  };
}

// === RULE REGISTRY ===

export const RULES: AdvisorRule[] = [
  ruleBuyTor,
  ruleBuyProgram,
  ruleRootServers,
  ruleBuyPserv,
  ruleUpgradePserv,
  ruleTrainHackingForNuke,
  ruleTrainHackingForTargets,
  ruleBalanceCombat,
  ruleJoinFaction,
  ruleBackdoorServers,
  ruleStartFactionWork,
  ruleStartShare,
  rulePurchaseAugs,
  ruleInstallAugs,
  ruleDaedalusApproaching,
  ruleDaedalusReady,
  ruleDaedalusWork,
  ruleBitnodeExit,
  ruleGangTerritory,
  ruleGangAscension,
];

// === SCORING ENGINE ===

const MAX_RECOMMENDATIONS = 20;

export function evaluate(ctx: AdvisorContext): AdvisorStatus {
  const start = Date.now();
  const recommendations: Recommendation[] = [];

  for (const rule of RULES) {
    try {
      const rec = rule(ctx);
      if (rec) recommendations.push(rec);
    } catch {
      // Skip rules that throw
    }
  }

  recommendations.sort((a, b) => b.score - a.score);
  const trimmed = recommendations.slice(0, MAX_RECOMMENDATIONS);

  const topCategory = trimmed.length > 0 ? trimmed[0].category : null;

  return {
    recommendations: trimmed,
    totalEvaluated: RULES.length,
    topCategory,
    lastAnalysisMs: Date.now() - start,
  };
}

// === MAIN ===

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "advisor", {
    "interval": "5000",
  });

  const interval = getConfigNumber(ns, "advisor", "interval", 5000);

  ns.print(`${C.cyan}Advisor daemon started${C.reset} (interval: ${interval}ms)`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ctx = gatherContext(ns);
    const status = evaluate(ctx);

    publishStatus(ns, STATUS_PORTS.advisor, status);

    // Print summary
    ns.print("");
    ns.print(`${C.cyan}=== Advisor Analysis ===${C.reset} (${status.lastAnalysisMs}ms, ${status.recommendations.length} recs)`);
    for (const rec of status.recommendations.slice(0, 8)) {
      const scoreColor = rec.score >= 90 ? C.red
        : rec.score >= 70 ? C.yellow
        : rec.score >= 50 ? C.green
        : C.dim;
      ns.print(`  ${scoreColor}[${rec.score}]${C.reset} ${rec.title} ${C.dim}— ${rec.reason}${C.reset}`);
    }
    if (status.recommendations.length > 8) {
      ns.print(`  ${C.dim}... +${status.recommendations.length - 8} more${C.reset}`);
    }
    if (status.recommendations.length === 0) {
      ns.print(`  ${C.dim}No recommendations — all systems nominal${C.reset}`);
    }

    await ns.sleep(interval);
  }
}
