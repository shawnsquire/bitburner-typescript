/**
 * Experiment 4: sanity check (k=0, no manipulation at all).
 *
 * Confirms the natural (unmanipulated) dynamics behave as documented:
 *   - stockMarketCycle()'s b-flip fires with probability ~0.45 per 75-tick cycle event
 *     (matches stocksim's own validate.ts check (b), reproduced here on our 3 target
 *     stocks specifically and over a much longer horizon)
 *   - the visible forecast wanders (otlkMag stays in [0,50], b flips both ways, no
 *     drift/explosion/NaN) rather than converging or diverging under pure natural
 *     dynamics
 */
import { makeSingleStockMarket, summarize, seeds, N_SEEDS, STOCKS } from "./lib.ts";

const TICKS = 6000; // ~80 cycle events per seed

function main(): void {
  const out: Record<string, unknown> = {};
  const seedList = seeds(N_SEEDS);

  for (const symbol of STOCKS) {
    let totalFlips = 0;
    let totalCycleEvents = 0;
    const finalForecasts: number[] = [];
    const finalOtlkMags: number[] = [];
    let bullishAtEnd = 0;
    let anyOutOfRange = false;
    let anyNaN = false;

    for (const seed of seedList) {
      const market = makeSingleStockMarket(seed, symbol);
      for (let t = 1; t <= TICKS; t++) {
        market.tick();
        const st = market.getStockState(symbol);
        if (st.otlkMag < 0 || st.otlkMag > 50) anyOutOfRange = true;
        if (Number.isNaN(st.otlkMag) || Number.isNaN(st.otlkMagForecast) || Number.isNaN(st.price)) anyNaN = true;
      }
      totalFlips += market.cycleFlips;
      totalCycleEvents += market.cycleEvents;
      const f = market.getForecast(symbol);
      finalForecasts.push(f);
      finalOtlkMags.push(market.getStockState(symbol).otlkMag);
      if (f > 0.5) bullishAtEnd++;
    }

    const observedFlipRate = totalFlips / totalCycleEvents; // per cycle event, expect ~0.45
    out[symbol] = {
      nSeeds: seedList.length,
      ticksPerSeed: TICKS,
      totalCycleEvents,
      totalFlips,
      observedFlipRatePerCycleEvent: observedFlipRate,
      expectedFlipRatePerCycleEvent: 0.45,
      // binomial standard error on the pooled flip-rate estimate
      seFlipRate: Math.sqrt((0.45 * 0.55) / totalCycleEvents),
      finalForecast: summarize(finalForecasts),
      finalOtlkMag: summarize(finalOtlkMags),
      fractionBullishAtEnd: bullishAtEnd / seedList.length,
      anyOtlkMagOutOfRange: anyOutOfRange,
      anyNaN: anyNaN,
    };
    process.stderr.write(
      `exp4 ${symbol}: flipRate=${observedFlipRate.toFixed(4)} (expect 0.45, se=${Math.sqrt((0.45 * 0.55) / totalCycleEvents).toFixed(4)}) ` +
        `fractionBullishAtEnd=${(bullishAtEnd / seedList.length).toFixed(3)} outOfRange=${anyOutOfRange} nan=${anyNaN}\n`,
    );
  }

  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
