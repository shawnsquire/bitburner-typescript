/**
 * Darknet Solver Stub: RateMyPix.Auth
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const rateMyPix: Solver<Record<string, never>> = {
  id: "RateMyPix.Auth",
  blind: false,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
