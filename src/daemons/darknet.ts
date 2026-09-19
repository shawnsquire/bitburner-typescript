/**
 * Darknet Coordinator Daemon
 *
 * Thin ns-facing shell around the pure brain in `controllers/darknet.ts`:
 * owns every `ns` call for the darknet system (config, reports, polling,
 * policy, re-seeding, status) and feeds the controller plain data. No
 * business logic lives here beyond wiring — see
 * `docs/design/2026-09-19-darknet.md` section 4 for the tick this replicates.
 *
 * Usage: run daemons/darknet.js
 */
import { NS } from "@ns";
import {
  createModel,
  applyReport,
  refreshFromDetails,
  computePolicy,
  toStatus,
  DEFAULT_CONFIG,
} from "/controllers/darknet";
import type { DarknetConfig, DarknetModel, Limits, PlayerInfo } from "/controllers/darknet";
import { publishStatus } from "/lib/ports";
import { writeDefaultConfig, getConfigBool, getConfigNumber, getConfigString, setConfigValue } from "/lib/config";
import { loadVault, saveVault } from "/lib/darknet/vault";
import { publishPolicy, drainReports } from "/lib/darknet/wire";
import { DNET_BUNDLE, DNET_WORKERS, LAB_HOSTS, LAB_MODEL_ID } from "/lib/darknet/protocol";
import type { SeenDetails } from "/lib/darknet/protocol";
import { STATUS_PORTS, DARKNET_CONTROL_PORT, CONTRACTS_CONTROL_PORT } from "/types/ports";

// RAM budget (pinned, not tiered — every ns call below is cheap and fixed):
//   base 1.6 + dnet.getServerDetails 0.1 + scp 0.6 + exec 1.3
//   + dnet.connectToSession 0.05 + getResetInfo 1.0 + getPlayer 0.5
//   + fileExists 0.1 + hasRootAccess 0.05 = 5.30
// dnet.getStasisLinkLimit / getStasisLinkedServers / getDarknetInstability,
// getPortHandle, sleep, print, disableLog, read and write are all 0 GB.
/** @ram 5.3 */
export function main(ns: NS): Promise<void> {
  ns.ramOverride(5.3);
  return daemon(ns);
}

const LAB_NAMES = Object.keys(LAB_HOSTS) as (keyof typeof LAB_HOSTS)[];
const NONE_LIMITS: Limits = { stasisLimit: 0, access: "none", labName: null };
const NONE_INSTABILITY = { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0 };
// Matches refreshFromDetails' own "agent gone silent" window — avoid
// re-scp'ing the whole bundle every 2s tick while a freshly-exec'd agent
// hasn't had time to send its first report yet.
const RESEED_THROTTLE_MULT = 3;

interface DarknetControlCommand {
  action?: string;
  key?: string;
  value?: string;
  host?: string;
  link?: boolean;
}

/** Re-read `/config/darknet.txt` into a `DarknetConfig`, so in-game edits apply without a restart. */
function readDarknetConfig(ns: NS): DarknetConfig {
  const stasisMode = getConfigString(ns, "darknet", "stasisMode", DEFAULT_CONFIG.stasisMode);
  const storm = getConfigString(ns, "darknet", "storm", DEFAULT_CONFIG.storm);
  return {
    heartbleed: getConfigBool(ns, "darknet", "heartbleed", DEFAULT_CONFIG.heartbleed),
    harvest: getConfigBool(ns, "darknet", "harvest", DEFAULT_CONFIG.harvest),
    phish: getConfigBool(ns, "darknet", "phish", DEFAULT_CONFIG.phish),
    phishMaxThreads: getConfigNumber(ns, "darknet", "phishMaxThreads", DEFAULT_CONFIG.phishMaxThreads),
    harvestKarmaFloor: getConfigNumber(ns, "darknet", "harvestKarmaFloor", DEFAULT_CONFIG.harvestKarmaFloor),
    stasisMode: stasisMode === "manual" ? "manual" : "auto",
    storm: storm === "auto" ? "auto" : "manual",
    lab: getConfigBool(ns, "darknet", "lab", DEFAULT_CONFIG.lab),
    gapPatienceMs: getConfigNumber(ns, "darknet", "gapPatienceMs", DEFAULT_CONFIG.gapPatienceMs),
    agentIntervalMs: getConfigNumber(ns, "darknet", "agentIntervalMs", DEFAULT_CONFIG.agentIntervalMs),
    maxAttempts: getConfigNumber(ns, "darknet", "maxAttempts", DEFAULT_CONFIG.maxAttempts),
  };
}

