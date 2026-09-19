/**
 * Darknet Solver: FreshInstall_1.0
 *
 * DefaultPassword servers pick the password from the game's
 * `defaultSettingsDictionary` (src/DarkNet/models/dictionaryData.ts), copied
 * verbatim below. Blind dictionary attack: try each entry in order.
 */
import { Solver } from "/lib/darknet/solvers/types";

// Copied verbatim from the game's `defaultSettingsDictionary`.
const DEFAULT_PASSWORDS = ["admin", "password", "0000", "12345"] as const;

interface State {
  index: number;
}

export const freshInstall: Solver<State> = {
  id: "FreshInstall_1.0",
  blind: true,
  start: () => ({ index: 0 }),
  next: (state) => {
    if (state.index >= DEFAULT_PASSWORDS.length) {
      return { giveUp: true, reason: "exhausted dictionary" };
    }
    return { attempt: DEFAULT_PASSWORDS[state.index], state: { index: state.index + 1 } };
  },
};
