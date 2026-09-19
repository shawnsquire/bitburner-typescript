/**
 * Port of src/StockMarket/Stock.ts.
 *
 * Every Math.random() call in the original becomes a call to an injected `Rng`
 * (see rng.ts) so a Market built from one seed is fully reproducible. All field
 * names, method names, and the order of operations match the source exactly so
 * behaviour (including surprising corners) is preserved; deviations are called
 * out in comments where they occur.
 */
import type { Rng } from "./rng.ts";
import { getRandomIntInclusive } from "./rng.ts";
import type { IConstructorParams, IMinMaxRange } from "./metadata.ts";
import { StockForecastInfluenceLimit } from "./metadata.ts";

export { StockForecastInfluenceLimit };

/**
 * Port of Stock.ts `toNumber`. Converts a plain number straight through; converts an
 * IMinMaxRange by rolling a uniform integer in [min, max] (via getRandomIntInclusive,
 * which THROWS if min/max are not integers - this matches the source, and is why every
 * range in metadata.ts uses integer bounds) and then dividing by `divisor` if present.
 */
function toNumber(rng: Rng, n: number | IMinMaxRange): number {
  let value: number;
  if (typeof n === "number") {
    return n;
  } else if (typeof n === "object" && n !== null) {
    value = getRandomIntInclusive(rng, n.min, n.max);
  } else {
    throw new Error(`Do not know how to convert the type '${typeof n}' to a number`);
  }

  if (typeof n === "object" && typeof n.divisor === "number") {
    return value / n.divisor;
  }
  return value;
}

/**
 * Port of src/StockMarket/Stock.ts `class Stock`.
 *
 * Field doc-comments are copied from the source; see that file for the authoritative
 * wording. `toJSON`/`fromJSON`/save-reviver machinery is intentionally omitted - this
 * simulator has no save system.
 */
export class Stock {
  /** Bear or bull (more likely to go up or down, based on otlkMag) */
  b: boolean;

  /** Maximum price of a stock (per share) */
  readonly cap: number;

  /** Stocks previous share price */
  lastPrice: number;

  /** Maximum number of shares that player can own (both long and short combined) */
  readonly maxShares: number;

  /** Maximum volatility */
  readonly mv: number;

  /** Name of the company that the stock is for */
  readonly name: string;

  /**
   * Outlook magnitude. Represents the stock's forecast and likelihood
   * of increasing/decreasing (based on whether its in bear or bull mode)
   */
  otlkMag: number;

  /**
   * Forecast of outlook magnitude. Essentially a second-order forecast.
   * Unlike 'otlkMag', this number is on an absolute scale from 0-100 (rather than 0-50)
   */
  otlkMagForecast: number;

  /** Average price of stocks that the player owns in the LONG position */
  playerAvgPx: number;

  /** Average price of stocks that the player owns in the SHORT position */
  playerAvgShortPx: number;

  /** Number of shares the player owns in the LONG position */
  playerShares: number;

  /** Number of shares the player owns in the SHORT position */
  playerShortShares: number;

  /** Stock's share price */
  price: number;

  /** How many shares need to be transacted in order to trigger a price movement */
  readonly shareTxForMovement: number;

  /**
   * How many share transactions remaining until a price movement occurs
   * (separately tracked for upward and downward movements)
   */
  shareTxUntilMovement: number;

  /**
   * Spread percentage. The bid/ask prices for this stock are N% above or below
   * the "real price" to emulate spread.
   */
  readonly spreadPerc: number;

  /** The stock's ticker symbol */
  readonly symbol: string;

  /**
   * Total number of shares of this stock
   * This is different than maxShares, as this is like authorized stock while
   * maxShares is outstanding stock.
   */
  readonly totalShares: number;

  /**
   * The rng used for every random draw this stock's methods make (cycleForecast,
   * cycleForecastForecast). Not part of the source class - the source calls the
   * global Math.random() directly - but needed here to keep everything reproducible.
   */
  private readonly rng: Rng;

