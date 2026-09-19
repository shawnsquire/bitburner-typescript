/**
 * Stock Market Daemon (Tiered Architecture)
 *
 * Automated stock trading with three RAM tiers plus hack-aware "smart mode".
 *
 *   Tier 1 (Monitor):    Poll prices, track positions, publish status. No trading.
 *   Tier 2 (Pre-4S):     Moving-average trend detection, buy/sell/short execution.
 *   Tier 3 (4S Trade):   Forecast-based trading with volatility-adjusted thresholds.
 *
 * Smart mode auto-enables when hack daemon publishes status. Reads hack targets
 * and adjusts trading confidence (long positions lose confidence when hacked, etc.).
 *
 * Uses budget daemon for capital allocation (graceful fallback if not running).
 *
 * Usage: run daemons/stocks.js
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { publishStatus, peekStatus } from "/lib/ports";
import { writeDefaultConfig, getConfigNumber, getConfigBool } from "/lib/config";
import { getBudgetBalance, notifyPurchase, canAfford, signalDone } from "/lib/budget";
import { freeRamForTarget } from "/lib/ram-utils";
import { WSE_TIX_API_COST, WSE_4S_TIX_API_COST } from "/controllers/budget";
import {
  STATUS_PORTS,
  STOCKS_CONTROL_PORT,
  StocksStatus,
  StocksMode,
  StockPosition,
  StockSignal,
  HackStatus,
} from "/types/ports";
import {
  createPriceHistory,
  addPrice,
  detectTrend,
  forecastSignal,
  calcExpectedReturn,
  calcWeightedBudget,
  calculatePositionSize,
  meetsCommissionThreshold,
  estimateForecast,
  estimateVolatility,
  shouldSell,
  getHackAdjustment,
  shouldStopLoss,
  updatePeakPrice,
  detectActiveProfile,
  PriceHistory,
  PositionTracking,
  StopLossParams,
  TradingProfileName,
} from "/controllers/stocks";

const C = COLORS;

// === TIER DEFINITIONS ===

interface StocksTierConfig {
  tier: number;
  name: string;
  functions: string[];
  features: string[];
}

const BASE_SCRIPT_COST = 1.6;

// Functions called unconditionally every tick regardless of tier (API purchase attempts,
// RAM bookkeeping in main()/freeRamForTarget, respawn). These must be budgeted at every
// tier, not just the tier that "feels" related to them.
const BASE_FUNCTIONS = [
  "getServerMaxRam",
  "getServerUsedRam",
  "getPlayer",
  "fileExists",
  "spawn",
  "stock.purchaseTixApi",
  "stock.purchase4SMarketDataTixApi",
  // via /lib/ram-utils freeRamForTarget()
  "ps",
  "getScriptRam",
  "kill",
];

// Launch-time static RAM cost, pinned via the literal ns.ramOverride() call at the top of
// main() (see the syntactic-override rule in the game's RAM static analyzer — it only
// applies when the override call is the first statement of main() with a literal argument).
// This lets the script start on a low-RAM home server; main() bumps the allocation up to the
// selected tier's requirement immediately after. Must equal ceil(tier-1 total) + 2 below —
// recompute with `node tools/ram-check.mjs --json daemons/stocks.js` if the function lists change.
const LAUNCH_RAM = 19;

const TIERS: StocksTierConfig[] = [
  {
    tier: 1,
    name: "monitor",
    functions: [
      "stock.getSymbols",
      "stock.getPrice",
      "stock.getPosition",
      "stock.hasWseAccount",
      "stock.hasTixApiAccess",
      "stock.has4SDataTixApi",
    ],
    features: ["price-polling", "position-tracking", "status-publishing"],
  },
  {
    tier: 2,
    name: "pre4s",
    functions: [
      "stock.buyStock",
      "stock.sellStock",
      "stock.buyShort",
      "stock.sellShort",
      "stock.getMaxShares",
    ],
    features: ["ma-trading", "long-positions", "short-positions"],
  },
  {
    tier: 3,
    name: "4s",
    functions: [
      "stock.getForecast",
      "stock.getVolatility",
    ],
    features: ["forecast-trading", "volatility-thresholds"],
  },
];

function calculateTierRam(ns: NS): { tier: number; name: string; ramNeeded: number }[] {
  let cumulative = BASE_SCRIPT_COST;
  for (const fn of BASE_FUNCTIONS) {
    cumulative += ns.getFunctionRamCost(fn);
  }

  const results: { tier: number; name: string; ramNeeded: number }[] = [];

  for (const t of TIERS) {
    for (const fn of t.functions) {
      cumulative += ns.getFunctionRamCost(fn);
    }
    results.push({ tier: t.tier, name: t.name, ramNeeded: cumulative });
  }

  return results;
}

function selectBestTier(
  potentialRam: number,
  tierRams: { tier: number; name: string; ramNeeded: number }[],
): { tier: number; name: string; totalRam: number } {
  let best = { tier: 0, name: "disabled", totalRam: 0 };
  for (const t of tierRams) {
    if (t.ramNeeded <= potentialRam) {
      best = { tier: t.tier, name: t.name, totalRam: t.ramNeeded };
    }
  }
  return best;
}

// === MAIN ===

/** @ram 19 */
export async function main(ns: NS): Promise<void> {
  // Literal + first statement: pins this script's static launch cost to the tier-1 minimum
  // (LAUNCH_RAM) so it can start on a low-RAM home server. Without this being the very first
  // statement with a literal argument, the game's static analyzer charges the FULL dependency
  // graph (~33GB) just to launch, defeating the entire tiered design. Bumped to the actual
  // selected tier's requirement below via a second, non-literal ramOverride() call.
  ns.ramOverride(19);

  const tierRams = calculateTierRam(ns);
  const available = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + LAUNCH_RAM;
  let tierInfo = selectBestTier(available, tierRams);

  if (tierInfo.tier === 0) {
    const tier1Need = Math.ceil(tierRams[0].ramNeeded) + 2;
    ns.tprint(`WARN: Not enough RAM for stock monitor. Need ~${tier1Need}GB for tier 1.`);
    return;
  }

  // Free RAM and override to the exact amount needed for our tier. We already hold
  // LAUNCH_RAM, so only the delta needs to be freed/acquired.
  let requiredRam = Math.ceil(tierInfo.totalRam) + 2;
  freeRamForTarget(ns, requiredRam - LAUNCH_RAM);
  let actual = ns.ramOverride(requiredRam);
  if (actual < requiredRam) {
    // Couldn't get the full amount (another script grabbed the freed RAM first) — fall back
    // to the highest tier that actually fits what we got.
    tierInfo = selectBestTier(actual, tierRams);
    if (tierInfo.tier === 0) {
      ns.tprint("WARN: Lost RAM allocation for stock monitor after override; exiting.");
      return;
    }
    requiredRam = Math.ceil(tierInfo.totalRam) + 2;
    actual = ns.ramOverride(requiredRam);
  }

  await daemon(ns, tierInfo.tier, tierInfo.name, actual);
}

