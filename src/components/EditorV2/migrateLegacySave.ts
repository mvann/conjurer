import { Experience, EXPERIENCE_VERSION } from "@/src/types/Experience";
import { NO_SONG } from "@/src/types/Song";
import { generateId } from "@/src/utils/id";
import { fitCurveNodes } from "@/src/utils/migrateVariations";
import { MINIMUM_VARIATION_DURATION } from "@/src/utils/time";
import {
  AutomationCurve,
  evaluateCurve,
  isCurveActive,
  payloadAtTime,
  SegmentSpec,
} from "@/src/components/EditorV2/automation";
import { SerializedEditorState } from "@/src/components/EditorV2/experiencePersistence";

// One-way migration of Spell Crafter's legacy localStorage document
// (song-fraction curves over an always-on pattern stack) into the
// experience blob (block-local seconds, region variations). Runs once,
// when a legacy save is found; the result lands in the draft channel
// as unsaved work.
//
// Regions are emitted as SERIALIZED literals (what Variation.serialize
// would produce) rather than class instances: the classes drag three.js
// and store dependencies into what should be pure data conversion, and
// the blob is the contract anyway.
//
// Semantics honored from the merge plan:
// - Every entry becomes a full-song block in ONE layer (identical
//   spans generate no auto-crossfade, so the stack still sums).
// - Un-automated params and deactivated curves write full-block
//   constants (the manual value IS the lone constant region).
// - Wave/audio segments adopt the absolute generator model: offset is
//   seeded from the left keyframe; ramped baselines are Bezier-fitted
//   when reasonable, else surrendered to a centered offset.
// - Legacy visibility automation becomes a u_opacity step lane.
// - Regions shorter than the upstream editing minimum are merged.

// The legacy format's visibility-lane sentinel (PatternsPanel's
// VISIBILITY_PARAM). Inlined: the legacy format is frozen, and
// importing the .tsx would drag UI code into the ts-node test build.
const VISIBILITY_PARAM = "__visibility";

const DEFAULT_BLOCK_SECONDS = 60; // no-song saves: nominal basis

// How many wave cycles we are willing to bake into a Bezier fit when
// a ramped baseline forces baking (64-node cap needs ~5 nodes/cycle).
const MAX_BAKED_WAVE_CYCLES = 12;

type LegacyEntry = SerializedEditorState["entries"][number];
type Region = { type: string; duration: number; [key: string]: unknown };

const isGenerator = (spec: SegmentSpec | undefined) =>
  spec?.type === "wave" || spec?.type === "audio";

// A constant curve region: two nodes, straight handles. Byte-stable
// through upstream's load (their fitter leaves curves alone), unlike a
// FlatVariation, which the load pass would rewrite.
const flatCurve = (duration: number, value: number): Region => ({
  type: "curve",
  duration,
  rangeMin: undefined,
  rangeMax: undefined,
  nodes: [
    {
      time: 0,
      value,
      handleIn: { dt: 0, dv: 0 },
      handleOut: { dt: duration / 3, dv: 0 },
    },
    {
      time: duration,
      value,
      handleIn: { dt: -duration / 3, dv: 0 },
      handleOut: { dt: 0, dv: 0 },
    },
  ],
});

const fittedCurve = (
  sample: (t: number) => number,
  duration: number,
  seeds?: number[],
): Region => ({
  type: "curve",
  duration,
  rangeMin: undefined,
  rangeMax: undefined,
  nodes: fitCurveNodes(sample, duration, {}, seeds).map((node) => ({
    time: node.time,
    value: node.value,
    handleIn: { dt: node.handleIn.dt, dv: node.handleIn.dv },
    handleOut: { dt: node.handleOut.dt, dv: node.handleOut.dv },
  })),
});

const constantRegion = (duration: number, value: unknown): Region | null => {
  if (typeof value === "number") return flatCurve(duration, value);
  if (Array.isArray(value) && value.length === 4)
    return { type: "linear4", duration, from: [...value], to: [...value] };
  if (value && typeof value === "object" && "a" in (value as object))
    return { type: "palette", duration, palette: value };
  return null;
};

// A value lane (color/palette payload periods) maps period-for-period:
// each hold becomes one constant region.
const valueLaneRegions = (
  curve: AutomationCurve,
  blockSeconds: number,
): Region[] => {
  const times = [0, ...curve.keyframes.map((k) => k.time), 1];
  const regions: Region[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const t0 = times[i];
    const t1 = times[i + 1];
    const duration = (t1 - t0) * blockSeconds;
    if (duration <= 1e-9) continue;
    const payload = payloadAtTime(curve, (t0 + t1) / 2);
    if (!payload) continue;
    if (payload.palette)
      regions.push({ type: "palette", duration, palette: payload.palette });
    else if (payload.color)
      regions.push({
        type: "linear4",
        duration,
        from: [...payload.color],
        to: [...payload.color],
      });
  }
  return mergeTinyRegions(regions);
};

