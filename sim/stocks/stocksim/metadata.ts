/**
 * Stock metadata, ported from:
 *   src/StockMarket/data/InitStockMetadata.ts (all 33 entries)
 *   src/StockMarket/Stock.ts                  (IConstructorParams, IMinMaxRange semantics)
 *   src/StockMarket/Enums.ts                  (StockSymbol map, PositionType, OrderType)
 *   src/StockMarket/data/Constants.ts         (StockMarketConstants)
 *   src/Locations/Enums.ts                    (LocationName -> organization-name strings,
 *                                               e.g. LocationName.AevumECorp = "ECorp";
 *                                               these strings are the `name` field below
 *                                               and are what a Server's `organizationName`
 *                                               would match for influenceHack/influenceGrow)
 *
 * "Do not use enums" (erasable TypeScript syntax) - PositionType/OrderType are ported as
 * `as const` objects + derived types instead of `enum`.
 */

/** Port of src/StockMarket/Enums.ts PositionType (was `enum PositionType`). */
export const PositionType = { Long: "L", Short: "S" } as const;
export type PositionType = (typeof PositionType)[keyof typeof PositionType];

/**
 * Port of src/types.ts `IMinMaxRange`. A numeric field on a stock's init metadata is
 * either a plain number or a range to roll at construction time (see Stock.ts
 * `toNumber`). `divisor` is optional; when present the rolled integer is divided by
 * it (e.g. mv: {min:40,max:50,divisor:100} -> a value in [0.40, 0.50]).
 */
export interface IMinMaxRange {
  min: number;
  max: number;
  divisor?: number;
}

/** Port of src/StockMarket/Stock.ts IConstructorParams. */
export interface IConstructorParams {
  b: boolean;
  initPrice: number | IMinMaxRange;
  marketCap: number;
  mv: number | IMinMaxRange;
  name: string;
  otlkMag: number;
  spreadPerc: number | IMinMaxRange;
  shareTxForMovement: number | IMinMaxRange;
  symbol: string;
}

/**
 * Port of src/StockMarket/data/InitStockMetadata.ts, in the SAME array order as the
 * source file. This order matters: `initStockMarket()` inserts stocks into the
 * `StockMarket` object in this order, and `Object.keys(StockMarket)` (used by both
 * `stockMarketCycle()` and the price-update loop in `processStockPrices()`) iterates
 * in that insertion order. Our `Market` class iterates its internal stock list in this
 * same order for the same reason - see market.ts.
 *
 * NOTE: this order is NOT the same as the `StockSymbol` enum-object's declaration
 * order (see SYMBOLS_IN_ENUM_ORDER below) - in the real source, FoodNStuff/JoesGuns
 * are adjacent in StockSymbol but Sigma Cosmetics is spliced between them in
 * InitStockMetadata. `ns.stock.getSymbols()` returns `Object.values(StockSymbol)`,
 * i.e. the enum order, which is why `Market#symbols()` uses SYMBOLS_IN_ENUM_ORDER
 * rather than metadata order.
 */