// === STATE ===

let realizedProfit = 0;
let tickCount = 0;
let sessionStartOffset = 0;
const priceHistories: Map<string, PriceHistory> = new Map();
const positionTracking: Map<string, PositionTracking> = new Map();
const profitHistory: number[] = []; // Track portfolio value for $/s calc
const MAX_PROFIT_HISTORY = 30;
const sellCooldowns: Map<string, number> = new Map(); // symbol → tick when sold
const previousPositions: Map<string, [number, number, number, number]> = new Map(); // symbol → [longShares, longAvg, shortShares, shortAvg]

// Trade history for dashboard display and session analytics
interface TradeRecordInternal {
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  shares: number;
  profit: number;
  ticksHeld: number;
  exitReason: string;
  forecastAtEntry?: number;
  forecastAtExit?: number;
}
const recentTrades: TradeRecordInternal[] = [];
const MAX_RECENT_TRADES = 20;

// Session analytics
let sessionTradeCount = 0;
let sessionWins = 0;
let sessionLosses = 0;
let sessionTotalProfit = 0;
let sessionTotalHoldTicks = 0;
let sessionBestTrade = 0;
let sessionWorstTrade = 0;
// Per-direction stats
let longTrades = 0;
let longWins = 0;
let longTotalProfit = 0;
let shortTrades = 0;
let shortWins = 0;
let shortTotalProfit = 0;

// === CONTROL PORT ===

interface StocksControlMessage {
  action: string;
  [key: string]: unknown;
}

function readControlPort(ns: NS): StocksControlMessage[] {
  const messages: StocksControlMessage[] = [];
  const port = ns.getPortHandle(STOCKS_CONTROL_PORT);
  while (!port.empty()) {
    const data = port.read();
    if (data === "NULL PORT DATA") break;
    try {
      messages.push(JSON.parse(data as string) as StocksControlMessage);
    } catch {
      // Skip invalid
    }
  }
  return messages;
}

// === TRADE RECORDING ===

function recordTrade(trade: TradeRecordInternal): void {
  recentTrades.push(trade);
  if (recentTrades.length > MAX_RECENT_TRADES) recentTrades.shift();

  sessionTradeCount++;
  if (trade.profit > 0) sessionWins++;
  else sessionLosses++;
  sessionTotalProfit += trade.profit;
  sessionTotalHoldTicks += trade.ticksHeld;
  sessionBestTrade = Math.max(sessionBestTrade, trade.profit);
  sessionWorstTrade = Math.min(sessionWorstTrade, trade.profit);

  // Per-direction tracking
  if (trade.direction === "long") {
    longTrades++;
    if (trade.profit > 0) longWins++;
    longTotalProfit += trade.profit;
  } else {
    shortTrades++;
    if (trade.profit > 0) shortWins++;
    shortTotalProfit += trade.profit;
  }
}

// === API PURCHASE ===

