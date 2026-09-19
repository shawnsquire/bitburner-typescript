/**
 * Darknet Solver Stub: AccountsManager_4.2
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const accountsManager: Solver<Record<string, never>> = {
  id: "AccountsManager_4.2",
  blind: false,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
