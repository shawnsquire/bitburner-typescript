/**
 * Darknet Solver Stub: FreshInstall_1.0
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const freshInstall: Solver<Record<string, never>> = {
  id: "FreshInstall_1.0",
  blind: true,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
