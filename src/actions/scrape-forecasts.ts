/**
 * 4S Forecast DOM Scraper
 *
 * Scrapes stock forecast values from the game's Stock Market UI via DOM/React
 * fiber mining. Writes results to /data/stock-forecasts.json for the stocks
 * daemon to consume as a fallback when the $25B 4S TIX API isn't purchased.
 *
 * Requires: the Stock Market page must be open in the game UI. 4S Market Data is NOT
 * required: the ticker rows receive the raw Stock object (otlkMag, b, mv) as a React
 * prop regardless, so fiber mining reads the exact forecast with only a WSE account.
 * The text-parsing fallback (++/--) does need the 4S display. Trading still needs the
 * TIX API.
 * Stop: Close the tail window or kill the script.
 *
 * Usage: run actions/scrape-forecasts.js
 */
import { NS } from "@ns";

const doc = globalThis["document"] as Document;
const OUTPUT_FILE = "/data/stock-forecasts.json";
const SCRAPE_INTERVAL = 6000; // Match stock tick rate

/** All known Bitburner stock symbols */
const ALL_SYMBOLS = [
  "ECP", "MGCP", "BLD", "CLRK", "OMTK", "FSIG", "KGI", "FLCM",
  "STM", "DCOMM", "HLS", "VITA", "ICRS", "UNV", "AERO", "OMN",
  "SLRS", "GPH", "NVMD", "LXO", "RHOC", "APHE", "SYSC", "CTK",
  "NTLK", "OMGA", "FNS", "JGN", "SGC", "CTYS", "MDYN", "TITN",
];
const SYMBOL_SET = new Set(ALL_SYMBOLS);

interface ScrapedForecast {
  forecast: number;
  volatility: number | null;
}

interface ScrapeResult {
  timestamp: number;
  forecasts: Record<string, ScrapedForecast>;
}

export async function main(ns: NS): Promise<void> {
  ns.ramOverride(1.6);
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.print("=== 4S Forecast DOM Scraper ===");
  ns.print("Stock Market page must be open. Close tail to stop.");
  ns.print("");

  let consecutiveFailures = 0;
  let lastStrategy = "";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = scrapeForecasts(ns);

    if (result && Object.keys(result.forecasts).length > 0) {
      consecutiveFailures = 0;
      const count = Object.keys(result.forecasts).length;
      ns.write(OUTPUT_FILE, JSON.stringify(result), "w");
      const strategyNote = lastStrategy !== result.strategy
        ? ` [${result.strategy}]`
        : "";
      lastStrategy = result.strategy;
      ns.print(
        `[${new Date().toLocaleTimeString()}] Scraped ${count}/${ALL_SYMBOLS.length} symbols${strategyNote}`
      );
    } else {
      consecutiveFailures++;
      if (consecutiveFailures <= 3) {
        ns.print(
          `[${new Date().toLocaleTimeString()}] WARN: No forecasts found — ` +
          `is Stock Market page open with 4S data? (attempt ${consecutiveFailures})`
        );
      } else if (consecutiveFailures % 10 === 0) {
        ns.print(
          `[${new Date().toLocaleTimeString()}] Still no data after ${consecutiveFailures} attempts. ` +
          `Open the Stock Market page in-game.`
        );
      }
    }

    await ns.sleep(SCRAPE_INTERVAL);
  }
}

interface ScrapeResultInternal extends ScrapeResult {
  strategy: string;
}

/**
 * Attempt to scrape forecast data from the DOM.
 * Tries multiple strategies in order of precision.
 */
function scrapeForecasts(ns: NS): ScrapeResultInternal | null {
  const forecasts: Record<string, ScrapedForecast> = {};
  let strategy = "";

  // Strategy 1: Find stock symbol elements, walk UP their fiber trees
  try {
    const fiberResults = scrapeViaSymbolElements();
    for (const [sym, data] of Object.entries(fiberResults)) {
      forecasts[sym] = data;
    }
    if (Object.keys(fiberResults).length > 0) strategy = "fiber";
  } catch (e) {
    ns.print(`  Fiber mining error: ${e}`);
  }

  // Strategy 2: Text content parsing for Price Forecast: ++/--/+/-
  if (Object.keys(forecasts).length < ALL_SYMBOLS.length / 2) {
    try {
      const textResults = scrapeTextContent();
      let textAdded = 0;
      for (const [sym, data] of Object.entries(textResults)) {
        if (!forecasts[sym]) {
          forecasts[sym] = data;
          textAdded++;
        }
      }
      if (textAdded > 0 && !strategy) strategy = "text";
      else if (textAdded > 0) strategy += "+text";
    } catch (e) {
      ns.print(`  Text parsing error: ${e}`);
    }
  }

  if (Object.keys(forecasts).length === 0) return null;

  return { timestamp: Date.now(), forecasts, strategy };
}

