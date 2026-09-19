import { describe, it, expect } from "vitest";
import { getAction, preScreenNextHand, getDeckCards } from "/lib/casino";

/**
 * Reimplements Blackjack.tsx's getHandValue/getTrueHandValue exactly (Aces count
 * as both 1 and 11, the largest total <=21 wins, busted hands return any value)
 * so the fake instance behaves identically to the real React component the
 * solver normally reads via the fiber tree.
 */
interface Card { value: number; suit: string }
interface Hand { cards: readonly Card[] }

function getHandValues(hand: Hand): number[] {
  let result: number[] = [0];
  for (const card of hand.cards) {
    if (card.value >= 10) result = result.map(x => x + 10);
    else if (card.value === 1) result = result.flatMap(x => [x + 1, x + 11]);
    else result = result.map(x => x + card.value);
  }
  return result;
}

function getTrueHandValue(hand: Hand): number {
  const values = getHandValues(hand);
  const under21 = values.filter(x => x <= 21).sort((a, b) => a - b);
  return under21.length > 0 ? under21[under21.length - 1] : values[0];
}

function card(value: number, suit = "clubs"): Card {
  return { value, suit };
}

interface FakeInstanceOptions {
  playerCards: Card[];
  dealerCards: Card[];
  deck?: Card[];
  wagerInvalid?: boolean;
}

function fakeInstance(opts: FakeInstanceOptions) {
  return {
    state: {
      playerHand: { cards: opts.playerCards },
      dealerHand: { cards: opts.dealerCards },
      gameInProgress: true,
      result: "Pending",
      bet: 1_000_000,
      gains: 0,
      wagerInvalid: opts.wagerInvalid ?? false,
    },
    deck: { cards: opts.deck ?? [] },
    getTrueHandValue: (hand: Hand) => getTrueHandValue(hand),
  };
}

describe("getAction", () => {
  it("stays once the player's hand is already 21 or more (no benefit to hitting)", () => {
    const instance = fakeInstance({
      playerCards: [card(7), card(7), card(7)], // 21 via three cards, not a natural
      dealerCards: [card(5), card(5)],
      deck: [card(5)],
    });
    expect(getAction(instance)).toBe("stay");
  });

  it("stays when hitting the next deck card would bust", () => {
    // Player at 15, next card is a 10 -> busts. Dealer would draw and likely
    // beat/tie a stand at 15, but busting is strictly worse than any stand.
    const instance = fakeInstance({
      playerCards: [card(9), card(6)], // 15
      dealerCards: [card(2), card(2)], // 4, will draw more
      deck: [card(10), card(3), card(3), card(3)],
    });
    expect(getAction(instance)).toBe("stay");
  });

  it("hits when standing loses but hitting wins outright with perfect deck knowledge", () => {
    // Player at 12 (loses to dealer's inevitable 20 on stand); the very next
    // card is a 9, bringing the player to 21 — a guaranteed win over 20.
    const instance = fakeInstance({
      playerCards: [card(7), card(5)], // 12
      dealerCards: [card(10), card(10)], // 20 already — stand always loses
      deck: [card(9)],
    });
    expect(getAction(instance)).toBe("hit");
  });

  it("stays when standing already wins outright (dealer must draw and will bust)", () => {
    const instance = fakeInstance({
      playerCards: [card(10), card(9)], // 19
      dealerCards: [card(10), card(6)], // 16, must hit
      deck: [card(10)], // dealer draws a 10 and busts at 26
    });
    expect(getAction(instance)).toBe("stay");
  });

  it("falls back to full-information heuristics when the deck cannot be read", () => {
    const instance = fakeInstance({
      playerCards: [card(10), card(2)], // 12
      dealerCards: [card(10), card(6)], // 16 (>=12, dealer will hit since <17... actually check heuristic)
      deck: [],
    });
    // With no deck array (getDeckCards returns null for empty), falls back to
    // getActionFallback: dealerVal(16) < 17 and playerVal(12) is between 12
    // and 16 with dealerVal>=12 is false (16>=12 true, but playerVal>=13 is
    // false) -> playerVal<=11 false -> default hit.
    expect(getAction(instance)).toBe("hit");
  });
});

describe("getDeckCards", () => {
  it("returns null when the deck field is missing or empty", () => {
    expect(getDeckCards(fakeInstance({ playerCards: [], dealerCards: [], deck: [] }))).toBeNull();
  });

  it("returns the cards array when present", () => {
    const deck = [card(5), card(6)];
    expect(getDeckCards(fakeInstance({ playerCards: [], dealerCards: [], deck }))).toEqual(deck);
  });
});

describe("preScreenNextHand", () => {
  it("returns 'unknown' when fewer than 4 cards are available to deal", () => {
    const instance = fakeInstance({ playerCards: [], dealerCards: [], deck: [card(1), card(2)] });
    expect(preScreenNextHand(instance)).toBe("unknown");
  });

  it("predicts an outright win on a natural player blackjack (non-blackjack dealer)", () => {
    // deck[0..1] -> player, deck[2..3] -> dealer per Blackjack.tsx's startGame().
    const instance = fakeInstance({
      playerCards: [],
      dealerCards: [],
      deck: [card(1), card(13), card(9), card(5)], // player A+K=21, dealer 9+5=14
    });
    expect(preScreenNextHand(instance)).toBe("win");
  });

  it("predicts a tie when both player and dealer are dealt a natural blackjack", () => {
    const instance = fakeInstance({
      playerCards: [],
      dealerCards: [],
      deck: [card(1), card(11), card(1), card(12)], // both 21 via Ace+face
    });
    expect(preScreenNextHand(instance)).toBe("tie");
  });

  it("predicts a loss on a dealer natural blackjack over a non-blackjack player", () => {
    const instance = fakeInstance({
      playerCards: [],
      dealerCards: [],
      deck: [card(9), card(5), card(1), card(13)], // player 14, dealer A+K=21
    });
    expect(preScreenNextHand(instance)).toBe("loss");
  });

  it("predicts a win when the dealer's forced draw-to-17 would bust it", () => {
    // player deck[0..1]=5+4=9, dealer deck[2..3]=10+6=16 (must hit since <17).
    // Standing right away already wins because the dealer's very next card
    // (deck[4]=8) busts it to 24 — the simulation should stop hitting once
    // staying is already a guaranteed win.
    const instance = fakeInstance({
      playerCards: [],
      dealerCards: [],
      deck: [card(5), card(4), card(10), card(6), card(8), card(10)],
    });
    expect(preScreenNextHand(instance)).toBe("win");
  });
});
