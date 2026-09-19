#!/usr/bin/env node
/**
 * Bitburner RAM Cost Calculator
 *
 * Statically analyzes compiled JS files in dist/ to calculate RAM costs,
 * replicating the game's own algorithm. Works offline without the game.
 *
 * Usage:
 *   node tools/ram-check.mjs [file...]          # Check specific files (paths relative to dist/)
 *   node tools/ram-check.mjs --all              # Check all files with a main() export
 *   node tools/ram-check.mjs --all --libs       # Include library files too
 *   node tools/ram-check.mjs --limit 8          # Highlight scripts over 8 GB
 *   node tools/ram-check.mjs --json             # JSON output for programmatic use
 *   node tools/ram-check.mjs --verbose          # Show which file each function came from
 *   node tools/ram-check.mjs --sf4 3            # Use SF4 level 3 (base singularity costs)
 *   node tools/ram-check.mjs --bn4              # BitNode 4 (base singularity costs)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { glob } from "node:fs/promises";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE_RAM = 1.6;
const DIST_DIR = resolve(process.cwd(), "dist");

// Singularity cost multiplier — depends on SF4 level.
// Default: 16x (no SF4 or SF4 level 1, outside BN4).
// Set via --sf4 <level> or --bn4.
let SF4_MULT = 16;

// ─── RAM Cost Table (generated from Bitburner v3.0.1 RamCostGenerator.ts) ──
// Singularity entries are base costs; lookupCost() applies SF4_MULT.
// Regenerate with: node tools/gen-ram-table.mjs [tag]

const RAM_COSTS = {
  corporation: {
    hasCorporation: 0,
    canCreateCorporation: 0,
    createCorporation: 20,
    hasUnlock: 10,
    getUnlockCost: 10,
    getUpgradeLevel: 10,
    getUpgradeLevelCost: 10,
    getInvestmentOffer: 10,
    getConstants: 0,
    getIndustryData: 10,
    getMaterialData: 10,
    acceptInvestmentOffer: 20,
    goPublic: 20,
    bribe: 20,
    getCorporation: 10,
    getDivision: 10,
    expandIndustry: 20,
    expandCity: 20,
    purchaseUnlock: 20,
    levelUpgrade: 20,
    issueDividends: 20,
    issueNewShares: 20,
    buyBackShares: 20,
    sellShares: 20,
    getBonusTime: 0,
    nextUpdate: 0,
    sellDivision: 20,
    sellMaterial: 20,
    sellProduct: 20,
    discontinueProduct: 20,
    setSmartSupply: 20,
    setSmartSupplyOption: 20,
    buyMaterial: 20,
    bulkPurchase: 20,
    getWarehouse: 10,
    getProduct: 10,
    getMaterial: 10,
    setMaterialMarketTA1: 20,
    setMaterialMarketTA2: 20,
    setProductMarketTA1: 20,
    setProductMarketTA2: 20,
    exportMaterial: 20,
    cancelExportMaterial: 20,
    purchaseWarehouse: 20,
    upgradeWarehouse: 20,
    makeProduct: 20,
    limitMaterialProduction: 20,
    limitProductProduction: 20,
    getUpgradeWarehouseCost: 10,
    hasWarehouse: 10,
    hireEmployee: 20,
    upgradeOfficeSize: 20,
    throwParty: 20,
    buyTea: 20,
    hireAdVert: 20,
    research: 20,
    getOffice: 10,
    getHireAdVertCost: 10,
    getHireAdVertCount: 10,
    getResearchCost: 10,
    hasResearched: 10,
    setJobAssignment: 20,
    getOfficeSizeUpgradeCost: 10,
  },
  hacknet: {
    numNodes: 0.5,
    purchaseNode: 0.5,
    getPurchaseNodeCost: 0.5,
    getNodeStats: 0.5,
    upgradeLevel: 0.5,
    upgradeRam: 0.5,
    upgradeCore: 0.5,
    upgradeCache: 0.5,
    getLevelUpgradeCost: 0.5,
    getRamUpgradeCost: 0.5,
    getCoreUpgradeCost: 0.5,
    getCacheUpgradeCost: 0.5,
    numHashes: 0.5,
    hashCost: 0.5,
    spendHashes: 0.5,
    maxNumNodes: 0.5,
    hashCapacity: 0.5,
    getHashUpgrades: 0.5,
    getHashUpgradeLevel: 0.5,
    getStudyMult: 0.5,
    getTrainingMult: 0.5,
  },
  stock: {
    getConstants: 0,
    hasWseAccount: 0.05,
    hasTixApiAccess: 0.05,
    has4SData: 0.05,
    has4SDataTixApi: 0.05,
    getBonusTime: 0,
    nextUpdate: 0,
    getSymbols: 2,
    getPrice: 2,
    getOrganization: 2,
    getAskPrice: 2,
    getBidPrice: 2,
    getPosition: 2,
    getMaxShares: 2,
    getPurchaseCost: 2,
    getSaleGain: 2,
    buyStock: 2.5,
    sellStock: 2.5,
    buyShort: 2.5,
    sellShort: 2.5,
    placeOrder: 2.5,
    cancelOrder: 2.5,
    getOrders: 2.5,
    getVolatility: 2.5,
    getForecast: 2.5,
    purchase4SMarketData: 2.5,
    purchase4SMarketDataTixApi: 2.5,
    purchaseWseAccount: 2.5,
    purchaseTixApi: 2.5,
  },
  singularity: {
    universityCourse: 2,
    gymWorkout: 2,
    travelToCity: 2,
    goToLocation: 5,
    purchaseTor: 2,
    purchaseProgram: 2,
    getCurrentServer: 2,
    getCompanyPositionInfo: 2,
    getCompanyPositions: 2,
    cat: 0.5,
    connect: 2,
    manualHack: 2,
    installBackdoor: 2,
    getDarkwebProgramCost: 0.5,
    getDarkwebPrograms: 0.5,
    hospitalize: 0.5,
    isBusy: 0.5,
    stopAction: 1,
    upgradeHomeRam: 3,
    upgradeHomeCores: 3,
    getUpgradeHomeRamCost: 1.5,
    getUpgradeHomeCoresCost: 1.5,
    workForCompany: 3,
    applyToCompany: 3,
    quitJob: 3,
    getCompanyRep: 1,
    getCompanyFavor: 1,
    getCompanyFavorGain: 0.75,
    getFactionInviteRequirements: 3,
    getFactionEnemies: 3,
    checkFactionInvitations: 3,
    joinFaction: 3,
    workForFaction: 3,
    getFactionWorkTypes: 1,
    getFactionRep: 1,
    getFactionFavor: 1,
    getFactionFavorGain: 0.75,
    donateToFaction: 5,
    createProgram: 5,
    getHackingLevelRequirementOfProgram: 5,
    commitCrime: 5,
    getCrimeChance: 5,
    getCrimeStats: 5,
    getOwnedAugmentations: 5,
    getOwnedSourceFiles: 5,
    getAugmentationFactions: 5,
    getAugmentationsFromFaction: 5,
    getAugmentationPrereq: 5,
    getAugmentationPrice: 2.5,
    getAugmentationBasePrice: 2.5,
    getAugmentationRepReq: 2.5,
    getAugmentationStats: 5,
    purchaseAugmentation: 5,
    softReset: 5,
    installAugmentations: 5,
    isFocused: 0.1,
    setFocus: 0.1,
    getSaveData: 1,
    exportGame: 1,
    exportGameBonus: 0.5,
    b1tflum3: 16,
    destroyW0r1dD43m0n: 32,
    getCurrentWork: 0.5,
    getUnlockedAchievements: 5,
  },
  format: {
    number: 0,
    ram: 0,
    percent: 0,
    time: 0,
  },
  cloud: {
    getServerLimit: 0.05,
    getRamLimit: 0.05,
    getServerCost: 0.25,
    getServerUpgradeCost: 0.1,
    getServerNames: 1.05,
    upgradeServer: 0.25,
    renameServer: 0,
    purchaseServer: 2.25,
    deleteServer: 2.25,
  },
  gang: {
    createGang: 1,
    inGang: 0,
    getMemberNames: 1,
    renameMember: 0,
    getGangInformation: 2,
    getAllGangInformation: 2,
    getMemberInformation: 2,
    canRecruitMember: 1,
    getRecruitsAvailable: 1,
    respectForNextRecruit: 1,
    recruitMember: 2,
    getTaskNames: 0,
    getTaskStats: 1,
    setMemberTask: 2,
    getEquipmentNames: 0,
    getEquipmentCost: 2,
    getEquipmentType: 2,
    getEquipmentStats: 2,
    purchaseEquipment: 4,
    ascendMember: 4,
    getAscensionResult: 2,
    getInstallResult: 2,
    setTerritoryWarfare: 2,
    getChanceToWinClash: 4,
    getBonusTime: 0,
    nextUpdate: 0,
  },
  go: {
    makeMove: 4,
    passTurn: 0,
    getBoardState: 4,
    getMoveHistory: 0,
    getCurrentPlayer: 0,
    getGameState: 0,
    getOpponent: 0,
    opponentNextTurn: 0,
    resetBoardState: 0,
    analysis: {
      getValidMoves: 8,
      getChains: 16,
      getLiberties: 16,
      getControlledEmptyNodes: 16,
      getStats: 0,
      resetStats: 0,
      setTestingBoardState: 4,
      highlightPoint: 0,
      clearPointHighlight: 0,
      clearAllPointHighlights: 0,
    },
    cheat: {
      getCheatSuccessChance: 1,
      getCheatCount: 1,
      removeRouter: 8,
      playTwoMoves: 8,
      repairOfflineNode: 8,
      destroyNode: 8,
    },
  },
  dnet: {
    authenticate: 0.4,
    connectToSession: 0.05,
    heartbleed: 0.6,
    openCache: 2,
    probe: 0.2,
    setStasisLink: 12,
    getStasisLinkLimit: 0,
    getStasisLinkedServers: 0,
    getServer: 2,
    getServerDetails: 0.1,
    induceServerMigration: 4,
    unleashStormSeed: 0.1,
    isDarknetServer: 0.1,
    memoryReallocation: 1,
    getBlockedRam: 0,
    getDepth: 0.1,
    promoteStock: 2,
    phishingAttack: 2,
    getDarknetInstability: 0,
    nextMutation: 0,
    getServerRequiredCharismaLevel: 0.1,
    labreport: 0,
    labradar: 0,
  },
  bladeburner: {
    inBladeburner: 0,
    getContractNames: 0,
    getOperationNames: 0,
    getBlackOpNames: 0,
    getNextBlackOp: 2,
    getBlackOpRank: 2,
    getGeneralActionNames: 0,
    getSkillNames: 0,
    startAction: 4,
    stopBladeburnerAction: 2,
    getCurrentAction: 1,
    getActionTime: 4,
    getActionCurrentTime: 4,
    getActionEstimatedSuccessChance: 4,
    getActionRepGain: 4,
    getActionRankGain: 4,
    getActionRankLoss: 4,
    getActionCountRemaining: 4,
    getActionMaxLevel: 4,
    getActionCurrentLevel: 4,
    getActionAutolevel: 4,
    getActionSuccesses: 4,
    setActionAutolevel: 4,
    setActionLevel: 4,
    getRank: 4,
    getSkillPoints: 4,
    getSkillLevel: 4,
    getSkillUpgradeCost: 4,
    upgradeSkill: 4,
    getTeamSize: 4,
    setTeamSize: 4,
    getCityEstimatedPopulation: 4,
    getCityCommunities: 4,
    getCityChaos: 4,
    getCity: 4,
    switchCity: 4,
    getStamina: 4,
    joinBladeburnerFaction: 4,
    joinBladeburnerDivision: 4,
    getBonusTime: 0,
    nextUpdate: 0,
  },
  infiltration: {
    getPossibleLocations: 0,
    getInfiltration: 15,
  },
  codingcontract: {
    attempt: 10,
    getContractType: 5,
    getData: 5,
    getContract: 15,
    getDescription: 5,
    getNumTriesRemaining: 2,
    createDummyContract: 2,
    getContractTypes: 0,
  },
  sleeve: {
    getNumSleeves: 4,
    setToIdle: 4,
    setToShockRecovery: 4,
    setToSynchronize: 4,
    setToCommitCrime: 4,
    setToUniversityCourse: 4,
    travel: 4,
    setToCompanyWork: 4,
    setToFactionWork: 4,
    setToGymWorkout: 4,
    getTask: 4,
    getSleeve: 4,
    getSleeveAugmentations: 4,
    getSleevePurchasableAugs: 4,
    purchaseSleeveAug: 4,
    setToBladeburnerAction: 4,
    getSleeveAugmentationPrice: 4,
    getSleeveAugmentationRepReq: 4,
    purchaseSleeve: 4,
    upgradeMemory: 4,
    getSleeveCost: 4,
    getMemoryUpgradeCost: 4,
  },
  stanek: {
    giftWidth: 0.4,
    giftHeight: 0.4,
    chargeFragment: 0.4,
    fragmentDefinitions: 0,
    activeFragments: 5,
    clearGift: 0,
    canPlaceFragment: 0.5,
    placeFragment: 5,
    getFragment: 2,
    removeFragment: 0.15,
    acceptGift: 2,
  },
  ui: {
    openTail: 0,
    renderTail: 0,
    moveTail: 0,
    resizeTail: 0,
    closeTail: 0,
    setTailTitle: 0,
    setTailFontSize: 0,
    setTailMinimized: 0,
    getTheme: 0,
    setTheme: 0,
    resetTheme: 0,
    getStyles: 0,
    setStyles: 0,
    resetStyles: 0,
    getGameInfo: 0,
    clearTerminal: 0,
    windowSize: 0,
  },
  grafting: {
    getAugmentationGraftPrice: 3.75,
    getAugmentationGraftTime: 3.75,
    getGraftableAugmentations: 5,
    graftAugmentation: 7.5,
    waitForOngoingGrafting: 0,
  },
  sprintf: 0,
  vsprintf: 0,
  scan: 0.2,
  hack: 0.1,
  hackAnalyzeThreads: 1,
  hackAnalyze: 1,
  hackAnalyzeSecurity: 1,
  hackAnalyzeChance: 1,
  sleep: 0,
  asleep: 0,
  share: 2.4,
  getSharePower: 0.2,
  grow: 0.15,
  growthAnalyze: 1,
  growthAnalyzeSecurity: 1,
  weaken: 0.15,
  weakenAnalyze: 1,
  print: 0,
  printf: 0,
  tprint: 0,
  tprintf: 0,
  clearLog: 0,
  disableLog: 0,
  enableLog: 0,
  isLogEnabled: 0,
  getScriptLogs: 0,
  hasTorRouter: 0.05,
  nuke: 0.05,
  brutessh: 0.05,
  ftpcrack: 0.05,
  relaysmtp: 0.05,
  httpworm: 0.05,
  sqlinject: 0.05,
  run: 1,
  exec: 1.3,
  spawn: 2,
  self: 0,
  kill: 0.5,
  killall: 0.5,
  exit: 0,
  atExit: 0,
  scp: 0.6,
  ls: 0.2,
  ps: 0.2,
  getRecentScripts: 0.2,
  hasRootAccess: 0.05,
  getHostname: 0.05,
  getIP: 0.05,
  getHackingLevel: 0.05,
  getHackingMultipliers: 0.25,
  getHacknetMultipliers: 0.25,
  getBitNodeMultipliers: 4,
  getServer: 2,
  getServerMoneyAvailable: 0.1,
  getServerSecurityLevel: 0.1,
  getServerBaseSecurityLevel: 0.1,
  getServerMinSecurityLevel: 0.1,
  getServerRequiredHackingLevel: 0.1,
  getServerMaxMoney: 0.1,
  getServerGrowth: 0.1,
  getServerNumPortsRequired: 0.1,
  getServerMaxRam: 0.05,
  getServerUsedRam: 0.05,
  dnsLookup: 0.05,
  serverExists: 0.1,
  fileExists: 0.1,
  isRunning: 0.1,
  write: 0,
  tryWritePort: 0,
  read: 0,
  getFileMetadata: 0,
  peek: 0,
  clear: 0,
  writePort: 0,
  nextPortWrite: 0,
  readPort: 0,
  getPortHandle: 0,
  rm: 0.6,
  scriptRunning: 1,
  scriptKill: 1,
  getScriptName: 0,
  getScriptRam: 0.1,
  getHackTime: 0.05,
  getGrowTime: 0.05,
  getWeakenTime: 0.05,
  getTotalScriptIncome: 0.1,
  getScriptIncome: 0.1,
  getTotalScriptExpGain: 0.1,
  getScriptExpGain: 0.1,
  getRunningScript: 0.3,
  ramOverride: 0,
  prompt: 0,
  wget: 0,
  getFavorToDonate: 0.1,
  getPlayer: 0.5,
  getMoneySources: 1,
  mv: 0,
  getResetInfo: 1,
  getFunctionRamCost: 0,
  toast: 0,
  clearPort: 0,
  openDevMenu: 0,
  alert: 0,
  flags: 0,
  exploit: 0,
  bypass: 0,
  alterReality: 0,
  rainbow: 0,
  heart: {
    break: 0,
  },
  tprintRaw: 0,
  printRaw: 0,
  dynamicImport: 0,
  formulas: {
    mockServer: 0,
    mockPlayer: 0,
    mockPerson: 0,
    reputation: {
      calculateFavorToRep: 0,
      calculateRepToFavor: 0,
      repFromDonation: 0,
      donationForRep: 0,
      sharePower: 0,
    },
    skills: {
      calculateSkill: 0,
      calculateExp: 0,
    },
    hacking: {
      hackChance: 0,
      hackExp: 0,
      hackPercent: 0,
      growPercent: 0,
      growThreads: 0,
      growAmount: 0,
      hackTime: 0,
      growTime: 0,
      weakenTime: 0,
      weakenEffect: 0,
    },
    hacknetNodes: {
      moneyGainRate: 0,
      levelUpgradeCost: 0,
      ramUpgradeCost: 0,
      coreUpgradeCost: 0,
      hacknetNodeCost: 0,
      constants: 0,
    },
    hacknetServers: {
      hashGainRate: 0,
      levelUpgradeCost: 0,
      ramUpgradeCost: 0,
      coreUpgradeCost: 0,
      cacheUpgradeCost: 0,
      hashUpgradeCost: 0,
      hacknetServerCost: 0,
      constants: 0,
    },
    gang: {
      wantedPenalty: 0,
      respectGain: 0,
      wantedLevelGain: 0,
      moneyGain: 0,
      ascensionPointsGain: 0,
      ascensionMultiplier: 0,
    },
    work: {
      crimeSuccessChance: 0,
      crimeGains: 0,
      gymGains: 0,
      universityGains: 0,
      factionGains: 0,
      companyGains: 0,
    },
    bladeburner: {
      skillMaxUpgradeCount: 0,
    },
    dnet: {
      getAuthenticateTime: 0,
      getHeartbleedTime: 0,
      getExpectedRamBlockRemoved: 0,
    },
  },
};

// ─── NS Reference Detection ────────────────────────────────────────────────

/**
 * Given a MemberExpression node, walk to the root and collect the property chain.
 * Returns null if the root is not an Identifier named `ns`.
 */
