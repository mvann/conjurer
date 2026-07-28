import { Block } from "@/src/types/Block";
import { Variation } from "@/src/types/Variations/Variation";
import { CurveVariation } from "@/src/types/Variations/CurveVariation";
import { PeriodicVariation } from "@/src/types/Variations/PeriodicVariation";
import { AudioVariation } from "@/src/types/Variations/AudioVariation";
import { fitCurveNodes } from "@/src/utils/migrateVariations";
import type { Store } from "@/src/types/Store";

// The expanded editor's read model over a block lane's regions, plus
// the handful of mutations their Block/CurveVariation APIs don't cover
// (generator splits, retype makers). Everything here works in
// block-local seconds; the view converts to song time for display.

export type ViewKeyframe = {
  time: number; // block-local seconds
  value: number;
  regionIndex: number;
  // Curve nodes carry their node id; generator boundary keyframes
  // carry which edge they are (dragging either edge moves the offset).
  nodeId?: string;
  edge?: "start" | "end";
};

export type ViewSpan = {
  from: number;
  to: number;
  regionIndex: number;
  kind: "curve" | "periodic" | "audio" | "other";
  // Curve spans: the node ids bounding this span (for retype carving).
  fromNodeId?: string;
  toNodeId?: string;
};

export const regionStartTimes = (regions: Variation[]) => {
  const starts: number[] = [];
  let acc = 0;
  for (const region of regions) {
    starts.push(acc);
    acc += region.duration;
  }
  return starts;
};

export const laneTotal = (regions: Variation[]) =>
  regions.reduce((sum, region) => sum + region.duration, 0);

export const regionAt = (regions: Variation[], time: number) => {
  const starts = regionStartTimes(regions);
  for (let i = regions.length - 1; i >= 0; i--)
    if (time >= starts[i] - 1e-9) return { index: i, start: starts[i] };
  return { index: 0, start: 0 };
};

// The lane's keyframes: curve nodes at their absolute lane times plus
// both edges of every generator region (the stacked, offset-dragging
// dots of decision 14).
export const laneKeyframes = (regions: Variation[]): ViewKeyframe[] => {
  const starts = regionStartTimes(regions);
  const keyframes: ViewKeyframe[] = [];
  regions.forEach((region, index) => {
    const start = starts[index];
    if (region instanceof CurveVariation) {
      for (const node of region.nodes)
        keyframes.push({
          time: start + node.time,
          value: node.value,
          regionIndex: index,
          nodeId: node.id,
        });
    } else if (
      region instanceof PeriodicVariation ||
      region instanceof AudioVariation
    ) {
      keyframes.push({
        time: start,
        value: region.valueAtTime(0, 0),
        regionIndex: index,
        edge: "start",
      });
      keyframes.push({
        time: start + region.duration,
        value: region.valueAtTime(region.duration, 0),
        regionIndex: index,
        edge: "end",
      });
    }
  });
  return keyframes.sort((a, b) => a.time - b.time);
};

// Spans between adjacent keyframes, tagged with the region that owns
// them (for retype + inspector targeting).
export const laneSpans = (regions: Variation[]): ViewSpan[] => {
  const starts = regionStartTimes(regions);
  const spans: ViewSpan[] = [];
  regions.forEach((region, index) => {
    const start = starts[index];
    if (region instanceof CurveVariation) {
      for (let i = 0; i < region.nodes.length - 1; i++) {
        const a = region.nodes[i];
        const b = region.nodes[i + 1];
        if (b.time - a.time < 1e-9) continue; // stacked step
        spans.push({
          from: start + a.time,
          to: start + b.time,
          regionIndex: index,
          kind: "curve",
          fromNodeId: a.id,
          toNodeId: b.id,
        });
      }
    } else {
      spans.push({
        from: start,
        to: start + region.duration,
        regionIndex: index,
        kind:
          region instanceof PeriodicVariation
            ? "periodic"
            : region instanceof AudioVariation
              ? "audio"
              : "other",
      });
    }
  });
  return spans.sort((a, b) => a.from - b.from);
};

// Evaluate the lane at a block-local time (for drawing and for seeding
// new regions from the value they replace).
export const laneValueAt = (regions: Variation[], time: number) => {
  const starts = regionStartTimes(regions);
  for (let i = regions.length - 1; i >= 0; i--) {
    if (time >= starts[i] - 1e-9) {
      const local = Math.min(time - starts[i], regions[i].duration);
      const value = regions[i].valueAtTime(local, time);
      return typeof value === "number" ? value : 0;
    }
  }
  return 0;
};

// Split a generator region at a block-local time, phase-correcting the
// right half so the waveform is visually unchanged (decision 13's
// wave-split rule; audio splits are trivial since it reads global
// loudness).
export const splitGeneratorAt = (
  block: Block,
  uniform: string,
  time: number,
) => {
  const regions = block.parameterVariations[uniform];
  if (!regions) return;
  const { index, start } = regionAt(regions, time);
  const region = regions[index];
  const offset = time - start;
  if (offset < 1e-6 || offset > region.duration - 1e-6) return;

  if (region instanceof PeriodicVariation) {
    const left = new PeriodicVariation(
      offset,
      region.periodicType,
      region.amplitude,
      region.period,
      region.phase,
      region.offset,
    );
    // Sine/square phase is radians; triangle phase is seconds (the
    // upstream unit quirk), so the correction differs per waveform.
    const phase =
      region.periodicType === "triangle"
        ? (region.phase + offset) % region.period
        : region.phase + (offset / region.period) * 2 * Math.PI;
    const right = new PeriodicVariation(
      region.duration - offset,
      region.periodicType,
      region.amplitude,
      region.period,
      phase,
      region.offset,
    );
    regions.splice(index, 1, left, right);
  } else if (region instanceof AudioVariation) {
    const store = (region as unknown as { store: Store }).store;
    const left = new AudioVariation(
      offset,
      region.factor,
      region.offset,
      region.smoothing,
      store,
    );
    const right = new AudioVariation(
      region.duration - offset,
      region.factor,
      region.offset,
      region.smoothing,
      store,
    );
    regions.splice(index, 1, left, right);
  }
  block.triggerVariationReactions(uniform);
};

// Region makers for retyping a span (decision 14 seeding: generators
// start lined up with the span's left value, phase 0; period defaults
// to a quarter of the span so a few cycles show).
export const makeWave = (
  duration: number,
  leftValue: number,
  amplitude: number,
) =>
  new PeriodicVariation(
    duration,
    "sine",
    amplitude,
    duration / 4,
    0,
    leftValue,
  );

export const makeAudio = (store: Store, duration: number, leftValue: number) =>
  new AudioVariation(duration, 1, leftValue, 0.05, store);

// Retype to curve = bake whatever is there into a fitted Bezier.
export const makeBakedCurve = (
  regions: Variation[],
  from: number,
  to: number,
) => {
  const duration = to - from;
  return new CurveVariation(
    duration,
    fitCurveNodes((t) => laneValueAt(regions, from + t), duration),
  );
};

// Arm an empty lane for editing: the manual value becomes the lone
// constant region the editor then works on (promotion, decision 8).
export const ensureLaneRegions = (
  block: Block,
  uniform: string,
  fallbackValue: number,
) => {
  const existing = block.parameterVariations[uniform];
  if (existing && existing.length > 0) return existing;
  const regions = [CurveVariation.flat(block.duration, fallbackValue)];
  block.parameterVariations[uniform] = regions;
  return regions;
};