// === STRATEGY 1: Element-targeted fiber walk ===

/**
 * Find DOM elements containing stock symbol text, then walk UP their React
 * fiber trees to find stock data objects (otlkMag, b, mv, etc.).
 */
function scrapeViaSymbolElements(): Record<string, ScrapedForecast> {
  const results: Record<string, ScrapedForecast> = {};

  // Get the React fiber key from any element
  const anyEl = doc.querySelector("#root") ?? doc.body;
  const fiberKey = Object.keys(anyEl).find(k => k.startsWith("__reactFiber$"));
  const propsKey = Object.keys(anyEl).find(k => k.startsWith("__reactProps$"));
  if (!fiberKey && !propsKey) return results;

  // Find elements that contain stock symbols - scan all text-containing elements
  const candidates = doc.querySelectorAll("p, span, h5, h6, li, td, div, button");

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    // Check for exact symbol text (element's own text, not children's)
    const directText = getDirectText(el).trim();
    if (!SYMBOL_SET.has(directText)) continue;
    if (results[directText]) continue; // Already found this symbol

    const sym = directText;

    // Walk UP the DOM tree, checking each element's fiber for stock data
    let current: Element | null = el;
    let depth = 0;
    while (current && depth < 20) {
      const stockData = extractStockFromElement(current, fiberKey, propsKey);
      if (stockData && stockData.symbol === sym) {
        results[sym] = {
          forecast: stockData.forecast,
          volatility: stockData.volatility,
        };
        break;
      }
      // Also check: maybe the stock data doesn't have symbol but we found otlkMag
      if (stockData && !stockData.symbol) {
        results[sym] = {
          forecast: stockData.forecast,
          volatility: stockData.volatility,
        };
        break;
      }
      current = current.parentElement;
      depth++;
    }
  }

  return results;
}

interface StockDataFound {
  symbol: string | null;
  forecast: number;
  volatility: number | null;
}

/**
 * Check a DOM element's React fiber and props for stock data.
 */
function extractStockFromElement(
  el: Element,
  fiberKey: string | undefined,
  propsKey: string | undefined,
): StockDataFound | null {
  const elAny = el as unknown as Record<string, unknown>;

  // Check __reactProps$ first (simpler)
  if (propsKey) {
    const pk = Object.keys(el).find(k => k.startsWith("__reactProps$"));
    if (pk) {
      const props = elAny[pk] as Record<string, unknown> | undefined;
      if (props) {
        const found = searchObjectForStockData(props, 3);
        if (found) return found;
      }
    }
  }

  // Check __reactFiber$ — walk UP the fiber tree (via return)
  if (fiberKey) {
    const fk = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    if (fk) {
      let fiber = elAny[fk] as Record<string, unknown> | undefined;
      let fDepth = 0;
      while (fiber && fDepth < 15) {
        for (const propName of ["memoizedProps", "pendingProps"]) {
          const p = fiber[propName] as Record<string, unknown> | undefined;
          if (p) {
            const found = searchObjectForStockData(p, 4);
            if (found) return found;
          }
        }
        // Also check memoizedState (linked list of hooks)
        let state = fiber["memoizedState"] as Record<string, unknown> | null;
        let sDepth = 0;
        while (state && sDepth < 10) {
          if (state["memoizedState"] && typeof state["memoizedState"] === "object") {
            const found = searchObjectForStockData(
              state["memoizedState"] as Record<string, unknown>, 3
            );
            if (found) return found;
          }
          if (state["queue"] && typeof state["queue"] === "object") {
            const q = state["queue"] as Record<string, unknown>;
            if (q["lastRenderedState"] && typeof q["lastRenderedState"] === "object") {
              const found = searchObjectForStockData(
                q["lastRenderedState"] as Record<string, unknown>, 3
              );
              if (found) return found;
            }
          }
          state = state["next"] as Record<string, unknown> | null;
          sDepth++;
        }

        fiber = fiber["return"] as Record<string, unknown> | undefined;
        fDepth++;
      }
    }
  }

  return null;
}

/**
 * Recursively search an object for stock data patterns.
 *
 * Bitburner internal Stock objects have:
 *   symbol: string    — e.g. "ECP"
 *   otlkMag: number   — outlook magnitude (deviation from 50%, in % points ~1-50)
 *   b: boolean         — true = trending up (bullish)
 *   mv: number         — raw volatility magnitude (~0.1-1); ns.stock.getVolatility()
 *                        returns this divided by 100 (~0.001-0.01) — divide here too
 *   price: number      — current price
 *   maxShares: number  — max purchasable shares
 */
