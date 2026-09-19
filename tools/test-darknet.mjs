#!/usr/bin/env node
/**
 * DarkNet Solver Test Harness
 *
 * Runs every solver in src/lib/darknet/solvers against the game's OWN server
 * generators (src/DarkNet/controllers/ServerGenerator.ts) and its own
 * checkPassword (src/DarkNet/effects/authentication.ts), loaded straight from
 * a checkout of bitburner-src. Everything the generators/checker themselves
 * need (dictionaries, enums, RNG, darknetAuthUtils) is loaded for real too;
 * only the UI/state/network layers around them are stubbed (see the `stubs`
 * table below).
 *
 * Usage:
 *   node tools/test-darknet.mjs                 # all models, 25 rounds each
 *   node tools/test-darknet.mjs --rounds 100    # more rounds
 *   node tools/test-darknet.mjs "ZeroLogon"     # one model (exact modelId)
 *
 * Game source location: $BITBURNER_SRC, else ~/documents/apps/games/bitburner
 * (see CLAUDE.md for how that checkout is kept on the game version you play).
 */

import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLoader } from "./lib/ts-loader.mjs";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const GAME = process.env.BITBURNER_SRC ?? join(homedir(), "documents/apps/games/bitburner");
const GAME_DARKNET = join(GAME, "src/DarkNet");

const args = process.argv.slice(2);
const roundsIdx = args.indexOf("--rounds");
const ROUNDS = roundsIdx >= 0 ? Number(args[roundsIdx + 1]) : 25;
const only = args.filter((a, i) => !a.startsWith("--") && (roundsIdx < 0 || i !== roundsIdx + 1));
const DIFFICULTIES = [1, 4, 8, 18, 30];

if (!existsSync(join(GAME_DARKNET, "controllers/ServerGenerator.ts"))) {
  console.error(`Game source not found at ${GAME}. Clone bitburner-src there or set BITBURNER_SRC.`);
  process.exit(1);
}

// ─── Stubs ──────────────────────────────────────────────────────────────────
// Everything below UI/state/network for the DarkNet minigame is stubbed; the
// generators and checker themselves, plus the dictionaries/enums/RNG/auth-math
// they depend on, are loaded for real (see loadTs calls further down).

// Filled in once ServerGenerator.ts has been loaded for real; captured lazily
// by the packetSniffing stub below (only called once a round actually runs).
let ServerGeneratorModule;

const ALPHANUMERIC_FILLER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
function randomFiller(length) {
  let result = "";
  for (let i = 0; i < length; i++) result += ALPHANUMERIC_FILLER[Math.floor(Math.random() * ALPHANUMERIC_FILLER.length)];
  return result;
}

// Mirrors game:src/DarkNet/models/packetSniffing.ts:16-24, simplified: the
// <=16 branch's noise generator (getRandomData) pulls in a large chunk of the
// darknet UI/state layer for cosmetic variety we don't need here, so it's
// replaced with plain alphanumeric-and-space filler of the same length.
function capturePackets(server) {
  const length = 124 + Math.random() * 20;
  const passwordData = server.difficulty > 16 ? server.password : ` ${server.hostname}:${server.password} `;
  const randomData = server.difficulty > 16 ? ServerGeneratorModule.getPassword(length, true) : randomFiller(length);
  const insertIndex = Math.floor(Math.random() * (randomData.length - passwordData.length));
  return randomData.slice(0, insertIndex) + passwordData + randomData.slice(insertIndex);
}