function extractNsChain(node) {
  const parts = [];
  let current = node;

  while (current.type === "MemberExpression") {
    if (current.computed) return null; // ns["foo"] — skip dynamic access
    parts.unshift(current.property.name);
    current = current.object;
  }

  if (current.type === "Identifier" && current.name === "ns") {
    return parts;
  }
  return null;
}

/**
 * Look up a property chain in the RAM cost table.
 * e.g. ["hacknet", "purchaseNode"] → 0
 *      ["hack"] → 0.1
 * Returns undefined if not found.
 */
function lookupCost(chain) {
  let obj = RAM_COSTS;
  for (const key of chain) {
    if (obj == null || typeof obj !== "object") return undefined;
    obj = obj[key];
  }
  if (typeof obj !== "number") return undefined;
  // Apply SF4 multiplier to all singularity functions
  if (chain[0] === "singularity") {
    return obj * SF4_MULT;
  }
  return obj;
}

// ─── Import Resolution ─────────────────────────────────────────────────────

/**
 * Resolve an import path to a file path in dist/.
 *   "/lib/utils"     → dist/lib/utils.js
 *   "/lib/utils.js"  → dist/lib/utils.js
 *   "lib/utils"      → dist/lib/utils.js
 */
function resolveImport(importPath) {
  // Strip leading /
  let cleaned = importPath.startsWith("/") ? importPath.slice(1) : importPath;
  // Add .js if not present
  if (!cleaned.endsWith(".js")) cleaned += ".js";
  return resolve(DIST_DIR, cleaned);
}

