/**
 * Darknet Solver: KingOfTheHill
 *
 * globalMaxima servers hide the password as the peak of a landscape:
 * `feedback.data` is an altitude reading for the attempted (numeric) x,
 * from the game's `getKingOfTheHillAltitude`. The true peak (10,000 m, at
 * x = password) sits among `hillCount = min(floor(difficulty/8),4)*2+1`
 * hills total, each offset from the main hill by
 * `(i - passwordHillIndex) * width * 3 * (0.9..1.1)` -- i.e. decoys sit at
 * roughly `n * 3 * width` from the password, for integer `n`, with only
 * ~10% jitter (`width = 10**max(len-2,0)+1`, computable in advance, no
 * probing needed). Every decoy is strictly shorter than the main hill
 * (`10000 - |n|*2600*(0.95..1.05)`), and neighbouring hills contribute
 * negligibly at that spacing, so *locally* the landscape is an exact,
 * clean single Gaussian: `altitude(x) = height * exp(-((x-peak)/width)^2)`.
 * Deterministic too (re-seeded per call from the password), so repeated
 * probes of the same x always agree.
 *
 * A coarse grid that's fine enough to directly land within a fraction of a
 * width of the (often very narrow) main hill would need on the order of
 * domain/width samples -- far more than the attempt budget allows. So
 * instead of searching blindly:
 *  1. Coarse scan across the full domain, and zoom in (halving the window
 *     each round) on the single best sample to get an exact reading of
 *     THAT hill's true height and location (two probes on a known-width
 *     Gaussian solve for both algebraically).
 *  2. If that height is already close to 10,000, it IS the main hill --
 *     done. Otherwise its height reveals `n` (how many hill-slots away
 *     from main it is), which predicts the main hill's approximate
 *     location on EITHER side: `anchor ± n*3*width`, accurate to the
 *     game's ~10% jitter. A short targeted scan across that (now narrow,
 *     known) window finds it directly, on both the `+` and `-` side.
 *  3. Zoom in and exact-solve each of those two candidates the same way as
 *     the anchor, and take whichever of the three (anchor, minus-side,
 *     plus-side) reads tallest -- that is the main hill, and its solved
 *     location is the password.
 */
import { Solver, SolverDetails } from "/lib/darknet/solvers/types";

type Stage = "coarse" | "zoomAnchor" | "scanA" | "zoomA" | "scanB" | "zoomB" | "scanC" | "zoomC" | "verify" | "done";
type ZoomStage = "refine" | "solve";

interface Sample {
  x: number;
  alt: number;
}

interface Result {
  x: number;
  height: number;
}

interface State {
  low: number;
  high: number;
  width: number;
  hillCount: number;
  stage: Stage;

  queue: number[]; // remaining probe x-values for the activity in progress
  coarseSamples: Sample[];
  coarseStep: number;

  zoomBest: Sample;
  zoomWindow: number;
  zoomStage: ZoomStage;

  anchorX: number; // the refined anchor's location, for predicting window B from the same n
  predictedN: number;
  results: Result[];

  verifyBest: Sample;

  rawBest: Sample; // highest-altitude sample seen anywhere -- last-resort fallback
}

const COARSE_POINTS = 17;
const REFINE_THRESHOLD_WIDTHS = 1.2; // stop zooming once the window is this many widths wide
const MIN_TRUSTED_ALT = 1e-6; // below this, treat a reading as background noise, not a hill
const MAIN_HEIGHT_THRESHOLD = 8200; // no decoy (n>=1) can read above ~7530; safely above that
const WINDOW_SCAN_POINTS = 7;
const WINDOW_JITTER = 0.5; // the game's offset jitter is +-10%; scan a wider margin than that (our `n` estimate can itself be off by one slot when the anchor's own reading is contaminated)

function evenPoints(lo: number, hi: number, count: number): number[] {
  if (hi <= lo) return [Math.round(lo)];
  if (count <= 1) return [Math.round((lo + hi) / 2)];
  const pts = new Set<number>();
  for (let i = 0; i < count; i++) {
    pts.add(Math.round(lo + ((hi - lo) * i) / (count - 1)));
  }
  return [...pts];
}