function searchObjectForStockData(
  obj: Record<string, unknown>,
  maxDepth: number,
): StockDataFound | null {
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return null;

  // Check for Bitburner internal stock shape: otlkMag + b + symbol
  const otlkMag = obj["otlkMag"];
  const b = obj["b"];
  const symbol = obj["symbol"];
  const mv = obj["mv"];

  if (typeof otlkMag === "number" && typeof b === "boolean") {
    // Found it! Compute forecast from otlkMag + b
    const forecast = b
      ? 0.5 + otlkMag / 100
      : 0.5 - otlkMag / 100;

    return {
      symbol: typeof symbol === "string" && SYMBOL_SET.has(symbol) ? symbol : null,
      forecast: Math.max(0, Math.min(1, forecast)),
      // Raw internal Stock.mv is ~0.1-1 magnitude; ns.stock.getVolatility() returns
      // mv * darknetMult / 100 (~0.001-0.01). Divide by 100 so scraped volatility matches
      // the API's scale — without this, expected-return math is inflated ~100x.
      volatility: typeof mv === "number" ? mv / 100 : null,
    };
  }

  // Check for a direct forecast number with symbol
  const forecast = obj["forecast"];
  if (
    typeof forecast === "number" &&
    forecast >= 0 && forecast <= 1 &&
    typeof symbol === "string" &&
    SYMBOL_SET.has(symbol)
  ) {
    return {
      symbol,
      forecast,
      volatility: typeof mv === "number" ? mv / 100 : null,
    };
  }

  // Recurse into likely child keys
  for (const key of ["stock", "props", "children", "data", "stateNode"]) {
    const child = obj[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const found = searchObjectForStockData(child as Record<string, unknown>, maxDepth - 1);
      if (found) return found;
    }
  }

  // Also recurse into any key whose value looks like a stock object
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (
      val && typeof val === "object" && !Array.isArray(val) &&
      !["stock", "props", "children", "data", "stateNode"].includes(key) &&
      key !== "return" && key !== "alternate" && key !== "_owner" &&
      key !== "ref" && key !== "key" && key !== "type" &&
      key !== "__proto__"
    ) {
      const child = val as Record<string, unknown>;
      // Quick check: does this child have stock-like keys?
      if ("otlkMag" in child || "forecast" in child || "symbol" in child) {
        const found = searchObjectForStockData(child, maxDepth - 1);
        if (found) return found;
      }
    }
  }

  return null;
}

/**
 * Get the direct text content of an element (not its children).
 */
function getDirectText(el: Element): string {
  let text = "";
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === 3) { // TEXT_NODE
      text += node.textContent ?? "";
    }
  }
  return text;
}

// === STRATEGY 2: Text content parsing ===

/**
 * Parse visible text for "Price Forecast: ++/+/-/--" patterns and volatility.
 *
 * The 4S Market Data displays forecast as symbols:
 *   ++ = strong bullish (~0.70)
 *   +  = mild bullish (~0.60)
 *   -  = mild bearish (~0.40)
 *   -- = strong bearish (~0.30)
 *
 * These are approximate — fiber mining gives exact values when available.
 */
function scrapeTextContent(): Record<string, ScrapedForecast> {
  const results: Record<string, ScrapedForecast> = {};

  // Forecast symbol → approximate forecast value
  // ++ / -- are strong signals (above/below minConfidence threshold)
  // +  / -  are mild signals (in neutral zone — not enough edge to trade)
  const forecastMap: Record<string, number> = {
    "++": 0.70,
    "+": 0.56,
    "-": 0.44,
    "--": 0.30,
  };

  // Find all elements and scan for stock row text patterns
  // Pattern: "SYMBOL - $PRICE - Volatility: X.XX% - Price Forecast: ++"
  const allElements = doc.querySelectorAll("p, span, li, div");

  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    const text = el.textContent ?? "";

    // Look for the full stock row pattern
    const rowMatch = text.match(
      /([A-Z]{2,5})\s*-\s*\$[\d.,]+[kmbtq]?\s*-\s*Volatility:\s*([\d.]+)%\s*-\s*Price Forecast:\s*(\+\+|\+|-|--)/
    );
    if (rowMatch) {
      const sym = rowMatch[1];
      if (!SYMBOL_SET.has(sym)) continue;
      if (results[sym]) continue;

      const volatility = parseFloat(rowMatch[2]) / 100;
      const forecastSymbol = rowMatch[3];
      const forecast = forecastMap[forecastSymbol];

      if (forecast !== undefined) {
        results[sym] = {
          forecast,
          volatility: isNaN(volatility) ? null : volatility,
        };
      }
    }
  }

  return results;
}
