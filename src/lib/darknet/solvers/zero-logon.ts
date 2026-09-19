/**
 * Darknet Solver: ZeroLogon
 *
 * NoPassword servers never had a password set — the game's
 * `getNoPasswordConfig` builds from `getDictionaryAttackConfig(difficulty,
 * [""], hintTemplates, ModelIds.NoPassword)`, so the password is always the
 * empty string. One attempt.
 */
import { Solver } from "/lib/darknet/solvers/types";

interface State {
  tried: boolean;
}

export const zeroLogon: Solver<State> = {
  id: "ZeroLogon",
  blind: true,
  start: () => ({ tried: false }),
  next: (state) => {
    if (state.tried) return { giveUp: true, reason: "exhausted dictionary" };
    return { attempt: "", state: { tried: true } };
  },
};
