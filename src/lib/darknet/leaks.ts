/**
 * Darknet Log-Noise Leak Parser
 *
 * The game's log noise generators (`src/DarkNet/models/packetSniffing.ts`:
 * `getLogNoise`, `getRandomData`, `addPacketSnifferNoise`,
 * `getRandomCharsInPassword`, `getExactCharactersHint`) occasionally leak
 * real credential material into otherwise-cosmetic log lines. This
 * recognises those exact phrasings and turns them into `ReportEvent`s the
 * coordinator can act on. Best-effort: a line matching nothing recognised
 * returns null.
 *
 * Import with: import { parseLeak } from "/lib/darknet/leaks";
 */
import type { ReportEvent } from "/lib/darknet/protocol";

// `Connecting to ${name}:${password} ...` -- both `getLogNoise`'s neighbour
// leak and `addPacketSnifferNoise`'s use this exact shape. Hostnames are built
// from dictionary words joined by `connectors` (dictionaryData.ts), which
// includes ":" and "::", so the host itself can contain colons. Passwords are
// generated from digits/letters/dictionary words (including EU country names
// with spaces, e.g. "Republic of Cyprus") and never contain a colon, so the
// robust split is on the LAST colon rather than a colon-free host regex.
const CONNECTING_PREFIX = "Connecting to ";
const CONNECTING_SUFFIX = " ...";

// `Logging in with passcode: ${password} ...` -- `addPacketSnifferNoise`'s
// fallback when the server has no neighbours to connect to.
const PASSCODE_PREFIX = "Logging in with passcode: ";

// `--${password}--` -- a random server's password, host unknown. Non-greedy
// so a password containing spaces (but never "--") still matches.
const DASH_RE = /^--(.+?)--$/;

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
  if (line.startsWith(CONNECTING_PREFIX) && line.endsWith(CONNECTING_SUFFIX)) {
    const body = line.slice(CONNECTING_PREFIX.length, line.length - CONNECTING_SUFFIX.length);
    const colonIdx = body.lastIndexOf(":");
    if (colonIdx > 0 && colonIdx < body.length - 1) {
      const host = body.slice(0, colonIdx);
      const password = body.slice(colonIdx + 1);
      return { t: "leak", host, password, line };
    }
  }

  if (line.startsWith(PASSCODE_PREFIX) && line.endsWith(CONNECTING_SUFFIX)) {
    const password = line.slice(PASSCODE_PREFIX.length, line.length - CONNECTING_SUFFIX.length);
    if (password.length > 0) return { t: "leak", host: null, password, line };
  }

  let m = DASH_RE.exec(line);
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
