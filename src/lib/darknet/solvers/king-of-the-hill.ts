/**
 * Darknet Solver Stub: KingOfTheHill
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const kingOfTheHill: Solver<Record<string, never>> = {
  id: "KingOfTheHill",
  blind: false,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
