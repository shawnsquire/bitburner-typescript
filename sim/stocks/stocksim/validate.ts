/**
 * Validation harness for the stock market simulator (market.ts / stock.ts / helpers.ts /
 * metadata.ts / rng.ts). Run with `node validate.ts`. Prints one PASS/FAIL line per
 * check and exits with code 1 if anything fails.
 *
 * These are statistical/structural sanity checks against the ported formulas, not a
 * re-implementation of the game's own jest suite - see the game checkout at
 * test/jest/StockMarket.test.ts for the authoritative unit tests this simulator was
 * built to match.
 */
import { Market } from "./market.ts";
import { InitStockMetadata, StockMarketConstants, forecastChangePerPriceMovement } from "./metadata.ts";

let failures = 0;

function check(name: string, pass: boolean, detail: string): void {
  const status = pass ? "PASS" : "FAIL";
  console.log(`[${status}] ${name} - ${detail}`);
  if (!pass) failures++;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[], m: number): number {
  const variance = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// =====================================================================================
// (a) Frozen-stock per-tick log-return mean matches the closed-form expectation.
//
// Per tick: av = v * mv/100 with v ~ Uniform(0,1) shared across the tick, price *=
// (1+av) with probability chc, else price /= (1+av). So the per-tick log return is
// +ln(1+av) w.p. chc and -ln(1+av) w.p. (1-chc), and
//   E[log return] = (2*chc - 1) * E[ln(1+av)]
//   E[ln(1+av)]   = (1/M) * integral_0^M ln(1+a) da   [M = mv/100, av ~ Uniform(0,M)]
//                 = ((1+M)*ln(1+M) - M) / M
// This is the EXACT expectation (not the small-M linear approximation
// (chc-0.5)*vol from the task brief, which is the first-order Taylor expansion of
// the same quantity and is only approximate for the vol values used here).
// =====================================================================================
function expectedLogReturn(chc: number, vol: number): number {
  const M = vol;
  const eLn1plusAv = ((1 + M) * Math.log(1 + M) - M) / M;
  return (2 * chc - 1) * eLn1plusAv;
}

function runFrozenCheck(chc: number, b: boolean, otlkMag: number, vol: number, ticks: number): void {
  const startPrice = 10_000;
  const market = new Market(1234567, {
    frozen: true,
    stocks: [
      {
        b,
        initPrice: startPrice,
        marketCap: 1e12,
        mv: vol * 100, // Stock.mv is stored as a plain percentage-ish number; getVolatility()/100s it
        name: "Frozen",
        otlkMag,
        spreadPerc: 0, // spread doesn't affect price/tick, only ask/bid; keep it out of the way
        shareTxForMovement: 1e6,
        symbol: "FRZN",
      },
    ],
  });

  const logReturns: number[] = new Array(ticks);
  for (let i = 0; i < ticks; i++) {
    market.tick();
    const after = market.getPrice("FRZN");
    logReturns[i] = Math.log(after / startPrice);
    market.debugSetPrice("FRZN", startPrice); // renormalize so we never approach the cap
  }

  const m = mean(logReturns);
  const s = std(logReturns, m);
  const se = s / Math.sqrt(ticks);
  const expected = expectedLogReturn(chc, vol);
  const diff = Math.abs(m - expected);
  const sigmas = diff / se;

  check(
    `(a) frozen mean log-return chc=${chc} vol=${vol}`,
    sigmas < 6,
    `mean=${m.toFixed(6)} expected=${expected.toFixed(6)} se=${se.toExponential(3)} diff=${sigmas.toFixed(2)}sigma over ${ticks} ticks`,
  );

  // Also check against the task brief's literal (first-order/linear) formula,
  // (forecast - 0.5) * vol. This is the small-M Taylor approximation of the exact
  // expectation above (E[ln(1+av)] ~ E[av] = M/2 for small M), so it's only
  // approximately true - allow 5% relative error rather than a sigma bound.
  const linearExpected = (chc - 0.5) * vol;
  const linearRelErr = Math.abs(m - linearExpected) / Math.abs(m);
  check(
    `(a) frozen mean log-return vs brief's linear formula (chc-0.5)*vol, chc=${chc} vol=${vol}`,
    linearRelErr < 0.05,
    `mean=${m.toFixed(6)} linear-formula=${linearExpected.toFixed(6)} relErr=${(linearRelErr * 100).toFixed(2)}%`,
  );
}

// chc = (50 +/- otlkMag)/100, so pick otlkMag/b pairs that hit a few chc values away
// from 0.5 (0.5 would make the signal vanish into the noise).
runFrozenCheck(0.3, false, 20, 0.01, 200_000);
runFrozenCheck(0.6, true, 10, 0.02, 200_000);
runFrozenCheck(0.7, true, 20, 0.04, 200_000);

// =====================================================================================
// (b) Per-stock cycle flip rate ~ 0.45 per cycle event (stockMarketCycle()), i.e. the
// coin the source flips for each of the 33 stocks every ~75 ticks lands "flip" 45% of
// the time. cycleEvents/cycleFlips are simulator-only instrumentation (see market.ts)
// so the expected trial count is exact, not an estimate from ticks/75.
// =====================================================================================
{
  const ticks = 100_000;
  const market = new Market(987654321, { cash: 0 });
  const k0 = market.getTicksUntilCycle(); // initial getRandomIntInclusive(1, 75) roll
  for (let i = 0; i < ticks; i++) market.tick();

  // The cycle period (75) is deterministic, not statistical: cycle events land
  // exactly at ticks k0, k0+75, k0+150, ... This pins down TicksPerCycle and the
  // "reset to 75 after firing" behavior exactly, rather than only checking the 0.45
  // coin (which would still pass, just with a different trial count, if the period
  // were wrong or the reset were broken).
  const expectedEvents = Math.floor((ticks - k0) / 75) + 1;
  check(
    "(b) cycle period matches TicksPerCycle=75",
    k0 >= 1 && k0 <= 75 && market.cycleEvents === expectedEvents,
    `k0=${k0} cycleEvents=${market.cycleEvents} expected=${expectedEvents}`,
  );

  const numStocks = market.symbols().length; // 33
  const trials = market.cycleEvents * numStocks;
  const p = 0.45;
  const expectedFlips = trials * p;
  const se = Math.sqrt(trials * p * (1 - p));
  const sigmas = Math.abs(market.cycleFlips - expectedFlips) / se;
  const observedRatePerTick = market.cycleFlips / (ticks * numStocks);
  const briefRatePerTick = 0.45 / 75;

  check(
    "(b) cycle flip rate ~ 0.45 per cycle event (~0.45/75 per tick)",
    sigmas < 6,
    `flips=${market.cycleFlips} expected=${expectedFlips.toFixed(1)} over ${market.cycleEvents} cycle-events x ${numStocks} stocks, diff=${sigmas.toFixed(2)}sigma; ` +
      `per-tick rate observed=${observedRatePerTick.toFixed(6)} vs brief's 0.45/75=${briefRatePerTick.toFixed(6)}`,
  );
}

// =====================================================================================
// (c) maxShares = round(totalShares*0.2/1e5)*1e5 and
//     totalShares = round((marketCap/price)/1e5)*1e5, for all 33 stocks.
// =====================================================================================
{
  const market = new Market(42);
  let allOk = true;
  const bad: string[] = [];
  for (const meta of InitStockMetadata) {
    const s = market.getStockState(meta.symbol);
    const expectedTotal = Math.round(meta.marketCap / s.price / 1e5) * 1e5;
    const expectedMax = Math.round((expectedTotal * 0.2) / 1e5) * 1e5;
    if (s.totalShares !== expectedTotal || s.maxShares !== expectedMax) {
      allOk = false;
      bad.push(`${meta.symbol}: totalShares=${s.totalShares} (want ${expectedTotal}) maxShares=${s.maxShares} (want ${expectedMax})`);
    }
  }
  check("(c) totalShares/maxShares formula, all 33 stocks", allOk, allOk ? "all 33 match" : bad.join("; "));
}

// =====================================================================================
// (d) Buy then sell N shares at a constant price (no ticks in between) round-trips
// cash by exactly -(N*price*2*spreadPerc/100) - 2*commission.
// =====================================================================================
{
  const market = new Market(7, {
    cash: 1e12,
    stocks: [
      {
        b: true,
        initPrice: 5000,
        marketCap: 1e10,
        mv: 10,
        name: "RoundTrip",
        otlkMag: 5,
        spreadPerc: 2.5,
        shareTxForMovement: 1e6, // large enough that N shares never trips a price movement side-effect
        symbol: "RT",
      },
    ],
  });

  const shares = 10_000;
  const price = market.getPrice("RT");
  const ask = market.getAskPrice("RT");
  const bid = market.getBidPrice("RT");
  const cashBefore = market.getCash();

  const gotAsk = market.buyStock("RT", shares);
  const gotBid = market.sellStock("RT", shares);
  const cashAfter = market.getCash();

  const commission = StockMarketConstants.StockMarketCommission;
  const expectedDelta = shares * (bid - ask) - 2 * commission;
  const actualDelta = cashAfter - cashBefore;
  const relErr = Math.abs(actualDelta - expectedDelta) / Math.abs(expectedDelta);

  check(
    "(d) buy/sell round-trip cash delta",
    gotAsk === ask && gotBid === bid && relErr < 1e-9 && market.getPosition("RT")[0] === 0,
    `ask=${ask} bid=${bid} price=${price} actualDelta=${actualDelta} expectedDelta=${expectedDelta} relErr=${relErr.toExponential(3)}`,
  );
}

// =====================================================================================
// (e) processTransactionForecastMovement matches the source's formula.
//   (e1) Buying maxShares of ECP on a fresh market - the "many iterations" branch.
//   (e2) A custom mock stock (same ctorParams the game's own jest test in
//        test/jest/StockMarket.test.ts uses) transacting exactly 3*shareTxForMovement
//        shares, which that test asserts triggers exactly 4 "movements" - this anchors
//        the check to the source's own test expectations rather than only to our
//        re-derivation of its formula.
// =====================================================================================
{
  // ---- (e1): ECP, maxShares ----
  const market = new Market(2024, { cash: 1e15 });
  const before = market.getStockState("ECP");
  const M = before.maxShares;
  const S = before.shareTxForMovement;
  const U0 = before.shareTxUntilMovement; // == S on a fresh market

  market.buyStock("ECP", M);
  const after = market.getStockState("ECP");

  // Re-derivation of processTransactionForecastMovement (helpers.ts) in plain
  // arithmetic, for the "shares > shareTxUntilMovement" branch (true here since
  // maxShares is tens of millions and shareTxForMovement is tens of thousands).
  const remaining = M - U0;
  let numIterations = 1 + Math.ceil(remaining / S);
  let newU = S - ((M - U0) % S);
  if (newU === S || newU <= 0) {
    numIterations++;
    newU = S;
  }
  const forecastChange = forecastChangePerPriceMovement * (numIterations - 1);
  const forecastForecastChange = forecastChange * (before.mv / 100);
  const expectedOtlkMag = before.otlkMag > 5 ? Math.max(5, before.otlkMag - forecastChange) : before.otlkMag;
  let expectedOtlkMagForecast = before.otlkMagForecast;
  if (before.otlkMagForecast > 50) {
    expectedOtlkMagForecast = Math.max(50, before.otlkMagForecast - forecastForecastChange);
  } else if (before.otlkMagForecast < 50) {
    expectedOtlkMagForecast = Math.min(50, before.otlkMagForecast + forecastForecastChange);
  }

  const ok1 =
    after.otlkMag === expectedOtlkMag &&
    after.otlkMagForecast === expectedOtlkMagForecast &&
    after.shareTxUntilMovement === newU;
  check(
    "(e1) processTransactionForecastMovement, maxShares of ECP",
    ok1,
    `n=${numIterations} otlkMag ${before.otlkMag}->${after.otlkMag} (want ${expectedOtlkMag}), otlkMagForecast ${before.otlkMagForecast}->${after.otlkMagForecast} (want ${expectedOtlkMagForecast})`,
  );

  // ---- (e2): mock stock from the game's own jest test, 3*shareTxForMovement shares ----
  const mockMarket = new Market(1, {
    cash: 1e9,
    stocks: [
      {
        b: true,
        initPrice: 10e3,
        marketCap: 5e9,
        mv: 2,
        name: "MockStock",
        otlkMag: 20,
        spreadPerc: 1,
        shareTxForMovement: 5e3,
        symbol: "mock",
      },
    ],
  });
  const mockBefore = mockMarket.getStockState("mock");
  const n = 4; // per test/jest/StockMarket.test.ts "...transactions that are a multiple of 'shareTxForMovement' shares"
  const expectedMockOtlkMag = mockBefore.otlkMag - forecastChangePerPriceMovement * (n - 1);
  const expectedMockOtlkMagForecast = Math.max(
    50,
    mockBefore.otlkMagForecast - forecastChangePerPriceMovement * (n - 1) * (mockBefore.mv / 100),
  );

  mockMarket.buyStock("mock", 3 * mockBefore.shareTxForMovement);
  const mockAfter = mockMarket.getStockState("mock");

  const ok2 = mockAfter.otlkMag === expectedMockOtlkMag && mockAfter.otlkMagForecast === expectedMockOtlkMagForecast;
  check(
    "(e2) processTransactionForecastMovement, 3x shareTxForMovement (jest cross-check)",
    ok2,
    `otlkMag ${mockBefore.otlkMag}->${mockAfter.otlkMag} (want ${expectedMockOtlkMag}), otlkMagForecast ${mockBefore.otlkMagForecast}->${mockAfter.otlkMagForecast} (want ${expectedMockOtlkMagForecast})`,
  );
}

// =====================================================================================
// (f) Same-seed determinism: two Markets built from the same seed, driven through an
// identical script of ticks/trades/influence calls, end up in byte-identical state.
// =====================================================================================
{
  function snapshot(market: Market): unknown {
    return {
      cash: market.getCash(),
      ticksUntilCycle: market.getTicksUntilCycle(),
      cycleFlips: market.cycleFlips,
      cycleEvents: market.cycleEvents,
      stocks: market.symbols().map((sym) => market.getStockState(sym)),
    };
  }

  function runScript(seed: number): Market {
    const market = new Market(seed, { cash: 1e15 });
    for (let i = 0; i < 500; i++) {
      market.tick();
      if (i % 37 === 0) market.buyStock("ECP", 1000);
      if (i % 41 === 0) market.sellStock("ECP", 500);
      if (i % 53 === 0) market.buyShort("FLCM", 2000);
      if (i % 59 === 0) market.sellShort("FLCM", 1000);
      if (i % 17 === 0) market.influenceHack("MGCP", 0.3);
      if (i % 19 === 0) market.influenceGrow("MGCP", 0.3);
    }
    return market;
  }

  const m1 = runScript(555_111);
  const m2 = runScript(555_111);
  const s1 = JSON.stringify(snapshot(m1));
  const s2 = JSON.stringify(snapshot(m2));

  check("(f) same-seed determinism", s1 === s2, s1 === s2 ? "identical final state" : "state diverged between runs");
}

// =====================================================================================
console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("All checks PASSED");
}
