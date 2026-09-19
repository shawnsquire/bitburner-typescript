/**
 * Darknet Solver: OctantVoxel (ConvertToBase10)
 *
 * Blind, one-attempt decode. `details.data` is `"<base>,<encoded>"`; base may
 * be fractional above difficulty 12. `parseBaseNNumberString` is ported
 * verbatim from the game's `src/DarkNet/controllers/ServerGenerator.ts` (the
 * inverse of its `encodeNumberInBaseN`), using the same `0-9A-Z` digit
 * alphabet. The checker (`isCloseToCorrectPassword`) accepts within ±0.01 or
 * 0.5%, so no extra rounding is applied here.
 */
import { Solver } from "/lib/darknet/solvers/types";

const NUMBERS = "0123456789";
const LETTERS_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE_N_CHARACTERS = [...NUMBERS.split(""), ...LETTERS_UPPERCASE.split("")];

/** Verbatim port of the game's `parseBaseNNumberString`. */
function parseBaseNNumberString(numberString: string, base: number): number {
  let result = 0;
  let index = 0;
  let digit = numberString.split(".")[0].length - 1;

  while (index < numberString.length) {
    const currentDigit = numberString[index];
    if (currentDigit === ".") {
      index += 1;
      continue;
    }
    result += BASE_N_CHARACTERS.indexOf(currentDigit) * base ** digit;
    index += 1;
    digit -= 1;
  }

  return result;
}

interface OctantVoxelState {
  attempt: string;
}

export const octantVoxel: Solver<OctantVoxelState> = {
  id: "OctantVoxel",
  blind: true,

  start(details): OctantVoxelState {
    const commaIndex = details.data.indexOf(",");
    const base = Number(details.data.slice(0, commaIndex));
    const encoded = details.data.slice(commaIndex + 1);
    const result = parseBaseNNumberString(encoded, base);
    return { attempt: String(result) };
  },

  next(state, feedback) {
    if (feedback !== null) {
      return { giveUp: true, reason: "decode should succeed in one attempt" };
    }
    return { attempt: state.attempt, state };
  },
};
