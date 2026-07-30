/**
 * Round-trip tests for the region <-> curve projection
 * (yarn test:regioncurve).
 *
 * This is the objective measure of the whole adaptation: the editor may
 * only run on upstream's data model if a lane survives the trip in both
 * directions. What is asserted, per the merge plan's verification section:
 *
 * - VALUE EQUIVALENCE, sampled: evaluating the original region list and the
 *   round-tripped one at many times agrees within tolerance. Never byte
 *   equality — upstream's own loader refits legacy shapes, so tolerance is
 *   the honest bar.
 * - IDEMPOTENCE: the second round trip changes nothing structurally. A
 *   projection that keeps re-fitting would drift a little on every save.
 * - VOCABULARY: only curve / periodic / audio are ever written for scalar
 *   params. Writing flat / linear / easing / spline would be rewritten by
 *   upstream's loader on the next open, which is drift by construction.
 * - TILING: regions sum to the block's duration, which is what upstream's
 *   own lane-editing operations assume.
 * - Fraction/seconds conversion is correct for blocks that do not start at
 *   zero, not just the full-song default.
 */
import {
  CurveVariation,
  makeCurveNode,
} from "@/src/types/Variations/CurveVariation";
import { PeriodicVariation } from "@/src/types/Variations/PeriodicVariation";
import { AudioVariation } from "@/src/types/Variations/AudioVariation";
import { FlatVariation } from "@/src/types/Variations/FlatVariation";
import { LinearVariation } from "@/src/types/Variations/LinearVariation";
import { EasingVariation } from "@/src/types/Variations/EasingVariation";
import { Variation } from "@/src/types/Variations/Variation";
import type { Store } from "@/src/types/Store";
import {
  variationsToCurve,
  curveToVariations,
  RegionContext,
} from "@/src/components/EditorV2/regionCurve";


let failures = 0;
const fail = (message: string) => {
  failures++;
  console.error(`  FAIL: ${message}`);
};

// AudioVariation reads the song's loudness envelope through the store. The
// projection itself never evaluates one, but the equivalence check does, so
// the stub supplies a deterministic synthetic envelope: any stable function
// of time works, since both sides of the comparison see the same one.
const stubStore = {
  audioStore: {
    getSmoothedPeakAtTime: (globalTime: number, smoothing: number) =>
      0.5 + 0.5 * Math.sin(globalTime * 1.7 + smoothing),
  },
} as unknown as Store;

/** Value of a region list at block-local seconds t, with upstream's hold. */
const evaluateRegions = (variations: Variation[], t: number): number => {
  let cursor = 0;
  for (const variation of variations) {
    if (t < cursor + variation.duration) {
      const value = (variation as Variation<number>).valueAtTime(
        t - cursor,
        t - cursor,
      );
      return typeof value === "number" ? value : 0;
    }
    cursor += variation.duration;
  }
  // Past the end, upstream holds the last region's final value.
  const last = variations[variations.length - 1];
  if (!last) return 0;
  const value = (last as Variation<number>).valueAtTime(
    last.duration,
    last.duration,
  );
  return typeof value === "number" ? value : 0;
};

const SCALAR_TYPES = new Set(["curve", "periodic", "audio"]);

const checkVocabulary = (label: string, variations: Variation[]) => {
  for (const variation of variations)
    if (!SCALAR_TYPES.has(variation.type))
      fail(
        `${label}: wrote "${variation.type}" — upstream's loader rewrites it, so it must not be emitted`,
      );
};

const checkTiling = (
  label: string,
  variations: Variation[],
  blockDuration: number,
) => {
  const total = variations.reduce((sum, v) => sum + v.duration, 0);
  if (Math.abs(total - blockDuration) > 1e-6)
    fail(
      `${label}: regions total ${total.toFixed(6)}s, block is ${blockDuration}s`,
    );
};

