/**
 * Darknet Solver: EuroZone Free
 *
 * EUCountryDictionary servers pick the password from the game's
 * `EUCountries` array (src/DarkNet/models/dictionaryData.ts), copied
 * verbatim below. Blind dictionary attack: try each entry in order.
 */
import { Solver } from "/lib/darknet/solvers/types";

// Copied verbatim from the game's `EUCountries`.
const EU_COUNTRIES = [
  "Austria",
  "Belgium",
  "Bulgaria",
  "Croatia",
  "Republic of Cyprus",
  "Czech Republic",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Ireland",
  "Italy",
  "Latvia",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Netherlands",
  "Poland",
  "Portugal",
  "Romania",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden",
] as const;

interface State {
  index: number;
}

export const eurozone: Solver<State> = {
  id: "EuroZone Free",
  blind: true,
  start: () => ({ index: 0 }),
  next: (state) => {
    if (state.index >= EU_COUNTRIES.length) {
      return { giveUp: true, reason: "exhausted dictionary" };
    }
    return { attempt: EU_COUNTRIES[state.index], state: { index: state.index + 1 } };
  },
};