// ─── Core Analysis (dependency-graph-aware) ─────────────────────────────────

/**
 * Collect NS references from a subtree, respecting prefix chains.
 */
function collectNsRefs(node) {
  const refs = new Map();
  // 1. Detect ns.* chains via MemberExpression
  walk.simple(node, {
    MemberExpression(n) {
      const chain = extractNsChain(n);
      if (!chain || chain.length === 0) return;
      const key = chain.join(".");
      if (refs.has(key)) return;
      const cost = lookupCost(chain);
      if (cost !== undefined) {
        refs.set(key, { chain, cost });
      }
    },
  });
  // 2. Bare identifier matching — replicates Bitburner's pessimistic check
  // where ANY identifier matching a top-level NS function name is counted.
  // Uses walk.full to visit ALL identifier positions (including variable
  // declarations, function names, and parameters that walk.simple misses).
  // This produces the same false positives as the game (e.g. a local
  // function named "hasTorRouter" triggers the 0.05 GB cost).
  walk.full(node, (n) => {
    if (n.type === "Identifier" && !refs.has(n.name)) {
      const cost = lookupCost([n.name]);
      if (cost !== undefined) {
        refs.set(n.name, { chain: [n.name], cost });
      }
    }
  });
  // Filter partial chains (namespace prefixes)
  const keys = [...refs.keys()];
  for (const key of keys) {
    if (keys.some((other) => other !== key && other.startsWith(key + "."))) {
      refs.delete(key);
    }
  }
  return refs;
}

