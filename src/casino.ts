/**
 * Casino Blackjack Automation
 *
 * Standalone script with no live status port — the dashboard's Casino tile
 * (views/dashboard/tools/casino.tsx) only launches it and shows Running/Idle
 * from process detection. Can also be run manually: `run casino.js`
 *
 * Uses perfect information via React fiber state access to read both
 * the player's and dealer's full hands. No save-scumming needed —
 * plays continuously until the $10B casino kick-out cap.
 *
 * RAM: ~1.7 GB (minimum floor via ramOverride; includes getServerMoneyAvailable).
 */
import { NS } from "@ns";
import { domUtils, installTrustBypass } from "/lib/dom";
import {
  navigateToCasino,
  clickPlayBlackjack,
  isAtCasino,
  isBlackjackActive,
  isGameInProgress,
  isKickedOut,
  setWager,
  clickStart,
  clickHit,
  clickStay,
  readGameResult,
  readGameState,
  getBlackjackInstance,
  getAction,
  isWagerValid,
  preScreenNextHand,
  getDeckCards,
} from "/lib/casino";

export async function main(ns: NS): Promise<void> {
  ns.ramOverride(1.7);
  ns.disableLog("ALL");

  const dom = domUtils;
  installTrustBypass();

  ns.tprint("Casino: Starting blackjack automation (perfect-info mode)...");

  // Navigate to blackjack table
  try {
    if (!isBlackjackActive()) {
      if (!isAtCasino()) {
        ns.tprint("Casino: Navigating to Iker Molina Casino...");
        await navigateToCasino(dom);
        await dom.sleep(500);
      }
      ns.tprint("Casino: Starting blackjack...");
      await clickPlayBlackjack(dom);
      await dom.sleep(500);
    } else {
      ns.tprint("Casino: Already at blackjack table.");
    }
  } catch (e) {
    ns.tprint(`ERROR Casino: Navigation failed — ${e}`);
    return;
  }

  // Game loop — play continuously with pre-screening
  let handsPlayed = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;

  while (true) {
    if (isKickedOut()) {
      ns.tprint(`SUCCESS Casino: Kicked out! Played ${handsPlayed} hands [W:${wins} L:${losses} T:${ties}]. GG!`);
      return;
    }

    // Pre-screen the next hand to decide wager
    const instance = getBlackjackInstance();
    let prediction: ReturnType<typeof preScreenNextHand> = "unknown";
    if (instance && getDeckCards(instance)) {
      prediction = preScreenNextHand(instance);
    }

    const wager = await tryStartHand(ns, dom, prediction === "win");
    if (wager === 0) {
      ns.tprint(`Casino: Could not start a hand after ${handsPlayed} hands. Exiting.`);
      return;
    }

    await dom.sleep(200);

    // Play the hand using perfect information
    let moveCount = 0;
    while (isGameInProgress() && moveCount < 20) {
      const inst = getBlackjackInstance();
      if (!inst) {
        await dom.sleep(100);
        continue;
      }

      const action = getAction(inst);

      try {
        if (action === "hit") {
          clickHit(dom);
        } else {
          clickStay(dom);
        }
      } catch {
        break;
      }

      moveCount++;
      await dom.sleep(200);
    }

    // Wait for result
    const result = await pollResult(dom, 5_000);
    handsPlayed++;

    const betStr = wager >= 1e6 ? `$${(wager / 1e6).toFixed(0)}M` : `$${wager}`;

    if (result === "win" || result === "blackjack") {
      wins++;
      const label = result === "blackjack" ? "Blackjack" : "Win";
      ns.tprint(`Casino: Hand #${handsPlayed} — ${label} (${betStr} bet, pred:${prediction}) [W:${wins} L:${losses} T:${ties}]`);
    } else if (result === "loss") {
      losses++;
      ns.tprint(`Casino: Hand #${handsPlayed} — Loss (${betStr} bet, pred:${prediction}) [W:${wins} L:${losses} T:${ties}]`);
    } else if (result === "tie") {
      ties++;
      ns.tprint(`Casino: Hand #${handsPlayed} — Tie (${betStr} bet, pred:${prediction}) [W:${wins} L:${losses} T:${ties}]`);
    } else if (result === null) {
      ns.tprint(`WARN Casino: Result timeout on hand #${handsPlayed}. Waiting...`);
      const settleDeadline = Date.now() + 5_000;
      while (Date.now() < settleDeadline && isGameInProgress()) {
        await dom.sleep(200);
      }
    }

    await dom.sleep(100);
  }
}

