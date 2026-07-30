// The projection between the data model's region list and the editor's
// automation curve — the seam that lets Spell Crafter's editor run on
// upstream's Block/Variation model without changing what the editor is.
//
// The block owns the truth: `Block.parameterVariations[uniform]` is an
// ordered list of Variations, each with a duration, laid end to end in
// block-local SECONDS. The editor works in AutomationCurve terms:
// keyframes at fractions of the SONG, with a typed segment between each
// adjacent pair. This module converts, both ways, and nothing here keeps
// state — the curve is derived on read and written straight back on edit,
// so there is never a second copy to reconcile.
//
// Time: region-sequence local seconds `t` maps to song fraction
// (blockStartTime + t) / songDuration. For a default Spell Crafter block
// (startTime 0, duration = song length, decision 24) that is just
// t / songDuration, which is why the existing editor math keeps working.
//
// Fidelity, per the merge plan:
// - flat, linear, and Bezier curves round-trip exactly.
// - Schlick bends and named easings are fit into Bezier nodes with
//   upstream's own fitter (1% relative tolerance), which is precisely what
//   upstream's load pipeline does to its own legacy data.
// - Waves and audio give up their ramped baseline: upstream's generators
//   oscillate about a constant offset and ignore their endpoints
//   (decision 14). A wave that rode a slope loses the slope.
// - Only curve / periodic / audio are ever written for scalar params:
//   upstream's loader rewrites flat / linear / easing / spline on every
//   open, so writing those would guarantee drift on the next round trip.

import { Vector4 } from "three";
import { Variation } from "@/src/types/Variations/Variation";
import { LinearVariation4 } from "@/src/types/Variations/LinearVariation4";
import { PaletteVariation } from "@/src/params/palette/variation/PaletteVariation";
import { Palette } from "@/src/params/palette/Palette";
import {
  CurveVariation,
  CurveNode,
  makeCurveNode,
} from "@/src/types/Variations/CurveVariation";
import { PeriodicVariation } from "@/src/types/Variations/PeriodicVariation";
import { AudioVariation } from "@/src/types/Variations/AudioVariation";
import { FlatVariation } from "@/src/types/Variations/FlatVariation";
import { LinearVariation } from "@/src/types/Variations/LinearVariation";
import { EasingVariation } from "@/src/types/Variations/EasingVariation";
import { SplineVariation } from "@/src/types/Variations/SplineVariation";
import { fitCurveNodes } from "@/src/utils/migrateVariations";
import type { Store } from "@/src/types/Store";
import {
  AutomationCurve,
  AutomationKeyframe,
  EasingName,
  SegmentSpec,
  WaveKind,
  evaluateSegment,
  getSegments,
} from "@/src/components/EditorV2/automation";

export type RegionContext = {
  /** Block start in the song, seconds. */
  blockStartTime: number;
  /** Block length, seconds. Regions tile exactly this. */
  blockDuration: number;
  /** Song length, seconds. The fraction basis. */
  songDuration: number;
};

// Times within a hair of each other are the same time: region boundaries
// land on floating-point sums of durations.
const TIME_EPS = 1e-9;
// Values within a hair are the same value, so a shared boundary between two
// regions that agree renders as one keyframe rather than a false step.
const VALUE_EPS = 1e-9;

// Segment types that occupy a region of their own, rather than folding into a
// Curve run: the generators, plus easing.
//
// Easing is written as a real EasingVariation even though upstream's loader
// bakes those into curves. Decision 15 accepts that bake — "their load pipeline
// bakes easing to curves anyway" — but it happens on LOAD, not during editing.
// Folding easing away at write time instead would lose the named easing the
// moment the author picked it, taking the inspector's modes and families with
// it. Writing the region keeps the feature intact for the whole session and
// defers the documented loss to the reload that decision 15 already expects.
const ownsRegion = (type: SegmentSpec["type"]) =>
  type === "wave" || type === "audio" || type === "easing";