/**
 * Collect all identifiers referenced in a subtree.
 */
function collectIdentifiers(node) {
  const idents = new Set();
  walk.simple(node, {
    Identifier(n) {
      idents.add(n.name);
    },
  });
  return idents;
}

const DOM_COST = 25;
const DOM_IDENTIFIERS = new Set(["window", "document"]);

/**
 * Collect special identifier references (window, document) from a subtree.
 * These cost 25 GB each in Bitburner (RamCostConstants.Dom).
 */
function collectDomRefs(node) {
  const refs = new Map();
  walk.simple(node, {
    Identifier(n) {
      if (DOM_IDENTIFIERS.has(n.name) && !refs.has(n.name)) {
        refs.set(n.name, { chain: [n.name], cost: DOM_COST });
      }
    },
  });
  return refs;
}

/**
 * Parse a JS file and extract per-scope NS references.
 *
 * Returns:
 *   globalRefs:     NS refs from top-level code (outside function bodies)
 *   functionRefs:   Map<fnName, Map<key, {chain, cost}>>
 *   functionDeps:   Map<fnName, Set<fnName>> — intra-module call graph
 *   functionNames:  Set of all top-level function names
 *   globalIdentifiers: Set of all identifiers used in global scope
 *   imports:        [{ path, names: Set<string> | "*" }]
 */
