/**
 * HammingCodes: Integer to Encoded Binary
 *
 * Mirrors HammingEncode() in the game source (src/CodingContract/contracts/HammingCode.ts):
 * data bits go MSB-first into the non-power-of-two positions, the block ends right
 * after the last data bit (no padding to a power-of-two length), parity bit 2^k is
 * bit k of the XOR of all set positions, and position 0 is the overall parity.
 * The game checks for an exact string match, so the length rule matters.
 */
export function hammingEncode(value: number): string {
  const dataBits = value.toString(2).split("").map(Number); // MSB first
  const enc: number[] = [0];

  let next = 0;
  for (let i = 1; next < dataBits.length; i++) {
    enc[i] = (i & (i - 1)) !== 0 ? dataBits[next++] : 0;
  }

  let syndrome = 0;
  for (let i = 0; i < enc.length; i++) {
    if (enc[i]) syndrome ^= i;
  }
  for (let p = 1; p < enc.length; p <<= 1) {
    enc[p] = syndrome & p ? 1 : 0;
  }

  let ones = 0;
  for (let i = 0; i < enc.length; i++) ones += enc[i];
  enc[0] = ones % 2;

  return enc.join("");
}

/** HammingCodes: Encoded Binary to Integer — Detect/correct error, extract data */
export function hammingDecode(encoded: string): number {
  const bits: number[] = [];
  for (const ch of encoded) bits.push(Number(ch));
  const n = bits.length;

  // Find error position using parity bits
  let errorPos = 0;
  for (let p = 0; (1 << p) < n; p++) {
    const parityPos = 1 << p;
    let parity = 0;
    for (let j = parityPos; j < n; j++) {
      if (j & parityPos) parity ^= bits[j];
    }
    if (parity) errorPos += parityPos;
  }

  // Correct the error
  if (errorPos > 0 && errorPos < n) {
    bits[errorPos] ^= 1;
  }

  // Extract data bits (skip position 0 and powers of 2)
  let dataBin = "";
  for (let i = 1; i < n; i++) {
    if ((i & (i - 1)) !== 0) {
      dataBin += bits[i];
    }
  }

  return parseInt(dataBin, 2);
}
