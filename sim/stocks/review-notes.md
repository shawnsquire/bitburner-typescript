# Code review findings (agent, 2026-09-19) — condensed
BUGS
1. Smart mode: getHackAdjustment keys on phase "batch"/"prep" (normal HWGW, which never passes {stock:true}) -> noise; the stocks strategy publishes action "grow"/"hack" -> never matches. Wrong or inert, never right.
2. Stops: entryPrice = ask/bid fill, compared against getPrice mid -> stops start partially triggered by the spread (up to 25% of 8% trailing budget).
3. meetsCommissionThreshold ignores spread; realizedProfit omits sell-side commission (sellStock returns bid price only).
4. addPrice counts unchanged price as DOWN tick; daemon uses ns.sleep(pollInterval) not nextUpdate (nextUpdate = 0 GB, CycleTiming=0). Bonus time ticks at 4s -> missed ticks.
5. External-sale detection only catches full liquidation, not partial.
6. stock-grow/stock-hack loop forever without weaken/drain: grow influence chance = moneyGrown/moneyMax -> 0 at max money; hack security climbs.
7. Scraper volatility omits darknet mult (minor).
STRATEGY
1. 4S mode: price stops checked before forecast sell; noise-trading esp. on high-vol stocks the ranking favors.
2. maxHoldTicks 60 < 75-tick cycle: forced turnover.
3. Hysteresis holds longs with forecast in (0.45,0.5): negative ER.
4. calcWeightedBudget 2x cap tied to maxPositions leaves capital idle with few candidates; 30% budget weight is the binding constraint.
5. hack stocks strategy only reinforces open positions; single-server-per-target deploy strands RAM.
6. Pre-4S tickWindow 40: sigma ~0.078, detects 0.10 deviation ~50% of time; f=0.5 false-signals ~20%.
DOCS: pre4s row wrong (tick-count first); smartMode row describes intended not actual; scraper comment says 4S data required but Stock objects are in props regardless -> fiber scraping works with just the page open (WSE account), only TIX API (5b) needed to trade.
VERIFIED OK: RAM tiers 19/31/36; buyShort(sym,0) probe safe; no double count on daemon sales.