function analyzeFile(filePath) {
  const code = readFileSync(filePath, "utf-8");
  let ast;
  try {
    ast = acorn.parse(code, { sourceType: "module", ecmaVersion: "latest" });
  } catch (err) {
    console.error(`  Parse error in ${filePath}: ${err.message}`);
    return {
      globalRefs: new Map(),
      functionRefs: new Map(),
      functionDeps: new Map(),
      functionNames: new Set(),
      globalIdentifiers: new Set(),
      imports: [],
    };
  }

  const functionNodes = new Map(); // fnName → AST node (FunctionDeclaration body)

  // 1. Identify all top-level function declarations
  for (const node of ast.body) {
    const decl = node.type === "ExportNamedDeclaration" ? node.declaration :
                 node.type === "ExportDefaultDeclaration" ? node.declaration :
                 node;
    if (decl && decl.type === "FunctionDeclaration" && decl.id) {
      functionNodes.set(decl.id.name, decl);
    }
  }

  const functionNames = new Set(functionNodes.keys());
  const functionRefs = new Map();
  const functionDeps = new Map();

  // 2. Analyze each function body separately
  for (const [name, fnNode] of functionNodes) {
    const nsRefs = collectNsRefs(fnNode.body);
    const domRefs = collectDomRefs(fnNode.body);
    for (const [key, ref] of domRefs) {
      if (!nsRefs.has(key)) nsRefs.set(key, ref);
    }
    functionRefs.set(name, nsRefs);
    // Intra-module calls: identifiers in this function that match other function names
    const idents = collectIdentifiers(fnNode.body);
    const deps = new Set();
    for (const id of idents) {
      if (id !== name && functionNames.has(id)) {
        deps.add(id);
      }
    }
    functionDeps.set(name, deps);
  }

  // 3. Global scope: walk top-level nodes that are NOT function declarations
  const globalRefs = new Map();
  const globalIdentifiers = new Set();
  for (const node of ast.body) {
    let target = node;
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        target = node.declaration;
      } else {
        continue; // export { x, y } — re-export, no code to walk
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      target = node.declaration;
    }
    if (target.type === "FunctionDeclaration") continue;
    if (target.type === "ImportDeclaration") continue;

    for (const [key, ref] of collectNsRefs(target)) {
      if (!globalRefs.has(key)) globalRefs.set(key, ref);
    }
    for (const [key, ref] of collectDomRefs(target)) {
      if (!globalRefs.has(key)) globalRefs.set(key, ref);
    }
    for (const id of collectIdentifiers(target)) {
      globalIdentifiers.add(id);
    }
  }

  // 4. Extract imports with named/namespace tracking
  const imports = [];
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration" || !node.source || typeof node.source.value !== "string") continue;
    const path = node.source.value;
    const names = new Set();
    let isWildcard = false;
    for (const spec of node.specifiers) {
      if (spec.type === "ImportSpecifier") {
        names.add((spec.imported || spec.local).name);
      } else {
        // ImportNamespaceSpecifier or ImportDefaultSpecifier
        isWildcard = true;
      }
    }
    imports.push({ path, names: isWildcard ? "*" : names });
  }

  return { globalRefs, functionRefs, functionDeps, functionNames, globalIdentifiers, imports };
}

