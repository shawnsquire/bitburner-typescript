/**
 * Darknet Solver Stub: CloudBlare(tm)
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const cloudblare: Solver<Record<string, never>> = {
  id: "CloudBlare(tm)",
  blind: true,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