  constructor(rng: Rng, p: IConstructorParams) {
    this.rng = rng;
    this.name = p.name;
    this.symbol = p.symbol;
    this.price = toNumber(rng, p.initPrice);
    this.lastPrice = this.price;
    this.playerShares = 0;
    this.playerAvgPx = 0;
    this.playerShortShares = 0;
    this.playerAvgShortPx = 0;
    this.mv = toNumber(rng, p.mv);
    this.b = p.b;
    this.otlkMag = p.otlkMag;
    this.otlkMagForecast = this.getAbsoluteForecast();
    this.cap = getRandomIntInclusive(rng, this.price * 1e3, this.price * 25e3);
    this.spreadPerc = toNumber(rng, p.spreadPerc);
    this.shareTxForMovement = toNumber(rng, p.shareTxForMovement);
    this.shareTxUntilMovement = this.shareTxForMovement;

    // Total shares is determined by market cap, and is rounded to nearest 100k
    const totalSharesUnrounded: number = p.marketCap / this.price;
    this.totalShares = Math.round(totalSharesUnrounded / 1e5) * 1e5;

    // Max Shares (Outstanding shares) is a percentage of total shares
    const outstandingSharePercentage = 0.2;
    this.maxShares = Math.round((this.totalShares * outstandingSharePercentage) / 1e5) * 1e5;
  }

  /** Safely set the stock's second-order forecast to a new value */
  changeForecastForecast(newff: number): void {
    this.otlkMagForecast = newff;
    if (this.otlkMagForecast > 100) {
      this.otlkMagForecast = 100;
    } else if (this.otlkMagForecast < 0) {
      this.otlkMagForecast = 0;
    }
  }

  /** Set the stock to a new price. Also updates the stock's previous price tracker */
  changePrice(newPrice: number): void {
    this.lastPrice = this.price;
    this.price = newPrice;
  }

  /**
   * Change the stock's forecast during a stock market 'tick'.
   * The way a stock's forecast changes depends on various internal properties,
   * but is ultimately determined by RNG
   */
  cycleForecast(changeAmt = 0.1): void {
    const increaseChance = this.getForecastIncreaseChance();

    if (this.rng() < increaseChance) {
      // Forecast increases
      if (this.b) {
        this.otlkMag += changeAmt;
      } else {
        this.otlkMag -= changeAmt;
      }
    } else if (this.b) {
      // Forecast decreases
      this.otlkMag -= changeAmt;
    } else {
      this.otlkMag += changeAmt;
    }

    this.otlkMag = Math.min(this.otlkMag, 50);
    if (this.otlkMag < 0) {
      this.otlkMag *= -1;
      this.b = !this.b;
    }
  }

  /**
   * Change's the stock's second-order forecast during a stock market 'tick'.
   * The change for the second-order forecast to increase is 50/50
   */
  cycleForecastForecast(changeAmt = 0.1): void {
    if (this.rng() < 0.5) {
      this.changeForecastForecast(this.otlkMagForecast + changeAmt);
    } else {
      this.changeForecastForecast(this.otlkMagForecast - changeAmt);
    }
  }

  /**
   * "Flip" the stock's second-order forecast. This can occur during a
   * stock market "cycle" (determined by RNG). It is used to simulate
   * RL stock market cycles and introduce volatility
   */
  flipForecastForecast(): void {
    this.otlkMagForecast = 100 - this.otlkMagForecast;
  }

  /** Returns the stock's absolute forecast, which is a number between 0-100 */
  getAbsoluteForecast(): number {
    return this.b ? 50 + this.otlkMag : 50 - this.otlkMag;
  }

  /** Return the price at which YOUR stock is bought (market ask price). Accounts for spread */
  getAskPrice(): number {
    return this.price * (1 + this.spreadPerc / 100);
  }

  /** Return the price at which YOUR stock is sold (market bid price). Accounts for spread */
  getBidPrice(): number {
    return this.price * (1 - this.spreadPerc / 100);
  }

  /** Returns the chance (0-1 decimal) that a stock has of having its forecast increase */
  getForecastIncreaseChance(): number {
    const diff = this.otlkMagForecast - this.getAbsoluteForecast();

    return (50 + Math.min(Math.max(diff, -45), 45)) / 100;
  }

  /**
   * Changes a stock's forecast. This is used when the stock is influenced
   * by a transaction. The stock's forecast always goes towards 50, but the
   * movement is capped by a certain threshold/limit
   */
  influenceForecast(change: number): void {
    if (this.otlkMag > StockForecastInfluenceLimit) {
      this.otlkMag = Math.max(StockForecastInfluenceLimit, this.otlkMag - change);
    }
  }

  /**
   * Changes a stock's second-order forecast. This is used when the stock is
   * influenced by a transaction. The stock's second-order forecast always
   * goes towards 50.
   */
  influenceForecastForecast(change: number): void {
    if (this.otlkMagForecast > 50) {
      this.otlkMagForecast -= change;
      this.otlkMagForecast = Math.max(50, this.otlkMagForecast);
    } else if (this.otlkMagForecast < 50) {
      this.otlkMagForecast += change;
      this.otlkMagForecast = Math.min(50, this.otlkMagForecast);
    }
  }
}