// Straight types are built structurally, point by point; everything else is
// fit. The distinction matters because FLAT IS DISCONTINUOUS — it holds its
// start value and then steps — and fitCurveNodes explicitly requires a
// continuous function. Fitting across a jump makes it subdivide toward the
// discontinuity until it hits its 64-node ceiling, so the lane would grow a
// little on every edit. Runs therefore never mix the two, and a flat is always
// encoded structurally as the coincident node pair the data model uses.
const isStraightType = (type: SegmentSpec["type"]) =>
  type === "flat" || type === "linear";

// -------------------------------------------------------------- value lanes
//
// Color and palette parameters automate the WHOLE value, not a number, so
// their lanes work differently from scalar ones and upstream treats them
// differently too: `previewAllParamsAsCurves` skips anything whose value is
// not a number, so these arrive raw and `linear4` / `palette` are the correct
// types to write back.
//
// The editor's model is periods: keyframes are boundaries and each one's
// payload holds from its time until the next. That lines up with regions
// exactly — one region IS one period — so the mapping is direct, with the
// first region starting at the block's start (leadIn dissolves).
//
// A color region is always `linear4` from->to upstream, which means a period is
// structurally always a gradient. Equal ends read as a plain single color; a
// genuine gradient carries its far end on `colorTo` (decision 23).

const asTuple = (vector: Vector4): [number, number, number, number] => [
  vector.x,
  vector.y,
  vector.z,
  vector.w,
];

const sameColor = (
  a: [number, number, number, number],
  b: [number, number, number, number],
) => a.every((component, index) => Math.abs(component - b[index]) < VALUE_EPS);

/** Whether a region list is a value lane (color or palette) rather than scalar. */
export const isValueLaneRegions = (
  variations: Variation[] | undefined | null,
): boolean =>
  !!variations &&
  variations.length > 0 &&
  variations.every(
    (variation) =>
      variation instanceof LinearVariation4 ||
      variation instanceof PaletteVariation,
  );

/** Color and palette regions, as the period keyframes the editor draws. */
const valueLaneToCurve = (
  variations: Variation[],
  ctx: RegionContext,
): AutomationCurve | null => {
  const { blockStartTime, songDuration } = ctx;
  const frac = (localSeconds: number) =>
    (blockStartTime + localSeconds) / songDuration;

  // Keyframes are period BOUNDARIES here, so N keyframes make N+1 periods: the
  // run before the first keyframe is its own period, which the editor calls
  // leadIn. "leadIn dissolves" means it stops being a special field and becomes
  // simply the first region — not that the period disappears. Dropping it would
  // cost the author an editable colour.
  const keyframes: AutomationKeyframe[] = [];
  let leadIn: AutomationCurve["leadIn"];
  let cursor = 0;
  for (const [regionIndex, variation] of variations.entries()) {
    const keyframe: AutomationKeyframe = {
      time: frac(cursor),
      // Value lanes have no vertical meaning; the payload carries everything.
      value: 0,
    };
    if (variation instanceof LinearVariation4) {
      const from = asTuple(variation.from);
      const to = asTuple(variation.to);
      keyframe.color = from;
      // Only a real gradient records its far end, so a constant period reads
      // back as one color rather than a gradient of nothing.
      if (!sameColor(from, to)) keyframe.colorTo = to;
    } else if (variation instanceof PaletteVariation) {
      keyframe.palette = variation.palette.serialize() as NonNullable<
        AutomationKeyframe["palette"]
      >;
    }
    cursor += variation.duration;
    if (regionIndex === 0) {
      leadIn = { color: keyframe.color, palette: keyframe.palette };
      continue;
    }
    keyframes.push(keyframe);
  }

  if (!leadIn && keyframes.length === 0) return null;
  // Segments carry no shape here, but the list has to stay sized to the
  // keyframes or getSegments will pad it and callers will misread the lane.
  return {
    keyframes,
    leadIn,
    segments: keyframes.slice(1).map(() => ({ type: "flat" as const })),
  };
};

