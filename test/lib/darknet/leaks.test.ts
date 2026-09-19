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

  it("splits 'Connecting to <host>:<password> ...' on the LAST colon, not the first", () => {
    // Real darknet hostnames can contain colons (`connectors` includes ":" and "::" in
    // dictionaryData.ts). Passwords never contain a colon, so the last colon is always the
    // host/password boundary.
    expect(parseLeak("Connecting to bit::sys:abc123 ...")).toEqual({
      t: "leak",
      host: "bit::sys",
      password: "abc123",
      line: "Connecting to bit::sys:abc123 ...",
    });
    expect(parseLeak("Connecting to neo:corp:xyz789 ...")).toEqual({
      t: "leak",
      host: "neo:corp",
      password: "xyz789",
      line: "Connecting to neo:corp:xyz789 ...",
    });
  });

  it("still recognises a plain colon-free host in 'Connecting to <host>:<password> ...'", () => {
    const line = "Connecting to foodnstuff:hunter2 ...";
    expect(parseLeak(line)).toEqual({ t: "leak", host: "foodnstuff", password: "hunter2", line });
  });

  it("allows a space-containing password in 'Connecting to <host>:<password> ...'", () => {
    // `EUCountries` entries like "Czech Republic" can be used as passwords.
    const line = "Connecting to host:Czech Republic ...";
    expect(parseLeak(line)).toEqual({ t: "leak", host: "host", password: "Czech Republic", line });
  });

  it("allows a space-containing password in '--<password>--'", () => {
    // `EUCountries` entries like "Republic of Cyprus" can be used as passwords.
    const line = "--Republic of Cyprus--";
    expect(parseLeak(line)).toEqual({ t: "leak", host: null, password: "Republic of Cyprus", line });
  });

  it("recognises 'Logging in with passcode: <password> ...' with an unknown host", () => {
    const line = "Logging in with passcode: hunter2 ...";
    expect(parseLeak(line)).toEqual({ t: "leak", host: null, password: "hunter2", line });
  });

  it("allows a space-containing password in 'Logging in with passcode: <password> ...'", () => {
    const line = "Logging in with passcode: Czech Republic ...";
    expect(parseLeak(line)).toEqual({ t: "leak", host: null, password: "Czech Republic", line });
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
