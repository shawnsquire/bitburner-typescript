/**
 * Darknet Log-Noise Leak Parser
 *
 * The game's log noise generators (`src/DarkNet/models/packetSniffing.ts`:
 * `getLogNoise`, `getRandomData`, `getRandomCharsInPassword`,
 * `getExactCharactersHint`) occasionally leak real credential material into
 * otherwise-cosmetic log lines. This recognises those exact phrasings and
 * turns them into `ReportEvent`s the coordinator can act on. Best-effort: a
 * line matching nothing recognised returns null.
 *
 * Import with: import { parseLeak } from "/lib/darknet/leaks";
 */
import type { ReportEvent } from "/lib/darknet/protocol";

// `Connecting to ${name}:${password} ...` -- both `getLogNoise`'s neighbour
// leak and `addPacketSnifferNoise`'s use this exact shape.
const CONNECTING_RE = /^Connecting to ([^:\s]+):(\S+) \.\.\.$/;

// `--${password}--` -- a random server's password, host unknown.
const DASH_RE = /^--(\S+)--$/;

// Every phrasing in `getRandomCharsInPassword`, verbatim.
const PRESENT_CHARS_RES: RegExp[] = [
  /^There's definitely a (.) and a (.)\.\.\.$/,
  /^I can see a (.) and a (.)\.$/,
  /^I must use (.) & (.)!$/,
  /^Did it have a (.) and a (.)\?$/,
  /^Note to self: (.) and (.) are important\.$/,
  /^I think (.) with (.) is key\.$/,
  /^I need to remember (.) 'n (.)\.$/,
  /^Theres a (.), and maybe a (.)\.\.\.$/,
];

// `The characters ${rightChars.join(", ")} are in the right place. ` from
// `getExactCharactersHint` (1 or 2 characters; trailing space is exact).
const PLACED_RE = /^The characters (.+) are in the right place\.\s*$/;

export function parseLeak(line: string): ReportEvent | null {
  let m = CONNECTING_RE.exec(line);
  if (m) return { t: "leak", host: m[1], password: m[2], line };

  m = DASH_RE.exec(line);
  if (m) return { t: "leak", host: null, password: m[1], line };

  for (const re of PRESENT_CHARS_RES) {
    m = re.exec(line);
    if (m) return { t: "leak", host: null, present: [m[1], m[2]], line };
  }

  m = PLACED_RE.exec(line);
  if (m) {
    const placed = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (placed.length > 0) return { t: "leak", host: null, placed, line };
  }

  return null;
}