/** Period keyframes, back to color or palette regions tiling the block. */
const valueLaneToVariations = (
  curve: AutomationCurve,
  ctx: RegionContext,
  kind: "color" | "palette",
): Variation[] => {
  const { blockStartTime, blockDuration, songDuration } = ctx;
  const local = (fraction: number) =>
    Math.min(
      Math.max(fraction * songDuration - blockStartTime, 0),
      blockDuration,
    );

  const { keyframes } = curve;
  // The leadIn period comes first, running from the block's start to the first
  // keyframe. It is a region like any other; only the editor calls it leadIn.
  const periods: { payload: AutomationKeyframe; start: number; end: number }[] =
    [];
  const firstBoundary = keyframes.length ? local(keyframes[0].time) : blockDuration;
  if (curve.leadIn && firstBoundary > TIME_EPS)
    periods.push({
      payload: { time: 0, value: 0, ...curve.leadIn },
      start: 0,
      end: firstBoundary,
    });
  for (let index = 0; index < keyframes.length; index++)
    periods.push({
      payload: keyframes[index],
      // With no leadIn the first period still starts at the block's start.
      start:
        index === 0 && !periods.length ? 0 : local(keyframes[index].time),
      end:
        index === keyframes.length - 1
          ? blockDuration
          : local(keyframes[index + 1].time),
    });

  const variations: Variation[] = [];
  for (const period of periods) {
    const keyframe = period.payload;
    const duration = period.end - period.start;
    if (duration <= TIME_EPS) continue;

    if (kind === "palette" && keyframe.palette) {
      variations.push(
        new PaletteVariation(duration, Palette.deserialize(keyframe.palette)),
      );
      continue;
    }
    const from = keyframe.color ?? [0, 0, 0, 1];
    const to = keyframe.colorTo ?? from;
    variations.push(
      new LinearVariation4(
        duration,
        new Vector4(from[0], from[1], from[2], from[3]),
        new Vector4(to[0], to[1], to[2], to[3]),
      ),
    );
  }
  return variations;
};

// ---------------------------------------------------------------- read path

/** Phase as upstream stores it, converted to the editor's cycles. */
const phaseToCycles = (
  kind: WaveKind,
  phase: number,
  period: number,
): number =>
  // Triangle is the odd one out upstream: its phase is a time offset in
  // seconds, while every other kind stores radians.
  kind === "triangle"
    ? period > 0
      ? phase / period
      : 0
    : phase / (2 * Math.PI);

/** The editor's cycles-phase, converted to what upstream stores. */
const phaseFromCycles = (
  kind: WaveKind,
  phaseCycles: number,
  period: number,
): number =>
  kind === "triangle" ? phaseCycles * period : phaseCycles * 2 * Math.PI;

/**
 * A block's region list, projected into the curve the editor draws and
 * edits. Returns null when there is nothing to show (no regions at all).
 */
