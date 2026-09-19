import { describe, it, expect } from "vitest";
import {
  analyzeCrime,
  analyzeAllCrimes,
  findBestCrime,
  fmtMoney,
  fmtExp,
  fmtPercent,
  CRIMES,
  type CrimeName,
} from "/controllers/crime";
import { mockNS } from "../helpers/mock-ns";

/** Build an ns stub with getCrimeStats/getCrimeChance driven by lookup tables. */
function crimeNS(
  stats: Record<string, Record<string, number>>,
  chances: Record<string, number>,
) {
  return mockNS({
    extra: {
      singularity: {
        getCrimeStats: (crime: string) => {
          if (!(crime in stats)) throw new Error(`no mock stats for ${crime}`);
          return stats[crime];
        },
        getCrimeChance: (crime: string) => {
          if (!(crime in chances)) throw new Error(`no mock chance for ${crime}`);
          return chances[crime];
        },
      },
    },
  });
}

describe("analyzeCrime", () => {
  // A crime that takes 30s (2 attempts/min) with round numbers, so
  // per-attempt vs per-minute math is easy to hand-check.
  const baseStats = {
    time: 30_000,
    money: 1000,
    hacking_exp: 10,
    strength_exp: 20,
    defense_exp: 30,
    dexterity_exp: 40,
    agility_exp: 50,
    charisma_exp: 60,
    karma: 4,
    kills: 1,
  };

  it("money and kills only pay out on success: full * chance * attemptsPerMin", () => {
    const ns = crimeNS({ Mug: baseStats }, { Mug: 0.5 });
    const a = analyzeCrime(ns, "Mug" as CrimeName);
    expect(a.timeSec).toBe(30);
    // attemptsPerMin = 60/30 = 2
    expect(a.moneyPerMin).toBeCloseTo(0.5 * 1000 * 2, 6); // 1000
    expect(a.killsPerMin).toBeCloseTo(0.5 * 1 * 2, 6); // 1
  });

  it("stat exp and karma still pay 25% on a failed attempt (per src/Work/CrimeWork.ts)", () => {
    const ns = crimeNS({ Mug: baseStats }, { Mug: 0.5 });
    const a = analyzeCrime(ns, "Mug" as CrimeName);
    // successOrFailFraction = chance + 0.25*(1-chance) = 0.5 + 0.125 = 0.625
    const frac = 0.625;
    const attemptsPerMin = 2;
    expect(a.strExpPerMin).toBeCloseTo(frac * 20 * attemptsPerMin, 6);
    expect(a.defExpPerMin).toBeCloseTo(frac * 30 * attemptsPerMin, 6);
    expect(a.dexExpPerMin).toBeCloseTo(frac * 40 * attemptsPerMin, 6);
    expect(a.agiExpPerMin).toBeCloseTo(frac * 50 * attemptsPerMin, 6);
    expect(a.hackExpPerMin).toBeCloseTo(frac * 10 * attemptsPerMin, 6);
    expect(a.chaExpPerMin).toBeCloseTo(frac * 60 * attemptsPerMin, 6);
    expect(a.karmaPerMin).toBeCloseTo(frac * 4 * attemptsPerMin, 6);
  });

  it("at chance=1, exp/karma reduce to the naive chance*value formula", () => {
    const ns = crimeNS({ Homicide: baseStats }, { Homicide: 1 });
    const a = analyzeCrime(ns, "Homicide" as CrimeName);
    expect(a.karmaPerMin).toBeCloseTo(1 * 4 * 2, 6);
    expect(a.strExpPerMin).toBeCloseTo(1 * 20 * 2, 6);
  });

  it("at chance=0, money/kills are 0 but exp/karma still get the 25% failure floor", () => {
    const ns = crimeNS({ Heist: baseStats }, { Heist: 0 });
    const a = analyzeCrime(ns, "Heist" as CrimeName);
    expect(a.moneyPerMin).toBe(0);
    expect(a.killsPerMin).toBe(0);
    expect(a.karmaPerMin).toBeCloseTo(0.25 * 4 * 2, 6);
    expect(a.strExpPerMin).toBeCloseTo(0.25 * 20 * 2, 6);
  });
});

describe("analyzeAllCrimes / findBestCrime", () => {
  // Give every crime the same shape but a distinct money value equal to its
  // index in CRIMES, so sort order is easy to assert.
  const stats: Record<string, Record<string, number>> = {};
  const chances: Record<string, number> = {};
  CRIMES.forEach((c, i) => {
    stats[c] = {
      time: 20_000,
      money: i,
      hacking_exp: 0,
      strength_exp: i * 2,
      defense_exp: 0,
      dexterity_exp: 0,
      agility_exp: 0,
      charisma_exp: 0,
      karma: 0,
      kills: 0,
    };
    chances[c] = 1;
  });

  it("sorts descending by the requested key", () => {
    const ns = crimeNS(stats, chances);
    const sorted = analyzeAllCrimes(ns, "moneyPerMin");
    const moneys = sorted.map((c) => c.moneyPerMin);
    expect(moneys).toEqual([...moneys].sort((a, b) => b - a));
    // Highest index (Heist, last in CRIMES) has the highest money.
    expect(sorted[0].crime).toBe(CRIMES[CRIMES.length - 1]);
  });

  it("sorts by a different key independently", () => {
    const ns = crimeNS(stats, chances);
    const sorted = analyzeAllCrimes(ns, "strExpPerMin");
    expect(sorted[0].crime).toBe(CRIMES[CRIMES.length - 1]);
  });

  it("findBestCrime returns the top of the sorted list", () => {
    const ns = crimeNS(stats, chances);
    expect(findBestCrime(ns, "moneyPerMin").crime).toBe(analyzeAllCrimes(ns, "moneyPerMin")[0].crime);
  });
});

describe("fmtMoney", () => {
  it("formats thousands/millions/billions/trillions with 2 decimals", () => {
    expect(fmtMoney(999)).toBe("999");
    expect(fmtMoney(1_500)).toBe("1.50k");
    expect(fmtMoney(2_500_000)).toBe("2.50m");
    expect(fmtMoney(3_500_000_000)).toBe("3.50b");
    expect(fmtMoney(4_500_000_000_000)).toBe("4.50t");
  });

  it("preserves sign and handles non-finite input", () => {
    expect(fmtMoney(-1_500)).toBe("-1.50k");
    expect(fmtMoney(NaN)).toBe("-");
    expect(fmtMoney(Infinity)).toBe("-");
  });
});

describe("fmtExp", () => {
  it("returns '-' for zero or non-finite, otherwise scales like fmtMoney", () => {
    expect(fmtExp(0)).toBe("-");
    expect(fmtExp(NaN)).toBe("-");
    expect(fmtExp(500)).toBe("500.0");
    expect(fmtExp(1_500)).toBe("1.5k");
    expect(fmtExp(2_500_000)).toBe("2.5m");
  });
});

describe("fmtPercent", () => {
  it("formats a 0-1 fraction as a percentage with one decimal", () => {
    expect(fmtPercent(0.5)).toBe("50.0%");
    expect(fmtPercent(1)).toBe("100.0%");
    expect(fmtPercent(0)).toBe("0.0%");
  });
});