const stubs = {
  "@player": {
    Player: {
      hasProgram: () => true,
      skills: { charisma: 0 },
      hasAugmentation: () => false,
      activeSourceFileLvl: () => 0,
    },
  },
  "@nsdefs": {},
  "@enums": {
    CompletedProgramName: { darkscape: "DarkscapeNavigator.exe" },
    FactionName: {},
    LocationName: {},
  },
  "@ns": {},
  [join(GAME, "src/BitNode/BitNodeUtils.ts")]: { canAccessBitNodeFeature: () => false },
  [join(GAME, "src/Paths/Directory.ts")]: { oneInvalidCharacter: "/" },
  [join(GAME, "src/Server/DarknetServer.ts")]: {}, // type-only use
  [join(GAME, "src/Server/data/SpecialServers.ts")]: { SpecialServers: { DarkWeb: "darkweb" } },
  [join(GAME, "src/utils/helpers/clampNumber.ts")]: {
    clampNumber: (v, lo = -Number.MAX_VALUE, hi = Number.MAX_VALUE) => Math.min(Math.max(v, lo), hi),
  },
  [join(GAME, "src/utils/helpers/exceptionAlert.ts")]: { exceptionAlert: (e) => console.error(e) },
  [join(GAME_DARKNET, "effects/effects.ts")]: {
    hasFullDarknetAccess: () => true,
    handleFailedAuth() {},
    handleSuccessfulAuth() {},
  },
  [join(GAME_DARKNET, "effects/labyrinth.ts")]: {
    isLabyrinthServer: () => false,
    isLocationStatus: () => false,
    handleLabyrinthPassword() {
      throw new Error("not in harness");
    },
  },
  [join(GAME_DARKNET, "models/DarknetState.ts")]: {
    getServerState: () => ({ authenticatedPIDs: [], serverLogs: [] }),
    DarknetState: {},
  },
  [join(GAME_DARKNET, "models/DarknetServerOptions.ts")]: {
    DnetServerBuilder: (o) => o,
    isPasswordResponse: (v) => v != null && typeof v === "object" && "code" in v,
  },
  [join(GAME_DARKNET, "models/packetSniffing.ts")]: {
    logPasswordAttempt() {},
    capturePackets,
  },
  [join(GAME_DARKNET, "utils/darknetServerUtils.ts")]: {},
};

// ─── Resolver ───────────────────────────────────────────────────────────────

