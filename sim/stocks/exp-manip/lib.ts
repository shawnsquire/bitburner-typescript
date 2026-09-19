/**
 * Shared helpers for the stock-manipulation experiments. Imports the read-only
 * simulator from ../stocksim/ directly - never modifies it.
 */
import { Market } from "../stocksim/market.ts";
import type { MarketOptions } from "../stocksim/market.ts";
import { InitStockMetadata } from "../stocksim/metadata.ts";
import type { IConstructorParams } from "../stocksim/metadata.ts";

export type Direction = "short" | "long"; // short = bearish pressure (hack), long = bullish pressure (grow)

export const K_GRID = [0, 0.5, 1, 2, 5, 10, 20];
export const N_SEEDS = 200;
export const STOCKS = ["ECP", "FLCM", "JGN"] as const;

/** Find one stock's canonical metadata entry by symbol, for building single-stock markets. */
export function metadataFor(symbol: string): IConstructorParams {
  const m = InitStockMetadata.find((s) => s.symbol === symbol);
  if (!m) throw new Error(`No metadata for symbol ${symbol}`);
  return m;
}

/** Build a single-stock market so the target stock's RNG stream is isolated and runs are fast. */
export function makeSingleStockMarket(seed: number, symbol: string, cash = 0): Market {
  const opts: MarketOptions = { cash, stocks: [metadataFor(symbol)] };
  return new Market(seed, opts);
}

/**
 * Apply a fractional rate of "guaranteed successful" influence events for one tick.
 * Maintains a fractional accumulator across calls (mutated in place via return value)
 * so that e.g. k=0.5 produces exactly one event every other tick, deterministically,
 * rather than adding extra RNG noise on top of the market's own randomness.
 *
 * Each event calls influenceHack/influenceGrow with fraction=1.0, which still consumes
 * one RNG draw (matching the real influenceStockThroughServerHack/Grow, which always
 * calls Math.random() before comparing against the fraction) but is guaranteed to
 * succeed (rng() < 1.0 is always true), i.e. it represents one real hack/grow
 * completion that stole/added 100% of the server's moneyMax.
 */
export function applyRatePerTick(market: Market, symbol: string, dir: Direction, k: number, acc: number): number {
  acc += k;
  while (acc >= 1) {
    if (dir === "short") market.influenceHack(symbol, 1.0);
    else market.influenceGrow(symbol, 1.0);
    acc -= 1;
  }
  return acc;
}

/** True if the visible forecast is on the "desired" side for this direction. */
export function onDesiredSide(forecast: number, dir: Direction): boolean {
  return dir === "short" ? forecast < 0.5 : forecast > 0.5;
}

// ---- Simple stats (no deps) ----

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (s[base + 1] !== undefined) return s[base] + rest * (s[base + 1] - s[base]);
  return s[base];
}

export interface Summary {
  n: number;
  median: number;
  q25: number;
  q75: number;
  min: number;
  max: number;
  mean: number;
}

export function summarize(xs: number[]): Summary {
  if (xs.length === 0) return { n: 0, median: NaN, q25: NaN, q75: NaN, min: NaN, max: NaN, mean: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    n: xs.length,
    median: median(xs),
    q25: quantile(xs, 0.25),
    q75: quantile(xs, 0.75),
    min: Math.min(...xs),
    max: Math.max(...xs),
    mean,
  };
}

/** Seeds 1..n (avoid 0, which mulberry32 handles fine, but keep seeds positive/simple). */
export function seeds(n: number, offset = 1): number[] {
  return Array.from({ length: n }, (_, i) => i + offset);
}
