/**
 * Total Number of Primes — count primes in the inclusive range [low, high].
 *
 * The game generates low up to 5,000,000 and high up to 1,000,000 above it, so a
 * segmented Sieve of Eratosthenes is used: sieve the small primes up to
 * sqrt(high), then mark their multiples inside [low, high] only.
 * Mirrors src/CodingContract/contracts/TotalPrimesInRange.ts in the game source.
 */
export function totalPrimesInRange(data: [number, number] | number[]): number {
  const low = Math.max(2, data[0]);
  const high = data[1];
  if (high < low) return 0;

  const limit = Math.floor(Math.sqrt(high));
  const small = new Uint8Array(limit + 1);
  const smallPrimes: number[] = [];
  for (let i = 2; i <= limit; i++) {
    if (small[i]) continue;
    smallPrimes.push(i);
    for (let j = i * i; j <= limit; j += i) small[j] = 1;
  }

  const composite = new Uint8Array(high - low + 1);
  for (const p of smallPrimes) {
    const start = Math.max(p * p, Math.ceil(low / p) * p);
    for (let m = start; m <= high; m += p) composite[m - low] = 1;
  }

  let count = 0;
  for (let i = 0; i < composite.length; i++) {
    if (!composite[i]) count++;
  }
  // `low` was clamped to 2 above, so 0 and 1 are never counted
  return count;
}