export const variationsToCurve = (
  variations: Variation[] | undefined | null,
  ctx: RegionContext,
): AutomationCurve | null => {
  if (!variations || variations.length === 0) return null;
  const { blockStartTime, songDuration } = ctx;
  if (!(songDuration > 0)) return null;

  // Color and palette lanes are periods, not shapes; they take their own path.
  if (isValueLaneRegions(variations)) return valueLaneToCurve(variations, ctx);

  const frac = (localSeconds: number) =>
    (blockStartTime + localSeconds) / songDuration;

  const keyframes: AutomationKeyframe[] = [];
  const segments: SegmentSpec[] = [];

  // Append a keyframe.
  //
  // `startsRegion` marks the first keyframe of a region, which is the only
  // place a boundary needs reconciling with what came before:
  //
  // - The previous region ended at the same value: collapse to one keyframe.
  //   The incoming outgoing handle wins, since it belongs to the segment
  //   about to be described.
  // - It ended at a DIFFERENT value: keep both, which is the editor's
  //   stacked-keyframe step and upstream's coincident-time nodes. That adds
  //   a keyframe without adding a segment, so the step gets its own
  //   zero-width segment — otherwise the segment list slides out of step
  //   with the keyframes and every later segment describes the wrong span.
  //
  // Keyframes INSIDE a region (a curve's node list) never take this path:
  // their caller already emits one segment per node gap.
  const push = (keyframe: AutomationKeyframe, startsRegion = false) => {
    const previous = keyframes[keyframes.length - 1];
    if (
      startsRegion &&
      previous &&
      Math.abs(previous.time - keyframe.time) < TIME_EPS
    ) {
      if (Math.abs(previous.value - keyframe.value) < VALUE_EPS) {
        if (keyframe.handleOut) previous.handleOut = keyframe.handleOut;
        return;
      }
      segments.push({ type: "linear" });
    }
    keyframes.push(keyframe);
  };

  let cursor = 0; // local seconds
  for (const variation of variations) {
    const duration = variation.duration;
    const start = cursor;
    const end = cursor + duration;
    cursor = end;

    if (variation instanceof CurveVariation) {
      const nodes = variation.nodes;
      if (nodes.length === 0) continue;

      // A hold-then-step — a level pair followed by a jump at the same time —
      // is how a FLAT segment is stored (see the write path). Recognising the
      // fingerprint here is what lets the author's flat segment come back as a
      // flat segment rather than as two curve segments around a step. Same
      // move the plan makes for lone constants and for from == to colours.
      const flatMiddle = new Set<number>();
      for (let i = 0; i + 2 < nodes.length; i++) {
        const level =
          Math.abs(nodes[i + 1].value - nodes[i].value) < VALUE_EPS &&
          nodes[i + 1].time - nodes[i].time > TIME_EPS;
        const steps =
          Math.abs(nodes[i + 2].time - nodes[i + 1].time) < TIME_EPS &&
          Math.abs(nodes[i + 2].value - nodes[i + 1].value) > VALUE_EPS;
        if (level && steps) flatMiddle.add(i + 1);
      }

      nodes.forEach((node, index) => {
        if (flatMiddle.has(index)) return;
        push(
          {
            time: frac(start + node.time),
            value: node.value,
            handleIn: {
              dt: node.handleIn.dt / songDuration,
              dv: node.handleIn.dv,
            },
            handleOut: {
              dt: node.handleOut.dt / songDuration,
              dv: node.handleOut.dv,
            },
          },
          index === 0,
        );
        // Otherwise "curve": that is the editor's DEFAULT segment type, and a
        // bend of 1 draws straight, so a straight run is an unbent curve
        // rather than a linear segment. Reporting straight runs as linear
        // would silently retype every default segment on its first round trip.
        // The Bezier shape lives in the handles; bend stays neutral.
        if (index < nodes.length - 1)
          segments.push(
            flatMiddle.has(index + 1)
              ? { type: "flat" }
              : { type: "curve", bend: 1 },
          );
      });
      continue;
    }

    if (variation instanceof PeriodicVariation) {
      const kind = variation.periodicType as WaveKind;
      const period = variation.period;
      push({ time: frac(start), value: variation.offset }, true);
      segments.push({
        type: "wave",
        wave: kind,
        amplitude: variation.amplitude,
        cycles: period > 0 ? duration / period : 0,
        phase: phaseToCycles(kind, variation.phase, period),
      });
      push({ time: frac(end), value: variation.offset });
      continue;
    }

    if (variation instanceof AudioVariation) {
      push({ time: frac(start), value: variation.offset }, true);
      segments.push({
        type: "audio",
        factor: variation.factor,
        smoothing: variation.smoothing,
      });
      push({ time: frac(end), value: variation.offset });
      continue;
    }

    if (variation instanceof FlatVariation) {
      push({ time: frac(start), value: variation.value }, true);
      segments.push({ type: "flat" });
      push({ time: frac(end), value: variation.value });
      continue;
    }

    if (variation instanceof LinearVariation) {
      push({ time: frac(start), value: variation.from }, true);
      segments.push({ type: "linear" });
      push({ time: frac(end), value: variation.to });
      continue;
    }

    if (variation instanceof EasingVariation) {
      push({ time: frac(start), value: variation.from }, true);
      segments.push({
        type: "easing",
        easing: variation.easingType as EasingName,
      });
      push({ time: frac(end), value: variation.to });
      continue;
    }

    if (variation instanceof SplineVariation) {
      // No spline segment type in the editor; sample it into Bezier nodes,
      // seeded at the spline's own control points so the fit is exact there.
      // Upstream's loader bakes splines away too.
      const nodes = fitCurveNodes(
        (t) => variation.valueAtTime(t),
        duration,
        {},
        variation.points?.map((point) => point.x),
      );
      nodes.forEach((node, index) => {
        push(
          {
            time: frac(start + node.time),
            value: node.value,
            handleIn: {
              dt: node.handleIn.dt / songDuration,
              dv: node.handleIn.dv,
            },
            handleOut: {
              dt: node.handleOut.dt / songDuration,
              dv: node.handleOut.dv,
            },
          },
          index === 0,
        );
        if (index < nodes.length - 1)
          segments.push({ type: "curve", bend: 1 });
      });
      continue;
    }

    // An unknown scalar variation type still occupies its span: hold its
    // value at the region's start so the lane's timing stays honest.
    const held = (variation as Variation<number>).valueAtTime?.(0, 0) ?? 0;
    push({ time: frac(start), value: typeof held === "number" ? held : 0 }, true);
    segments.push({ type: "flat" });
    push({ time: frac(end), value: typeof held === "number" ? held : 0 });
  }

  if (keyframes.length === 0) return null;
  // A lone keyframe stays lone: it is a legitimate constant curve in the
  // editor's model, and the state the first double-click on an empty lane
  // produces. Padding it to two would make that first keyframe un-round-
  // trippable.
  return { keyframes, segments: segments.slice(0, keyframes.length - 1) };
};

