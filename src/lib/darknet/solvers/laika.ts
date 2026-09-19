/**
 * Darknet Solver Stub: Laika4
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const laika: Solver<Record<string, never>> = {
  id: "Laika4",
  blind: true,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
