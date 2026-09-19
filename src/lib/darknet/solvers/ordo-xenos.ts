/**
 * Darknet Solver: OrdoXenos
 *
 * encryptedPassword servers publish `passwordHintData` as
 * `"<encrypted>;<mask1 mask2 ...>"`, where each mask is an 8-bit binary
 * string and `encrypted[i] = password[i] ^ mask[i]` (see the game's
 * `getXorMaskEncryptedPasswordConfig`). XOR each encrypted character back
 * against its mask to recover the password. One attempt.
 */
import { Solver, SolverDetails } from "/lib/darknet/solvers/types";

interface State {
  tried: boolean;
  password: string;
}

function decodeXor(data: string): string {
  const separatorIndex = data.indexOf(";");
  if (separatorIndex === -1) return "";
  const encrypted = data.slice(0, separatorIndex);
  const masks = data
    .slice(separatorIndex + 1)
    .trim()
    .split(/\s+/);

  let password = "";
  for (let i = 0; i < encrypted.length; i++) {
    const mask = masks[i] ?? "00000000";
    password += String.fromCharCode(encrypted.charCodeAt(i) ^ parseInt(mask, 2));
  }
  return password;
}

export const ordoXenos: Solver<State> = {
  id: "OrdoXenos",
  blind: true,
  start: (details: SolverDetails) => ({ tried: false, password: decodeXor(details.data) }),
  next: (state) => {
    if (state.tried) return { giveUp: true, reason: "exhausted dictionary" };
    return { attempt: state.password, state: { ...state, tried: true } };
  },
};