function tryPurchaseAPIs(ns: NS): { hasWSE: boolean; hasTIX: boolean; has4S: boolean } {
  let hasWSE = false;
  let hasTIX = false;
  let has4S = false;

  // v3.0+: TIX API access is independent from the WSE account. The WSE account and the
  // non-API "4S Market Data" only unlock the Stock Market UI, so scripts never buy them.
  try {
    hasWSE = ns.stock.hasWseAccount();
    hasTIX = ns.stock.hasTixApiAccess();
    has4S = ns.stock.has4SDataTixApi();
  } catch {
    // Stock market not available in this bitnode
  }

  const player = ns.getPlayer();
  const money = player.money;

  // Purchase TIX API ($5B) — no longer requires a WSE account in v3.0+.
  // The budget daemon carves out the full price once cash covers wseCarveoutMult times it.
  if (!hasTIX) {
    const cost = WSE_TIX_API_COST;
    if (money >= cost && canAfford(ns, "wse-access", cost)) {
      try {
        if (ns.stock.purchaseTixApi()) {
          hasTIX = true;
          notifyPurchase(ns, "wse-access", cost, "TIX API");
          ns.print(`  ${C.green}PURCHASED${C.reset} TIX API`);
        }
      } catch {
        // Not available
      }
    }
  }

  // Purchase 4S Market Data TIX API ($25B)
  if (hasTIX && !has4S) {
    const cost = WSE_4S_TIX_API_COST;
    if (money >= cost && canAfford(ns, "wse-access", cost)) {
      try {
        if (ns.stock.purchase4SMarketDataTixApi()) {
          has4S = true;
          notifyPurchase(ns, "wse-access", cost, "4S Market Data TIX API");
          ns.print(`  ${C.green}PURCHASED${C.reset} 4S Market Data TIX API`);
        }
      } catch {
        // Not available
      }
    }
  }

  // Signal done for wse-access once all APIs owned
  if (hasTIX && has4S) {
    signalDone(ns, "wse-access");
  }

  return { hasWSE, hasTIX, has4S };
}

// === HACK AWARENESS ===

function getHackTargets(ns: NS): Map<string, string> {
  const targets = new Map<string, string>();
  const hackStatus = peekStatus<HackStatus>(ns, STATUS_PORTS.hack, 30_000);
  if (!hackStatus) return targets;

  // Batch mode targets
  if (hackStatus.batchTargets) {
    for (const t of hackStatus.batchTargets) {
      targets.set(t.hostname, t.phase);
    }
  }

  // Legacy mode targets
  if (hackStatus.targets) {
    for (const t of hackStatus.targets) {
      targets.set(t.hostname, t.action);
    }
  }

  return targets;
}

// === DAEMON LOOP ===