/** Solve `height*exp(-((x-p)/width)^2)` for `p` and `height` given two samples. */
function solveExact(x1: number, alt1: number, x2: number, alt2: number, width: number): { p: number; height: number } {
  const ln1 = Math.log(alt1);
  const ln2 = Math.log(alt2);
  const p = (x1 + x2) / 2 - ((ln1 - ln2) * (width * width)) / (2 * (x2 - x1));
  const height = alt1 * Math.exp(((x1 - p) / width) ** 2);
  return { p, height };
}

function isTrustworthy(state: State, alt1: number, alt2: number, p: number, anchorX: number, height: number): boolean {
  return (
    alt1 > MIN_TRUSTED_ALT &&
    alt2 > MIN_TRUSTED_ALT &&
    Number.isFinite(height) &&
    height > 0 &&
    height <= 10001 &&
    Math.abs(p - anchorX) <= 5 * state.width
  );
}

/**
 * The game only simplifies to a single clean Gaussian within 3% of the
 * ACTUAL password -- which can be smaller than one `width` for a password
 * near the low end of its digit-length's range (width is sized off the
 * length alone, but 3%*password varies 10x across that range). So the
 * "close enough" radius has to be judged from our current best x estimate,
 * not from width alone, with margin below the game's 3% cutoff.
 */
function cleanRadius(x: number, width: number): number {
  return Math.min(REFINE_THRESHOLD_WIDTHS * width, 0.02 * Math.max(x, 1));
}

/** Next probe(s) needed to zoom the current candidate in, or [] once tight enough. */
function nextZoomProbes(state: State): number[] {
  const threshold = cleanRadius(state.zoomBest.x, state.width);
  if (state.zoomWindow <= threshold) return [];
  const left = Math.round(Math.max(state.low, state.zoomBest.x - state.zoomWindow));
  const right = Math.round(Math.min(state.high, state.zoomBest.x + state.zoomWindow));
  return [...new Set([left, right])].filter((p) => p !== state.zoomBest.x);
}

/**
 * Offset for the exact-solve's second probe. Too small (e.g. 1) and, right
 * next to the peak, the ln(altitude) difference between the two points is
 * dominated by floating-point noise rather than the main hill's own
 * curvature, throwing the solved peak off by more than rounding to the
 * nearest integer can absorb -- but it also has to stay inside the same
 * (possibly narrower-than-a-width) clean radius as the refine loop, or the
 * two points aren't reading the same single Gaussian any more.
 */
function solveOffset(state: State, from: Sample): number {
  return Math.max(1, Math.round(Math.min(state.width / 3, cleanRadius(from.x, state.width) / 2)));
}

function solveSecondProbe(state: State, from: Sample): number {
  const offset = solveOffset(state, from);
  return from.x + offset <= state.high ? from.x + offset : from.x - offset;
}

/** Start (or continue) zooming in on `seed`, from stage `nextStage` once solved. */
function beginZoom(state: State, seed: Sample, window: number): { attempt: string; state: State } {
  const withZoom: State = { ...state, zoomBest: seed, zoomWindow: window, zoomStage: "refine" };
  const probes = nextZoomProbes(withZoom);
  if (probes.length === 0) {
    const x2 = solveSecondProbe(withZoom, seed);
    return { attempt: x2.toString(), state: { ...withZoom, zoomStage: "solve" } };
  }
  const [x, ...rest] = probes;
  return { attempt: x.toString(), state: { ...withZoom, queue: rest } };
}

/** Begin a short scan across a predicted window, looking for the hill hiding there. */
function beginWindowScanAt(
  state: State,
  lo: number,
  hi: number,
  stage: "scanA" | "scanB" | "scanC",
): { attempt: string; state: State } {
  const points = evenPoints(Math.max(state.low, lo), Math.min(state.high, hi), WINDOW_SCAN_POINTS);
  const [x, ...rest] = points;
  return { attempt: x.toString(), state: { ...state, stage, queue: rest, coarseSamples: [] } };
}

/**
 * The exact-solve's rounding can land one integer off the true peak when a
 * probe just barely strayed outside the (password-dependent, not always
 * width-sized) clean zone. Rather than trust that rounding blindly, probe
 * the winning integer and its immediate neighbours directly and submit
 * whichever reads highest -- next to the real peak, even a 1-unit offset
 * reads measurably lower, so three adjacent integer samples pin down the
 * exact answer regardless of how the solve's estimate rounded.
 */