/**
 * A fully-offline `SeenDetails`, used when `getServerDetails` throws (the
 * host exists but is no longer a darknet server) rather than returning the
 * game's own `isOnline: false` dummy. Carries forward whatever the model
 * already knew about the host so a transient hiccup doesn't wipe its
 * fingerprint fields to zero for no reason; `refreshFromDetails` only reads
 * `isOnline` before deciding to tombstone the cell anyway.
 */
function offlineDetails(prior: SeenDetails | null): SeenDetails {
  return {
    isOnline: false,
    isConnectedToCurrentServer: false,
    hasSession: false,
    modelId: prior?.modelId ?? "",
    passwordHint: prior?.passwordHint ?? "",
    data: prior?.data ?? "",
    logTrafficInterval: prior?.logTrafficInterval ?? 0,
    passwordLength: prior?.passwordLength ?? 0,
    passwordFormat: prior?.passwordFormat ?? "numeric",
    blockedRam: prior?.blockedRam ?? 0,
    difficulty: prior?.difficulty ?? 0,
    depth: prior?.depth ?? 0,
    requiredCharismaSkill: prior?.requiredCharismaSkill ?? 0,
    isStationary: prior?.isStationary ?? false,
    maxRam: prior?.maxRam ?? 0,
    usedRam: prior?.usedRam ?? 0,
    hasAdmin: false,
  };
}

/**
 * Poll one known hostname. `maxRam`/`usedRam` are carried forward from
 * whatever an agent last reported (avoids paying for
 * `getServerMaxRam`/`getServerUsedRam` on a pinned daemon); `hasAdmin` is
 * re-checked fresh every tick via `hasRootAccess` since a restart clears
 * admin rights silently and a host with no resident agent would otherwise
 * never see that reflected.
 */
function pollDetails(ns: NS, host: string, prior: SeenDetails | null): SeenDetails {
  try {
    const raw = ns.dnet.getServerDetails(host);
    return {
      ...raw,
      maxRam: prior?.maxRam ?? 0,
      usedRam: prior?.usedRam ?? 0,
      hasAdmin: raw.isOnline ? ns.hasRootAccess(host) : false,
    };
  } catch {
    // getServerDetails throws for a hostname that exists but is no longer a
    // darknet server (e.g. recycled); treat exactly like offline.
    return offlineDetails(prior);
  }
}

/**
 * Which of the 8 fixed labyrinth hostnames currently exists as a live
 * darknet server. The game only ever generates the player's *current* lab
 * (`getCurrentLabName`/`getLabyrinthDetails` in the game source derive it
 * from owned reward augmentations and place only that one server); every
 * other name simply doesn't exist yet, so `getServerDetails` reports it
 * offline with no throw and no side effect. Polling all 8 is therefore a
 * safe, zero-marginal-RAM way to find the active one without any
 * Singularity augmentation check.
 */
function findCurrentLab(ns: NS): string | null {
  for (const name of LAB_NAMES) {
    try {
      const details = ns.dnet.getServerDetails(name);
      if (details.isOnline && details.modelId === LAB_MODEL_ID) return name;
    } catch {
      // Exists but isn't a darknet server — not a lab. Skip.
    }
  }
  return null;
}

/** Read every pending control-port command, applying each to `model`/config. Returns whether a `reseed` was requested. */
function readControlCommands(ns: NS, model: DarknetModel): boolean {
  let forceReseed = false;
  const port = ns.getPortHandle(DARKNET_CONTROL_PORT);

  while (!port.empty()) {
    const raw = port.read();
    if (raw === "NULL PORT DATA") break;

    let cmd: DarknetControlCommand;
    try {
      cmd = JSON.parse(raw as string) as DarknetControlCommand;
    } catch {
      continue; // malformed command, ignore
    }

    switch (cmd.action) {
      case "set":
        if (cmd.key !== undefined && cmd.value !== undefined) {
          setConfigValue(ns, "darknet", cmd.key, String(cmd.value));
        }
        break;

      case "stasis":
        if (cmd.host) {
          if (cmd.link) {
            if (!model.manualStasis.includes(cmd.host)) model.manualStasis.push(cmd.host);
          } else {
            model.manualStasis = model.manualStasis.filter((h) => h !== cmd.host);
          }
        }
        break;

      case "storm":
        // computePolicy's firing state machine only needs stormPending plus
        // a real stormSeedHost; it doesn't gate on config.storm, so this
        // works as a manual trigger regardless of the storm config mode.
        model.stormPending = true;
        break;

      case "reseed":
        forceReseed = true;
        break;

      default:
        break; // unknown/malformed action, ignore
    }
  }

  return forceReseed;
}

/**
 * Re-seed `darkweb` and every stasis-linked host whenever no live agent is
 * resident there (design doc section 4 step 4). Liveness is read straight
 * off the model: `refreshFromDetails`/`applyReport` already demote a cell
 * out of "agent"/"anchor" once its last report is older than a few missed
 * ticks, so that's the whole liveness check — no extra `ns.isRunning`/`ns.ps`
 * needed. A `reseed` control command bypasses both the liveness check and
 * the re-attempt throttle.
 */