// --------------------------------------------------------------- write path

/**
 * The editor's curve, written back as a region list tiling the block. Only
 * curve / periodic / audio regions are emitted, so a round trip through
 * upstream's load pipeline is a no-op rather than a rewrite.
 */
export const curveToVariations = (
  curve: AutomationCurve,
  ctx: RegionContext,
  store: Store,
): Variation[] => {
  const { blockStartTime, blockDuration, songDuration } = ctx;
  const { keyframes } = curve;
  if (keyframes.length === 0 || !(songDuration > 0)) return [];

  // A curve whose keyframes carry payloads is a value lane, and its periods map
  // straight back to color or palette regions.
  const carriesPalette =
    keyframes.some((keyframe) => keyframe.palette) || !!curve.leadIn?.palette;
  const carriesColor =
    keyframes.some((keyframe) => keyframe.color || keyframe.colorTo) ||
    !!curve.leadIn?.color;
  if (carriesPalette || carriesColor)
    return valueLaneToVariations(
      curve,
      ctx,
      carriesPalette ? "palette" : "color",
    );

  // Fractions back to block-local seconds, clamped into the block: the
  // first region starts at the block start (leadIn dissolves) and nothing
  // is emitted past the end.
  const local = (fraction: number) =>
    Math.min(
      Math.max(fraction * songDuration - blockStartTime, 0),
      blockDuration,
    );

  // One keyframe is a constant curve. A single-node Curve region evaluates to
  // that value everywhere (upstream returns nodes[0].value when there is only
  // one), so it survives the round trip as exactly one keyframe — which is what
  // the editor shows after the first double-click on an empty lane.
  if (keyframes.length === 1) {
    const only = keyframes[0];
    const handleIn = only.handleIn ?? { dt: 0, dv: 0 };
    const handleOut = only.handleOut ?? { dt: 0, dv: 0 };
    return [
      new CurveVariation(blockDuration, [
        makeCurveNode(
          local(only.time),
          only.value,
          { dt: handleIn.dt * songDuration, dv: handleIn.dv },
          { dt: handleOut.dt * songDuration, dv: handleOut.dv },
        ),
      ]),
    ];
  }

  const segments = getSegments(curve);

  // Regions carry no start time: a region's position IS the sum of the
  // durations before it. So the lane is laid out as a tiling of spans, and the
  // keyframes are placed INSIDE those spans rather than defining their edges.
  //
  // That distinction is what keeps the projection from inventing keyframes. A
  // Curve region's nodes need not touch its edges — upstream returns the first
  // node's value before it and the last node's value after it — so the editor's
  // "hold the first value until the first keyframe" falls out for free, with no
  // extra node to render as a dot the author never placed.
  //
  // Generators are the exception: a wave occupies exactly the span between its
  // two keyframes, because its phase and period are measured from the region's
  // own start.
  type Chunk = {
    kind: "owned" | "run";
    firstSegment: number;
    lastSegment: number; // exclusive
    startT: number;
    endT: number;
  };

  const chunks: Chunk[] = [];
  let index = 0;
  while (index < segments.length) {
    if (ownsRegion(segments[index].type)) {
      chunks.push({
        kind: "owned",
        firstSegment: index,
        lastSegment: index + 1,
        startT: local(keyframes[index].time),
        endT: local(keyframes[index + 1].time),
      });
      index++;
      continue;
    }
    const runStart = index;
    const runIsStraight = isStraightType(segments[index].type);
    while (index < segments.length && !ownsRegion(segments[index].type)) {
      // Never mix straight and shaped segments in one run: see isStraightType.
      if (isStraightType(segments[index].type) !== runIsStraight) break;
      const a = keyframes[index];
      const b = keyframes[index + 1];
      // A zero-width segment between differing values is a step; it belongs to
      // this run as coincident nodes, and ends it.
      const zeroWidth = Math.abs(b.time - a.time) < TIME_EPS;
      index++;
      if (zeroWidth && Math.abs(b.value - a.value) > VALUE_EPS) break;
    }
    chunks.push({
      kind: "run",
      firstSegment: runStart,
      lastSegment: index,
      startT: local(keyframes[runStart].time),
      endT: local(keyframes[index].time),
    });
  }

  const variations: Variation[] = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const next = chunks[i + 1];
    const isLast = i === chunks.length - 1;

    if (chunk.kind === "owned") {
      // Anything before the generator starts is a hold at its first value.
      // One node, placed at the END of the hold, so it projects to a keyframe
      // exactly where the generator's own first keyframe sits and collapses
      // into it. A two-node flat would instead show the author a keyframe at
      // the block's start that they never placed.
      if (chunk.startT - cursor > TIME_EPS) {
        const gap = chunk.startT - cursor;
        variations.push(
          new CurveVariation(gap, [
            makeCurveNode(gap, keyframes[chunk.firstSegment].value),
          ]),
        );
        cursor = chunk.startT;
      }
      const duration = Math.max(chunk.endT - cursor, 0);
      if (duration > TIME_EPS) {
        const segment = segments[chunk.firstSegment];
        const a = keyframes[chunk.firstSegment];
        if (segment.type === "wave") {
          const period = segment.cycles !== 0 ? duration / segment.cycles : 0;
          variations.push(
            new PeriodicVariation(
              duration,
              segment.wave as PeriodicVariation["periodicType"],
              segment.amplitude,
              period,
              phaseFromCycles(segment.wave, segment.phase, period),
              // The generator's centre is constant; seed it from the left
              // boundary, which is where creation lines the wave up.
              a.value,
            ),
          );
        } else if (segment.type === "audio") {
          variations.push(
            new AudioVariation(duration, segment.factor, a.value, segment.smoothing, store),
          );
        } else if (segment.type === "easing") {
          const b = keyframes[chunk.firstSegment + 1];
          variations.push(
            new EasingVariation(
              duration,
              segment.easing as never,
              a.value,
              b.value,
            ),
          );
        }
        cursor += duration;
      }
      continue;
    }

    // A run fills from wherever the previous region ended to wherever the next
    // one begins — the whole remaining block when it is last.
    const spanStart = cursor;
    const spanEnd = isLast ? blockDuration : next.startT;
    const duration = spanEnd - spanStart;
    if (duration <= TIME_EPS) continue;

    variations.push(
      curveRegionForRun(curve, segments, keyframes, chunk.firstSegment, chunk.lastSegment, {
        start: spanStart,
        duration,
        songDuration,
        localOf: local,
      }),
    );
    cursor = spanEnd;
  }

  return spanToBlock(variations, blockDuration);
};

