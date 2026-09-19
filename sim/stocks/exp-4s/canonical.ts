/**
 * The "community-standard" 4S stock strategy, for comparison against the repo's real
 * daemon (harness.ts). Each tick:
 *   1. Exit: sell any long with forecast below (0.5 - exitHysteresis); cover any short
 *      with forecast above (0.5 + exitHysteresis). No stop-loss/trailing/time-limit -
 *      exit is forecast-only.
 *   2. Entry: rank ALL symbols by |expectedReturn| = vol*|forecast-0.5| descending; for
 *      each with |forecast-0.5| >= entryThreshold (or, in spread-aware mode, passing the
 *      spread/commission hurdle below), buy as many shares as available cash allows, up
 *      to maxShares minus whatever is already held (long+short combined, same-direction
 *      top-up allowed) - no cooldown, no maxPositions cap.
 *
 * Variants (see CanonicalConfig): entry threshold sweep, spread-aware entry, per-position
 * diversification cap, exit hysteresis.
 */
import { Market } from "../stocksim/market.ts";
import { COMMISSION, HORIZON, MetricsTracker, computeTradingCapital, type CapitalParams, type RunMetrics } from "./common.ts";

export interface SpreadAwareParams {
  H: number; // holding-period ticks used in the spread/commission hurdle
}

export interface CanonicalConfig {
  startCash: number;
  canShort: boolean;
  capital: CapitalParams;
  entryThreshold: number; // |forecast-0.5| gate (ignored when spreadAware is set)
  exitHysteresis: number; // exit when forecast crosses (0.5 -/+ this); 0 = plain 0.5 cross
  spreadAware?: SpreadAwareParams;
  diversifiedN?: number; // cap total position value (existing+new) at tradingCapital/N
  horizon?: number;
}

interface Candidate {
  sym: string;
  dir: "long" | "short";
  expectedReturn: number; // signed
  forecast: number;
  volatility: number;
}

