/**
 * Unit tests for `parseLeak`, one case per phrasing recognised from the
 * game's log-noise generators (`src/DarkNet/models/packetSniffing.ts`:
 * `getLogNoise`, `getRandomCharsInPassword`, `getExactCharactersHint`),
 * plus a non-match. Phrasings are copied verbatim from that source.
 */
import { describe, it, expect } from "vitest";
import { parseLeak } from "/lib/darknet/leaks";

describe("parseLeak", () => {
  it("recognises 'Connecting to <host>:<password> ...'", () => {
    const line = "Connecting to foodnstuff:hunter2 ...";
    expect(parseLeak(line)).toEqual({ t: "leak", host: "foodnstuff", password: "hunter2", line });
  });

  it("recognises '--<password>--' with an unknown host", () => {
    const line = "--sw0rdf1sh--";
    expect(parseLeak(line)).toEqual({ t: "leak", host: null, password: "sw0rdf1sh", line });
  });

  it.each([
    "There's definitely a x and a y...",
    "I can see a x and a y.",
    "I must use x & y!",
    "Did it have a x and a y?",
    "Note to self: x and y are important.",
    "I think x with y is key.",
    "I need to remember x 'n y.",
    "Theres a x, and maybe a y...",
  ])("recognises the 'present characters' phrasing %j", (line) => {
    expect(parseLeak(line)).toEqual({ t: "leak", host: null, present: ["x", "y"], line });
  });

  it("recognises 'The characters X, Y are in the right place.' (two characters)", () => {
    const line = "The characters 4, 2 are in the right place. ";
    expect(parseLeak(line)).toEqual({ t: "leak", host: null, placed: ["4", "2"], line });
  });

  it("recognises the exact-characters hint with a single character", () => {
    const line = "The characters 7 are in the right place. ";
    expect(parseLeak(line)).toEqual({ t: "leak", host: null, placed: ["7"], line });
  });

  it("returns null for an unrecognised line", () => {
    expect(parseLeak("14:32:07: n00dles - heartbeat check (alive)")).toBeNull();
  });

  it("returns null for noise that merely resembles a leak", () => {
    expect(parseLeak("No characters are in the right place.")).toBeNull();
    expect(parseLeak("There's definitely nothing in that password...")).toBeNull();
  });
});