// Number lanes: generator segments become live regions; every maximal
// run of drawn segments (and holds) is Bezier-fitted as one curve
// region, split additionally at stacked-keyframe steps so
// discontinuities land on region boundaries instead of being smoothed.
const numberLaneRegions = (
  curve: AutomationCurve,
  blockSeconds: number,
): Region[] => {
  const { keyframes } = curve;
  const segments = curve.segments ?? [];
  const regions: Region[] = [];

  // Fraction-space cut points: 0, every generator segment edge, every
  // stacked-keyframe time, 1. Between consecutive cuts lies either one
  // generator segment or a fittable continuous stretch.
  const cuts = new Set<number>([0, 1]);
  const generatorSpans: { t0: number; t1: number; index: number }[] = [];
  for (let i = 0; i < keyframes.length - 1; i++) {
    const t0 = keyframes[i].time;
    const t1 = keyframes[i + 1].time;
    if (isGenerator(segments[i])) {
      cuts.add(t0);
      cuts.add(t1);
      if (t1 - t0 > 1e-9) generatorSpans.push({ t0, t1, index: i });
    }
    if (t1 - t0 < 1e-9) cuts.add(t0); // stacked pair: a step boundary
    // A flat segment holds its left value then steps at its RIGHT
    // keyframe (later-segment-wins); that discontinuity must land on
    // a region boundary or the fit would smooth it.
    if (
      segments[i]?.type === "flat" &&
      Math.abs(keyframes[i + 1].value - keyframes[i].value) > 1e-9
    )
      cuts.add(t1);
  }
  const sortedCuts = [...cuts].sort((a, b) => a - b);

  for (let c = 0; c < sortedCuts.length - 1; c++) {
    const f0 = sortedCuts[c];
    const f1 = sortedCuts[c + 1];
    if (f1 - f0 < 1e-9) continue;
    const duration = (f1 - f0) * blockSeconds;
    const generator = generatorSpans.find(
      (span) => span.t0 <= f0 + 1e-9 && span.t1 >= f1 - 1e-9,
    );
    if (generator) {
      regions.push(
        generatorRegion(curve, generator.index, duration, blockSeconds),
      );
      continue;
    }
    // Continuous stretch: sample the legacy evaluator, seed node
    // positions at the keyframes inside the window.
    const sample = (t: number) =>
      evaluateCurve(curve, f0 + (t / duration) * (f1 - f0)) ?? 0;
    const seeds = keyframes
      .map((k) => k.time)
      .filter((t) => t > f0 + 1e-9 && t < f1 - 1e-9)
      .map((t) => (t - f0) / (f1 - f0));
    regions.push(fittedCurve(sample, duration, seeds));
  }
  return mergeTinyRegions(regions);
};

const generatorRegion = (
  curve: AutomationCurve,
  segmentIndex: number,
  duration: number,
  blockSeconds: number,
): Region => {
  const a = curve.keyframes[segmentIndex];
  const b = curve.keyframes[segmentIndex + 1];
  const spec = curve.segments![segmentIndex];
  if (spec.type === "audio")
    // Absolute baseline: the left keyframe's value. A ramped baseline
    // is surrendered (documented legacy-import approximation). The
    // smoothing field rides through; the fixed serializer persists it.
    return {
      type: "audio",
      duration,
      factor: spec.factor,
      offset: a.value,
      smoothing: spec.smoothing,
    };

  // Wave (generatorRegion is only called for wave | audio).
  if (spec.type !== "wave") return flatCurve(duration, a.value);
  const period = duration / Math.max(spec.cycles, 1e-6);
  const ramped = Math.abs(b.value - a.value) > 1e-9;
  if (ramped && spec.cycles <= MAX_BAKED_WAVE_CYCLES) {
    // Bake the composite (ramp + wave) into a curve region.
    const f0 = a.time;
    const f1 = b.time;
    const sample = (t: number) =>
      evaluateCurve(curve, f0 + (t / duration) * (f1 - f0)) ?? 0;
    return fittedCurve(sample, duration);
  }
  const offset = ramped ? (a.value + b.value) / 2 : a.value;
  // Sine/square phase is radians; triangle phase is SECONDS (upstream
  // quirk, see PeriodicVariation.valueAtTime).
  const phase =
    spec.wave === "triangle" ? spec.phase * period : spec.phase * 2 * Math.PI;
  return {
    type: "periodic",
    duration,
    periodicType: spec.wave,
    amplitude: spec.amplitude,
    period,
    phase,
    offset,
  };
};