export function runCanonical(seed: number, cfg: CanonicalConfig): RunMetrics {
  const horizon = cfg.horizon ?? HORIZON;
  const market = new Market(seed, { cash: cfg.startCash });
  const symbols = market.symbols();
  const tracker = new MetricsTracker(seed, market.netWorth());

  for (let t = 0; t < horizon; t++) {
    market.tick();

    // --- 1. Exits (forecast-only, full liquidation) ---
    for (const sym of symbols) {
      const [longShares, , shortShares] = market.getPosition(sym);
      if (longShares === 0 && shortShares === 0) continue;
      const forecast = market.getForecast(sym);
      const price = market.getPrice(sym);

      if (longShares > 0 && forecast < 0.5 - cfg.exitHysteresis) {
        const before = market.getStockState(sym).otlkMag;
        const fill = market.sellStock(sym, longShares);
        if (fill > 0) {
          const after = market.getStockState(sym).otlkMag;
          tracker.recordErosion(before, after);
          tracker.recordTradeCost(fill, price, longShares, COMMISSION);
          tracker.recordExit("signal");
        }
      }
      if (shortShares > 0 && forecast > 0.5 + cfg.exitHysteresis && cfg.canShort) {
        const before = market.getStockState(sym).otlkMag;
        const fill = market.sellShort(sym, shortShares);
        if (fill > 0) {
          const after = market.getStockState(sym).otlkMag;
          tracker.recordErosion(before, after);
          tracker.recordTradeCost(fill, price, shortShares, COMMISSION);
          tracker.recordExit("signal");
        }
      }
    }

    // --- Budget: same holder-bucket model as the daemon harness, computed fresh
    // each tick from post-exit state. portfolioValue: mark-to-mid longs, cost-basis
    // shorts (same definition used throughout, for apples-to-apples comparison).
    let portfolioValue = 0;
    for (const sym of symbols) {
      const [longShares, , shortShares, shortAvg] = market.getPosition(sym);
      if (longShares > 0) portfolioValue += longShares * market.getPrice(sym);
      if (shortShares > 0) portfolioValue += shortShares * shortAvg;
    }
    const netWorthNow = market.netWorth();
    const tradingCapital = computeTradingCapital(cfg.capital, netWorthNow, portfolioValue, market.getCash());

    // --- 2. Rank entry candidates by |expected return| ---
    const candidates: Candidate[] = [];
    for (const sym of symbols) {
      const forecast = market.getForecast(sym);
      const volatility = market.getVolatility(sym);
      const dev = forecast - 0.5;
      const absDev = Math.abs(dev);
      if (dev < 0 && !cfg.canShort) continue;
      if (!cfg.spreadAware && absDev < cfg.entryThreshold) continue;
      const expectedReturn = volatility * dev;
      candidates.push({ sym, dir: dev > 0 ? "long" : "short", expectedReturn, forecast, volatility });
    }
    candidates.sort((a, b) => Math.abs(b.expectedReturn) - Math.abs(a.expectedReturn));

    // `pool` is this tick's remaining allowance, decremented as candidates are filled -
    // tradingCapital itself stays fixed (used as the fixed per-position cap for
    // diversifiedN) so a bucket-mode run deploys AT MOST its allowance per tick instead
    // of re-applying the full allowance to every candidate in turn.
    let pool = tradingCapital;

    for (const cand of candidates) {
      const [longShares, , shortShares] = market.getPosition(cand.sym);
      const alreadyHeld = cand.dir === "long" ? longShares : shortShares;
      const maxShares = market.getMaxShares(cand.sym);
      const roomShares = maxShares - alreadyHeld;
      if (roomShares <= 0) continue;

      const price = market.getPrice(cand.sym); // mid - used for ranking/diversification/spread math
      // Actual per-share charge: getBuyTransactionCost uses ASK for a long, BID for a
      // short (opening a short is charged at bid, per helpers.ts/BuyingAndSelling.tsx) -
      // sizing off mid would systematically overspend and starve later candidates.
      const entryUnitPrice = cand.dir === "long" ? market.getAskPrice(cand.sym) : market.getBidPrice(cand.sym);
      const cash = market.getCash();
      let availCash = Math.min(cash, pool);

      if (cfg.diversifiedN && cfg.diversifiedN > 0) {
        const positionCap = tradingCapital / cfg.diversifiedN;
        const existingValue = alreadyHeld * price;
        const room = Math.max(0, positionCap - existingValue);
        availCash = Math.min(availCash, room);
      }

      if (availCash <= COMMISSION || price <= 0) continue;
      let shares = Math.min(Math.floor((availCash - COMMISSION) / entryUnitPrice), roomShares);
      if (shares <= 0) continue;

      if (cfg.spreadAware) {
        const spreadPerc = market.getStockState(cand.sym).spreadPerc;
        const expectedReturnPerTick = Math.abs(cand.expectedReturn);
        const requiredReturn = (2 * spreadPerc) / 100 + (2 * COMMISSION) / (shares * price);
        if (expectedReturnPerTick * cfg.spreadAware.H < requiredReturn) continue;
      }

      if (cand.dir === "long") {
        const before = market.getStockState(cand.sym).otlkMag;
        const fill = market.buyStock(cand.sym, shares);
        if (fill > 0) {
          const after = market.getStockState(cand.sym).otlkMag;
          tracker.recordErosion(before, after);
          tracker.recordTradeCost(fill, price, shares, COMMISSION);
          tracker.recordBuyCapacity(shares, maxShares);
          pool -= shares * fill + COMMISSION;
        }
      } else {
        const before = market.getStockState(cand.sym).otlkMag;
        const fill = market.buyShort(cand.sym, shares);
        if (fill > 0) {
          const after = market.getStockState(cand.sym).otlkMag;
          tracker.recordErosion(before, after);
          tracker.recordTradeCost(fill, price, shares, COMMISSION);
          tracker.recordBuyCapacity(shares, maxShares);
          pool -= shares * fill + COMMISSION;
        }
      }
    }

    let openPositions = 0;
    for (const sym of symbols) {
      const [l, , s] = market.getPosition(sym);
      if (l > 0 || s > 0) openPositions++;
    }
    tracker.sampleTick(market.netWorth(), market.getCash(), openPositions);
  }

  return tracker.finish(market.netWorth());
}
