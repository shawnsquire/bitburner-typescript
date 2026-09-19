/**
 * Follow-up to experiment 1: directly verify the mechanism behind why megacap
 * holding power is roughly k-independent and why re-pinning after a cycle flip is
 * dominated by "wait for the next cycle" rather than by pressure-driven decay.
 *
 * A 75-tick cycle flip does otlkMagForecast (OMF) = 100 - OMF, which for a
 * previously-pinned-bearish stock (OMF near its floor, ~0-5) jumps OMF up near 100 -
 * the WRONG extreme for continued bearish pressure. Sustained pressure at rate
 * k events/tick claws OMF back down at k*0.1/tick, so:
 *   - ticks to cross back through neutral (OMF < 50)         ~= 500 / k
 *   - ticks to fully re-saturate getForecastIncreaseChance()
 *     at its 0.05 floor (|OMF - absoluteForecast| >= 45)     ~= 950 / k
 * This script measures both directly (pooled over many depin events across many
 * seeds) and compares to those closed-form predictions.
 */
import { makeSingleStockMarket, applyRatePerTick, onDesiredSide, summarize, seeds, N_SEEDS, STOCKS } from "./lib.ts";

const TICKS = 3000;
const DIR = "short" as const;
const KS = [0.5, 1, 2, 5, 10, 20];

function absoluteForecast(otlkMag: number, b: boolean): number {
  return b ? 50 + otlkMag : 50 - otlkMag;
}
function increaseChance(otlkMagForecast: number, otlkMag: number, b: boolean): number {
  const diff = otlkMagForecast - absoluteForecast(otlkMag, b);
  return (50 + Math.min(Math.max(diff, -45), 45)) / 100;
}

interface Event {
  neutralLatency: number | null; // ticks until OMF < 50 again, or null if censored
  saturateLatency: number | null; // ticks until increaseChance <= 0.0501 again
}

function runOne(seed: number, symbol: string, k: number): Event[] {
  const market = makeSingleStockMarket(seed, symbol);
  let acc = 0;
  let prevSide = false;
  const events: Event[] = [];
  let pending: { tick: number; neutralHit: number | null } | null = null;

  for (let t = 1; t <= TICKS; t++) {
    const cf0 = market.cycleFlips;
    market.tick();
    const flipped = market.cycleFlips > cf0;
    acc = applyRatePerTick(market, symbol, DIR, k, acc);
    const st = market.getStockState(symbol);
    const side = onDesiredSide(market.getForecast(symbol), DIR);

    if (flipped && prevSide === true && side === false) {
      // Depin: close out any still-open pending event as censored, start a new one.
      if (pending !== null) events.push({ neutralLatency: pending.neutralHit, saturateLatency: null });
      pending = { tick: t, neutralHit: null };
    }

    if (pending !== null) {
      if (pending.neutralHit === null && st.otlkMagForecast < 50) {
        pending.neutralHit = t - pending.tick;
      }
      const ic = increaseChance(st.otlkMagForecast, st.otlkMag, st.b);
      if (ic <= 0.0501) {
        events.push({ neutralLatency: pending.neutralHit, saturateLatency: t - pending.tick });
        pending = null;
      }
    }

    prevSide = side;
  }
  if (pending !== null) events.push({ neutralLatency: pending.neutralHit, saturateLatency: null });

  return events;
}

function main(): void {
  const out: Record<string, Record<string, unknown>> = {};
  const seedList = seeds(N_SEEDS);

  for (const symbol of STOCKS) {
    out[symbol] = {};
    for (const k of KS) {
      const neutralLatencies: number[] = [];
      const saturateLatencies: number[] = [];
      let censoredNeutral = 0;
      let censoredSaturate = 0;
      let totalEvents = 0;

      for (const seed of seedList) {
        const events = runOne(seed, symbol, k);
        for (const e of events) {
          totalEvents++;
          if (e.neutralLatency === null) censoredNeutral++;
          else neutralLatencies.push(e.neutralLatency);
          if (e.saturateLatency === null) censoredSaturate++;
          else saturateLatencies.push(e.saturateLatency);
        }
      }

      out[symbol][String(k)] = {
        k,
        totalEvents,
        predictedNeutralTicks: 500 / k,
        predictedSaturateTicks: 950 / k,
        neutralLatency: summarize(neutralLatencies),
        censoredNeutral,
        saturateLatency: summarize(saturateLatencies),
        censoredSaturate,
      };
      process.stderr.write(
        `exp1_omf ${symbol} k=${k}: neutralMedian=${summarize(neutralLatencies).median} (pred ${(500 / k).toFixed(0)}) ` +
          `saturateMedian=${summarize(saturateLatencies).median} (pred ${(950 / k).toFixed(0)}) events=${totalEvents}\n`,
      );
    }
  }

  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
