/**
 * Darknet Solver Registry
 *
 * Imports every per-model solver and maps exact `modelId` strings to solver
 * objects. Zero NS imports, zero RAM cost.
 *
 * Import with: import { SOLVERS, solverFor } from "/lib/darknet/solvers/index";
 */
import { Solver } from "/lib/darknet/solvers/types";
import { zeroLogon } from "/lib/darknet/solvers/zero-logon";
import { deskMemo } from "/lib/darknet/solvers/desk-memo";
import { freshInstall } from "/lib/darknet/solvers/fresh-install";
import { laika } from "/lib/darknet/solvers/laika";
import { eurozone } from "/lib/darknet/solvers/eurozone";
import { topPass } from "/lib/darknet/solvers/top-pass";
import { cloudblare } from "/lib/darknet/solvers/cloudblare";
import { binary } from "/lib/darknet/solvers/binary";
import { ordoXenos } from "/lib/darknet/solvers/ordo-xenos";
import { proverflo } from "/lib/darknet/solvers/proverflo";
import { octantVoxel } from "/lib/darknet/solvers/octant-voxel";
import { mathml } from "/lib/darknet/solvers/mathml";
import { primeTime } from "/lib/darknet/solvers/prime-time";
import { bellaCuore } from "/lib/darknet/solvers/bella-cuore";
import { accountsManager } from "/lib/darknet/solvers/accounts-manager";
import { nil } from "/lib/darknet/solvers/nil";
import { rateMyPix } from "/lib/darknet/solvers/rate-my-pix";
import { deepGreen } from "/lib/darknet/solvers/deep-green";
import { cellular2g } from "/lib/darknet/solvers/cellular-2g";
import { factoriOs } from "/lib/darknet/solvers/factori-os";
import { bigMood } from "/lib/darknet/solvers/big-mood";
import { php54 } from "/lib/darknet/solvers/php54";
import { kingOfTheHill } from "/lib/darknet/solvers/king-of-the-hill";
import { openWebAccessPoint } from "/lib/darknet/solvers/open-web-access-point";

// Built from an array (rather than 24 object-literal keys) so `key === id`
// holds by construction instead of by 24 chances to typo a key string.
const ALL: Solver[] = [
  zeroLogon,
  deskMemo,
  freshInstall,
  laika,
  eurozone,
  topPass,
  cloudblare,
  binary,
  ordoXenos,
  proverflo,
  octantVoxel,
  mathml,
  primeTime,
  bellaCuore,
  accountsManager,
  nil,
  rateMyPix,
  deepGreen,
  cellular2g,
  factoriOs,
  bigMood,
  php54,
  kingOfTheHill,
  openWebAccessPoint,
];

export const SOLVERS: Record<string, Solver> = Object.fromEntries(ALL.map((s) => [s.id, s]));

export function solverFor(modelId: string): Solver | null {
  return SOLVERS[modelId] ?? null;
}