function finish(state: State): { attempt: string; state: State } {
  const valid = state.results.filter((r) => r.height > -Infinity);
  let winnerX = state.rawBest.x;
  if (valid.length > 0) {
    let best = valid[0];
    for (const r of valid) if (r.height > best.height) best = r;
    winnerX = best.x;
  }
  const center = Math.round(Math.max(state.low, Math.min(state.high, winnerX)));
  const points = [...new Set([center - 1, center, center + 1])]
    .filter((p) => p >= state.low && p <= state.high)
    .sort((a, b) => a - b);
  const [x, ...rest] = points;
  return {
    attempt: x.toString(),
    state: { ...state, stage: "verify", queue: rest, verifyBest: { x, alt: -Infinity } },
  };
}

export const kingOfTheHill: Solver<State> = {
  id: "KingOfTheHill",
  blind: false,
  start: (details: SolverDetails): State => {
    const len = details.passwordLength;
    const low = len <= 1 ? 0 : 10 ** (len - 1);
    const high = 10 ** len - 1;
    const width = 10 ** Math.max(len - 2, 0) + 1;
    const hillCount = Math.min(Math.floor(details.difficulty / 8), 4) * 2 + 1;
    const queue = evenPoints(low, high, COARSE_POINTS);
    return {
      low,
      high,
      width,
      hillCount,
      stage: "coarse",
      queue,
      coarseSamples: [],
      coarseStep: (high - low) / Math.max(queue.length - 1, 1),
      zoomBest: { x: low, alt: -Infinity },
      zoomWindow: 0,
      zoomStage: "refine",
      anchorX: low,
      predictedN: 0,
      results: [],
      verifyBest: { x: low, alt: -Infinity },
      rawBest: { x: low, alt: -Infinity },
    };
  },
  next: (state, feedback) => {
    if (feedback === null) {
      const [x, ...rest] = state.queue;
      return { attempt: x.toString(), state: { ...state, queue: rest } };
    }
    if (feedback.data === undefined) {
      return { giveUp: true, reason: "needs heartbleed" };
    }
    if (state.stage === "done") {
      return { giveUp: true, reason: "reconstruction mismatch" };
    }

    const x = Number(feedback.passwordAttempted);
    const rawAlt = Number(feedback.data);
    const alt = Number.isFinite(rawAlt) && rawAlt > 0 ? rawAlt : Number.MIN_VALUE;
    const rawBest = alt > state.rawBest.alt ? { x, alt } : state.rawBest;

    if (state.stage === "verify") {
      const verifyBest = alt > state.verifyBest.alt ? { x, alt } : state.verifyBest;
      if (state.queue.length > 0) {
        const [nx, ...rest] = state.queue;
        return { attempt: nx.toString(), state: { ...state, queue: rest, verifyBest, rawBest } };
      }
      return { attempt: verifyBest.x.toString(), state: { ...state, verifyBest, rawBest, stage: "done" } };
    }

    if (state.stage === "coarse") {
      const coarseSamples = [...state.coarseSamples, { x, alt }];
      if (state.queue.length > 0) {
        const [nx, ...rest] = state.queue;
        return { attempt: nx.toString(), state: { ...state, queue: rest, coarseSamples, rawBest } };
      }
      let seed = coarseSamples[0];
      for (const s of coarseSamples) if (s.alt > seed.alt) seed = s;
      return beginZoom({ ...state, stage: "zoomAnchor", coarseSamples, rawBest }, seed, state.coarseStep);
    }

    if (state.stage === "scanA" || state.stage === "scanB" || state.stage === "scanC") {
      const coarseSamples = [...state.coarseSamples, { x, alt }];
      if (state.queue.length > 0) {
        const [nx, ...rest] = state.queue;
        return { attempt: nx.toString(), state: { ...state, queue: rest, coarseSamples, rawBest } };
      }
      let seed = coarseSamples[0];
      for (const s of coarseSamples) if (s.alt > seed.alt) seed = s;
      const window = (coarseSamples[coarseSamples.length - 1].x - coarseSamples[0].x) / (WINDOW_SCAN_POINTS - 1) || state.width;
      const nextStage = state.stage === "scanA" ? "zoomA" : state.stage === "scanB" ? "zoomB" : "zoomC";
      return beginZoom({ ...state, stage: nextStage, coarseSamples: [], rawBest }, seed, window);
    }

    // stage is zoomAnchor / zoomA / zoomB
    if (state.zoomStage === "refine") {
      const zoomBest = alt > state.zoomBest.alt ? { x, alt } : state.zoomBest;

      if (state.queue.length > 0) {
        const [nx, ...rest] = state.queue;
        return { attempt: nx.toString(), state: { ...state, queue: rest, zoomBest, rawBest } };
      }

      const shrunk: State = { ...state, zoomBest, zoomWindow: state.zoomWindow / 2, rawBest };
      const probes = nextZoomProbes(shrunk);
      if (probes.length === 0) {
        const x2 = solveSecondProbe(shrunk, zoomBest);
        return { attempt: x2.toString(), state: { ...shrunk, zoomStage: "solve" } };
      }
      const [nx, ...rest] = probes;
      return { attempt: nx.toString(), state: { ...shrunk, queue: rest } };
    }

    // zoomStage === "solve"
    const { p, height } = solveExact(state.zoomBest.x, state.zoomBest.alt, x, alt, state.width);
    const trustworthy = isTrustworthy(state, state.zoomBest.alt, alt, p, state.zoomBest.x, height);
    const result: Result = { x: p, height: trustworthy ? height : -Infinity };
    const results = [...state.results, result];

    if (state.stage === "zoomAnchor") {
      if (result.height >= MAIN_HEIGHT_THRESHOLD) {
        return finish({ ...state, results, rawBest });
      }
      // The solve can come back untrustworthy (a decoy region's own noise
      // can still be too contaminated to clean-solve exactly). Fall back to
      // the raw zoomBest reading to estimate `n` and the anchor position --
      // a real observed sample, even if not clean enough to solve exactly.
      const anchorHeight = trustworthy ? result.height : state.zoomBest.alt;
      const anchorX = trustworthy ? result.x : state.zoomBest.x;
      if (anchorHeight >= MAIN_HEIGHT_THRESHOLD) {
        return finish({ ...state, results: [...results, { x: anchorX, height: anchorHeight }], rawBest });
      }
      const n = Math.max(1, Math.min(state.hillCount - 1, Math.round((10000 - anchorHeight) / 2600)));
      const offset = n * 3 * state.width;
      const loA = anchorX - offset * (1 + WINDOW_JITTER);
      const hiA = anchorX - offset * (1 - WINDOW_JITTER);
      return beginWindowScanAt({ ...state, results, rawBest, anchorX, predictedN: n }, loA, hiA, "scanA");
    }

    if (state.stage === "zoomA") {
      const offset = state.predictedN * 3 * state.width;
      const loB = state.anchorX + offset * (1 - WINDOW_JITTER);
      const hiB = state.anchorX + offset * (1 + WINDOW_JITTER);
      return beginWindowScanAt({ ...state, results, rawBest }, loB, hiB, "scanB");
    }

    if (state.stage === "zoomB") {
      const settled = { ...state, results, rawBest };
      if (results.some((r) => r.height >= MAIN_HEIGHT_THRESHOLD)) return finish(settled);

      // Neither predicted side panned out. If both found a REAL (trustworthy)
      // decoy, and main sits between two same-side-count decoys (e.g. both
      // one hill-slot away, one on each side), its midpoint is a strong last
      // guess -- worth one more zoom before falling back to the best of what
      // we've already got.
      const [, resA, resB] = results;
      if (resA && resB && resA.height > -Infinity && resB.height > -Infinity) {
        const mid = (resA.x + resB.x) / 2;
        const span = Math.max(state.width * 2, Math.abs(resA.x - resB.x) / 4);
        return beginWindowScanAt(settled, mid - span, mid + span, "scanC");
      }
      return finish(settled);
    }

    // stage === "zoomC": every candidate collected.
    return finish({ ...state, results, rawBest });
  },
};
