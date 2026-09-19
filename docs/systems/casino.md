# Casino

Plays blackjack at Iker Molina Casino in Aevum with perfect information: it
reads both hands and the upcoming deck order from the game's React state.
Source: `src/casino.ts` (loop), `src/lib/casino.ts` (strategy and state
readers, unit tested), `src/actions/travel-to-casino.ts`.

## Run

```
run actions/travel-to-casino.js     # if you are not in Aevum
run casino.js
```

`casino.js` is pinned at 1.6 GB. The travel action costs about 4 GB with SF4
level 3 and about 34 GB without. Both are launched from the dashboard's
Casino tab, which shows only whether the script is running.

## Behaviour

- Before each hand it pre-screens the next hand from the deck order and bets
  the maximum it can when the hand wins, the minimum when it loses or ties.
- Bets cascade down when a wager is rejected for insufficient funds, so it
  does not spin forever below the top wager.
- Hit or stay is decided from the true hand values and the next card.
- The game kicks you out after 10b in casino winnings; the script stops there.

No config file and no status port.
