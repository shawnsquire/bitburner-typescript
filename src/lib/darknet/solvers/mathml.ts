/**
 * Darknet Solver: MathML (parsedExpression)
 *
 * Blind, one-attempt decode. `details.data` is an arithmetic expression,
 * optionally with the unicode operator swap (`ҳ÷➕➖` for multiply, divide,
 * add, subtract above difficulty 12) and/or a code-injection suffix (a literal `ns.exit(),`
 * inserted after the first `(`, or a `, !globalThis.pwn3d...` tail appended
 * to the whole expression).
 *
 * `cleanArithmeticExpression` and `parseSimpleArithmeticExpression` below are
 * ported VERBATIM from the game's
 * `src/DarkNet/controllers/ServerGenerator.ts` — pure, no imports, no
 * `eval`/`Function`. The checker (`isCloseToCorrectPassword`) is float-
 * tolerant, but the game's own generator sets `password` to
 * `${parseSimpleArithmeticExpression(expression)}` verbatim, so an exact
 * port (no extra rounding) also matches the rare string-equality path (e.g.
 * a `(3 - 3)` sub-expression divides by zero elsewhere in the tree and
 * yields the literal string `"Infinity"`, which only an exact port
 * reproduces).
 */
import { Solver } from "/lib/darknet/solvers/types";

/** Verbatim port of the game's `cleanArithmeticExpression`. */
function cleanArithmeticExpression(expression: string): string {
  const expressionWithFixedSymbols = expression
    .replaceAll("ҳ", "*")
    .replaceAll("÷", "/")
    .replaceAll("➕", "+")
    .replaceAll("➖", "-")
    .replaceAll("ns.exit(),", "");
  return expressionWithFixedSymbols.split(",")[0];
}

/** Verbatim port of the game's `parseSimpleArithmeticExpression`. */
function parseSimpleArithmeticExpression(expression: string): number {
  const tokens = cleanArithmeticExpression(expression).split("");

  // Identify parentheses
  let currentDepth = 0;
  const depth = tokens.map((token) => {
    if (token === "(") {
      currentDepth += 1;
    } else if (token === ")") {
      currentDepth -= 1;
      return currentDepth + 1;
    }
    return currentDepth;
  });
  const depth1Start = depth.indexOf(1);
  // find the last 1 before the first 0 after depth1Start
  const firstZeroAfterDepth1Start = depth.indexOf(0, depth1Start);
  const depth1End = firstZeroAfterDepth1Start === -1 ? depth.length - 1 : firstZeroAfterDepth1Start - 1;
  if (depth1Start !== -1) {
    const subExpression = tokens.slice(depth1Start + 1, depth1End).join("");
    const result = parseSimpleArithmeticExpression(subExpression);
    tokens.splice(depth1Start, depth1End - depth1Start + 1, result.toString());
    return parseSimpleArithmeticExpression(tokens.join(""));
  }

  // handle multiplication and division
  let remainingExpression = tokens.join("");

  // breakdown and explanation for this regex: https://regex101.com/r/mZhiBn/1
  const multiplicationDivisionRegex = /(-?\d*\.?\d+) *([*/]) *(-?\d*\.?\d+)/;
  let match = remainingExpression.match(multiplicationDivisionRegex);

  while (match) {
    const [__, left, operator, right] = match;
    const result = operator === "*" ? parseFloat(left) * parseFloat(right) : parseFloat(left) / parseFloat(right);
    const resultString = Math.abs(result) < 0.000001 ? result.toFixed(20) : result.toString();
    remainingExpression = remainingExpression.replace(match[0], resultString);
    match = remainingExpression.match(multiplicationDivisionRegex);
  }

  // handle addition and subtraction
  const additionSubtractionRegex = /(-?\d*\.?\d+) *([+-]) *(-?\d*\.?\d+)/;
  match = remainingExpression.match(additionSubtractionRegex);

  while (match) {
    const [__, left, operator, right] = match;
    const result = operator === "+" ? parseFloat(left) + parseFloat(right) : parseFloat(left) - parseFloat(right);
    remainingExpression = remainingExpression.replace(match[0], result.toString());
    match = remainingExpression.match(additionSubtractionRegex);
  }

  const [__, leftover] = remainingExpression.match(/(-?\d*\.?\d+)/) ?? ["", ""];

  return parseFloat(leftover);
}

interface MathMlState {
  attempt: string;
}

export const mathml: Solver<MathMlState> = {
  id: "MathML",
  blind: true,

  start(details): MathMlState {
    const result = parseSimpleArithmeticExpression(details.data);
    return { attempt: String(result) };
  },

  next(state, feedback) {
    if (feedback !== null) {
      return { giveUp: true, reason: "decode should succeed in one attempt" };
    }
    return { attempt: state.attempt, state };
  },
};