export const InitStockMetadata: IConstructorParams[] = [
  {
    b: true,
    initPrice: { min: 17e3, max: 28e3 },
    marketCap: 2.4e12,
    mv: { min: 40, max: 50, divisor: 100 },
    name: "ECorp",
    otlkMag: 19,
    spreadPerc: { min: 1, max: 5, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "ECP",
  },
  {
    b: true,
    initPrice: { min: 24e3, max: 34e3 },
    marketCap: 2.4e12,
    mv: { min: 40, max: 50, divisor: 100 },
    name: "MegaCorp",
    otlkMag: 19,
    spreadPerc: { min: 1, max: 5, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "MGCP",
  },
  {
    b: true,
    initPrice: { min: 10e3, max: 25e3 },
    marketCap: 1.6e12,
    mv: { min: 70, max: 80, divisor: 100 },
    name: "Blade Industries",
    otlkMag: 13,
    spreadPerc: { min: 1, max: 6, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "BLD",
  },
  {
    b: true,
    initPrice: { min: 10e3, max: 25e3 },
    marketCap: 1.5e12,
    mv: { min: 65, max: 75, divisor: 100 },
    name: "Clarke Incorporated",
    otlkMag: 12,
    spreadPerc: { min: 1, max: 5, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "CLRK",
  },
  {
    b: true,
    initPrice: { min: 32e3, max: 43e3 },
    marketCap: 1.8e12,
    mv: { min: 60, max: 70, divisor: 100 },
    name: "OmniTek Incorporated",
    otlkMag: 12,
    spreadPerc: { min: 1, max: 6, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "OMTK",
  },
  {
    b: true,
    initPrice: { min: 50e3, max: 80e3 },
    marketCap: 2e12,
    mv: { min: 100, max: 110, divisor: 100 },
    name: "Four Sigma",
    otlkMag: 17,
    spreadPerc: { min: 1, max: 10, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "FSIG",
  },
  {
    b: true,
    initPrice: { min: 16e3, max: 28e3 },
    marketCap: 1.9e12,
    mv: { min: 75, max: 85, divisor: 100 },
    name: "KuaiGong International",
    otlkMag: 10,
    spreadPerc: { min: 1, max: 7, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "KGI",
  },
  {
    b: true,
    initPrice: { min: 29e3, max: 36e3 },
    marketCap: 2e12,
    mv: { min: 120, max: 130, divisor: 100 },
    name: "Fulcrum Technologies",
    otlkMag: 16,
    spreadPerc: { min: 1, max: 10, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "FLCM",
  },
  {
    b: true,
    initPrice: { min: 20e3, max: 25e3 },
    marketCap: 1.2e12,
    mv: { min: 80, max: 90, divisor: 100 },
    name: "Storm Technologies",
    otlkMag: 7,
    spreadPerc: { min: 2, max: 10, divisor: 10 },
    shareTxForMovement: { min: 36e3, max: 108e3 },
    symbol: "STM",
  },
  {
    b: true,
    initPrice: { min: 6e3, max: 19e3 },
    marketCap: 900e9,
    mv: { min: 60, max: 70, divisor: 100 },
    name: "DefComm",
    otlkMag: 10,
    spreadPerc: { min: 2, max: 10, divisor: 10 },
    shareTxForMovement: { min: 36e3, max: 108e3 },
    symbol: "DCOMM",
  },
  {
    b: true,
    initPrice: { min: 10e3, max: 18e3 },
    marketCap: 825e9,
    mv: { min: 55, max: 65, divisor: 100 },
    name: "Helios Labs",
    otlkMag: 9,
    spreadPerc: { min: 2, max: 10, divisor: 10 },
    shareTxForMovement: { min: 36e3, max: 108e3 },
    symbol: "HLS",
  },
  {
    b: true,
    initPrice: { min: 8e3, max: 14e3 },
    marketCap: 1e12,
    mv: { min: 70, max: 80, divisor: 100 },
    name: "VitaLife",
    otlkMag: 7,
    spreadPerc: { min: 2, max: 10, divisor: 10 },
    shareTxForMovement: { min: 36e3, max: 108e3 },
    symbol: "VITA",
  },
  {
    b: true,
    initPrice: { min: 12e3, max: 24e3 },
    marketCap: 800e9,
    mv: { min: 60, max: 70, divisor: 100 },
    name: "Icarus Microsystems",
    otlkMag: 7.5,
    spreadPerc: { min: 3, max: 10, divisor: 10 },
    shareTxForMovement: { min: 36e3, max: 108e3 },
    symbol: "ICRS",
  },
  {
    b: true,
    initPrice: { min: 16e3, max: 29e3 },
    marketCap: 900e9,
    mv: { min: 50, max: 60, divisor: 100 },
    name: "Universal Energy",
    otlkMag: 10,
    spreadPerc: { min: 2, max: 10, divisor: 10 },
    shareTxForMovement: { min: 36e3, max: 108e3 },
    symbol: "UNV",
  },
  {
    b: true,
    initPrice: { min: 8e3, max: 17e3 },
    marketCap: 640e9,
    mv: { min: 55, max: 65, divisor: 100 },
    name: "AeroCorp",
    otlkMag: 6,
    spreadPerc: { min: 3, max: 10, divisor: 10 },
    shareTxForMovement: { min: 42e3, max: 126e3 },
    symbol: "AERO",
  },
  {
    b: true,
    initPrice: { min: 6e3, max: 15e3 },
    marketCap: 600e9,
    mv: { min: 65, max: 75, divisor: 100 },
    name: "Omnia Cybersystems",
    otlkMag: 4.5,
    spreadPerc: { min: 4, max: 11, divisor: 10 },
    shareTxForMovement: { min: 42e3, max: 126e3 },
    symbol: "OMN",
  },
  {
    b: true,
    initPrice: { min: 14e3, max: 28e3 },
    marketCap: 705e9,
    mv: { min: 70, max: 80, divisor: 100 },
    name: "Solaris Space Systems",
    otlkMag: 8.5,
    spreadPerc: { min: 4, max: 12, divisor: 10 },
    shareTxForMovement: { min: 42e3, max: 126e3 },
    symbol: "SLRS",
  },
  {
    b: true,
    initPrice: { min: 12e3, max: 30e3 },
    marketCap: 695e9,
    mv: { min: 55, max: 65, divisor: 100 },
    name: "Global Pharmaceuticals",
    otlkMag: 10.5,
    spreadPerc: { min: 4, max: 10, divisor: 10 },
    shareTxForMovement: { min: 42e3, max: 126e3 },
    symbol: "GPH",
  },
  {
    b: true,
    initPrice: { min: 15e3, max: 27e3 },
    marketCap: 600e9,
    mv: { min: 70, max: 80, divisor: 100 },
    name: "Nova Medical",
    otlkMag: 5,
    spreadPerc: { min: 4, max: 11, divisor: 10 },
    shareTxForMovement: { min: 42e3, max: 126e3 },
    symbol: "NVMD",
  },
  {
    b: true,
    initPrice: { min: 4e3, max: 8.5e3 },
    marketCap: 450e9,
    mv: { min: 240, max: 260, divisor: 100 },
    name: "Watchdog Security",
    otlkMag: 1.5,
    spreadPerc: { min: 5, max: 12, divisor: 10 },
    shareTxForMovement: { min: 12e3, max: 54e3 },
    symbol: "WDS",
  },
  {
    b: true,
    initPrice: { min: 4.5e3, max: 8e3 },
    marketCap: 300e9,
    mv: { min: 115, max: 135, divisor: 100 },
    name: "LexoCorp",
    otlkMag: 6,
    spreadPerc: { min: 5, max: 12, divisor: 10 },
    shareTxForMovement: { min: 36e3, max: 108e3 },
    symbol: "LXO",
  },
  {
    b: true,
    initPrice: { min: 2e3, max: 7e3 },
    marketCap: 180e9,
    mv: { min: 50, max: 70, divisor: 100 },
    name: "Rho Construction",
    otlkMag: 1,
    spreadPerc: { min: 3, max: 10, divisor: 10 },
    shareTxForMovement: { min: 60e3, max: 126e3 },
    symbol: "RHOC",
  },
  {
    b: true,
    initPrice: { min: 4e3, max: 8.5e3 },
    marketCap: 240e9,
    mv: { min: 175, max: 205, divisor: 100 },
    name: "Alpha Enterprises",
    otlkMag: 10,
    spreadPerc: { min: 5, max: 16, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "APHE",
  },
  {
    b: true,
    initPrice: { min: 3e3, max: 8e3 },
    marketCap: 200e9,
    mv: { min: 150, max: 170, divisor: 100 },
    name: "SysCore Securities",
    otlkMag: 3,
    spreadPerc: { min: 5, max: 12, divisor: 10 },
    shareTxForMovement: { min: 15e3, max: 90e3 },
    symbol: "SYSC",
  },
  {
    b: true,
    initPrice: { min: 1e3, max: 6e3 },
    marketCap: 185e9,
    mv: { min: 80, max: 100, divisor: 100 },
    name: "CompuTek",
    otlkMag: 4,
    spreadPerc: { min: 4, max: 12, divisor: 10 },
    shareTxForMovement: { min: 60e3, max: 126e3 },
    symbol: "CTK",
  },
  {
    b: true,
    initPrice: { min: 1e3, max: 5e3 },
    marketCap: 58e9,
    mv: { min: 200, max: 400, divisor: 100 },
    name: "NetLink Technologies",
    otlkMag: 1,
    spreadPerc: { min: 5, max: 20, divisor: 10 },
    shareTxForMovement: { min: 18e3, max: 54e3 },
    symbol: "NTLK",
  },
  {
    b: true,
    initPrice: { min: 1e3, max: 8e3 },
    marketCap: 60e9,
    mv: { min: 90, max: 110, divisor: 100 },
    name: "Omega Software",
    otlkMag: 0.5,
    spreadPerc: { min: 4, max: 13, divisor: 10 },
    shareTxForMovement: { min: 30e3, max: 90e3 },
    symbol: "OMGA",
  },
  {
    b: false,
    initPrice: { min: 500, max: 4.5e3 },
    marketCap: 45e9,
    mv: { min: 70, max: 80, divisor: 100 },
    name: "FoodNStuff",
    otlkMag: 1,
    spreadPerc: { min: 6, max: 10, divisor: 10 },
    shareTxForMovement: { min: 60e3, max: 180e3 },
    symbol: "FNS",
  },
  {
    b: true,
    initPrice: { min: 1.5e3, max: 3.5e3 },
    marketCap: 30e9,
    mv: { min: 100, max: 275, divisor: 100 },
    name: "Sigma Cosmetics",
    otlkMag: 0,
    spreadPerc: { min: 6, max: 14, divisor: 10 },
    shareTxForMovement: { min: 20e3, max: 70e3 },
    symbol: "SGC",
  },
  {
    b: true,
    initPrice: { min: 250, max: 1.5e3 },
    marketCap: 42e9,
    mv: { min: 200, max: 350, divisor: 100 },
    name: "Joe's Guns",
    otlkMag: 1,
    spreadPerc: { min: 6, max: 14, divisor: 10 },
    shareTxForMovement: { min: 15e3, max: 52e3 },
    symbol: "JGN",
  },
  {
    b: true,
    initPrice: { min: 250, max: 1.5e3 },
    marketCap: 100e9,
    mv: { min: 120, max: 175, divisor: 100 },
    name: "Catalyst Ventures",
    otlkMag: 13.5,
    spreadPerc: { min: 5, max: 14, divisor: 10 },
    shareTxForMovement: { min: 24e3, max: 72e3 },
    symbol: "CTYS",
  },
  {
    b: true,
    initPrice: { min: 15e3, max: 30e3 },
    marketCap: 360e9,
    mv: { min: 70, max: 80, divisor: 100 },
    name: "Microdyne Technologies",
    otlkMag: 8,
    spreadPerc: { min: 3, max: 10, divisor: 10 },
    shareTxForMovement: { min: 90e3, max: 216e3 },
    symbol: "MDYN",
  },
  {
    b: true,
    initPrice: { min: 12e3, max: 24e3 },
    marketCap: 420e9,
    mv: { min: 50, max: 70, divisor: 100 },
    name: "Titan Laboratories",
    otlkMag: 11,
    spreadPerc: { min: 2, max: 10, divisor: 10 },
    shareTxForMovement: { min: 90e3, max: 216e3 },
    symbol: "TITN",
  },
];

/**
 * Port of src/StockMarket/Enums.ts StockSymbol map, VALUES ONLY, in declaration order.
 * This is the order `ns.stock.getSymbols()` returns (`Object.values(StockSymbol)` in
 * src/NetscriptFunctions/StockMarket.ts `getSymbols`). See the big comment on
 * InitStockMetadata above for why this differs from metadata/tick-iteration order
 * (FoodNStuff/JoesGuns are adjacent here; Sigma Cosmetics is NOT between them).
 */
export const SYMBOLS_IN_ENUM_ORDER: string[] = [
  "ECP",
  "MGCP",
  "BLD",
  "CLRK",
  "OMTK",
  "FSIG",
  "KGI",
  "FLCM",
  "STM",
  "DCOMM",
  "HLS",
  "VITA",
  "ICRS",
  "UNV",
  "AERO",
  "OMN",
  "SLRS",
  "GPH",
  "NVMD",
  "WDS",
  "LXO",
  "RHOC",
  "APHE",
  "SYSC",
  "CTK",
  "NTLK",
  "OMGA",
  "FNS",
  "JGN",
  "SGC",
  "CTYS",
  "MDYN",
  "TITN",
];

/** Port of src/StockMarket/data/Constants.ts StockMarketConstants (subset the sim uses). */
export const StockMarketConstants = {
  msPerStockUpdate: 6e3,
  TicksPerCycle: 75,
  StockMarketCommission: 100e3,
} as const;

/** Port of src/StockMarket/Stock.ts `StockForecastInfluenceLimit`. */
export const StockForecastInfluenceLimit = 5;

/** Port of src/StockMarket/StockMarketHelpers.ts `forecastChangePerPriceMovement`. */
export const forecastChangePerPriceMovement = 0.006;

/**
 * Port of src/StockMarket/PlayerInfluencing.ts `forecastForecastChangeFromHack`.
 * (The same constant is reused, unchanged, for the grow() case in the source.)
 */
export const forecastForecastChangeFromHack = 0.1;