/**
 * One Curve region covering segments [runStart, runEnd) of the lane.
 *
 * Exact where it can be: a run whose keyframes all carry handles is copied
 * node for node, and a run of straight segments falls out of straight
 * handles. Anything shaped (Schlick bend, named easing) is fit with
 * upstream's own fitter, seeded at the run's interior keyframes so those
 * land exactly.
 */
const curveRegionForRun = (
  curve: AutomationCurve,
  segments: SegmentSpec[],
  keyframes: AutomationKeyframe[],
  runStart: number,
  runEnd: number,
  geometry: {
    start: number;
    duration: number;
    songDuration: number;
    localOf: (fraction: number) => number;
  },
): CurveVariation => {
  const { start, duration, songDuration, localOf } = geometry;
  const runKeyframes = keyframes.slice(runStart, runEnd + 1);

  // A run is copied node for node when every handle the shape actually
  // needs is present: interior keyframes need both, but the run's first
  // only needs its outgoing handle and its last only its incoming one.
  // Requiring both everywhere would send a run that begins where a wave
  // ended (so its first keyframe has no incoming handle) down the fitting
  // path and quietly approximate an exactly representable Bezier.
  // The handles only describe the shape while the segments say nothing else.
  // A curve segment with a real bend, or any shaped type, means the author has
  // just changed the shape THROUGH the spec — and the handles still on the
  // keyframes are the previous shape. Copying them would swallow the edit, so
  // such a run is re-fit instead.
  const shapeLivesInHandles = segments
    .slice(runStart, runEnd)
    .every(
      (segment) =>
        segment.type === "curve" &&
        (segment.bend === undefined || Math.abs(segment.bend - 1) < 1e-9),
    );
  const runIsHandled =
    shapeLivesInHandles &&
    runKeyframes.every((keyframe, i) => {
      const needsOut = i < runKeyframes.length - 1;
      const needsIn = i > 0;
      return (
        (!needsOut || !!keyframe.handleOut) && (!needsIn || !!keyframe.handleIn)
      );
    });
  const everySegmentIsStraight = segments
    .slice(runStart, runEnd)
    .every((segment) => segment.type === "linear" || segment.type === "flat");

  if (runIsHandled) {
    const nodes: CurveNode[] = runKeyframes.map((keyframe) => {
      const handleIn = keyframe.handleIn ?? { dt: 0, dv: 0 };
      const handleOut = keyframe.handleOut ?? { dt: 0, dv: 0 };
      return makeCurveNode(
        localOf(keyframe.time) - start,
        keyframe.value,
        { dt: handleIn.dt * songDuration, dv: handleIn.dv },
        { dt: handleOut.dt * songDuration, dv: handleOut.dv },
      );
    });
    return new CurveVariation(duration, nodes);
  }

  if (everySegmentIsStraight) {
    // Straight runs are built point by point, because a FLAT segment is two
    // points rather than one: it holds its start value all the way to the next
    // keyframe and then steps. That step is a coincident-time node pair, which
    // is exactly how the data model encodes a jump — so a hold-then-step
    // survives as a hold-then-step instead of flattening into a ramp.
    const points: { t: number; v: number }[] = [
      {
        t: localOf(runKeyframes[0].time) - start,
        v: runKeyframes[0].value,
      },
    ];
    for (let i = runStart; i < runEnd; i++) {
      const a = keyframes[i];
      const b = keyframes[i + 1];
      const bt = localOf(b.time) - start;
      // The hold point only exists to carry the value up to the step. With
      // equal endpoints there IS no step, so writing it anyway leaves a
      // coincident pair the read side cannot recognise as a flat — and since
      // every edit rewrites the lane, each pass would add another pair and the
      // keyframes would multiply under a drag.
      if (
        segments[i].type === "flat" &&
        Math.abs(b.value - a.value) > VALUE_EPS
      )
        points.push({ t: bt, v: a.value });
      points.push({ t: bt, v: b.value });
    }

    const nodes = points.map((point, i) => {
      const previous = points[i - 1];
      const next = points[i + 1];
      const inDt = previous ? point.t - previous.t : 0;
      const outDt = next ? next.t - point.t : 0;
      const inDv = previous ? point.v - previous.v : 0;
      const outDv = next ? next.v - point.v : 0;
      // Control points at the chord thirds: both flat and linear fall out of
      // straight handles.
      return makeCurveNode(
        point.t,
        point.v,
        { dt: -inDt / 3, dv: -inDv / 3 },
        { dt: outDt / 3, dv: outDv / 3 },
      );
    });
    return new CurveVariation(duration, nodes);
  }

  // Shaped run: fit the lane's own evaluation, so bends and easings land
  // within tolerance and interior keyframes are seeded exactly.
  //
  // The fit runs over the KEYFRAME range, not the region's whole span. The
  // fitter always anchors a node at each end of what it is given, so fitting
  // the full span would plant nodes at the region's edges — keyframes the
  // author never placed, appearing as dots in the editor. Fitting the curve
  // itself and then sliding the nodes into position inside the region keeps
  // the node set exactly the author's, while the region still tiles.
  const nodesStart = localOf(keyframes[runStart].time);
  const nodesDuration = localOf(keyframes[runEnd].time) - nodesStart;
  const offset = nodesStart - start;

  const valueAtCurveTime = (t: number) => {
    const target = nodesStart + t;
    for (let i = runStart; i < runEnd; i++) {
      const a = keyframes[i];
      const b = keyframes[i + 1];
      const aLocal = localOf(a.time);
      const bLocal = localOf(b.time);
      if (target >= aLocal - TIME_EPS && target <= bLocal + TIME_EPS) {
        const span = bLocal - aLocal;
        const u = span > TIME_EPS ? (target - aLocal) / span : 1;
        return evaluateSegment(a, b, segments[i], Math.min(Math.max(u, 0), 1));
      }
    }
    return target < nodesStart
      ? keyframes[runStart].value
      : keyframes[runEnd].value;
  };

  if (nodesDuration <= TIME_EPS)
    return new CurveVariation(duration, [
      makeCurveNode(offset, keyframes[runStart].value),
    ]);

  const seedUs = runKeyframes
    .map((keyframe) => (localOf(keyframe.time) - nodesStart) / nodesDuration)
    .filter((u) => u > 1e-6 && u < 1 - 1e-6);

  const fitted = fitCurveNodes(valueAtCurveTime, nodesDuration, {}, seedUs);
  for (const node of fitted) node.time += offset;
  return new CurveVariation(duration, fitted);
};

