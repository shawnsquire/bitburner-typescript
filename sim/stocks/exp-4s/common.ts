/**
 * Shared utilities for the 4S stock-strategy Monte Carlo backtests: seed list,
 * capital ("trading budget") model shared by the daemon and canonical harnesses,
 * a per-run metrics accumulator, and median/IQR helpers for aggregating across
 * seeds.
 */

export const HORIZON = 3000; // ticks == 5 game-hours at 6s/tick
export const COMMISSION = 100_000;

/** Fixed seed list so every strategy/config sees the same set of market paths. */
export function seedList(n: number, base = 1_000): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

// === Capital / budget model ===
// Mirrors src/controllers/budget.ts's holder-bucket formula for the "stocks" bucket:
//   allowance = max(0, weight * netWorth - portfolioValue)
// computed fresh each tick (no cross-daemon lag modeled - see results.md caveats).
// "allin" mode models the ablation in the task brief (allowance = cash).
// "unlimited" models the real daemon's fallback when no budget daemon runs at all
// (getBudgetBalance returns Infinity) - included as a documented third mode, not
// one of the two the task asked for, because it behaves very differently from
// "allin" (each buy this tick can draw up to 90% of *remaining* cash, serially).
export type CapitalMode = "bucket" | "allin" | "unlimited";

export interface CapitalParams {
  mode: CapitalMode;
  bucketWeight: number; // default 0.30
}

export function computeTradingCapital(
  capital: CapitalParams,
  netWorth: number,
  portfolioValue: number,
  cash: number,
): number {
  if (capital.mode === "unlimited") return Infinity;
  if (capital.mode === "allin") return cash;
  return Math.max(0, capital.bucketWeight * netWorth - portfolioValue);
}

// === Metrics ===

export interface RunMetrics {
  seed: number;
  startNW: number;
  endNW: number;
  logReturnPer100Ticks: number;
  maxDrawdown: number;
  roundTrips: number;
  costPctOfStart: number;
  idleCashFraction: number; // mean(cash / netWorth) across ticks
  zeroPositionFraction: number; // fraction of ticks with no open position
  exitReasons: Record<string, number>;
  erosion: number; // sum(otlkMag_before - otlkMag_after) over every trade this run made
  capacityUtilization: number | null; // mean(sharesBought / maxShares) over buys
  cappedBuyFraction: number | null; // fraction of buys where sharesBought hit maxShares
  buys: number;
  ticks: number;
}

export class MetricsTracker {
  private peakNW: number;
  private maxDD = 0;
  private totalCost = 0;
  private exitReasons: Record<string, number> = {};
  private roundTrips = 0;
  private erosion = 0;
  private idleCashSum = 0;
  private zeroPosTicks = 0;
  private ticks = 0;
  private capacitySamples: number[] = [];
  private cappedBuys = 0;
  private totalBuys = 0;
  private readonly startNW: number;
  private readonly seed: number;

  constructor(seed: number, startNW: number) {
    this.seed = seed;
    this.startNW = startNW;
    this.peakNW = startNW;
  }

  sampleTick(nw: number, cash: number, openPositions: number): void {
    this.ticks++;
    if (nw > this.peakNW) this.peakNW = nw;
    const dd = this.peakNW > 0 ? (this.peakNW - nw) / this.peakNW : 0;
    if (dd > this.maxDD) this.maxDD = dd;
    this.idleCashSum += nw > 0 ? cash / nw : 1;
    if (openPositions === 0) this.zeroPosTicks++;
  }

  recordTradeCost(fillPrice: number, midPrice: number, shares: number, commission: number): void {
    this.totalCost += Math.abs(fillPrice - midPrice) * shares + commission;
  }

  recordExit(reason: string): void {
    this.roundTrips++;
    this.exitReasons[reason] = (this.exitReasons[reason] ?? 0) + 1;
  }

  recordErosion(before: number, after: number): void {
    this.erosion += before - after;
  }

  recordBuyCapacity(shares: number, maxShares: number): void {
    this.totalBuys++;
    this.capacitySamples.push(maxShares > 0 ? shares / maxShares : 0);
    if (shares >= maxShares) this.cappedBuys++;
  }

  finish(endNW: number): RunMetrics {
    return {
      seed: this.seed,
      startNW: this.startNW,
      endNW,
      logReturnPer100Ticks: (Math.log(endNW / this.startNW) * 100) / this.ticks,
      maxDrawdown: this.maxDD,
      roundTrips: this.roundTrips,
      costPctOfStart: (this.totalCost / this.startNW) * 100,
      idleCashFraction: this.ticks > 0 ? this.idleCashSum / this.ticks : 0,
      zeroPositionFraction: this.ticks > 0 ? this.zeroPosTicks / this.ticks : 0,
      exitReasons: this.exitReasons,
      erosion: this.erosion,
      capacityUtilization: this.capacitySamples.length > 0 ? avg(this.capacitySamples) : null,
      cappedBuyFraction: this.totalBuys > 0 ? this.cappedBuys / this.totalBuys : null,
      buys: this.totalBuys,
      ticks: this.ticks,
    };
  }
}

// === Stats helpers ===

export function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface MedianIQR {
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  min: number;
  max: number;
  n: number;
}

export function medianIQR(xs: number[]): MedianIQR {
  const sorted = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return { median, q1, q3, iqr: q3 - q1, min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length };
}

/** Summarize a numeric field across an array of per-seed RunMetrics. */
export function summarizeField(runs: RunMetrics[], field: keyof RunMetrics): MedianIQR {
  return medianIQR(runs.map((r) => r[field] as number));
}

/** Sum exit-reason counters across runs (for a total-count table, not median/IQR). */
export function sumExitReasons(runs: RunMetrics[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs) {
    for (const [reason, count] of Object.entries(r.exitReasons)) {
      out[reason] = (out[reason] ?? 0) + count;
    }
  }
  return out;
}