async function daemon(ns: NS, maxTier: number, tierName: string, allocatedRam: number): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "stocks", {
    enabled: "true",
    pollInterval: "6000",
    smartMode: "true",
    minForecastDeviation: "0.10",
    sellForecastDeviation: "0.05",
    preThreshold: "0.03",
    tickWindow: "40",
    maxPositions: "8",
    stopLossPercent: "0.15",
    trailingStopPercent: "0.08",
    maxHoldTicks: "60",
    sellCooldownTicks: "3",
    commissionPerTrade: "100000",
    scrapeMaxAge: "120000",
  });

  const enabled = getConfigBool(ns, "stocks", "enabled", true);
  if (!enabled) {
    const disabledStatus: StocksStatus = {
      mode: "disabled", tier: maxTier, tierName,
      hasWSE: false, hasTIX: false, has4S: false,
      portfolioValue: 0, portfolioValueFormatted: "$0",
      totalProfit: 0, totalProfitFormatted: "$0",
      realizedProfit: 0, realizedProfitFormatted: "$0",
      profitPerSec: 0, profitPerSecFormatted: "$0/s",
      longPositions: 0, shortPositions: 0, positions: [],
      signals: [], tradingCapital: 0, tradingCapitalFormatted: "$0",
      smartMode: false, pollInterval: 0, tickCount: 0,
    };
    publishStatus(ns, STATUS_PORTS.stocks, disabledStatus);
    ns.print(`${C.yellow}Stocks daemon disabled by config${C.reset}`);
    return;
  }

  // Short selling availability (requires BN8 or SF8.2) — detected on first trade tick
  let canShort = false;
  let shortDetected = false;

  ns.print(
    `${C.cyan}Stocks daemon started${C.reset} tier=${maxTier} (${tierName})`
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Read config every tick (hot reload for profile switching)
    const pollInterval = getConfigNumber(ns, "stocks", "pollInterval", 6000);
    const smartMode = getConfigBool(ns, "stocks", "smartMode", true);
    const minForecastDeviation = getConfigNumber(ns, "stocks", "minForecastDeviation", 0.10);
    const sellForecastDeviation = getConfigNumber(ns, "stocks", "sellForecastDeviation", 0.05);
    const preThreshold = getConfigNumber(ns, "stocks", "preThreshold", 0.03);
    const tickWindow = getConfigNumber(ns, "stocks", "tickWindow", 40);
    const maxPositions = getConfigNumber(ns, "stocks", "maxPositions", 8);
    const sellCooldownTicks = getConfigNumber(ns, "stocks", "sellCooldownTicks", 3);
    const commissionPerTrade = getConfigNumber(ns, "stocks", "commissionPerTrade", 100_000);
    const scrapeMaxAge = getConfigNumber(ns, "stocks", "scrapeMaxAge", 120_000);
    const stopLossParams: StopLossParams = {
      hardStopPercent: getConfigNumber(ns, "stocks", "stopLossPercent", 0.15),
      trailingStopPercent: getConfigNumber(ns, "stocks", "trailingStopPercent", 0.08),
      maxHoldTicks: getConfigNumber(ns, "stocks", "maxHoldTicks", 60),
    };

    // Process control messages
    const controlMessages = readControlPort(ns);
    for (const msg of controlMessages) {
      if (msg.action === "reload-config") {
        ns.print(`  ${C.green}Config reloaded${C.reset} (profile change)`);
      } else if (msg.action === "reset-pnl") {
        realizedProfit = 0;
        sessionStartOffset = 0;
        profitHistory.length = 0;
        recentTrades.length = 0;
        sessionTradeCount = 0;
        sessionWins = 0;
        sessionLosses = 0;
        sessionTotalProfit = 0;
        sessionTotalHoldTicks = 0;
        sessionBestTrade = 0;
        sessionWorstTrade = 0;
        longTrades = 0;
        longWins = 0;
        longTotalProfit = 0;
        shortTrades = 0;
        shortWins = 0;
        shortTotalProfit = 0;
        ns.print(`  ${C.green}P&L and trade history reset${C.reset}`);
      }
    }

    // Attempt to purchase APIs
    const apis = tryPurchaseAPIs(ns);

    // Respawn at higher tier if we now have 4S but started at a lower tier — but only if a
    // higher tier would actually fit. Otherwise this would respawn every tick forever
    // (has4S stays true, maxTier stays the same after every restart).
    if (apis.has4S && maxTier < 3) {
      const tierRams = calculateTierRam(ns);
      const available = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + allocatedRam;
      const nextBest = selectBestTier(available, tierRams);
      if (nextBest.tier > maxTier) {
        ns.tprint(`INFO: 4S API acquired — respawning stocks daemon at tier ${nextBest.tier}`);
        ns.spawn(ns.getScriptName(), { threads: 1, spawnDelay: 100 });
        return;
      }
    }

    if (!apis.hasTIX) {
      // Can't do anything without TIX API — publish waiting status and sleep
      const waitStatus: StocksStatus = {
        mode: "monitor", tier: maxTier, tierName,
        hasWSE: apis.hasWSE, hasTIX: false, has4S: false,
        portfolioValue: 0, portfolioValueFormatted: "$0",
        totalProfit: 0, totalProfitFormatted: "$0",
        realizedProfit: 0, realizedProfitFormatted: "$0",
        profitPerSec: 0, profitPerSecFormatted: "$0/s",
        longPositions: 0, shortPositions: 0, positions: [],
        signals: [], tradingCapital: 0, tradingCapitalFormatted: "$0",
        smartMode, pollInterval, tickCount,
      };
      publishStatus(ns, STATUS_PORTS.stocks, waitStatus);
      await ns.sleep(pollInterval);
      continue;
    }

    tickCount++;

    // On first tick, snapshot inherited unrealized P&L so the session starts at $0
    if (tickCount === 1) {
      let inheritedPnL = 0;
      for (const sym of ns.stock.getSymbols()) {
        const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(sym);
        const price = ns.stock.getPrice(sym);
        if (longShares > 0) inheritedPnL += longShares * (price - longAvg);
        if (shortShares > 0) inheritedPnL += shortShares * (shortAvg - price);
      }
      sessionStartOffset = inheritedPnL;
      if (Math.abs(sessionStartOffset) > 0) {
        ns.print(`  ${C.dim}Session P&L offset: ${ns.format.number(sessionStartOffset)} (inherited positions)${C.reset}`);
      }
    }

    // Determine effective mode
    const canTrade = maxTier >= 2;
    const can4S = maxTier >= 3 && apis.has4S;

    // Read scraped forecasts (DOM scraper fallback when no 4S TIX API)
    let scrapedForecasts: Record<string, { forecast: number; volatility: number | null }> | null = null;
    let scrapedAge = Infinity;
    if (!can4S && canTrade) {
      try {
        if (ns.fileExists("/data/stock-forecasts.json")) {
          const raw = ns.read("/data/stock-forecasts.json");
          const parsed = JSON.parse(raw) as { timestamp: number; forecasts: Record<string, { forecast: number; volatility: number | null }> };
          scrapedAge = Date.now() - parsed.timestamp;
          if (scrapedAge < scrapeMaxAge && Object.keys(parsed.forecasts).length > 0) {
            scrapedForecasts = parsed.forecasts;
          }
        }
      } catch {
        // Invalid or missing file, ignore
      }
    }

    const mode: StocksMode = can4S ? "4s" : (scrapedForecasts ? "scraped" : (canTrade ? "pre4s" : "monitor"));

    // Get symbols and poll prices
    const symbols = ns.stock.getSymbols();

    // Detect short selling availability once (needs symbols)
    if (!shortDetected && canTrade) {
      shortDetected = true;
      try {
        ns.stock.buyShort(symbols[0], 0);
        canShort = true;
      } catch {
        canShort = false;
      }
      ns.print(`  ${C.dim}Short selling: ${canShort ? "available" : "not available (need BN8/SF8.2)"}${C.reset}`);
    }

    // Get hack targets for smart mode
    const hackTargets = smartMode ? getHackTargets(ns) : new Map<string, string>();

    // Budget: use balance as trading capital limit
    let tradingCapital = Infinity;
    if (canTrade) {
      tradingCapital = getBudgetBalance(ns, "stocks");
    }

    const positions: StockPosition[] = [];
    const signals: StockSignal[] = [];
    const buyCandidates: { sym: string; dir: "long" | "short"; strength: number; price: number; expectedReturn: number; forecast?: number }[] = [];
    let portfolioValue = 0;
    let unrealizedProfit = 0;
    let longCount = 0;
    let shortCount = 0;
    const allForecasts: Map<string, number> = new Map(); // symbol → forecast (for market grid)
    const heldSymbols: Map<string, "long" | "short"> = new Map(); // symbol → direction

    for (const sym of symbols) {
      const price = ns.stock.getPrice(sym);
      const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(sym);

      // Detect external position changes (e.g. sell-all-stocks.ts)
      if (previousPositions.has(sym)) {
        const [prevLong, prevLongAvg, prevShort, prevShortAvg] = previousPositions.get(sym)!;
        const longKey = `${sym}-long`;
        const shortKey = `${sym}-short`;

        // Long position disappeared externally
        if (prevLong > 0 && longShares === 0) {
          const profit = prevLong * (price - prevLongAvg);
          realizedProfit += profit;
          sellCooldowns.set(sym, tickCount);
          const tracking = positionTracking.get(longKey);
          recordTrade({
            symbol: sym, direction: "long", entryPrice: prevLongAvg, exitPrice: price,
            shares: prevLong, profit, ticksHeld: tracking?.ticksHeld ?? 0,
            exitReason: "external", forecastAtEntry: tracking?.forecastAtEntry,
          });
          positionTracking.delete(longKey);
          ns.print(`  ${C.yellow}EXTERNAL SELL${C.reset} ${sym} LONG: ~${ns.format.number(profit)}`);
        }

        // Short position disappeared externally
        if (prevShort > 0 && shortShares === 0) {
          const profit = prevShort * (prevShortAvg - price);
          realizedProfit += profit;
          sellCooldowns.set(sym, tickCount);
          const tracking = positionTracking.get(shortKey);
          recordTrade({
            symbol: sym, direction: "short", entryPrice: prevShortAvg, exitPrice: price,
            shares: prevShort, profit, ticksHeld: tracking?.ticksHeld ?? 0,
            exitReason: "external", forecastAtEntry: tracking?.forecastAtEntry,
          });
          positionTracking.delete(shortKey);
          ns.print(`  ${C.yellow}EXTERNAL SELL${C.reset} ${sym} SHORT: ~${ns.format.number(profit)}`);
        }
      }

      // Update price history
      if (!priceHistories.has(sym)) {
        priceHistories.set(sym, createPriceHistory(tickWindow));
      }
      const history = priceHistories.get(sym)!;
      addPrice(history, price);

      // Get forecast + volatility if available (4S API or scraped)
      let forecast: number | null = null;
      let volatility: number | null = null;
      if (can4S) {
        try {
          forecast = ns.stock.getForecast(sym);
          volatility = ns.stock.getVolatility(sym);
        } catch { /* no 4S access */ }
      } else if (scrapedForecasts && scrapedForecasts[sym]) {
        forecast = scrapedForecasts[sym].forecast;
        volatility = scrapedForecasts[sym].volatility;
      }

      // Estimate volatility from price history if not available from API/scrape
      if (volatility === null || volatility === 0) {
        volatility = estimateVolatility(history);
      }

      // Generate signal
      let signalDir: "long" | "short" | "neutral" = "neutral";
      let signalStrength = 0;
      let expectedReturn = 0;
      let maRatio: number | undefined;
      let forecastVal: number | undefined;

      // Display confidence = forecast deviation from 0.5 (meaningful as a %)
      let displayConfidence = 0;

      if (forecast !== null && volatility !== null && volatility > 0) {
        // Expected-return-based signal (4S or scraped mode)
        const sig = forecastSignal(forecast, volatility, minForecastDeviation);
        signalDir = sig.direction;
        signalStrength = sig.strength;
        expectedReturn = sig.expectedReturn;
        displayConfidence = Math.abs(forecast - 0.5);
        forecastVal = forecast;
      } else if (forecast !== null) {
        // Have forecast but no volatility data yet — use forecast deviation as crude proxy
        const deviation = Math.abs(forecast - 0.5);
        if (deviation >= minForecastDeviation) {
          signalDir = forecast > 0.5 ? "long" : "short";
          signalStrength = deviation;
          expectedReturn = forecast - 0.5;
        }
        displayConfidence = deviation;
        forecastVal = forecast;
      } else {
        // Pre-4S mode: tick-count forecast estimation with MA fallback
        const sig = detectTrend(history, preThreshold, minForecastDeviation);
        signalDir = sig.direction;
        signalStrength = sig.strength;
        displayConfidence = sig.strength;
        maRatio = sig.maRatio;
        // Use estimated forecast for display, and to derive an expected-return magnitude
        // for the commission threshold check below (same formula as the 4S/scraped path).
        // Without this, expectedReturn stays 0 and meetsCommissionThreshold() always
        // rejects — pre-4S mode would never actually buy anything.
        const estFc = estimateForecast(history);
        if (estFc !== null) {
          forecastVal = estFc;
          if (volatility !== null && volatility > 0) {
            expectedReturn = calcExpectedReturn(estFc, volatility);
          }
        }
      }

      // Collect forecast for market grid
      if (forecastVal !== undefined) {
        allForecasts.set(sym, forecastVal);
      }

      // Apply hack adjustment in smart mode
      let hackAdj = "";
      if (smartMode && signalDir !== "neutral") {
        const adj = getHackAdjustment(sym, signalDir, hackTargets);
        signalStrength *= adj.confidenceMultiplier;
        displayConfidence *= adj.confidenceMultiplier;
        if (adj.reason) hackAdj = adj.reason;
      }

      // Track existing positions
      if (longShares > 0) heldSymbols.set(sym, "long");
      if (shortShares > 0) heldSymbols.set(sym, "short");

      if (longShares > 0) {
        longCount++;
        const profit = longShares * (price - longAvg);
        unrealizedProfit += profit;
        portfolioValue += longShares * price;
        positions.push({
          symbol: sym,
          shares: longShares,
          avgPrice: longAvg,
          currentPrice: price,
          direction: "long",
          profit,
          profitFormatted: ns.format.number(profit),
          confidence: displayConfidence,
          hackAdjustment: hackAdj || undefined,
        });

        // Initialize tracking for inherited positions
        const longKey = `${sym}-long`;
        if (!positionTracking.has(longKey)) {
          positionTracking.set(longKey, {
            entryPrice: longAvg,
            peakPrice: price,
            ticksHeld: 0,
            direction: "long",
          });
        }
        const tracking = positionTracking.get(longKey)!;
        tracking.ticksHeld++;
        tracking.peakPrice = updatePeakPrice(price, tracking);

        // Check stop-loss before signal-based sell
        let sold = false;
        if (canTrade) {
          const stopCheck = shouldStopLoss(price, tracking, stopLossParams);
          if (stopCheck.shouldExit) {
            const saleProfit = ns.stock.sellStock(sym, longShares);
            if (saleProfit > 0) {
              const profit = longShares * (saleProfit - longAvg);
              realizedProfit += profit;
              recordTrade({
                symbol: sym, direction: "long", entryPrice: longAvg, exitPrice: saleProfit,
                shares: longShares, profit, ticksHeld: tracking.ticksHeld,
                exitReason: stopCheck.reason, forecastAtEntry: tracking.forecastAtEntry,
                forecastAtExit: forecastVal,
              });
              positionTracking.delete(longKey);
              sellCooldowns.set(sym, tickCount);
              ns.print(`  ${C.red}STOP ${stopCheck.reason.toUpperCase()}${C.reset} ${sym} LONG: ${ns.format.number(saleProfit)}`);
              sold = true;
            }
          }
          // Signal-based sell: forecast crosses 0.5 with hysteresis (4S/scraped) or MA reversal (pre-4S)
          const shouldSellLong = shouldSell("long", forecast, maRatio ?? null, sellForecastDeviation, preThreshold);
          if (!sold && shouldSellLong) {
            const saleProfit = ns.stock.sellStock(sym, longShares);
            if (saleProfit > 0) {
              const profit = longShares * (saleProfit - longAvg);
              realizedProfit += profit;
              recordTrade({
                symbol: sym, direction: "long", entryPrice: longAvg, exitPrice: saleProfit,
                shares: longShares, profit, ticksHeld: tracking.ticksHeld,
                exitReason: "signal", forecastAtEntry: tracking.forecastAtEntry,
                forecastAtExit: forecastVal,
              });
              positionTracking.delete(longKey);
              sellCooldowns.set(sym, tickCount);
              ns.print(`  ${C.green}SELL LONG${C.reset} ${sym}: ${ns.format.number(saleProfit)}`);
            }
          }
        }
      }

      if (shortShares > 0) {
        shortCount++;
        const profit = shortShares * (shortAvg - price);
        unrealizedProfit += profit;
        portfolioValue += shortShares * shortAvg; // Cost basis
        positions.push({
          symbol: sym,
          shares: shortShares,
          avgPrice: shortAvg,
          currentPrice: price,
          direction: "short",
          profit,
          profitFormatted: ns.format.number(profit),
          confidence: displayConfidence,
          hackAdjustment: hackAdj || undefined,
        });

        // Initialize tracking for inherited positions
        const shortKey = `${sym}-short`;
        if (!positionTracking.has(shortKey)) {
          positionTracking.set(shortKey, {
            entryPrice: shortAvg,
            peakPrice: price,
            ticksHeld: 0,
            direction: "short",
          });
        }
        const tracking = positionTracking.get(shortKey)!;
        tracking.ticksHeld++;
        tracking.peakPrice = updatePeakPrice(price, tracking);

        // Check stop-loss before signal-based sell
        let sold = false;
        if (canTrade) {
          const stopCheck = shouldStopLoss(price, tracking, stopLossParams);
          if (stopCheck.shouldExit) {
            const saleProfit = ns.stock.sellShort(sym, shortShares);
            if (saleProfit > 0) {
              const profit = shortShares * (shortAvg - saleProfit);
              realizedProfit += profit;
              recordTrade({
                symbol: sym, direction: "short", entryPrice: shortAvg, exitPrice: saleProfit,
                shares: shortShares, profit, ticksHeld: tracking.ticksHeld,
                exitReason: stopCheck.reason, forecastAtEntry: tracking.forecastAtEntry,
                forecastAtExit: forecastVal,
              });
              positionTracking.delete(shortKey);
              sellCooldowns.set(sym, tickCount);
              ns.print(`  ${C.red}STOP ${stopCheck.reason.toUpperCase()}${C.reset} ${sym} SHORT: ${ns.format.number(saleProfit)}`);
              sold = true;
            }
          }
          // Signal-based sell: forecast crosses 0.5 with hysteresis (4S/scraped) or MA reversal (pre-4S)
          const shouldSellShort = shouldSell("short", forecast, maRatio ?? null, sellForecastDeviation, preThreshold);
          if (!sold && shouldSellShort) {
            const saleProfit = ns.stock.sellShort(sym, shortShares);
            if (saleProfit > 0) {
              const profit = shortShares * (shortAvg - saleProfit);
              realizedProfit += profit;
              recordTrade({
                symbol: sym, direction: "short", entryPrice: shortAvg, exitPrice: saleProfit,
                shares: shortShares, profit, ticksHeld: tracking.ticksHeld,
                exitReason: "signal", forecastAtEntry: tracking.forecastAtEntry,
                forecastAtExit: forecastVal,
              });
              positionTracking.delete(shortKey);
              sellCooldowns.set(sym, tickCount);
              ns.print(`  ${C.yellow}SELL SHORT${C.reset} ${sym}: ${ns.format.number(saleProfit)}`);
            }
          }
        }
      }

      // Collect buy candidates (executed after loop, sorted by expected return)
      if (canTrade && signalDir !== "neutral" && signalStrength > 0) {
        if (signalDir === "long" && longShares === 0) {
          buyCandidates.push({ sym, dir: "long", strength: signalStrength, price, expectedReturn, forecast: forecastVal });
        } else if (signalDir === "short" && shortShares === 0 && canShort) {
          buyCandidates.push({ sym, dir: "short", strength: signalStrength, price, expectedReturn, forecast: forecastVal });
        }
      }

      // Record signal for non-held stocks
      if (longShares === 0 && shortShares === 0 && signalDir !== "neutral") {
        signals.push({
          symbol: sym,
          direction: signalDir,
          strength: signalStrength,
          forecast: forecastVal,
          maRatio,
        });
      }

      // Save current position for next tick's external-sale detection.
      // Re-read position after daemon sells so we don't double-count next tick.
      const [curLong, curLongAvg, curShort, curShortAvg] = ns.stock.getPosition(sym);
      previousPositions.set(sym, [curLong, curLongAvg, curShort, curShortAvg]);
    }

    // Execute buy candidates sorted by strength, weighted allocation, respecting diversification cap
    buyCandidates.sort((a, b) => b.strength - a.strength);
    const totalCandidateStrength = buyCandidates.reduce((sum, c) => sum + c.strength, 0);
    const currentPositionCount = longCount + shortCount;
    let newPositions = 0;
    for (const cand of buyCandidates) {
      if (maxPositions > 0 && currentPositionCount + newPositions >= maxPositions) break;

      // Check sell cooldown
      if (sellCooldownTicks > 0) {
        const lastSoldTick = sellCooldowns.get(cand.sym);
        if (lastSoldTick !== undefined && tickCount - lastSoldTick < sellCooldownTicks) continue;
      }

      const maxShares = ns.stock.getMaxShares(cand.sym);
      const playerCash = ns.getPlayer().money;
      // Weighted allocation: stronger signals get more capital, capped at 2x equal share
      const perStockBudget = calcWeightedBudget(tradingCapital, maxPositions, cand.strength, totalCandidateStrength);
      // 10% cash reserve: never spend more than 90% of cash
      const availCash = Math.min(perStockBudget, playerCash * 0.9, tradingCapital);
      const sharesToBuy = calculatePositionSize(availCash, maxShares, cand.price);
      if (sharesToBuy <= 0) continue;

      // Commission check: skip if expected profit can't overcome round-trip commission
      if (!meetsCommissionThreshold(sharesToBuy, cand.price, cand.expectedReturn, commissionPerTrade)) {
        continue;
      }

      if (cand.dir === "long") {
        const cost = ns.stock.buyStock(cand.sym, sharesToBuy);
        if (cost > 0) {
          positionTracking.set(`${cand.sym}-long`, {
            entryPrice: cost,
            peakPrice: cost,
            ticksHeld: 0,
            direction: "long",
            forecastAtEntry: cand.forecast,
          });
          notifyPurchase(ns, "stocks", cost * sharesToBuy, `Buy ${cand.sym} LONG`);
          ns.print(`  ${C.green}BUY LONG${C.reset} ${cand.sym}: ${sharesToBuy} @ ${ns.format.number(cost)}`);
          newPositions++;
        }
      } else {
        const cost = ns.stock.buyShort(cand.sym, sharesToBuy);
        if (cost > 0) {
          positionTracking.set(`${cand.sym}-short`, {
            entryPrice: cost,
            peakPrice: cost,
            ticksHeld: 0,
            direction: "short",
            forecastAtEntry: cand.forecast,
          });
          notifyPurchase(ns, "stocks", cost * sharesToBuy, `Buy ${cand.sym} SHORT`);
          ns.print(`  ${C.cyan}BUY SHORT${C.reset} ${cand.sym}: ${sharesToBuy} @ ${ns.format.number(cost)}`);
          newPositions++;
        }
      }
    }

    // Calculate profit/sec (subtract inherited P&L so session starts at $0)
    const totalProfit = realizedProfit + unrealizedProfit - sessionStartOffset;
    profitHistory.push(totalProfit);
    if (profitHistory.length > MAX_PROFIT_HISTORY) profitHistory.shift();

    let profitPerSec = 0;
    if (profitHistory.length >= 2) {
      const oldest = profitHistory[0];
      const newest = profitHistory[profitHistory.length - 1];
      const timeSpanSec = (profitHistory.length - 1) * (pollInterval / 1000);
      if (timeSpanSec > 0) {
        profitPerSec = (newest - oldest) / timeSpanSec;
      }
    }

    // Sort signals by strength
    signals.sort((a, b) => b.strength - a.strength);

    // Build market overview grid (4S/scraped mode only)
    const marketOverview = (mode === "4s" || mode === "scraped") && allForecasts.size > 0
      ? Array.from(allForecasts.entries()).map(([sym, fc]) => ({
          symbol: sym,
          forecast: fc,
          direction: (fc >= 0.5 ? "bull" : "bear") as "bull" | "bear",
          held: heldSymbols.has(sym),
          heldDirection: heldSymbols.get(sym),
        }))
      : undefined;

    // Detect active trading profile
    const activeProfile: TradingProfileName = detectActiveProfile({
      minForecastDeviation,
      sellForecastDeviation,
      stopLossPercent: stopLossParams.hardStopPercent,
      trailingStopPercent: stopLossParams.trailingStopPercent,
      maxHoldTicks: stopLossParams.maxHoldTicks,
      maxPositions,
    });

    // Build status
    const status: StocksStatus = {
      mode,
      tier: maxTier,
      tierName,
      hasWSE: apis.hasWSE,
      hasTIX: apis.hasTIX,
      has4S: apis.has4S,
      portfolioValue,
      portfolioValueFormatted: ns.format.number(portfolioValue),
      totalProfit,
      totalProfitFormatted: ns.format.number(totalProfit),
      realizedProfit,
      realizedProfitFormatted: ns.format.number(realizedProfit),
      profitPerSec,
      profitPerSecFormatted: ns.format.number(profitPerSec) + "/s",
      longPositions: longCount,
      shortPositions: shortCount,
      positions: positions.sort((a, b) => Math.abs(b.profit) - Math.abs(a.profit)),
      signals: signals.slice(0, 10),
      tradingCapital: tradingCapital === Infinity ? -1 : tradingCapital,
      tradingCapitalFormatted: tradingCapital === Infinity ? "unlimited" : ns.format.number(tradingCapital),
      smartMode,
      activeProfile,
      pollInterval,
      tickCount,
      scrapedForecastAge: scrapedForecasts ? Math.round(scrapedAge) : undefined,
      scrapedForecastCount: scrapedForecasts ? Object.keys(scrapedForecasts).length : undefined,
      // Market overview grid
      marketOverview,
      // Trade history & session analytics
      recentTrades: recentTrades.map(t => ({
        ...t,
        profitFormatted: ns.format.number(t.profit),
      })),
      sessionStats: sessionTradeCount > 0 ? {
        totalTrades: sessionTradeCount,
        wins: sessionWins,
        losses: sessionLosses,
        winRate: sessionWins / sessionTradeCount,
        avgProfit: sessionTotalProfit / sessionTradeCount,
        avgHoldTicks: Math.round(sessionTotalHoldTicks / sessionTradeCount),
        bestTrade: sessionBestTrade,
        worstTrade: sessionWorstTrade,
        avgProfitFormatted: ns.format.number(sessionTotalProfit / sessionTradeCount),
        bestTradeFormatted: ns.format.number(sessionBestTrade),
        worstTradeFormatted: ns.format.number(sessionWorstTrade),
        long: {
          trades: longTrades,
          wins: longWins,
          winRate: longTrades > 0 ? longWins / longTrades : 0,
          totalProfit: longTotalProfit,
          totalProfitFormatted: ns.format.number(longTotalProfit),
        },
        short: {
          trades: shortTrades,
          wins: shortWins,
          winRate: shortTrades > 0 ? shortWins / shortTrades : 0,
          totalProfit: shortTotalProfit,
          totalProfitFormatted: ns.format.number(shortTotalProfit),
        },
      } : undefined,
    };

    publishStatus(ns, STATUS_PORTS.stocks, status);

    ns.print(
      `${C.cyan}=== Stocks ===${C.reset} ` +
      `[${mode.toUpperCase()}] ` +
      `Pos: ${longCount}L/${shortCount}S | ` +
      `Value: ${ns.format.number(portfolioValue)} | ` +
      `P&L: ${ns.format.number(totalProfit)} | ` +
      `${ns.format.number(profitPerSec)}/s`
    );

    await ns.sleep(pollInterval);
  }
}
