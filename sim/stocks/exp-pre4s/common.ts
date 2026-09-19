// Shared stats helpers for the pre-4S Monte Carlo experiments.
import { writeFileSync } from "node:fs";

export function mean(a: number[]): number {
  if (a.length === 0) return NaN;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

export function median(a: number[]): number {
  return quantile(a, 0.5);
}

export function quantile(a: number[], q: number): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export interface Summary {
  median: number;
  q1: number;
  q3: number;
  mean: number;
  min: number;
  max: number;
  n: number;
}

function minMax(a: number[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const x of a) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return [lo, hi];
}

export function summarize(a: number[]): Summary {
  if (a.length === 0) return { median: NaN, q1: NaN, q3: NaN, mean: NaN, min: NaN, max: NaN, n: 0 };
  const [lo, hi] = minMax(a);
  return {
    median: median(a),
    q1: quantile(a, 0.25),
    q3: quantile(a, 0.75),
    mean: mean(a),
    min: lo,
    max: hi,
    n: a.length,
  };
}

export function fmtSummary(s: Summary, digits = 4): string {
  return `median=${s.median.toFixed(digits)} IQR=[${s.q1.toFixed(digits)}, ${s.q3.toFixed(digits)}] mean=${s.mean.toFixed(digits)} n=${s.n}`;
}

export function writeJSON(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Simple deterministic seed stream so each experiment uses a disjoint seed range. */
export function seedRange(base: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(base + i);
  return out;
}

export function now(): number {
  return performance.now();
}
