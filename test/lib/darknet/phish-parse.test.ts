/**
 * Unit tests for `parsePhishResult`, one case per phrasing
 * `handlePhishingAttack` produces (`src/DarkNet/effects/phishing.ts`):
 * a money reward (`formatNumber`-suffixed), a cache-file reward, and the
 * no-reward failure message. Phrasings are copied verbatim from that source.
 */
import { describe, it, expect } from "vitest";
import { parsePhishResult } from "/workers/dnet-phish";

describe("parsePhishResult", () => {
  it("parses a money reward with no suffix", () => {
    const message = "Phishing attack succeeded! $842.13 retrieved. (Gained 12.5 cha xp)";
    expect(parsePhishResult(message)).toEqual({ money: 842.13, cache: false });
  });

  it("parses a money reward suffixed 'k' (thousands)", () => {
    const message = "Phishing attack succeeded! $1.23k retrieved. (Gained 12.5 cha xp)";
    expect(parsePhishResult(message)).toEqual({ money: 1230, cache: false });
  });

  it("parses a money reward suffixed 'm' (millions)", () => {
    const message = "Phishing attack succeeded! $4.5m retrieved. (Gained 12.5 cha xp)";
    expect(parsePhishResult(message)).toEqual({ money: 4_500_000, cache: false });
  });

  it("parses a money reward suffixed 'b' (billions)", () => {
    const message = "Phishing attack succeeded! $12b retrieved. (Gained 12.5 cha xp)";
    expect(parsePhishResult(message)).toEqual({ money: 12_000_000_000, cache: false });
  });

  it("parses a money reward suffixed 't' (trillions)", () => {
    const message = "Phishing attack succeeded! $3t retrieved. (Gained 12.5 cha xp)";
    expect(parsePhishResult(message)).toEqual({ money: 3_000_000_000_000, cache: false });
  });

  it("recognises the cache-file reward message", () => {
    const message = "Phishing attack succeeded! Found a cache file. (Gained 12.5 cha xp)";
    expect(parsePhishResult(message)).toEqual({ money: 0, cache: true });
  });

  it("returns no reward for the no-takers failure message", () => {
    const message = "There were no takers on that phishing attempt. (Gained 3.1 cha xp)";
    expect(parsePhishResult(message)).toEqual({ money: 0, cache: false });
  });

  it("returns no reward for an unrecognised message", () => {
    expect(parsePhishResult("garbage nonsense")).toEqual({ money: 0, cache: false });
  });
});
