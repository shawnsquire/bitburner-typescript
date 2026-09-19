/**
 * Darknet Solver Stub: 2G_cellular
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const cellular2g: Solver<Record<string, never>> = {
  id: "2G_cellular",
  blind: false,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
