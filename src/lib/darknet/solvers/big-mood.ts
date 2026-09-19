/**
 * Darknet Solver: BigMo%od
 *
 * tripleModulo servers respond to an attempted divisor `n` with
 * `data: String((password % n) % (((n-1) % 32) + 1))`. For `n` in `[1,32]`,
 * `(n-1) % 32 + 1` equals `n` itself, so the response collapses to
 * `password % n` -- a plain modulus. Ask a set of pairwise-coprime moduli
 * in that range, then reconstruct the password with CRT: the product of
 * the chosen moduli comfortably exceeds the largest password this model
 * generates (`getPassword(3 + difficulty/5)`, at most ~9 digits), so the
 * CRT solution is exact, not just modulo something smaller.
 */
import { Solver } from "/lib/darknet/solvers/types";

// Pairwise-coprime moduli in [1,32]: prime powers of 2, 3, 5 plus distinct
// primes. Product ≈ 1.44e14, far above the largest password this model
// generates.
const MODULI = [32, 31, 29, 27, 25, 23, 19, 17, 13, 11, 7];

interface State {
  index: number; // index into MODULI of the attempt we're about to make (or just made, once == MODULI.length)
  residues: { m: bigint; r: bigint }[];
}

function egcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (b === 0n) return [a, 1n, 0n];
  const [g, x1, y1] = egcd(b, a % b);
  return [g, y1, x1 - (a / b) * y1];
}

function modInverse(a: bigint, m: bigint): bigint {
  const [, x] = egcd(((a % m) + m) % m, m);
  return ((x % m) + m) % m;
}

/** Combine x ≡ r1 (mod m1), x ≡ r2 (mod m2) into x mod lcm(m1,m2), assuming gcd(m1,m2)=1. */
function crtCombine(r1: bigint, m1: bigint, r2: bigint, m2: bigint): { r: bigint; m: bigint } {
  const inv = modInverse(m1, m2);
  const t = (((((r2 - r1) % m2) + m2) % m2) * inv) % m2;
  const m = m1 * m2;
  const r = (((r1 + m1 * t) % m) + m) % m;
  return { r, m };
}

export const bigMood: Solver<State> = {
  id: "BigMo%od",
  blind: false,
  start: () => ({ index: 0, residues: [] }),
  next: (state, feedback) => {
    if (feedback === null) {
      return { attempt: MODULI[0].toString(), state };
    }
    if (feedback.data === undefined) {
      return { giveUp: true, reason: "needs heartbleed" };
    }
    if (state.index >= MODULI.length) {
      // Our CRT-reconstructed guess didn't match -- shouldn't happen.
      return { giveUp: true, reason: "reconstruction mismatch" };
    }

    const m = BigInt(MODULI[state.index]);
    const r = BigInt(feedback.data);
    const residues = [...state.residues, { m, r }];
    const index = state.index + 1;

    if (index < MODULI.length) {
      return { attempt: MODULI[index].toString(), state: { index, residues } };
    }

    let acc = residues[0];
    for (let i = 1; i < residues.length; i++) {
      acc = crtCombine(acc.r, acc.m, residues[i].r, residues[i].m);
    }
    return { attempt: acc.r.toString(), state: { index, residues } };
  },
};