/** Sampled agreement between two region lists across the block. */
const checkEquivalence = (
  label: string,
  before: Variation[],
  after: Variation[],
  ctx: RegionContext,
  tolerance: number,
) => {
  const samples = 400;
  let worst = 0;
  let worstAt = 0;
  const values: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * ctx.blockDuration;
    values.push(evaluateRegions(before, t));
  }
  const span = Math.max(Math.max(...values) - Math.min(...values), 1e-6);
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * ctx.blockDuration;
    const error = Math.abs(evaluateRegions(before, t) - evaluateRegions(after, t));
    if (error > worst) {
      worst = error;
      worstAt = t;
    }
  }
  const relative = worst / span;
  if (relative > tolerance)
    fail(
      `${label}: worst deviation ${relative.toFixed(4)} of span (abs ${worst.toFixed(
        4,
      )}) at t=${worstAt.toFixed(3)}s, tolerance ${tolerance}`,
    );
  return relative;
};

/** Structural fingerprint, for the idempotence check. */
const shapeOf = (variations: Variation[]) =>
  variations
    .map((v) => {
      const nodes = v instanceof CurveVariation ? v.nodes.length : 0;
      return `${v.type}:${v.duration.toFixed(6)}:${nodes}`;
    })
    .join("|");

type Case = {
  name: string;
  variations: () => Variation[];
  ctx: RegionContext;
  tolerance: number;
};

const fullSong: RegionContext = {
  blockStartTime: 0,
  blockDuration: 120,
  songDuration: 120,
};

// A block that neither starts at zero nor fills the song: the case where a
// fraction/seconds mistake shows up as a visible time shift.
const offsetBlock: RegionContext = {
  blockStartTime: 30,
  blockDuration: 45,
  songDuration: 200,
};

const cases: Case[] = [
  {
    name: "flat",
    variations: () => [new FlatVariation(120, 0.42)],
    ctx: fullSong,
    tolerance: 1e-9,
  },
  {
    name: "linear",
    variations: () => [new LinearVariation(120, 0.1, 0.9)],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "bezier curve (exact node copy)",
    variations: () => [
      new CurveVariation(120, [
        makeCurveNode(0, 0.2, { dt: 0, dv: 0 }, { dt: 12, dv: 0.4 }),
        makeCurveNode(60, 0.8, { dt: -18, dv: -0.1 }, { dt: 9, dv: 0.05 }),
        makeCurveNode(120, 0.35, { dt: -20, dv: 0.2 }, { dt: 0, dv: 0 }),
      ]),
    ],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "curve with a step (coincident nodes)",
    variations: () => [
      new CurveVariation(120, [
        makeCurveNode(0, 0.1),
        makeCurveNode(60, 0.4),
        makeCurveNode(60, 0.9),
        makeCurveNode(120, 1),
      ]),
    ],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "periodic sine",
    variations: () => [new PeriodicVariation(120, "sine", 0.3, 8, 0.7, 0.5)],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "periodic square",
    variations: () => [new PeriodicVariation(120, "square", 0.25, 15, 0, 0.5)],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "periodic triangle (phase stored as seconds)",
    variations: () => [
      new PeriodicVariation(120, "triangle", 0.4, 10, 2.5, 0.45),
    ],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "periodic sawUp",
    variations: () => [new PeriodicVariation(120, "sawUp", 0.5, 12, 1.1, 0.5)],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "periodic sawDown",
    variations: () => [
      new PeriodicVariation(120, "sawDown", 0.5, 12, 1.1, 0.5),
    ],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "audio",
    variations: () => [new AudioVariation(120, 2, 0.25, 0.05, stubStore)],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "easing (fit to bezier, upstream does the same)",
    variations: () => [
      new EasingVariation(120, "easeInOutCubic", 0.2, 0.85),
    ],
    ctx: fullSong,
    tolerance: 0.02,
  },
  {
    name: "sequence: flat, wave, linear",
    variations: () => [
      new FlatVariation(40, 0.3),
      new PeriodicVariation(40, "sine", 0.2, 5, 0, 0.6),
      new LinearVariation(40, 0.6, 0.1),
    ],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "sequence with a discontinuous seam",
    variations: () => [
      new FlatVariation(60, 0.25),
      new FlatVariation(60, 0.75),
    ],
    ctx: fullSong,
    tolerance: 1e-6,
  },
  {
    name: "offset block: wave then curve",
    variations: () => [
      new PeriodicVariation(20, "sine", 0.3, 4, 0.25, 0.5),
      new CurveVariation(25, [
        makeCurveNode(0, 0.5, { dt: 0, dv: 0 }, { dt: 5, dv: 0.3 }),
        makeCurveNode(25, 0.2, { dt: -6, dv: 0.1 }, { dt: 0, dv: 0 }),
      ]),
    ],
    ctx: offsetBlock,
    tolerance: 1e-6,
  },
  {
    name: "offset block: audio across the whole block",
    variations: () => [new AudioVariation(45, 1.5, 0.4, 0.02, stubStore)],
    ctx: offsetBlock,
    tolerance: 1e-6,
  },
];

