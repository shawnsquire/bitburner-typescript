/**
 * Darknet Solver Stub: DeskMemo_3.1
 *
 * Unimplemented — a later task fills in `next`. Registered in `index.ts`;
 * that file already lists this export, so it does not need editing to wire
 * this solver in.
 */
import { Solver } from "/lib/darknet/solvers/types";

export const deskMemo: Solver<Record<string, never>> = {
  id: "DeskMemo_3.1",
  blind: true,
  start: () => ({}),
  next: () => ({ giveUp: true, reason: "unimplemented" }),
};