function reseed(ns: NS, model: DarknetModel, lastSeedAttempt: Record<string, number>, config: DarknetConfig, forceReseed: boolean, now: number): void {
  const throttleMs = config.agentIntervalMs * RESEED_THROTTLE_MULT;
  const targets = new Set<string>(["darkweb", ...model.stasisHosts]);

  for (const host of targets) {
    const cell = model.cells[host];
    const alive = cell?.state === "agent" || cell?.state === "anchor";
    if (alive && !forceReseed) continue;

    const attemptedAt = lastSeedAttempt[host] ?? 0;
    if (!forceReseed && now - attemptedAt < throttleMs) continue;
    lastSeedAttempt[host] = now;

    if (host !== "darkweb") {
      // Only darkweb is always-authed; every other exec/scp target needs a
      // session first, which a stasis host's backdoor flag lets home
      // establish remotely from its own known vault password.
      const vaultEntry = model.vault.entries[host];
      if (!vaultEntry) continue;
      const conn = ns.dnet.connectToSession(host, vaultEntry.password);
      if (!conn.success) {
        ns.print(`darknet: connectToSession(${host}) failed: ${conn.message}`);
        continue;
      }
    }

    if (!ns.scp(DNET_BUNDLE, host, "home")) {
      ns.print(`darknet: scp to ${host} failed`);
      continue;
    }

    const pid = ns.exec(DNET_WORKERS.agent, host, { threads: 1, preventDuplicates: true }, host);
    if (pid === 0) {
      ns.print(`darknet: exec agent on ${host} failed`);
    } else {
      ns.print(`darknet: seeded agent on ${host} (pid ${pid})`);
    }
  }
}

async function daemon(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "darknet", {
    heartbleed: "true",
    harvest: "true",
    phish: "true",
    phishMaxThreads: "64",
    harvestKarmaFloor: "-1e12",
    stasisMode: "auto",
    storm: "manual",
    lab: "true",
    gapPatienceMs: "300000",
    agentIntervalMs: "2000",
    maxAttempts: "120",
  });

  const resetInfo = ns.getResetInfo();
  const model = createModel(resetInfo.lastNodeReset);
  model.vault = loadVault(ns, resetInfo.lastNodeReset);
  const lastSeedAttempt: Record<string, number> = {};

  while (true) {
    try {
      const now = Date.now();
      const config = readDarknetConfig(ns);
      const rawPlayer = ns.getPlayer();
      const player: PlayerInfo = { charisma: rawPlayer.skills.charisma, karma: rawPlayer.karma };

      if (!ns.fileExists("DarkscapeNavigator.exe", "home")) {
        publishStatus(ns, STATUS_PORTS.darknet, toStatus(model, config, player, NONE_LIMITS, NONE_INSTABILITY, now));
        await ns.sleep(30000);
        continue;
      }

      const access: "basic" | "full" = resetInfo.currentNode === 15 || (resetInfo.ownedSF.get(15) ?? 0) > 0 ? "full" : "basic";

      // Must run before applyReport: it decides "agent" vs "anchor" for the
      // very first cell a drained batch touches.
      model.stasisHosts = ns.dnet.getStasisLinkedServers();

      let vaultDirty = false;
      const contractsPort = ns.getPortHandle(CONTRACTS_CONTROL_PORT);
      for (const batch of drainReports(ns)) {
        const { contracts, vaultChanged } = applyReport(model, batch, now);
        if (vaultChanged) vaultDirty = true;
        for (const c of contracts) {
          contractsPort.tryWrite(JSON.stringify({ host: c.host, file: c.file }));
        }
      }

      for (const host of Object.keys(model.cells)) {
        const seen = pollDetails(ns, host, model.cells[host]?.details ?? null);
        const { vaultChanged } = refreshFromDetails(model, host, seen, now, config);
        if (vaultChanged) vaultDirty = true;
      }

      const forceReseed = readControlCommands(ns, model);

      const labName = access === "full" ? findCurrentLab(ns) : null;
      const limits: Limits = { stasisLimit: ns.dnet.getStasisLinkLimit(), access, labName };

      const policy = computePolicy(model, config, player, limits, now);
      publishPolicy(ns, policy);

      reseed(ns, model, lastSeedAttempt, config, forceReseed, now);

      const instability = ns.dnet.getDarknetInstability();
      publishStatus(ns, STATUS_PORTS.darknet, toStatus(model, config, player, limits, instability, now));

      if (vaultDirty) saveVault(ns, model.vault);
    } catch (e) {
      ns.print(`darknet: tick error: ${String(e)}`);
    }

    await ns.sleep(2000);
  }
}
