/**
 * Coding Contract Solver Registry
 *
 * Imports all solvers from individual files and maps exact Bitburner
 * contract type strings to solver functions. Zero NS imports, zero RAM.
 *
 * Import with: import { solve, SOLVERS } from "/lib/contracts/index";
 */
import { findLargestPrimeFactor } from "/lib/contracts/solvers/prime-factor";
import { subarrayMaxSum } from "/lib/contracts/solvers/subarray-max-sum";
import { totalWaysToSum, totalWaysToSumII } from "/lib/contracts/solvers/total-ways-to-sum";
import { arrayJumpingGame, arrayJumpingGameII } from "/lib/contracts/solvers/array-jumping";
import { generateIPAddresses } from "/lib/contracts/solvers/ip-addresses";
import { mergeOverlappingIntervals } from "/lib/contracts/solvers/merge-intervals";
import { rleCompress } from "/lib/contracts/solvers/rle-compression";
import { hammingEncode, hammingDecode } from "/lib/contracts/solvers/hamming-codes";
import { spiralizeMatrix } from "/lib/contracts/solvers/spiralize-matrix";
import { uniquePathsI, uniquePathsII } from "/lib/contracts/solvers/unique-paths";
import { minPathSumTriangle } from "/lib/contracts/solvers/triangle-path";
import { stockTraderI, stockTraderII, stockTraderIII, stockTraderK } from "/lib/contracts/solvers/stock-trader";
import { sanitizeParentheses } from "/lib/contracts/solvers/sanitize-parentheses";
import { findAllValidMathExpressions } from "/lib/contracts/solvers/math-expressions";
import { shortestPathInGrid } from "/lib/contracts/solvers/shortest-path";
import { proper2Coloring } from "/lib/contracts/solvers/graph-coloring";
import { lzDecompress, lzCompress } from "/lib/contracts/solvers/lz-compression";
import { caesarCipher } from "/lib/contracts/solvers/caesar-cipher";
import { vigenereCipher } from "/lib/contracts/solvers/vigenere-cipher";
import { squareRoot } from "/lib/contracts/solvers/square-root";
import { totalPrimesInRange } from "/lib/contracts/solvers/total-primes";
import { largestRectangle } from "/lib/contracts/solvers/largest-rectangle";

// === SOLVER REGISTRY ===

export const SOLVERS: Record<string, (data: any) => any> = {
  "Find Largest Prime Factor": findLargestPrimeFactor,
  "Subarray with Maximum Sum": subarrayMaxSum,
  "Total Ways to Sum": totalWaysToSum,
  "Total Ways to Sum II": totalWaysToSumII,
  "Array Jumping Game": arrayJumpingGame,
  "Array Jumping Game II": arrayJumpingGameII,
  "Generate IP Addresses": generateIPAddresses,
  "Merge Overlapping Intervals": mergeOverlappingIntervals,
  "Compression I: RLE Compression": rleCompress,
  "HammingCodes: Integer to Encoded Binary": hammingEncode,
  "HammingCodes: Encoded Binary to Integer": hammingDecode,
  "Spiralize Matrix": spiralizeMatrix,
  "Unique Paths in a Grid I": uniquePathsI,
  "Unique Paths in a Grid II": uniquePathsII,
  "Minimum Path Sum in a Triangle": minPathSumTriangle,
  "Algorithmic Stock Trader I": stockTraderI,
  "Algorithmic Stock Trader II": stockTraderII,
  "Algorithmic Stock Trader III": stockTraderIII,
  "Algorithmic Stock Trader IV": stockTraderK,
  "Sanitize Parentheses in Expression": sanitizeParentheses,
  "Find All Valid Math Expressions": findAllValidMathExpressions,
  "Shortest Path in a Grid": shortestPathInGrid,
  "Proper 2-Coloring of a Graph": proper2Coloring,
  "Compression II: LZ Decompression": lzDecompress,
  "Compression III: LZ Compression": lzCompress,
  "Encryption I: Caesar Cipher": caesarCipher,
  "Encryption II: Vigenère Cipher": vigenereCipher,
  "Square Root": squareRoot,
  "Total Number of Primes": totalPrimesInRange,
  "Largest Rectangle in a Matrix": largestRectangle,
};

// === PUBLIC API ===

export interface SolveResult {
  solved: boolean;
  answer: any;
}

export function solve(type: string, data: any): SolveResult {
  const solver = SOLVERS[type];
  if (!solver) return { solved: false, answer: null };

  try {
    const answer = solver(data);
    return { solved: true, answer };
  } catch {
    return { solved: false, answer: null };
  }
}
