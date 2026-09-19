/**
 * Experiment 3: value of manipulation.
 *
 * Buy maxShares of a stock LONG at the start, then compare log-return over 100 ticks
 * with k in {0, 2, 10} of favourable (bullish, via influenceGrow) pressure applied
 * every tick. netWorth() = cash + liquidation value of the position (see stocksim
 * README), so log-return = ln(netWorth(t=100) / netWorth(t=0 after buying)).
 */
import { makeSingleStockMarket, applyRatePerTick, summarize, seeds, N_SEEDS, STOCKS } from "./lib.ts";
import { StockMarketConstants } from "../stocksim/metadata.ts";

const TICKS = 100;
const TEST_KS = [0, 2, 10];

function runOne(seed: number, symbol: string, k: number): { logReturn: number; priceLogReturn: number } {
  // Pass 1 (cash=0): read maxShares/askPrice to size cash exactly, so the portfolio
  // isn't dominated by a huge idle cash pile that would dilute the log-return signal.
  // These reads consume no RNG, and re-constructing with the same seed replays the
  // exact same construction-time RNG draws, so pass 2 starts from identical stock
  // state.
  const probe = makeSingleStockMarket(seed, symbol, 0);
  const maxShares = probe.getMaxShares(symbol);
  const cost = maxShares * probe.getAskPrice(symbol) + StockMarketConstants.StockMarketCommission;

  const market = makeSingleStockMarket(seed, symbol, cost * 1.0001);
  market.buyStock(symbol, maxShares);
  const startNetWorth = market.netWorth();
  const startPrice = market.getPrice(symbol);

  let acc = 0;
  for (let t = 1; t <= TICKS; t++) {
    market.tick();
    acc = applyRatePerTick(market, symbol, "long", k, acc);
  }

  const endNetWorth = market.netWorth();
  const endPrice = market.getPrice(symbol);
  return {
    logReturn: Math.log(endNetWorth / startNetWorth),
    priceLogReturn: Math.log(endPrice / startPrice),
  };
}

function main(): void {
  const out: Record<string, Record<string, unknown>> = {};
  const seedList = seeds(N_SEEDS);

  for (const symbol of STOCKS) {
    out[symbol] = {};
    for (const k of TEST_KS) {
      const logReturns: number[] = [];
      const priceLogReturns: number[] = [];
      for (const seed of seedList) {
        const r = runOne(seed, symbol, k);
        logReturns.push(r.logReturn);
        priceLogReturns.push(r.priceLogReturn);
      }
      out[symbol][String(k)] = {
        k,
        nSeeds: seedList.length,
        netWorthLogReturn: summarize(logReturns),
        priceLogReturn: summarize(priceLogReturns),
      };
      process.stderr.write(
        `exp3 ${symbol} k=${k}: netWorthLogReturnMedian=${summarize(logReturns).median.toFixed(5)} priceLogReturnMedian=${summarize(priceLogReturns).median.toFixed(5)}\n`,
      );
    }
  }

  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
