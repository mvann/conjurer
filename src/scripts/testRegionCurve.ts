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
import { Vector4 } from "three";
import {
  CurveVariation,
  makeCurveNode,
} from "@/src/types/Variations/CurveVariation";
import { LinearVariation4 } from "@/src/types/Variations/LinearVariation4";
import { PaletteVariation } from "@/src/params/palette/variation/PaletteVariation";
import { Palette } from "@/src/params/palette/Palette";
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
import {
  AutomationCurve,
  colorAtTime,
  ensureCurveHandles,
  evaluateCurve,
  handlesThroughMidpoint,
  setSegmentHandles,
} from "@/src/components/EditorV2/automation";

type Rgba = [number, number, number, number];


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

// What a scalar lane may write. flat / linear / spline are excluded because
// upstream's loader refits them into curves on every open, so emitting them
// would guarantee drift — the curve encoding covers both anyway (flat is a
// level pair plus a coincident step; linear is straight handles).
//
// `easing` IS allowed, deliberately. Upstream bakes it too, but on LOAD, and
// decision 15 already accepts that ("their load pipeline bakes easing to curves
// anyway"). Folding it away at WRITE time instead would destroy the named
// easing the instant the author picked it, taking the inspector's modes and
// families with it. Writing the region keeps the feature whole for the session
// and defers the documented loss to the reload the plan expects.
const SCALAR_TYPES = new Set(["curve", "periodic", "audio", "easing"]);

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
    name: "easing (its own region; upstream bakes it on load)",
    variations: () => [
      new EasingVariation(120, "easeInOutCubic", 0.2, 0.85),
    ],
    ctx: fullSong,
    tolerance: 1e-6,
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

  // Shape must reach a FIXED POINT, and reach it quickly. The first write can
  // legitimately normalise: hand-written regions carry no boundary stack, and
  // a generator's stack is stored as a coincident node pair, so the region
  // beside one gains that node the first time the editor writes it. What must
  // never happen is a shape that keeps changing — that is a file that grows
  // every time it is opened.
  const shapes = [shapeOf(back)];
  let latest = back;
  for (let trip = 0; trip < 3; trip++) {
    const projected = variationsToCurve(latest, testCase.ctx);
    if (!projected) {
      fail(`${testCase.name}: projection ${trip + 2} produced no curve`);
      break;
    }
    latest = curveToVariations(projected, testCase.ctx, stubStore);
    shapes.push(shapeOf(latest));
  }
  const settled = shapes.findIndex(
    (shape, index) => index > 0 && shape === shapes[index - 1],
  );
  if (settled < 0)
    fail(
      `${testCase.name}: shape never settles\n    ${shapes.join("\n    ")}`,
    );
  else if (settled > 2)
    fail(
      `${testCase.name}: settles only after ${settled} trips\n    ${shapes.join("\n    ")}`,
    );
  // Whatever the shape settles to, it must still play the same lane.
  checkEquivalence(
    `${testCase.name} (idempotence values)`,
    back,
    latest,
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

// ---- value lanes: color and palette periods
{
  const ctx = fullSong;
  // Three periods: a solid red, a genuine gradient, then a solid blue.
  const red: [number, number, number, number] = [1, 0, 0, 1];
  const green: [number, number, number, number] = [0, 1, 0, 1];
  const blue: [number, number, number, number] = [0, 0, 1, 1];
  const v4 = (c: [number, number, number, number]) =>
    new Vector4(c[0], c[1], c[2], c[3]);

  const original: Variation[] = [
    new LinearVariation4(40, v4(red), v4(red)),
    new LinearVariation4(40, v4(red), v4(green)),
    new LinearVariation4(40, v4(blue), v4(blue)),
  ];

  const curve = variationsToCurve(original, ctx);
  if (!curve) fail("a color lane must project to a curve");
  else {
    // Keyframes are period BOUNDARIES, so N periods are leadIn + N-1
    // keyframes. leadIn "dissolving" means it stops being a special field and
    // becomes the first region — the period itself still exists, and dropping
    // it would cost the author an editable colour.
    if (!curve.leadIn)
      fail("the first period must come back as leadIn");
    if (curve.leadIn && !curve.leadIn.color?.every((c, i) => Math.abs(c - red[i]) < 1e-9))
      fail("leadIn keeps the first period's colour");
    if (curve.keyframes.length !== 2)
      fail(`3 periods -> leadIn + 2 keyframes, got ${curve.keyframes.length}`);
    const [second, third] = curve.keyframes;
    if (Math.abs(second.time - 40 / 120) > 1e-9)
      fail(`second period boundary at 1/3, got ${second.time}`);
    if (!second.colorTo)
      fail("a genuine gradient must record its far end on colorTo");
    if (second.colorTo && !second.colorTo.every((c, i) => Math.abs(c - green[i]) < 1e-9))
      fail("the gradient's far end must be its `to` colour");
    if (third.colorTo)
      fail("a constant period must NOT record colorTo, or it reads as a gradient");
    if (!third.color || !third.color.every((c, i) => Math.abs(c - blue[i]) < 1e-9))
      fail("the third period keeps its own colour");

    const back = curveToVariations(curve, ctx, stubStore);
    if (back.length !== 3)
      fail(`color lane round trip: 3 regions, got ${back.length}`);
    if (!back.every((r) => r.type === "linear4"))
      fail(`color regions must stay linear4, got ${back.map((r) => r.type).join(", ")}`);
    checkTiling("color lane", back, ctx.blockDuration);
    const grad = back[1] as any;
    if (!grad || Math.abs(grad.from.x - 1) > 1e-9 || Math.abs(grad.to.y - 1) > 1e-9)
      fail("the gradient region must round trip from red to green");
    const solid = back[0] as any;
    if (Math.abs(solid.from.x - solid.to.x) > 1e-9)
      fail("a solid period must write from == to");

    const shapeA = shapeOf(back);
    const again = curveToVariations(variationsToCurve(back, ctx)!, ctx, stubStore);
    if (shapeA !== shapeOf(again))
      fail(`color lane not idempotent: ${shapeA} vs ${shapeOf(again)}`);
    if (failures === 0)
      console.log(
        "  color lane: leadIn + 2 keyframes = 3 linear4 periods, gradient on colorTo",
      );
  }
}

// ---- palette lanes
{
  const ctx = fullSong;
  const paletteAt = (n: number) =>
    Palette.deserialize({
      a: [n, n, n],
      b: [0.5, 0.5, 0.5],
      c: [1, 1, 1],
      d: [0, 0.33, 0.67],
    });
  const original: Variation[] = [
    new PaletteVariation(60, paletteAt(0.1)),
    new PaletteVariation(60, paletteAt(0.9)),
  ];
  const curve = variationsToCurve(original, ctx);
  if (!curve) fail("a palette lane must project to a curve");
  else {
    // Same boundary convention as colour: 2 periods are leadIn + 1 keyframe.
    if (!curve.leadIn?.palette)
      fail("the first palette period comes back as leadIn");
    if (curve.keyframes.length !== 1)
      fail(`2 periods -> leadIn + 1 keyframe, got ${curve.keyframes.length}`);
    if (!curve.keyframes[0].palette)
      fail("each palette period carries its palette payload");
    const back = curveToVariations(curve, ctx, stubStore);
    if (!back.every((r) => r.type === "palette"))
      fail(`palette regions must stay palette, got ${back.map((r) => r.type).join(", ")}`);
    checkTiling("palette lane", back, ctx.blockDuration);
    const restored = (back[1] as any).palette.serialize();
    if (Math.abs(restored.a[0] - 0.9) > 1e-9)
      fail(`the second period's palette must survive, got a=${restored.a[0]}`);
    if (failures === 0)
      console.log("  palette lane: 2 periods round trip as palette regions");
  }
}

// An empty lane is not a curve.
if (variationsToCurve([], fullSong) !== null)
  fail("empty region list should project to null, not an empty curve");
if (variationsToCurve(undefined, fullSong) !== null)
  fail("absent region list should project to null");

console.log("");
// ---- a colour period is a ramp, not a hold
{
  // Reported from the app: "I have gradient on and when I move the playhead to
  // the end of a segment with a gradient it still only shows the color of the
  // first color." The lane was driving the parameter from the period's payload
  // alone, which is the right question for a palette and the wrong one for a
  // colour — upstream stores a colour period as linear4 from->to and ramps
  // between them.
  const span = { start: 0, end: 1 };
  const curve = {
    keyframes: [{ time: 0.5, value: 0, color: [0, 0, 0, 1] as Rgba }],
    segments: [],
    leadIn: { color: [1, 1, 1, 1] as Rgba, colorTo: [0, 0, 0, 1] as Rgba },
  };

  const at = (time: number) => colorAtTime(curve as never, time, span)!;
  if (!(Math.abs(at(0)[0] - 1) < 1e-9)) fail("a gradient starts at its from colour");
  if (!(Math.abs(at(0.25)[0] - 0.5) < 1e-9))
    fail(`halfway through the period is halfway between the colours, got ${at(0.25)[0]}`);
  if (!(Math.abs(at(0.499)[0]) < 0.01))
    fail(`the end of the period reaches the to colour, got ${at(0.499)[0]}`);
  // A solid period holds, which is the behaviour that was already right.
  if (!(Math.abs(at(0.75)[0]) < 1e-9))
    fail("a period with no far end holds its colour");
  console.log("  a gradient period ramps across its span; a solid one holds");
}

// ---- a curve segment is a Bezier, and the trip changes nothing ----
//
// "by default now, we're gonna do the curves that they do, which is, like, the
//  Bezier handles. That's gonna be kind of the default thing."
//
// Curves used to be stored as one Schlick bend per segment and refitted on
// every save. The fitter is adaptive: seeded at the author's keyframes it
// subdivides wherever the error is worst, and EVERY node it adds reads back as
// a keyframe, because a Curve region's nodes are exactly what the editor draws
// dots for. A hard enough bend needed a third node, so keyframes appeared
// beside the real ones and each edit made more. With real handles there is one
// cubic per segment, nothing is fitted, and the trip is exact.
{
  const ctx: RegionContext = {
    blockStartTime: 0,
    blockDuration: 120,
    songDuration: 120,
  };
  const store = {} as Store;

  for (const bend of [1, 2, 4, 8, 0.25, 0.125]) {
    const authored = ensureCurveHandles({
      keyframes: [
        { time: 0.1, value: 0 },
        { time: 0.5, value: 1 },
        { time: 0.9, value: 0 },
      ],
      segments: [
        { type: "curve", bend },
        { type: "curve", bend },
      ],
    });
    const back = variationsToCurve(
      curveToVariations(authored, ctx, store),
      ctx,
    )!;

    if (back.keyframes.length !== authored.keyframes.length)
      fail(
        `bend ${bend}: keyframes ${authored.keyframes.length} -> ${back.keyframes.length}; the fitter invented some`,
      );
    let worst = 0;
    for (let i = 0; i <= 200; i++) {
      const t = 0.05 + (0.9 * i) / 200;
      const before = evaluateCurve(authored, t);
      const after = evaluateCurve(back, t);
      if (before !== null && after !== null)
        worst = Math.max(worst, Math.abs(before - after));
    }
    if (worst > 1e-6)
      fail(`bend ${bend}: shape moved by ${worst.toFixed(5)} on a round trip`);
  }
  console.log("  a bent curve round trips exactly, keyframe set unchanged");

  // A LEGACY curve, stored as a bend with no handles, still has to be fitted:
  // old autosaves hold them. The fit is capped at the author's own keyframes,
  // so it approximates the shape rather than subdividing until it matches and
  // handing back the subdivisions as keyframes.
  for (const bend of [4, 8, 0.125]) {
    const legacy: AutomationCurve = {
      keyframes: [
        { time: 0.1, value: 0 },
        { time: 0.5, value: 1 },
        { time: 0.9, value: 0 },
      ],
      segments: [
        { type: "curve", bend },
        { type: "curve", bend },
      ],
    };
    const back = variationsToCurve(curveToVariations(legacy, ctx, store), ctx)!;
    if (back.keyframes.length !== legacy.keyframes.length)
      fail(
        `legacy bend ${bend}: keyframes ${legacy.keyframes.length} -> ${back.keyframes.length}; the fitter subdivided`,
      );
  }
  console.log("  a legacy bend is fitted without inventing keyframes");

  // The drag gesture: the curve passes through the cursor at the halfway
  // point, including on a FLAT chord, which a Schlick bend could never lift.
  const flat = ensureCurveHandles({
    keyframes: [
      { time: 0.2, value: 1 },
      { time: 0.8, value: 1 },
    ],
    segments: [{ type: "curve", bend: 1 }],
  });
  const bent = setSegmentHandles(
    flat,
    0,
    handlesThroughMidpoint(flat.keyframes[0], flat.keyframes[1], 2),
  );
  const mid = evaluateCurve(bent, 0.5)!;
  if (Math.abs(mid - 2) > 1e-9)
    fail(`a dragged bend should pass through the cursor, got ${mid}`);
  const trippedBent = variationsToCurve(
    curveToVariations(bent, ctx, store),
    ctx,
  )!;
  if (trippedBent.keyframes.length !== 2)
    fail(
      `a bent flat chord gained keyframes: ${trippedBent.keyframes.length}`,
    );
  console.log("  a flat chord bends, and survives the trip");
}

// ---- stacked keyframes survive the round trip ----
//
// Two keyframes at the same time are a deliberate instant step, and the editor
// lets you make one. The round trip used to destroy them: a zero-width segment
// ends its run, the resulting run chunk has zero duration and is skipped
// entirely, and then the read path's boundary merge collapses what is left.
// Reported live as "I moved a keyframe up and each movement it would delete
// the keyframe to the right".
{
  const ctx: RegionContext = {
    blockStartTime: 0,
    blockDuration: 120,
    songDuration: 120,
  };
  const store = {} as Store;
  const trip = (curve: AutomationCurve) =>
    variationsToCurve(curveToVariations(curve, ctx, store), ctx)!;

  // A stacked pair whose values are EQUAL, straddling a region boundary.
  const equalStack = ensureCurveHandles({
    keyframes: [
      { time: 0.2, value: 0 },
      { time: 0.5, value: 0.9 },
      { time: 0.5, value: 0.9 },
      { time: 0.8, value: 0.4 },
    ],
    segments: [
      { type: "curve", bend: 1 },
      { type: "flat" },
      { type: "curve", bend: 1 },
    ],
  });
  const equalBack = trip(equalStack);
  if (equalBack.keyframes.length !== 4)
    fail(
      `an equal-valued stacked pair collapsed: 4 -> ${equalBack.keyframes.length}`,
    );

  // The same pair with DIFFERING values is a visible step and must also hold.
  const stepStack = ensureCurveHandles({
    keyframes: [
      { time: 0.2, value: 0 },
      { time: 0.5, value: 0.2 },
      { time: 0.5, value: 0.9 },
      { time: 0.8, value: 0.9 },
    ],
    segments: [
      { type: "curve", bend: 1 },
      { type: "flat" },
      { type: "curve", bend: 1 },
    ],
  });
  const stepBack = trip(stepStack);
  if (stepBack.keyframes.length !== 4)
    fail(`a stacked step collapsed: 4 -> ${stepBack.keyframes.length}`);

  // A stacked pair at the very start of the block.
  const atStart = ensureCurveHandles({
    keyframes: [
      { time: 0, value: 0 },
      { time: 0, value: 0.9 },
      { time: 0.6, value: 0.7 },
    ],
    segments: [
      { type: "curve", bend: 1 },
      { type: "curve", bend: 1 },
    ],
  });
  const startBack = trip(atStart);
  if (startBack.keyframes.length !== 3)
    fail(
      `a stacked pair at the block start collapsed: 3 -> ${startBack.keyframes.length}`,
    );

  // And the live edit loop: dragging one of a stacked pair vertically must
  // never change the keyframe COUNT, whatever value it passes through.
  let live = stepStack;
  for (let step = 0; step < 14; step++) {
    const next = { ...live, keyframes: [...live.keyframes] };
    next.keyframes[1] = { ...next.keyframes[1], value: 0.2 + step * 0.1 };
    live = trip(ensureCurveHandles(next));
    if (live.keyframes.length !== 4) {
      fail(
        `dragging a stacked keyframe to ${(0.2 + step * 0.1).toFixed(1)} lost one: 4 -> ${live.keyframes.length}`,
      );
      break;
    }
  }
  console.log("  stacked keyframes survive the trip, and a vertical drag");
}

// Two generators meeting, and what happens at the boundary between them.
{
  const ctx: RegionContext = {
    blockStartTime: 0,
    blockDuration: 60,
    songDuration: 60,
  };
  const store = {} as Store;

  // Decision 14: a generator owns its endpoints absolutely, so two of them
  // meeting is a permanent boundary stack. Sharing an offset must not fuse
  // them — a single shared keyframe would drag both waves' centres at once.
  const sameOffset = [
    new PeriodicVariation(30, "sine", 0.2, 5, 0, 0.5),
    new PeriodicVariation(30, "square", 0.4, 3, 0, 0.5),
  ];
  const met = variationsToCurve(sameOffset, ctx)!;
  if (met.keyframes.length !== 4)
    fail(
      `two generators sharing an offset lost their stack: 4 -> ${met.keyframes.length}`,
    );
  // The zero-width segment between them is the one unzip widens, and unzip
  // opens a curve.
  const metSegments = met.segments ?? [];
  const bridge = metSegments[1];
  if (bridge?.type !== "curve")
    fail(`the generator bridge came back as ${bridge?.type}, not curve`);
  if (metSegments[0]?.type !== "wave" || metSegments[2]?.type !== "wave")
    fail("the waves either side of the bridge did not survive");
  console.log("  two generators keep their stack, bridged by a curve");

  // A wave with no cycles left still has to be writable: upstream divides by
  // the period, so a zero one makes every sample on the canopy NaN.
  const noCycles: AutomationCurve = {
    keyframes: [
      { time: 0, value: 0.5 },
      { time: 0.5, value: 0.5 },
    ],
    segments: [
      { type: "wave", wave: "sine", amplitude: 0.3, cycles: 0, phase: 0 },
    ],
  };
  for (const written of curveToVariations(noCycles, ctx, store)) {
    if (!(written instanceof PeriodicVariation)) continue;
    if (!(written.period > 0))
      fail(`a cycle-less wave wrote period ${written.period}`);
    const sample = written.valueAtTime(1);
    if (!Number.isFinite(sample))
      fail(`a cycle-less wave evaluates to ${sample} on the canopy`);
  }
  console.log("  a wave with no cycles still writes a usable period");

  // The editor draws what the canopy plays. Sampled across the whole span,
  // for every shape. The samples within a hair of a square wave's own
  // discontinuity are skipped: which side of the jump a sample lands on there
  // is decided by floating point, the two paths compute the phase slightly
  // differently, and the disagreement lasts no time at all. The convention
  // itself (a boundary reads LOW, as upstream's `> 0` has it) lives in
  // waveShape; what this guards is every moment either side of it.
  for (const kind of ["sine", "square", "triangle", "sawUp", "sawDown"] as const) {
    const wave = new PeriodicVariation(20, kind, 0.4, 4, 0, 0.5);
    const drawn = variationsToCurve([wave], ctx)!;
    // The endpoints themselves are the boundary stack: the keyframe there
    // carries the generator's offset, and the wave is deliberately decoupled
    // from it ("the wave will be decoupled from whatever value the one on the
    // left or the right is"). Everything strictly inside is the wave.
    for (let step = 1; step < 200; step++) {
      const seconds = (step / 200) * 20;
      const cycle = seconds / 4;
      if (kind === "square" && Math.abs(cycle - Math.round(cycle * 2) / 2) < 1e-6)
        continue;
      const played = wave.valueAtTime(seconds);
      const shown = evaluateCurve(drawn, seconds / ctx.songDuration);
      if (shown === null || Math.abs(played - shown) > 1e-6) {
        fail(
          `${kind} at ${seconds.toFixed(2)}s: canopy plays ${played}, editor draws ${shown}`,
        );
        break;
      }
    }
  }
  console.log("  every wave shape draws what the canopy plays");
}

// Shaping by hand, and what the projection does with the shape.
{
  const ctx: RegionContext = {
    blockStartTime: 0,
    blockDuration: 120,
    songDuration: 120,
  };
  const store = {} as Store;
  const trip = (curve: AutomationCurve) =>
    variationsToCurve(curveToVariations(curve, ctx, store), ctx)!;

  // The projection refits a segment whose bend is not 1, on the grounds that
  // the bend is the newer instruction. Dragging a handle is the author saying
  // otherwise, so the drag has to survive the write.
  const bent = ensureCurveHandles({
    keyframes: [
      { time: 0.2, value: 0.1 },
      { time: 0.8, value: 0.9 },
    ],
    segments: [{ type: "curve", bend: 2.5 }],
  });
  const dragged = setSegmentHandles(
    bent,
    0,
    { out: { dt: 0.2, dv: 0.5 }, in: { dt: -0.05, dv: -0.4 } },
    { handlesOwnShape: true },
  );
  const back = trip(dragged);
  const out = back.keyframes[0]?.handleOut;
  const inn = back.keyframes[1]?.handleIn;
  if (
    !out ||
    !inn ||
    Math.abs(out.dt - 0.2) > 1e-6 ||
    Math.abs(out.dv - 0.5) > 1e-6 ||
    Math.abs(inn.dt + 0.05) > 1e-6 ||
    Math.abs(inn.dv + 0.4) > 1e-6
  )
    fail(
      `handles dragged on a bent segment snapped back: ${JSON.stringify([out, inn])}`,
    );
  console.log("  handles dragged on a bent segment survive the write");

  // A stacked pair inside a shaped run seeds the fitter with the same u
  // twice. The fitter dedupes its own seeds, so a cap counted from the
  // undeduped list left room for one node more than there are keyframes —
  // a dot the author never placed, appearing beside the ones they did.
  const stackedInShapedRun = ensureCurveHandles({
    keyframes: [
      { time: 0.1, value: 0.2 },
      { time: 0.4, value: 0.6 },
      { time: 0.4, value: 0.6 },
      { time: 0.7, value: 0.1 },
    ],
    segments: [
      { type: "curve", bend: 2.5 },
      { type: "curve", bend: 1 },
      { type: "curve", bend: 0.4 },
    ],
  });
  const fitted = trip(stackedInShapedRun);
  if (fitted.keyframes.length > 4)
    fail(
      `a shaped run invented a keyframe around a stacked pair: 4 -> ${fitted.keyframes.length}`,
    );
  console.log("  a shaped run around a stacked pair invents nothing");

  // A flat carries its start value to the next keyframe and then steps, so it
  // is written as a hold point plus the step. Squeezed shut it IS the step,
  // and the hold point landed on the keyframe before it — reading back as a
  // keyframe of its own, one more every time the lane was written.
  const squeezedFlat = ensureCurveHandles({
    keyframes: [
      { time: 0.1, value: 0.2 },
      { time: 0.3, value: 0.5 },
      { time: 0.3, value: 0.7 },
      { time: 0.6, value: 0.9 },
    ],
    segments: [{ type: "flat" }, { type: "flat" }, { type: "flat" }],
  });
  let grown = squeezedFlat;
  for (let pass = 0; pass < 3; pass++) {
    grown = trip(grown);
    if (grown.keyframes.length !== 4) {
      fail(
        `a flat run with a squeezed segment grew on pass ${pass + 1}: 4 -> ${grown.keyframes.length}`,
      );
      break;
    }
  }
  console.log("  a flat squeezed shut stays one step, however often written");
}

console.log("");
if (failures > 0) {
  console.error(`FAIL: ${failures} region/curve round-trip failure(s)`);
  process.exit(1);
}
console.log("PASS: region <-> curve round trips within tolerance");
