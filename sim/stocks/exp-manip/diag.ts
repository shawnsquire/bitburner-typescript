import { makeSingleStockMarket, applyRatePerTick, onDesiredSide } from "./lib.ts";

const symbol = "ECP";
const k = 20;
const seed = 5; // pick a seed with a depin event for ECP k=20 within budget

const market = makeSingleStockMarket(seed, symbol);
let acc = 0;
let prevSide = false;
for (let t = 1; t <= 600; t++) {
  const cf0 = market.cycleFlips;
  const stBefore = market.getStockState(symbol);
  market.tick();
  const flipped = market.cycleFlips > cf0;
  acc = applyRatePerTick(market, symbol, "short", k, acc);
  const st = market.getStockState(symbol);
  const forecast = market.getForecast(symbol);
  const side = onDesiredSide(forecast, "short");
  if (flipped || (side !== prevSide)) {
    console.log(
      `t=${t} flipped=${flipped} side=${side} forecast=${forecast.toFixed(4)} b=${st.b} otlkMag=${st.otlkMag.toFixed(3)} otlkMagForecast=${st.otlkMagForecast.toFixed(3)} (prevB=${stBefore.b} prevOMF=${stBefore.otlkMagForecast.toFixed(3)})`,
    );
  }
  prevSide = side;
}