// Descending wager amounts to try when we predict a win.
const MAX_WAGERS = [100e6, 75e6, 50e6, 25e6, 10e6, 5e6, 1e6, 500000, 100000, 10000];

/**
 * Try to set a wager and start a hand. For predicted wins, cascade to find max affordable bet.
 *
 * BetInput's "wagerInvalid" state (checked via isWagerValid()) only validates the wager's
 * *format* (positive, <= table max) — it deliberately does not check affordability
 * (Casino/BetInput.tsx). Actually having enough cash is checked separately, inside the
 * Start button's click handler (Casino/Game.ts hasEnoughMoney), which just silently no-ops
 * (shows a dialog, does not throw, does not set wagerInvalid) when the player can't afford
 * the bet. So an affordability pre-filter AND a post-click verification that the wager was
 * actually placed are both needed — otherwise a player under $100M would keep "succeeding"
 * at clicking Start on a wager that never registers, and the daemon would spin forever
 * waiting for a hand that never began.
 *
 * The post-click check compares money before/after rather than polling isGameInProgress():
 * a natural blackjack for either side resolves the hand synchronously inside the same click
 * handler (Casino/Blackjack.tsx startGame()), so gameInProgress can go true-then-false within
 * one React batch and never actually appear in the DOM — isGameInProgress() would wrongly
 * read that as "never started" and the cascade would re-bet a hand that already resolved.
 * The bet is always deducted up front (win(-bet)) the instant hasEnoughMoney passes, so a
 * money decrease is a reliable "this wager was accepted" signal regardless of how the hand
 * subsequently resolves.
 */
async function tryStartHand(ns: NS, dom: typeof domUtils, predictedWin: boolean): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const input = (globalThis["document"] as Document).querySelector('input[type="number"]');
    if (input) break;
    await dom.sleep(100);
  }

  const money = ns.getServerMoneyAvailable("home");
  const wagers = predictedWin ? MAX_WAGERS.filter(w => w <= money) : [1];

  for (const wager of wagers) {
    try {
      const beforeMoney = ns.getServerMoneyAvailable("home");
      setWager(dom, wager);
      await dom.sleep(50);
      if (!isWagerValid()) continue;
      clickStart(dom);

      // Confirm the wager was actually accepted (money decreased) — clickStart is a
      // silent no-op when the wager exceeds the player's cash on hand.
      const startDeadline = Date.now() + 500;
      let started = false;
      while (Date.now() < startDeadline) {
        if (ns.getServerMoneyAvailable("home") < beforeMoney) { started = true; break; }
        await dom.sleep(25);
      }
      if (!started) continue;

      return wager;
    } catch {
      continue;
    }
  }
  return 0;
}

/** Poll for game result using fiber state first, then DOM fallback. */
async function pollResult(dom: typeof domUtils, timeoutMs: number): Promise<ReturnType<typeof readGameResult>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Try fiber state first
    const instance = getBlackjackInstance();
    if (instance) {
      const state = readGameState(instance);
      if (!state.gameInProgress && state.result !== null) {
        return state.result;
      }
    }

    // Fall back to DOM
    const domResult = readGameResult();
    if (domResult !== null) return domResult;

    await dom.sleep(100);
  }
  return null;
}