function resolveSpecifier(spec, fromFile) {
  if (spec === "@player" || spec === "@nsdefs" || spec === "@enums" || spec === "@ns") return spec;

  // Repo-absolute imports used by our own solvers/types modules.
  if (spec.startsWith("/lib/") || spec.startsWith("lib/") || spec.startsWith("/types/") || spec.startsWith("types/")) {
    let p = join(REPO, "src", spec.replace(/^\//, ""));
    if (!p.endsWith(".ts")) p += ".ts";
    return p;
  }

  // Relative game imports: resolve to an absolute path. If that path is one
  // of the stubbed modules above, `load()` will find it in `stubs` and never
  // touch the filesystem; otherwise it's read and transpiled for real.
  let abs = resolve(dirname(fromFile), spec);
  if (!abs.endsWith(".ts")) abs += ".ts";
  return abs;
}

const load = createLoader({ resolve: resolveSpecifier, stubs });

// ─── Load the real game modules ────────────────────────────────────────────

ServerGeneratorModule = load(join(GAME_DARKNET, "controllers/ServerGenerator.ts"));
const AuthModule = load(join(GAME_DARKNET, "effects/authentication.ts"));
const AuthUtilsModule = load(join(GAME_DARKNET, "utils/darknetAuthUtils.ts"));
load(join(GAME_DARKNET, "models/dictionaryData.ts"));
const EnumsModule = load(join(GAME_DARKNET, "Enums.ts"));
load(join(GAME_DARKNET, "Constants.ts"));
load(join(GAME, "src/Casino/RNG.ts"));

const { checkPassword } = AuthModule;
const { getSharedChars } = AuthUtilsModule;
const { getPasswordType } = ServerGeneratorModule;
const { ModelIds } = EnumsModule;

// ─── Load our own solvers through the same loader ──────────────────────────

const { SOLVERS } = load(join(REPO, "src/lib/darknet/solvers/index.ts"));
const { parseFeedback } = load(join(REPO, "src/lib/darknet/solvers/types.ts"));

// ─── modelId -> config builder ──────────────────────────────────────────────

const BUILDERS = {
  [ModelIds.NoPassword]: ServerGeneratorModule.getNoPasswordConfig,
  [ModelIds.EchoVuln]: ServerGeneratorModule.getEchoVulnConfig,
  [ModelIds.DefaultPassword]: ServerGeneratorModule.getDefaultPasswordConfig,
  [ModelIds.Captcha]: ServerGeneratorModule.getCaptchaConfig,
  [ModelIds.DogNames]: ServerGeneratorModule.getDogNameConfig,
  [ModelIds.Yesn_t]: ServerGeneratorModule.getYesn_tConfig,
  [ModelIds.BufferOverflow]: ServerGeneratorModule.getBufferOverflowConfig,
  [ModelIds.SortedEchoVuln]: ServerGeneratorModule.getSortedEchoVulnConfig,
  [ModelIds.MastermindHint]: ServerGeneratorModule.getMastermindHintConfig,
  [ModelIds.RomanNumeral]: ServerGeneratorModule.getRomanNumeralConfig,
  [ModelIds.GuessNumber]: ServerGeneratorModule.getGuessNumberConfig,
  [ModelIds.ConvertToBase10]: ServerGeneratorModule.getConvertToBase10Config,
  [ModelIds.divisibilityTest]: ServerGeneratorModule.getDivisibilityTestConfig,
  [ModelIds.packetSniffer]: ServerGeneratorModule.getPacketSnifferConfig,
  [ModelIds.globalMaxima]: ServerGeneratorModule.getKingOfTheHillConfig,
  [ModelIds.SpiceLevel]: ServerGeneratorModule.getSpiceLevelConfig,
  [ModelIds.LargestPrimeFactor]: ServerGeneratorModule.getLargestPrimeFactorConfig,
  [ModelIds.CommonPasswordDictionary]: ServerGeneratorModule.getLargeDictionaryConfig,
  [ModelIds.EUCountryDictionary]: ServerGeneratorModule.getEuCountryDictionaryConfig,
  [ModelIds.TimingAttack]: ServerGeneratorModule.getTimingAttackConfig,
  [ModelIds.BinaryEncodedFeedback]: ServerGeneratorModule.getBinaryEncodedConfig,
  [ModelIds.parsedExpression]: ServerGeneratorModule.getParseArithmeticExpressionConfig,
  [ModelIds.encryptedPassword]: ServerGeneratorModule.getXorMaskEncryptedPasswordConfig,
  [ModelIds.tripleModulo]: ServerGeneratorModule.getTripleModuloConfig,
};

// Fail loudly if a builder's own modelId disagrees with the key we filed it
// under above -- that would silently test the wrong solver against the wrong
// generator.
for (const [modelId, builder] of Object.entries(BUILDERS)) {
  const cfg = builder(1);
  if (cfg.modelId !== modelId) {
    console.error(`FATAL: builder for "${modelId}" produced modelId "${cfg.modelId}" instead.`);
    process.exit(1);
  }
}

const ALL_MODEL_IDS = Object.values(ModelIds).filter((id) => id !== ModelIds.labyrinth);

// ─── Attempt caps ───────────────────────────────────────────────────────────
// Default 1 (blind solvers resolve the password directly from the hint), the
// four blind dictionary-attack models get their dictionary size, and every
// non-blind (adaptive/heartbleed-driven) solver gets its own explicit cap.

const SOLVER_CAPS = {
  BellaCuore: 16,
  "AccountsManager_4.2": 12,
  NIL: 70,
  "RateMyPix.Auth": 200,
  DeepGreen: 200,
  "2G_cellular": (passwordLength) => 62 * passwordLength,
  "Factori-Os": 250,
  "BigMo%od": 12,
  "PHP 5.4": 60,
  KingOfTheHill: 60,
  OpenWebAccessPoint: 8,
  "FreshInstall_1.0": 4,
  Laika4: 4,
  "EuroZone Free": 27,
  TopPass: 94,
};

function capFor(modelId, passwordLength, noHeartbleed) {
  if (noHeartbleed && modelId === ModelIds.GuessNumber) return 150; // AccountsManager_4.2
  const entry = SOLVER_CAPS[modelId];
  if (typeof entry === "function") return entry(passwordLength);
  if (typeof entry === "number") return entry;
  return 1;
}

// Failing the no-heartbleed pass only counts as a real failure for these two
// models, which are expected to have a blind fallback strategy; every other
// non-blind solver is expected to `giveUp("needs heartbleed")` instead, which
// is reported as "n-a" rather than pass/fail.
const REQUIRES_BLIND_FALLBACK = new Set([ModelIds.TimingAttack, ModelIds.GuessNumber]);

// ─── Round / pass runners ───────────────────────────────────────────────────

function buildRound(modelId, builder, difficulty) {
  const cfg = builder(difficulty);
  const server = {
    hostname: "dn-test",
    password: cfg.password,
    modelId: cfg.modelId,
    staticPasswordHint: cfg.staticPasswordHint,
    passwordHintData: cfg.passwordHintData ?? "",
    difficulty,
    depth: difficulty,
    requiredCharismaSkill: 0,
    serversOnNetwork: [],
  };
  const details = {
    host: "dn-test",
    modelId,
    passwordHint: cfg.staticPasswordHint,
    data: cfg.passwordHintData ?? "",
    passwordLength: cfg.password.length,
    passwordFormat: getPasswordType(cfg.password),
    difficulty,
    requiredCharismaSkill: 0,
  };
  return { cfg, server, details };
}

/** Runs one authentication attempt loop. Never throws: failures come back as a result. */
function runRound(solver, server, details, cap, noHeartbleed) {
  let feedback = null;
  let attempts = 0;
  try {
    let state = solver.start(details);
    for (;;) {
      const step = solver.next(state, feedback);
      if ("giveUp" in step) {
        return { ok: false, attempts, reason: step.reason };
      }
      attempts++;
      if (attempts > cap) {
        return { ok: false, attempts, reason: "cap" };
      }
      const responseTime = 1000 + getSharedChars(server.password, step.attempt) * 50;
      const response = checkPassword(server, step.attempt, 1, responseTime);
      if (response.code === 200) {
        return { ok: true, attempts, reason: null };
      }
      state = step.state;
      if (noHeartbleed) {
        feedback = { code: 401, passwordAttempted: step.attempt, message: "Unauthorized", elapsedMs: responseTime };
      } else {
        feedback = parseFeedback(JSON.stringify(response));
        feedback.elapsedMs = responseTime;
      }
    }
  } catch (e) {
    return { ok: false, attempts, reason: `threw: ${e instanceof Error ? e.message : e}` };
  }
}

/** True if the solver's very first call, from a cold start, gives up unimplemented. */
function isStubSolver(modelId, builder, solver) {
  try {
    const { details } = buildRound(modelId, builder, DIFFICULTIES[0]);
    const state = solver.start(details);
    const step = solver.next(state, null);
    return "giveUp" in step && step.reason === "unimplemented";
  } catch {
    return false; // not a stub -- let runFullPass report the throw as a real failure
  }
}

function runFullPass(modelId, builder, solver, noHeartbleed) {
  let passed = 0;
  let total = 0;
  let attemptsSum = 0;
  let attemptsMax = 0;
  let firstFailure = null;

  for (const difficulty of DIFFICULTIES) {
    for (let i = 0; i < ROUNDS; i++) {
      total++;
      const { cfg, server, details } = buildRound(modelId, builder, difficulty);
      const cap = capFor(modelId, cfg.password.length, noHeartbleed);
      const result = runRound(solver, server, details, cap, noHeartbleed);
      attemptsSum += result.attempts;
      if (result.attempts > attemptsMax) attemptsMax = result.attempts;
      if (result.ok) {
        passed++;
      } else if (!firstFailure) {
        firstFailure = { difficulty, password: cfg.password, reason: result.reason };
      }
    }
  }

  return {
    passed,
    total,
    avgAttempts: total > 0 ? attemptsSum / total : 0,
    maxAttempts: attemptsMax,
    firstFailure,
  };
}

// ─── Run ────────────────────────────────────────────────────────────────────

const targetModelIds = only.length > 0 ? only : ALL_MODEL_IDS;

let failedModels = 0;
for (const modelId of targetModelIds) {
  const builder = BUILDERS[modelId];
  const solver = SOLVERS[modelId];
  if (!builder || !solver) {
    console.log(`?? ${modelId}: unknown model`);
    failedModels++;
    continue;
  }

  if (isStubSolver(modelId, builder, solver)) {
    console.log(`-- ${modelId}: NO SOLVER`);
    failedModels++;
    continue;
  }

  let modelFailed = false;

  const normal = runFullPass(modelId, builder, solver, false);
  const normalOk = normal.passed === normal.total;
  if (!normalOk) modelFailed = true;

  let line = `${normalOk ? "ok" : "FAIL"} ${modelId}: ${normal.passed}/${normal.total} (avg ${normal.avgAttempts.toFixed(1)} attempts, max ${normal.maxAttempts})`;
  if (!normalOk && normal.firstFailure) {
    line += ` first failure: d=${normal.firstFailure.difficulty} pw=${normal.firstFailure.password} reason=${normal.firstFailure.reason}`;
  }

  if (!solver.blind) {
    const nh = runFullPass(modelId, builder, solver, true);
    const nhOk = nh.passed === nh.total;
    let nhStatus;
    if (nhOk) {
      nhStatus = "ok";
    } else if (REQUIRES_BLIND_FALLBACK.has(modelId)) {
      nhStatus = "FAIL";
      modelFailed = true;
    } else {
      nhStatus = "n-a"; // expected to giveUp("needs heartbleed")
    }
    line += ` | no-heartbleed: ${nhStatus}`;
  }

  console.log(line);
  if (modelFailed) failedModels++;
}

console.log();
console.log(`Models: ${targetModelIds.length}, passing: ${targetModelIds.length - failedModels}`);
process.exit(failedModels > 0 ? 1 : 0);
