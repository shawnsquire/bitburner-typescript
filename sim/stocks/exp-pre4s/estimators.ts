// Additional (non-repo) estimators used for experiment A/B/C comparisons.
// The repo's own createPriceHistory/addPrice/estimateForecast/estimateVolatility are
// imported directly from src/controllers/stocks.ts wherever "estimator (1)" (exactly as
// wired) is needed - these are only the *extra* variants the experiment brief asks for.

export type FlatMode = "downOnFlat" | "skipFlat";

export interface DirHistory {
  dirs: boolean[]; // true = up
  maxLen: number;
  lastPrice: number | null;
}

export function createDirHistory(maxLen: number): DirHistory {
  return { dirs: [], maxLen, lastPrice: null };
}

/** Mirrors controllers/stocks.ts addPrice()'s tick-direction bookkeeping, except
 * "skipFlat" mode drops an unchanged price instead of recording it as a down-tick. */
export function addSample(h: DirHistory, price: number, mode: FlatMode): void {
  if (h.lastPrice !== null) {
    if (price > h.lastPrice) {
      h.dirs.push(true);
      if (h.dirs.length > h.maxLen) h.dirs.shift();
    } else if (price < h.lastPrice) {
      h.dirs.push(false);
      if (h.dirs.length > h.maxLen) h.dirs.shift();
    } else if (mode === "downOnFlat") {
      h.dirs.push(false);
      if (h.dirs.length > h.maxLen) h.dirs.shift();
    }
    // skipFlat + unchanged price: don't push anything
  }
  h.lastPrice = price;
}

export function fracUp(dirs: boolean[]): number {
  let up = 0;
  for (const d of dirs) if (d) up++;
  return up / dirs.length;
}

export function estimateFromDirHistory(h: DirHistory, minTicks = 10): number | null {
  if (h.dirs.length < minTicks) return null;
  return fracUp(h.dirs);
}

// === Exponentially-weighted up-tick fraction ===

export interface EwmaState {
  lambda: number; // decay per tick, computed from half-life
  value: number | null;
  lastPrice: number | null;
  samples: number;
}

export function createEwma(halfLife: number): EwmaState {
  return { lambda: Math.pow(0.5, 1 / halfLife), value: null, lastPrice: null, samples: 0 };
}

export function updateEwma(st: EwmaState, price: number): void {
  if (st.lastPrice !== null) {
    const up = price > st.lastPrice ? 1 : 0; // ties count as down, matching repo convention
    if (st.value === null) {
      st.value = up;
    } else {
      st.value = st.lambda * st.value + (1 - st.lambda) * up;
    }
    st.samples++;
  }
  st.lastPrice = price;
}

export function readEwma(st: EwmaState, minTicks = 10): number | null {
  if (st.samples < minTicks || st.value === null) return null;
  return st.value;
}

// === Inversion-aware ("detect flip") estimator ===
// Keeps a long window (like estimator (1)/(3)) plus a short window of the most recent
// ~8-10 ticks. If the short window disagrees strongly (>0.2 on the other side of 0.5)
// with the long-window estimate, the long window's history is replaced by the short
// window's contents (so the estimator isn't blind for another `longWindow` ticks after
// a real flip) instead of merely discarded.

export interface InvAwareState {
  long: DirHistory;
  short: DirHistory;
  mode: FlatMode;
  minLongTicks: number;
  minShortTicks: number;
  resets: number;
}

export function createInvAware(
  longWindow = 40,
  shortWindow = 10,
  mode: FlatMode = "downOnFlat",
  minLongTicks = 10,
  minShortTicks = 8,
): InvAwareState {
  return {
    long: createDirHistory(longWindow),
    short: createDirHistory(shortWindow),
    mode,
    minLongTicks,
    minShortTicks,
    resets: 0,
  };
}

export function updateInvAware(st: InvAwareState, price: number): number | null {
  addSample(st.long, price, st.mode);
  addSample(st.short, price, st.mode);

  let longEst = st.long.dirs.length >= st.minLongTicks ? fracUp(st.long.dirs) : null;
  const shortLen = st.short.dirs.length;

  if (shortLen >= st.minShortTicks) {
    const shortEst = fracUp(st.short.dirs);
    if (longEst !== null) {
      const disagree =
        Math.sign(longEst - 0.5) !== 0 &&
        Math.sign(longEst - 0.5) !== Math.sign(shortEst - 0.5) &&
        Math.abs(shortEst - 0.5) > 0.2;
      if (disagree) {
        st.long.dirs = [...st.short.dirs];
        st.resets++;
        longEst = shortEst;
      }
    } else {
      // Long window not warmed up yet - use the short window as a tentative read
      // (both windows fill from empty at the same rate, so this only matters for
      // the first `minLongTicks` ticks of a run).
      longEst = shortEst;
    }
  }

  return longEst;
}

// === Volatility from |log return| magnitude ===
// |log return|_t = ln(1 + v_t*vol) where v_t ~ U(0,1) is redrawn every tick (shared
// across stocks that tick) and vol (mv/100) is fixed for a stock's whole lifetime.
// max over a window of W iid U(0,1) draws has E[max] = W/(W+1), so max(|logret|) over
// W ticks is a biased-low estimate of vol; multiplying by (W+1)/W corrects the bias
// (to first order, since ln(1+x)~=x for the small x actually seen in this sim).

export interface VolWindowState {
  rets: number[];
  maxLen: number;
  lastPrice: number | null;
}

export function createVolWindow(maxLen = 40): VolWindowState {
  return { rets: [], maxLen, lastPrice: null };
}

export function updateVolWindow(st: VolWindowState, price: number): void {
  if (st.lastPrice !== null && st.lastPrice > 0) {
    const logret = Math.abs(Math.log(price / st.lastPrice));
    st.rets.push(logret);
    if (st.rets.length > st.maxLen) st.rets.shift();
  }
  st.lastPrice = price;
}

export function maxLogRetVol(st: VolWindowState, minTicks = 10): { raw: number; corrected: number } | null {
  if (st.rets.length < minTicks) return null;
  const w = st.rets.length;
  const raw = Math.max(...st.rets);
  return { raw, corrected: (raw * (w + 1)) / w };
}
