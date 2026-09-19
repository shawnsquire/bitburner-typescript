/**
 * Stock Market Daemon (Tiered Architecture)
 *
 * Automated stock trading with three RAM tiers.
 *
 *   Tier 1 (Monitor):    Poll prices, track positions, publish status. No trading.
 *   Tier 2 (Pre-4S):     Trade on forecasts estimated from tick directions.
 *   Tier 3 (4S Trade):   Trade on the 4S forecast and volatility.
 *
 * Strategy (see docs/systems/stocks.md and sim/stocks for the measurements):
 *   - rank candidates by expected return = volatility × (forecast − 0.5) and fill
 *     each to its share limit until the cash pool is spent
 *   - enter only when the expected return over holdHorizonTicks covers the round
 *     trip spread and commission
 *   - exit a long the tick the forecast drops below 0.5, a short when it rises above;
 *     no price-based stops, no hold timer, no cooldown
 *   - one loop iteration per market tick via ns.stock.nextUpdate()
 *
 * Uses the budget daemon's `stocks` bucket for capital (unlimited if it is not running).
 *
 * Usage: run daemons/stocks.js
 */
import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import { publishStatus } from "/lib/ports";
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
} from "/types/ports";
import {
  createPriceHistory,
  addPrice,
  estimateForecast,
  estimateVolatility,
  forecastSignal,
  spreadFromQuotes,
  planPurchases,
  shouldSell,
  detectActiveProfile,
  longExitProfit,
  shortExitProfit,
  PriceHistory,
  PositionTracking,
  PurchaseCandidate,
  TradingProfileName,
  Direction,
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
// RAM bookkeeping in main()/freeRamForTarget, respawn, tick sync). These must be budgeted
// at every tier, not just the tier that "feels" related to them.
const BASE_FUNCTIONS = [
  "getServerMaxRam",
  "getServerUsedRam",
  "getPlayer",
  "fileExists",
  "spawn",
  "stock.purchaseTixApi",
  "stock.purchase4SMarketDataTixApi",
  "stock.nextUpdate", // 0 GB (CycleTiming)
  "stock.getConstants", // 0 GB
  // via /lib/ram-utils freeRamForTarget()
  "ps",
  "getScriptRam",
  "kill",
];

// Launch-time static RAM cost, pinned via the literal ns.ramOverride() call at the top of
// main() (the game's static analyzer only honours the override when it is the first
// statement of main() with a literal argument). This lets the script start on a low-RAM
// home server; main() bumps the allocation up to the selected tier's requirement
// immediately after. Must equal ceil(tier-1 total) + 2 below — recompute with
// `node tools/ram-check.mjs --json daemons/stocks.js` if the function lists change.
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
      "stock.getAskPrice",
      "stock.getBidPrice",
    ],
    features: ["estimated-forecast-trading", "long-positions", "short-positions"],
  },
  {
    tier: 3,
    name: "4s",
    functions: [
      "stock.getForecast",
      "stock.getVolatility",
    ],
    features: ["forecast-trading"],
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
  // (LAUNCH_RAM) so it can start on a low-RAM home server. Bumped to the selected tier's
  // requirement below via a second, non-literal ramOverride() call.
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
const previousPositions: Map<string, [number, number, number, number]> = new Map(); // symbol → [longShares, longAvg, shortShares, shortAvg]

// Trade history for dashboard display and session analytics
interface TradeRecordInternal {
  symbol: string;
  direction: Direction;
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

function resetSession(): void {
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

// === DAEMON LOOP ===

function emptyStatus(mode: StocksMode, tier: number, tierName: string, apis: { hasWSE: boolean; hasTIX: boolean; has4S: boolean }): StocksStatus {
  return {
    mode, tier, tierName,
    hasWSE: apis.hasWSE, hasTIX: apis.hasTIX, has4S: apis.has4S,
    portfolioValue: 0, portfolioValueFormatted: "$0",
    totalProfit: 0, totalProfitFormatted: "$0",
    realizedProfit: 0, realizedProfitFormatted: "$0",
    profitPerSec: 0, profitPerSecFormatted: "$0/s",
    longPositions: 0, shortPositions: 0, positions: [],
    signals: [], tradingCapital: 0, tradingCapitalFormatted: "$0",
    tickCount,
  };
}

async function daemon(ns: NS, maxTier: number, tierName: string, allocatedRam: number): Promise<void> {
  ns.disableLog("ALL");

  writeDefaultConfig(ns, "stocks", {
    enabled: "true",
    minForecastDeviation: "0.05",
    preMinForecastDeviation: "0.10",
    holdHorizonTicks: "50",
    tickWindow: "40",
    cashReservePercent: "10",
    scrapeMaxAge: "120000",
  });

  const enabled = getConfigBool(ns, "stocks", "enabled", true);
  if (!enabled) {
    publishStatus(ns, STATUS_PORTS.stocks, emptyStatus("disabled", maxTier, tierName, { hasWSE: false, hasTIX: false, has4S: false }));
    ns.print(`${C.yellow}Stocks daemon disabled by config${C.reset}`);
    return;
  }

  // Short selling availability (requires BN8 or SF8.2) — detected on first trade tick
  let canShort = false;
  let shortDetected = false;
  let commission = 100_000;
  let commissionRead = false;

  ns.print(
    `${C.cyan}Stocks daemon started${C.reset} tier=${maxTier} (${tierName})`
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Read config every tick (hot reload for profile switching)
    const minForecastDeviation = getConfigNumber(ns, "stocks", "minForecastDeviation", 0.05);
    const preMinForecastDeviation = getConfigNumber(ns, "stocks", "preMinForecastDeviation", 0.10);
    const holdHorizonTicks = getConfigNumber(ns, "stocks", "holdHorizonTicks", 50);
    const tickWindow = getConfigNumber(ns, "stocks", "tickWindow", 40);
    const cashReservePercent = getConfigNumber(ns, "stocks", "cashReservePercent", 10);
    const scrapeMaxAge = getConfigNumber(ns, "stocks", "scrapeMaxAge", 120_000);

    // Process control messages
    const controlMessages = readControlPort(ns);
    for (const msg of controlMessages) {
      if (msg.action === "reload-config") {
        ns.print(`  ${C.green}Config reloaded${C.reset} (profile change)`);
      } else if (msg.action === "reset-pnl") {
        resetSession();
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
      // Can't do anything without TIX API (and nextUpdate throws without it) — publish
      // waiting status and sleep one market period.
      publishStatus(ns, STATUS_PORTS.stocks, emptyStatus("monitor", maxTier, tierName, apis));
      await ns.sleep(6000);
      continue;
    }

    tickCount++;

    if (!commissionRead) {
      commission = ns.stock.getConstants().StockMarketCommission;
      commissionRead = true;
    }

    // On first tick, snapshot inherited unrealized P&L so the session starts at $0,
    // valued the same way as every later tick (bid for longs, ask for shorts, less
    // the exit commission) when the tier has the quotes.
    if (tickCount === 1) {
      let inheritedPnL = 0;
      for (const sym of ns.stock.getSymbols()) {
        const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(sym);
        const price = ns.stock.getPrice(sym);
        const bid = maxTier >= 2 ? ns.stock.getBidPrice(sym) : price;
        const ask = maxTier >= 2 ? ns.stock.getAskPrice(sym) : price;
        if (longShares > 0) inheritedPnL += longExitProfit(longShares, longAvg, bid, commission);
        if (shortShares > 0) inheritedPnL += shortExitProfit(shortShares, shortAvg, ask, commission);
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

    const symbols = ns.stock.getSymbols();

    // Detect short selling availability once (needs symbols). The BN8/SF8.2 check runs
    // before any side effect, and a zero-share order is rejected before it touches anything.
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

    // Budget: the stocks bucket allowance caps how much cash may go into new positions
    let tradingCapital = Infinity;
    if (canTrade) {
      tradingCapital = getBudgetBalance(ns, "stocks");
    }

    const positions: StockPosition[] = [];
    const signals: StockSignal[] = [];
    const candidates: PurchaseCandidate[] = [];
    let portfolioValue = 0;
    let unrealizedProfit = 0;
    let longCount = 0;
    let shortCount = 0;
    const allForecasts: Map<string, number> = new Map(); // symbol → forecast (for market grid)
    const heldSymbols: Map<string, Direction> = new Map();

    for (const sym of symbols) {
      const price = ns.stock.getPrice(sym);
      const ask = canTrade ? ns.stock.getAskPrice(sym) : price;
      const bid = canTrade ? ns.stock.getBidPrice(sym) : price;
      const spread = spreadFromQuotes(ask, bid);
      let [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(sym);
      const longKey = `${sym}-long`;
      const shortKey = `${sym}-short`;

      // Detect external position changes (sell-all-stocks.js, the game UI): any decrease
      // in shares that this daemon did not make is booked at the current bid/ask.
      if (previousPositions.has(sym)) {
        const [prevLong, prevLongAvg, prevShort, prevShortAvg] = previousPositions.get(sym)!;

        if (prevLong > longShares) {
          const sold = prevLong - longShares;
          const profit = longExitProfit(sold, prevLongAvg, bid, commission);
          realizedProfit += profit;
          const tracking = positionTracking.get(longKey);
          recordTrade({
            symbol: sym, direction: "long", entryPrice: prevLongAvg, exitPrice: bid,
            shares: sold, profit, ticksHeld: tracking?.ticksHeld ?? 0,
            exitReason: "external", forecastAtEntry: tracking?.forecastAtEntry,
          });
          if (longShares === 0) positionTracking.delete(longKey);
          ns.print(`  ${C.yellow}EXTERNAL SELL${C.reset} ${sym} LONG: ~${ns.format.number(profit)}`);
        }

        if (prevShort > shortShares) {
          const covered = prevShort - shortShares;
          const profit = shortExitProfit(covered, prevShortAvg, ask, commission);
          realizedProfit += profit;
          const tracking = positionTracking.get(shortKey);
          recordTrade({
            symbol: sym, direction: "short", entryPrice: prevShortAvg, exitPrice: ask,
            shares: covered, profit, ticksHeld: tracking?.ticksHeld ?? 0,
            exitReason: "external", forecastAtEntry: tracking?.forecastAtEntry,
          });
          if (shortShares === 0) positionTracking.delete(shortKey);
          ns.print(`  ${C.yellow}EXTERNAL SELL${C.reset} ${sym} SHORT: ~${ns.format.number(profit)}`);
        }
      }

      // Update price history (used for the pre-4S estimate and nothing else in 4S mode)
      if (!priceHistories.has(sym)) {
        priceHistories.set(sym, createPriceHistory(tickWindow));
      }
      const history = priceHistories.get(sym)!;
      addPrice(history, price);

      // Forecast + volatility: 4S API, scraped file, or estimated from tick directions
      let forecast: number | null = null;
      let volatility: number | null = null;
      let exactForecast = false;
      if (can4S) {
        try {
          forecast = ns.stock.getForecast(sym);
          volatility = ns.stock.getVolatility(sym);
          exactForecast = true;
        } catch { /* no 4S access */ }
      } else if (scrapedForecasts && scrapedForecasts[sym]) {
        forecast = scrapedForecasts[sym].forecast;
        volatility = scrapedForecasts[sym].volatility;
        exactForecast = true;
      }
      if (forecast === null) {
        forecast = estimateForecast(history);
      }
      if (volatility === null || volatility <= 0) {
        volatility = estimateVolatility(history);
      }

      // Entry signal. The estimated forecast is noisier than the real one, so it needs
      // a wider deviation before it counts.
      const minDeviation = exactForecast ? minForecastDeviation : preMinForecastDeviation;
      const sig = forecast !== null && volatility !== null && volatility > 0
        ? forecastSignal(forecast, volatility, minDeviation)
        : null;
      const signalDir: Direction | "neutral" = sig ? sig.direction : "neutral";
      const expectedReturn = sig ? sig.expectedReturn : 0;
      const displayConfidence = forecast !== null ? Math.abs(forecast - 0.5) : 0;

      if (forecast !== null) {
        allForecasts.set(sym, forecast);
      }

      // === EXITS: a long leaves when the forecast drops below 0.5, a short when it rises above ===
      if (longShares > 0 && canTrade && shouldSell("long", forecast)) {
        const tracking = positionTracking.get(longKey);
        const fill = ns.stock.sellStock(sym, longShares);
        if (fill > 0) {
          const profit = longExitProfit(longShares, longAvg, fill, commission);
          realizedProfit += profit;
          recordTrade({
            symbol: sym, direction: "long", entryPrice: longAvg, exitPrice: fill,
            shares: longShares, profit, ticksHeld: tracking?.ticksHeld ?? 0,
            exitReason: "signal", forecastAtEntry: tracking?.forecastAtEntry,
            forecastAtExit: forecast ?? undefined,
          });
          positionTracking.delete(longKey);
          ns.print(`  ${C.green}SELL LONG${C.reset} ${sym}: ${ns.format.number(profit)}`);
          [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(sym);
        }
      }

      if (shortShares > 0 && canTrade && shouldSell("short", forecast)) {
        const tracking = positionTracking.get(shortKey);
        const fill = ns.stock.sellShort(sym, shortShares);
        if (fill > 0) {
          const profit = shortExitProfit(shortShares, shortAvg, fill, commission);
          realizedProfit += profit;
          recordTrade({
            symbol: sym, direction: "short", entryPrice: shortAvg, exitPrice: fill,
            shares: shortShares, profit, ticksHeld: tracking?.ticksHeld ?? 0,
            exitReason: "signal", forecastAtEntry: tracking?.forecastAtEntry,
            forecastAtExit: forecast ?? undefined,
          });
          positionTracking.delete(shortKey);
          ns.print(`  ${C.yellow}SELL SHORT${C.reset} ${sym}: ${ns.format.number(profit)}`);
          [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(sym);
        }
      }

      // === HELD POSITIONS: valuation at the price they would actually close at ===
      if (longShares > 0) {
        longCount++;
        heldSymbols.set(sym, "long");
        const profit = longExitProfit(longShares, longAvg, bid, commission);
        unrealizedProfit += profit;
        portfolioValue += longShares * bid;
        positions.push({
          symbol: sym, shares: longShares, avgPrice: longAvg, currentPrice: price,
          direction: "long", profit, profitFormatted: ns.format.number(profit),
          confidence: displayConfidence,
        });
        if (!positionTracking.has(longKey)) {
          positionTracking.set(longKey, { entryPrice: longAvg, ticksHeld: 0, direction: "long" });
        }
        positionTracking.get(longKey)!.ticksHeld++;
      }

      if (shortShares > 0) {
        shortCount++;
        heldSymbols.set(sym, "short");
        const profit = shortExitProfit(shortShares, shortAvg, ask, commission);
        unrealizedProfit += profit;
        portfolioValue += shortShares * shortAvg; // Cost basis
        positions.push({
          symbol: sym, shares: shortShares, avgPrice: shortAvg, currentPrice: price,
          direction: "short", profit, profitFormatted: ns.format.number(profit),
          confidence: displayConfidence,
        });
        if (!positionTracking.has(shortKey)) {
          positionTracking.set(shortKey, { entryPrice: shortAvg, ticksHeld: 0, direction: "short" });
        }
        positionTracking.get(shortKey)!.ticksHeld++;
      }

      // === ENTRY CANDIDATES (bought after the loop, ranked by expected return) ===
      if (canTrade && signalDir !== "neutral" && (signalDir === "long" || canShort)) {
        const opposite = signalDir === "long" ? shortShares : longShares;
        if (opposite === 0) {
          const sharesRoom = ns.stock.getMaxShares(sym) - longShares - shortShares;
          candidates.push({
            symbol: sym,
            direction: signalDir,
            expectedReturn,
            fillPrice: signalDir === "long" ? ask : bid,
            spread,
            sharesRoom,
          });
        }
      }

      // Record signal for non-held stocks
      if (longShares === 0 && shortShares === 0 && signalDir !== "neutral") {
        signals.push({
          symbol: sym,
          direction: signalDir,
          strength: Math.abs(expectedReturn),
          forecast: forecast ?? undefined,
          expectedReturn,
        });
      }

      // Save current position for next tick's external-sale detection. The buys below
      // update this again for the symbols they touch.
      previousPositions.set(sym, [longShares, longAvg, shortShares, shortAvg]);
    }

    // === BUY: rank by expected return, fill each to its room, one shared cash pool ===
    if (canTrade && candidates.length > 0) {
      const reserveFraction = Math.min(Math.max(cashReservePercent, 0), 100) / 100;
      const cashPool = Math.min(tradingCapital, ns.getPlayer().money * (1 - reserveFraction));
      const orders = planPurchases(candidates, cashPool, {
        commission,
        horizonTicks: holdHorizonTicks,
        minOrderNotional: commission * 100,
      });
      for (const order of orders) {
        const fill = order.direction === "long"
          ? ns.stock.buyStock(order.symbol, order.shares)
          : ns.stock.buyShort(order.symbol, order.shares);
        if (fill <= 0) continue;
        const key = `${order.symbol}-${order.direction}`;
        const after = ns.stock.getPosition(order.symbol);
        const avgAfter = order.direction === "long" ? after[1] : after[3];
        const existing = positionTracking.get(key);
        if (existing) {
          // Top-up of a held position: the game's average price is the new entry.
          existing.entryPrice = avgAfter;
        } else {
          positionTracking.set(key, {
            entryPrice: avgAfter,
            ticksHeld: 0,
            direction: order.direction,
            forecastAtEntry: allForecasts.get(order.symbol),
          });
          if (order.direction === "long") longCount++; else shortCount++;
        }
        notifyPurchase(ns, "stocks", fill * order.shares + commission, `Buy ${order.symbol} ${order.direction.toUpperCase()}`);
        ns.print(`  ${order.direction === "long" ? C.green + "BUY LONG" : C.cyan + "BUY SHORT"}${C.reset} ${order.symbol}: ${ns.format.number(order.shares, 0)} @ ${ns.format.number(fill)}`);
        previousPositions.set(order.symbol, after);
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
      const timeSpanSec = (profitHistory.length - 1) * 6;
      profitPerSec = (newest - oldest) / timeSpanSec;
    }

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

    const activeProfile: TradingProfileName = detectActiveProfile({ minForecastDeviation });

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
      activeProfile,
      tickCount,
      scrapedForecastAge: scrapedForecasts ? Math.round(scrapedAge) : undefined,
      scrapedForecastCount: scrapedForecasts ? Object.keys(scrapedForecasts).length : undefined,
      marketOverview,
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

    // One iteration per market tick. Resolves when the next price update lands, so the
    // loop never double-samples a tick or misses one during bonus time (4 s ticks).
    await ns.stock.nextUpdate();
  }
}