// File analysis cache (keyed by absolute path)
const fileCache = new Map();

function getFileAnalysis(absPath) {
  if (!fileCache.has(absPath)) {
    fileCache.set(absPath, analyzeFile(absPath));
  }
  return fileCache.get(absPath);
}

/**
 * Resolve which functions in a module are transitively needed,
 * given a set of directly imported names.
 */
function resolveNeededFunctions(analysis, importedNames) {
  if (importedNames === "*") return new Set(analysis.functionNames);

  const needed = new Set();
  const queue = [...importedNames].filter((n) => analysis.functionNames.has(n));
  while (queue.length > 0) {
    const fn = queue.shift();
    if (needed.has(fn)) continue;
    needed.add(fn);
    // Follow intra-module call graph
    const deps = analysis.functionDeps.get(fn);
    if (deps) {
      for (const dep of deps) {
        if (!needed.has(dep)) queue.push(dep);
      }
    }
  }
  return needed;
}

/**
 * Analyze a script and all its transitive imports via BFS.
 * Uses dependency-graph-aware scoping: only includes NS references
 * from functions that are actually imported, not everything in the file.
 *
 * Returns { functions: Map<key, {chain, cost, source}>, files: string[] }
 */
function analyzeScript(entryPath) {
  const absEntry = resolve(DIST_DIR, entryPath);
  if (!existsSync(absEntry)) {
    console.error(`File not found: ${absEntry}`);
    return { functions: new Map(), files: [] };
  }

  fileCache.clear();
  const allFunctions = new Map(); // nsKey → { chain, cost, source }
  const filesAnalyzed = [];

  // BFS queue: { absPath, importedNames: Set<string> | "*" }
  // "*" means include all functions (entry file or namespace import)
  const visited = new Map(); // absPath → Set of already-included function names
  const queue = [{ absPath: absEntry, importedNames: "*" }];

  while (queue.length > 0) {
    const { absPath, importedNames } = queue.shift();
    if (!existsSync(absPath)) continue;

    const relPath = relative(DIST_DIR, absPath);
    const analysis = getFileAnalysis(absPath);

    // Determine which functions to include from this module
    const needed = resolveNeededFunctions(analysis, importedNames);

    // Also include functions called from global scope code
    // (e.g. arrow-function React components calling local FunctionDeclarations)
    for (const id of analysis.globalIdentifiers) {
      if (analysis.functionNames.has(id) && !needed.has(id)) {
        const q = [id];
        while (q.length > 0) {
          const fn = q.shift();
          if (needed.has(fn)) continue;
          needed.add(fn);
          const deps = analysis.functionDeps.get(fn);
          if (deps) for (const dep of deps) if (!needed.has(dep)) q.push(dep);
        }
      }
    }

    // Check what we've already included for this file
    const alreadyIncluded = visited.get(absPath);
    if (alreadyIncluded) {
      // Only process newly-needed functions
      const newlyNeeded = new Set([...needed].filter((n) => !alreadyIncluded.has(n)));
      if (newlyNeeded.size === 0) continue;
      for (const n of newlyNeeded) alreadyIncluded.add(n);
      // Collect refs from newly needed functions only
      for (const fnName of newlyNeeded) {
        const refs = analysis.functionRefs.get(fnName);
        if (refs) {
          for (const [key, ref] of refs) {
            if (!allFunctions.has(key)) {
              allFunctions.set(key, { ...ref, source: relPath });
            }
          }
        }
      }
    } else {
      // First visit to this file
      visited.set(absPath, new Set(needed));
      if (!filesAnalyzed.includes(relPath)) filesAnalyzed.push(relPath);

      // Always include global scope refs
      for (const [key, ref] of analysis.globalRefs) {
        if (!allFunctions.has(key)) {
          allFunctions.set(key, { ...ref, source: relPath });
        }
      }

      // Include refs from needed functions
      for (const fnName of needed) {
        const refs = analysis.functionRefs.get(fnName);
        if (refs) {
          for (const [key, ref] of refs) {
            if (!allFunctions.has(key)) {
              allFunctions.set(key, { ...ref, source: relPath });
            }
          }
        }
      }
    }

    // Queue imports from this module
    for (const imp of analysis.imports) {
      const resolved = resolveImport(imp.path);
      queue.push({ absPath: resolved, importedNames: imp.names });
    }
  }

  return { functions: allFunctions, files: filesAnalyzed };
}

