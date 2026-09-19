/**
 * Darknet Solver Stub: 110100100
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const binary: Solver<Record<string, never>> = {
  id: "110100100",
  blind: true,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