// Upstream's editing math assumes no region is shorter than the UI
// minimum; merge slivers into their left neighbor (or fold a leading
// sliver into the right one).
const mergeTinyRegions = (regions: Region[]): Region[] => {
  const out: Region[] = [];
  for (const region of regions) {
    if (region.duration >= MINIMUM_VARIATION_DURATION || out.length === 0) {
      out.push(region);
    } else {
      out[out.length - 1].duration += region.duration;
    }
  }
  if (out.length > 1 && out[0].duration < MINIMUM_VARIATION_DURATION) {
    const [first, second, ...rest] = out;
    second.duration += first.duration;
    return [second, ...rest];
  }
  return out;
};

const laneRegions = (
  curve: AutomationCurve,
  currentValue: unknown,
  blockSeconds: number,
): Region[] | null => {
  if (curve.keyframes.length === 0) return null;
  // Deactivated curve: the manual value drives, and takeover state is
  // not part of the experience — write the constant, drop the curve.
  if (!isCurveActive(curve)) {
    const constant = constantRegion(blockSeconds, currentValue);
    return constant ? [constant] : null;
  }
  const first = curve.keyframes[0];
  if (first.color || first.palette || curve.leadIn)
    return valueLaneRegions(curve, blockSeconds);
  return numberLaneRegions(curve, blockSeconds);
};

const blockVariations = (
  params: Record<string, unknown>,
  automatedParams: string[],
  automation: Record<string, AutomationCurve>,
  laneKeyFor: (uniform: string) => string,
  blockSeconds: number,
) => {
  const variations: Record<string, Region[]> = {};
  for (const [uniform, value] of Object.entries(params)) {
    const laneKey = laneKeyFor(uniform);
    const curve = automatedParams.includes(laneKey)
      ? automation[laneKey]
      : undefined;
    const regions = curve ? laneRegions(curve, value, blockSeconds) : null;
    if (regions && regions.length > 0) {
      variations[uniform] = regions;
      continue;
    }
    const constant = constantRegion(blockSeconds, value);
    if (constant) variations[uniform] = [constant];
  }
  return variations;
};

// Legacy visibility (the eye + its automation) becomes the block's
// u_opacity channel: a plain hidden eye is a constant 0; a visibility
// curve becomes 0/1 steps. A visible eye with no curve writes nothing
// (absence = upstream's auto opacity).
const opacityVariations = (
  entry: LegacyEntry,
  blockSeconds: number,
): Region[] | null => {
  const curve = entry.automation?.[VISIBILITY_PARAM];
  if (
    curve &&
    entry.automatedParams.includes(VISIBILITY_PARAM) &&
    curve.keyframes.length > 0 &&
    isCurveActive(curve)
  ) {
    return numberLaneRegions(
      {
        ...curve,
        // Quantize to 0/1 the way the legacy evaluator did.
        keyframes: curve.keyframes.map((keyframe) => ({
          ...keyframe,
          value: keyframe.value >= 0.5 ? 1 : 0,
        })),
      },
      blockSeconds,
    );
  }
  if (entry.visible === false) return [flatCurve(blockSeconds, 0)];
  return null;
};

// songDurationSeconds comes from the caller once the song's audio has
// been decoded (legacy saves never stored a duration); no-song saves
// fall back to a nominal basis.
export const migrateLegacySave = (
  legacy: SerializedEditorState,
  songDurationSeconds?: number,
): Experience => {
  const blockSeconds = songDurationSeconds ?? DEFAULT_BLOCK_SECONDS;

  const blockMap: Record<string, unknown> = {};
  for (const entry of legacy.entries) {
    const id = generateId();
    const parameterVariations = blockVariations(
      entry.params ?? {},
      entry.automatedParams ?? [],
      entry.automation ?? {},
      (uniform) => uniform,
      blockSeconds,
    );
    const opacity = opacityVariations(entry, blockSeconds);
    if (opacity) parameterVariations["u_opacity"] = opacity;

    blockMap[id] = {
      id,
      pattern: entry.pattern,
      startTime: 0,
      duration: blockSeconds,
      parameterVariations,
      effectBlocks: (entry.effects ?? []).map((effect) => {
        const effectId = generateId();
        return {
          id: effectId,
          pattern: effect.pattern,
          // Placeholder timing, matching upstream-authored bytes;
          // effect params run over the parent block's timeline.
          startTime: 0,
          duration: 5,
          parameterVariations: blockVariations(
            effect.params ?? {},
            entry.automatedParams ?? [],
            entry.automation ?? {},
            (uniform) => `effect:${effect.id}:${uniform}`,
            blockSeconds,
          ),
          effectBlocks: [],
        };
      }),
    };
  }

  return {
    id: undefined,
    name: "untitled",
    user: { id: -1, username: "" } as Experience["user"],
    song: legacy.song ?? NO_SONG,
    status: "inprogress",
    version: EXPERIENCE_VERSION,
    data: { layers: [{ id: generateId(), name: "Layer 1", blockMap }] },
    thumbnailURL: "",
  };
};