// ─── Output Formatting ─────────────────────────────────────────────────────

function formatGb(gb) {
  return (Math.round(gb * 100) / 100).toFixed(2) + " GB";
}

function padRight(str, len) {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function padLeft(str, len) {
  return str.length >= len ? str : " ".repeat(len - str.length) + str;
}

function printDetailed(entryPath, result, verbose) {
  const { functions, files } = result;

  // Sort functions by cost descending
  const sorted = [...functions.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const nonZeroCost = sorted.filter(([, v]) => v.cost > 0);
  const totalApiCost = nonZeroCost.reduce((sum, [, v]) => sum + v.cost, 0);
  const totalRam = BASE_RAM + totalApiCost;

  const W = 56;
  console.log();
  console.log(`${padRight(entryPath, W - 10)}${padLeft(formatGb(totalRam), 10)}`);
  console.log();
  console.log(`  ${padRight("Base cost", W - 14)}${padLeft(formatGb(BASE_RAM), 10)}`);

  for (const [key, { cost, source }] of sorted) {
    if (cost === 0) continue;
    const label = verbose && source !== files[0] ? `${key} (via ${source})` : key;
    console.log(`  ${padRight(label, W - 14)}${padLeft(formatGb(cost), 10)}`);
  }

  console.log(`  ${"─".repeat(W - 4)}`);
  console.log(
    `  ${padRight(`Total (${nonZeroCost.length} unique NS function${nonZeroCost.length !== 1 ? "s" : ""})`, W - 14)}${padLeft(formatGb(totalRam), 10)}`,
  );
  console.log();
  console.log(`  Files analyzed: ${files.join(", ")}`);
  console.log();
}

function printBatchTable(results, limit) {
  const W = 50;
  console.log();
  console.log(`${padRight("Script", W - 12)}${padLeft("RAM", 12)}`);
  console.log("─".repeat(W));

  for (const { entry, functions } of results) {
    const nonZero = [...functions.values()].filter((v) => v.cost > 0);
    const totalRam = BASE_RAM + nonZero.reduce((sum, v) => sum + v.cost, 0);
    const ram = formatGb(totalRam);
    const flag = limit && totalRam > limit ? "  ← exceeds " + limit + " GB limit" : "";
    console.log(`${padRight(entry, W - 12)}${padLeft(ram, 12)}${flag}`);
  }
  console.log();
}

function printJson(results) {
  const output = results.map(({ entry, functions, files }) => {
    const items = [...functions.entries()].map(([key, { cost, source }]) => ({
      function: key,
      cost,
      source,
    }));
    const nonZero = items.filter((i) => i.cost > 0);
    const totalRam = Math.round((BASE_RAM + nonZero.reduce((s, i) => s + i.cost, 0)) * 100) / 100;
    return {
      script: entry,
      totalRam,
      baseCost: BASE_RAM,
      functions: items,
      filesAnalyzed: files,
    };
  });
  console.log(JSON.stringify(output, null, 2));
}

// ─── File Discovery ─────────────────────────────────────────────────────────

/**
 * Check if a file exports a main() function (simple heuristic).
 */
function hasMainExport(filePath) {
  try {
    const code = readFileSync(filePath, "utf-8");
    return /export\s+(async\s+)?function\s+main\s*\(/.test(code);
  } catch {
    return false;
  }
}

/**
 * Discover all analyzable scripts in dist/.
 */
async function discoverScripts(includeLibs) {
  const scripts = [];
  for await (const entry of glob("**/*.js", { cwd: DIST_DIR })) {
    const absPath = resolve(DIST_DIR, entry);
    if (includeLibs || hasMainExport(absPath)) {
      scripts.push(entry);
    }
  }
  return scripts.sort();
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    files: [],
    all: false,
    libs: false,
    limit: null,
    json: false,
    verbose: false,
    sf4: 1,
    bn4: false,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--all":
        opts.all = true;
        break;
      case "--libs":
        opts.libs = true;
        break;
      case "--limit":
        opts.limit = parseFloat(args[++i]);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--verbose":
      case "-v":
        opts.verbose = true;
        break;
      case "--sf4":
        opts.sf4 = parseInt(args[++i], 10);
        break;
      case "--bn4":
        opts.bn4 = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node tools/ram-check.mjs [options] [file...]

Options:
  --all              Check all files with a main() export
  --all --libs       Include library files too
  --limit <GB>       Highlight scripts exceeding this RAM limit
  --json             Output JSON for programmatic use
  --verbose, -v      Show which file each NS function came from
  --sf4 <level>      Source File 4 level (default: 1 → 16x singularity costs)
                       0-1: 16x, 2: 4x, 3+: 1x (base cost)
  --bn4              BitNode 4 mode (1x singularity costs)
  --help, -h         Show this help

Files are paths relative to dist/, e.g.:
  node tools/ram-check.mjs workers/hack.js hack/distributed.js`);
        process.exit(0);
        break;
      default:
        opts.files.push(args[i]);
        break;
    }
    i++;
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  // Set singularity cost multiplier based on SF4 level / BN4
  if (opts.bn4 || opts.sf4 >= 3) {
    SF4_MULT = 1;
  } else if (opts.sf4 === 2) {
    SF4_MULT = 4;
  } else {
    SF4_MULT = 16;
  }

  if (!existsSync(DIST_DIR)) {
    console.error(`dist/ directory not found at ${DIST_DIR}`);
    console.error("Run the TypeScript compiler first (npm run watch or tsc).");
    process.exit(1);
  }

  // Determine files to analyze
  let files = opts.files;
  if (opts.all) {
    files = await discoverScripts(opts.libs);
  }

  if (files.length === 0) {
    console.error("No files specified. Use --all or provide file paths relative to dist/.");
    console.error("Run with --help for usage information.");
    process.exit(1);
  }

  // Analyze all files
  const results = files.map((entry) => {
    const result = analyzeScript(entry);
    return { entry, ...result };
  });

  // Output
  if (opts.json) {
    printJson(results);
  } else if (results.length === 1) {
    printDetailed(results[0].entry, results[0], opts.verbose);
  } else {
    // Multiple files: batch summary table
    printBatchTable(results, opts.limit);

    // If verbose, also print details for each
    if (opts.verbose) {
      for (const r of results) {
        printDetailed(r.entry, r, true);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