/**
 * Stretch the region list to tile the block exactly. Upstream holds the last
 * region's final value past its end, so a short lane plays correctly either
 * way — but a lane that tiles is what its own editing operations assume.
 */
const spanToBlock = (
  variations: Variation[],
  blockDuration: number,
): Variation[] => {
  if (variations.length === 0) return variations;
  const total = variations.reduce(
    (sum, variation) => sum + variation.duration,
    0,
  );
  const shortfall = blockDuration - total;
  if (shortfall <= TIME_EPS) return variations;

  const last = variations[variations.length - 1];
  // A generator keeps its size: stretching a wave would make it oscillate on
  // into the extension, where decision 16 says the value freezes at the
  // region's end. The tail becomes a hold instead — one node at the START of
  // it, so it lands on the generator's own end keyframe and collapses into it
  // rather than adding a dot at the block's end. It holds the generator's
  // centre, which is the value the editor draws that keyframe at.
  if (last instanceof PeriodicVariation || last instanceof AudioVariation) {
    variations.push(
      new CurveVariation(shortfall, [makeCurveNode(0, last.offset)]),
    );
    return variations;
  }
  // An easing keeps its shape too: stretching it would restretch the curve the
  // author chose. The tail holds its end value instead.
  if (last instanceof EasingVariation) {
    variations.push(new CurveVariation(shortfall, [makeCurveNode(0, last.to)]));
    return variations;
  }
  if (last instanceof CurveVariation) last.resizeEnd(last.duration + shortfall);
  else last.duration += shortfall;
  return variations;
};
