/**
 * Darknet Solver Stub: PrimeTime 2
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const primeTime: Solver<Record<string, never>> = {
  id: "PrimeTime 2",
  blind: true,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
