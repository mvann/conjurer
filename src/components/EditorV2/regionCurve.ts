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

const isGenerator = (type: SegmentSpec["type"]) =>
  type === "wave" || type === "audio";

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

  const keyframes: AutomationKeyframe[] = [];
  let cursor = 0;
  for (const variation of variations) {
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
    keyframes.push(keyframe);
    cursor += variation.duration;
  }

  if (keyframes.length === 0) return null;
  // Segments carry no shape here, but the list has to stay sized to the
  // keyframes or getSegments will pad it and callers will misread the lane.
  return {
    keyframes,
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
  const variations: Variation[] = [];
  for (let index = 0; index < keyframes.length; index++) {
    const keyframe = keyframes[index];
    // The first period starts at the block's start whatever its keyframe says
    // (leadIn dissolves); the last runs to the block's end.
    const start = index === 0 ? 0 : local(keyframe.time);
    const end =
      index === keyframes.length - 1
        ? blockDuration
        : local(keyframes[index + 1].time);
    const duration = end - start;
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
        // Bezier shape lives in the handles; bend stays neutral.
        if (index < nodes.length - 1)
          segments.push({ type: "curve", bend: 1 });
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
  // A single point is not a curve the editor can draw a segment through;
  // give it the block's span so it reads as a flat lane.
  if (keyframes.length === 1) {
    keyframes.push({
      time: frac(ctx.blockDuration),
      value: keyframes[0].value,
    });
    segments.push({ type: "flat" });
  }
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
  const carriesPalette = keyframes.some((keyframe) => keyframe.palette);
  const carriesColor = keyframes.some(
    (keyframe) => keyframe.color || keyframe.colorTo,
  );
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

  const segments = getSegments(curve);
  const variations: Variation[] = [];

  // Split the lane into runs: each generator segment is its own region,
  // and a maximal run of interpolator segments becomes one Curve region.
  // Runs also break at a step (coincident keyframes with different values),
  // because the fitter is only valid over a continuous function.
  let index = 0;
  while (index < segments.length) {
    const segment = segments[index];

    if (isGenerator(segment.type)) {
      const a = keyframes[index];
      const b = keyframes[index + 1];
      const start = local(a.time);
      const duration = local(b.time) - start;
      if (duration > TIME_EPS) {
        if (segment.type === "wave") {
          const period = segment.cycles !== 0 ? duration / segment.cycles : 0;
          variations.push(
            new PeriodicVariation(
              duration,
              segment.wave as PeriodicVariation["periodicType"],
              segment.amplitude,
              period,
              phaseFromCycles(segment.wave, segment.phase, period),
              // Upstream's generator centre is constant; seed it from the
              // left boundary, which is where creation lines the wave up.
              a.value,
            ),
          );
        } else if (segment.type === "audio") {
          variations.push(
            new AudioVariation(
              duration,
              segment.factor,
              a.value,
              segment.smoothing,
              store,
            ),
          );
        }
      }
      index++;
      continue;
    }

    // Gather a maximal interpolator run, stopping before a generator or a
    // step boundary.
    const runStart = index;
    let runEnd = index; // exclusive segment index
    while (runEnd < segments.length && !isGenerator(segments[runEnd].type)) {
      const a = keyframes[runEnd];
      const b = keyframes[runEnd + 1];
      // A zero-width segment between differing values is a step: it ends
      // the run so the coincident nodes can be emitted inside one region.
      const zeroWidth = Math.abs(b.time - a.time) < TIME_EPS;
      if (zeroWidth && Math.abs(b.value - a.value) > VALUE_EPS) {
        runEnd++;
        break;
      }
      runEnd++;
    }

    const first = keyframes[runStart];
    const last = keyframes[runEnd];
    const start = local(first.time);
    const duration = local(last.time) - start;

    if (duration <= TIME_EPS) {
      index = runEnd;
      continue;
    }

    variations.push(
      curveRegionForRun(curve, segments, keyframes, runStart, runEnd, {
        start,
        duration,
        songDuration,
        localOf: local,
      }),
    );
    index = runEnd;
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
  const runIsHandled = runKeyframes.every((keyframe, i) => {
    const needsOut = i < runKeyframes.length - 1;
    const needsIn = i > 0;
    return (!needsOut || !!keyframe.handleOut) && (!needsIn || !!keyframe.handleIn);
  });
  const everySegmentIsStraight = segments
    .slice(runStart, runEnd)
    .every((segment) => segment.type === "linear" || segment.type === "flat");

  if (runIsHandled || everySegmentIsStraight) {
    const nodes: CurveNode[] = runKeyframes.map((keyframe, i) => {
      const time = localOf(keyframe.time) - start;
      if (runIsHandled) {
        const handleIn = keyframe.handleIn ?? { dt: 0, dv: 0 };
        const handleOut = keyframe.handleOut ?? { dt: 0, dv: 0 };
        return makeCurveNode(
          time,
          keyframe.value,
          { dt: handleIn.dt * songDuration, dv: handleIn.dv },
          { dt: handleOut.dt * songDuration, dv: handleOut.dv },
        );
      }
      // Straight run: control points at the chord thirds, which is how
      // flat and linear both fall out of a Bezier.
      const previous = runKeyframes[i - 1];
      const next = runKeyframes[i + 1];
      const inDt = previous ? time - (localOf(previous.time) - start) : 0;
      const outDt = next ? localOf(next.time) - start - time : 0;
      const inDv = previous ? keyframe.value - previous.value : 0;
      const outDv = next ? next.value - keyframe.value : 0;
      // A flat segment holds its start value, so its outgoing chord is level.
      const outSegment = segments[runStart + i];
      const levelOut = outSegment && outSegment.type === "flat";
      const inSegment = segments[runStart + i - 1];
      const levelIn = inSegment && inSegment.type === "flat";
      return makeCurveNode(
        time,
        keyframe.value,
        { dt: -inDt / 3, dv: levelIn ? 0 : -inDv / 3 },
        { dt: outDt / 3, dv: levelOut ? 0 : outDv / 3 },
      );
    });
    const region = new CurveVariation(duration, nodes);
    region.ensureTerminalNode();
    return region;
  }

  // Shaped run: fit the lane's own evaluation, so bends and easings land
  // within tolerance and interior keyframes are seeded exactly. `t` arrives
  // region-local (0..duration); the lane is indexed in block-local seconds.
  const valueAtRegionTime = (t: number) => {
    const target = start + t;
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
    return keyframes[runEnd].value;
  };

  const seedUs = runKeyframes
    .slice(1, -1)
    .map((keyframe) => (localOf(keyframe.time) - start) / duration);

  const region = new CurveVariation(
    duration,
    fitCurveNodes(valueAtRegionTime, duration, {}, seedUs),
  );
  region.ensureTerminalNode();
  return region;
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
  if (shortfall > TIME_EPS) {
    const last = variations[variations.length - 1];
    if (last instanceof CurveVariation) last.resizeEnd(last.duration + shortfall);
    else last.duration += shortfall;
  }
  return variations;
};
