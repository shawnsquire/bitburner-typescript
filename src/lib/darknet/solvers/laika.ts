/**
 * Darknet Solver: Laika4
 *
 * DogNames servers pick the password from the game's `dogNameDictionary`
 * (src/DarkNet/models/dictionaryData.ts), copied verbatim below. Blind
 * dictionary attack: try each entry in order.
 */
import { Solver } from "/lib/darknet/solvers/types";

// Copied verbatim from the game's `dogNameDictionary`.
const DOG_NAMES = ["fido", "spot", "rover", "max"] as const;

interface State {
  index: number;
}

export const laika: Solver<State> = {
  id: "Laika4",
  blind: true,
  start: () => ({ index: 0 }),
  next: (state) => {
    if (state.index >= DOG_NAMES.length) {
      return { giveUp: true, reason: "exhausted dictionary" };
    }
    return { attempt: DOG_NAMES[state.index], state: { index: state.index + 1 } };
  },
};