console.log("region <-> curve round trip\n");

for (const testCase of cases) {
  const original = testCase.variations();
  const curve = variationsToCurve(original, testCase.ctx);
  if (!curve) {
    fail(`${testCase.name}: projected to no curve at all`);
    continue;
  }
  const back = curveToVariations(curve, testCase.ctx, stubStore);
  if (back.length === 0) {
    fail(`${testCase.name}: wrote no regions`);
    continue;
  }

  checkVocabulary(testCase.name, back);
  checkTiling(testCase.name, back, testCase.ctx.blockDuration);
  const deviation = checkEquivalence(
    testCase.name,
    original,
    back,
    testCase.ctx,
    testCase.tolerance,
  );

  // Second trip: shape must stop changing.
  const curve2 = variationsToCurve(back, testCase.ctx);
  if (!curve2) {
    fail(`${testCase.name}: second projection produced no curve`);
    continue;
  }
  const back2 = curveToVariations(curve2, testCase.ctx, stubStore);
  if (shapeOf(back) !== shapeOf(back2))
    fail(
      `${testCase.name}: not idempotent\n    first:  ${shapeOf(back)}\n    second: ${shapeOf(back2)}`,
    );
  checkEquivalence(
    `${testCase.name} (idempotence values)`,
    back,
    back2,
    testCase.ctx,
    1e-6,
  );

  console.log(
    `  ${testCase.name}: ${back.length} region(s) [${back
      .map((v) => v.type)
      .join(", ")}], worst deviation ${(deviation * 100).toFixed(3)}% of span`,
  );
}

// Keyframe times must land where the block actually sits in the song.
{
  const ctx = offsetBlock;
  const curve = variationsToCurve([new FlatVariation(45, 0.5)], ctx);
  const first = curve?.keyframes[0];
  const last = curve?.keyframes[curve.keyframes.length - 1];
  const expectedFirst = 30 / 200;
  const expectedLast = 75 / 200;
  if (!first || Math.abs(first.time - expectedFirst) > 1e-9)
    fail(
      `offset block start: keyframe at ${first?.time}, expected ${expectedFirst}`,
    );
  if (!last || Math.abs(last.time - expectedLast) > 1e-9)
    fail(`offset block end: keyframe at ${last?.time}, expected ${expectedLast}`);
  if (failures === 0)
    console.log(
      `  fraction mapping: block 30..75s of a 200s song -> ${expectedFirst}..${expectedLast}`,
    );
}

// An empty lane is not a curve.
if (variationsToCurve([], fullSong) !== null)
  fail("empty region list should project to null, not an empty curve");
if (variationsToCurve(undefined, fullSong) !== null)
  fail("absent region list should project to null");

console.log("");
if (failures > 0) {
  console.error(`FAIL: ${failures} region/curve round-trip failure(s)`);
  process.exit(1);
}
console.log("PASS: region <-> curve round trips within tolerance");
