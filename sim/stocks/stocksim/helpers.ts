/**
 * Port of src/StockMarket/StockMarketHelpers.ts (the pure-calculation half; the
 * order-book-aware calculateBuyMaxAmount is omitted along with limit orders - see
 * README.md "Omitted").
 */
import type { Stock } from "./stock.ts";
import { PositionType, StockMarketConstants, forecastChangePerPriceMovement } from "./metadata.ts";

export { forecastChangePerPriceMovement };

/**
 * Port of getBuyTransactionCost. Calculate the total cost of a "buy" transaction.
 * Accounts for spread and commission. Returns null for an invalid transaction.
 */
export function getBuyTransactionCost(stock: Stock, shares: number, posType: PositionType): number | null {
  if (isNaN(shares) || shares <= 0) {
    return null;
  }

  // Cap the 'shares' arg at the stock's maximum shares. This'll prevent
  // hanging in the case when a really big number is passed in
  shares = Math.min(shares, stock.maxShares);

  const isLong = posType === PositionType.Long;

  if (isLong) {
    return shares * stock.getAskPrice() + StockMarketConstants.StockMarketCommission;
  } else {
    return shares * stock.getBidPrice() + StockMarketConstants.StockMarketCommission;
  }
}

/**
 * Port of getSellTransactionGain. Calculate the TOTAL amount of money gained from a
 * sale (NOT net profit). Accounts for spread and commission. Returns null for an
 * invalid transaction.
 */
export function getSellTransactionGain(stock: Stock, shares: number, posType: PositionType): number | null {
  if (isNaN(shares) || shares <= 0) {
    return null;
  }

  shares = Math.min(shares, stock.maxShares);

  const isLong = posType === PositionType.Long;
  if (isLong) {
    return shares * stock.getBidPrice() - StockMarketConstants.StockMarketCommission;
  } else {
    // Calculating gains for a short position requires calculating the profit made
    const origCost = shares * stock.playerAvgShortPx;
    const profit = (stock.playerAvgShortPx - stock.getAskPrice()) * shares - StockMarketConstants.StockMarketCommission;

    return origCost + profit;
  }
}

/**
 * Port of processTransactionForecastMovement. Processes a stock's change in
 * forecast & second-order forecast whenever it is transacted (buy/sell/short/cover).
 */
export function processTransactionForecastMovement(stock: Stock, shares: number): void {
  if (isNaN(shares) || shares <= 0) {
    return;
  }

  shares = Math.min(shares, stock.maxShares);

  // If there's only going to be one iteration at most
  const firstShares = stock.shareTxUntilMovement;
  if (shares <= firstShares) {
    stock.shareTxUntilMovement -= shares;
    if (stock.shareTxUntilMovement <= 0) {
      stock.shareTxUntilMovement = stock.shareTxForMovement;
      stock.influenceForecast(forecastChangePerPriceMovement);
      stock.influenceForecastForecast(forecastChangePerPriceMovement * (stock.mv / 100));
    }

    return;
  }

  // Calculate how many iterations of price changes we need to account for
  const remainingShares = shares - firstShares;
  let numIterations = 1 + Math.ceil(remainingShares / stock.shareTxForMovement);

  // If on the off chance we end up perfectly at the next price movement
  stock.shareTxUntilMovement =
    stock.shareTxForMovement - ((shares - stock.shareTxUntilMovement) % stock.shareTxForMovement);
  if (stock.shareTxUntilMovement === stock.shareTxForMovement || stock.shareTxUntilMovement <= 0) {
    ++numIterations;
    stock.shareTxUntilMovement = stock.shareTxForMovement;
  }

  // Forecast always decreases in magnitude
  const forecastChange = forecastChangePerPriceMovement * (numIterations - 1);
  const forecastForecastChange = forecastChange * (stock.mv / 100);
  stock.influenceForecast(forecastChange);
  stock.influenceForecastForecast(forecastForecastChange);
}
