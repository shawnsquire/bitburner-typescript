/**
 * Largest Rectangle in a Matrix — find the largest all-zero rectangle in a
 * binary matrix. Returns its corners as [[r1, c1], [r2, c2]].
 *
 * Mirrors the game's reference solution (src/CodingContract/contracts/LargestRectangle.ts):
 * build a per-cell "height of consecutive zeros above" histogram, then for each
 * cell expand left/right while neighbours are at least as tall. The game only
 * checks that the submitted rectangle is all zeros and has the maximal area, so
 * any maximal rectangle is accepted.
 */
export function largestRectangle(grid: number[][]): [[number, number], [number, number]] {
  const rows = grid.length;
  const cols = rows > 0 ? grid[0].length : 0;
  const heights: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let c = 0; c < cols; c++) {
    let run = 0;
    for (let r = 0; r < rows; r++) {
      run = grid[r][c] === 0 ? run + 1 : 0;
      heights[r][c] = run;
    }
  }

  let bestArea = 0;
  let best: [[number, number], [number, number]] = [[0, 0], [0, 0]];

  for (let r = 0; r < rows; r++) {
    const row = heights[r];
    for (let c = 0; c < cols; c++) {
      const h = row[c];
      if (h === 0) continue;
      let left = c;
      let right = c;
      while (left > 0 && row[left - 1] >= h) left--;
      while (right < cols - 1 && row[right + 1] >= h) right++;
      const area = (right - left + 1) * h;
      if (area > bestArea) {
        bestArea = area;
        best = [[r - h + 1, left], [r, right]];
      }
    }
  }

  return best;
}
