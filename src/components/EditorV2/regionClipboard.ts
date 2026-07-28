import { Block } from "@/src/types/Block";
import { Variation } from "@/src/types/Variations/Variation";
import { CurveVariation } from "@/src/types/Variations/CurveVariation";
import { PeriodicVariation } from "@/src/types/Variations/PeriodicVariation";
import { AudioVariation } from "@/src/types/Variations/AudioVariation";
import {
  laneValueAt,
  regionStartTimes,
} from "@/src/components/EditorV2/laneModel";
import type { Store } from "@/src/types/Store";

// The region clipboard (plan decisions): window operations split
// regions at the selection edges (waves phase-corrected), delete
// bridges the gap with a straight curve, paste overwrites what it
// covers, and cross-lane pastes normalize between the lanes' ranges.
// The clip also lands on the OS clipboard in the upstream app's
// serialized-variation format, so the two editors can trade material.

export type RegionClip = {
  regions: Variation[];
  duration: number;
  // The value range the source occupied (declared bounds when the
  // param had them, else the material's own extent).
  rangeMin: number;
  rangeMax: number;
};

// Module-level singleton, like the legacy automation clipboard.
export const regionClipboard: { clip: RegionClip | null } = { clip: null };

// A copy of `region` restricted to [from, to) in region-local time,
// preserving liveness: curves split exactly, waves keep their phase
// alignment, audio is trivially sliceable.
const sliceRegion = (
  region: Variation,
  from: number,
  to: number,
): Variation => {
  const duration = to - from;
  if (region instanceof CurveVariation) {
    let piece = region.clone() as CurveVariation;
    if (to < region.duration - 1e-9) [piece] = piece.splitAtTime(to);
    if (from > 1e-9) [, piece] = piece.splitAtTime(from);
    return piece;
  }
  if (region instanceof PeriodicVariation) {
    const phase =
      region.periodicType === "triangle"
        ? (region.phase + from) % region.period
        : region.phase + (from / region.period) * 2 * Math.PI;
    return new PeriodicVariation(
      duration,
      region.periodicType,
      region.amplitude,
      region.period,
      phase,
      region.offset,
    );
  }
  if (region instanceof AudioVariation) {
    const store = (region as unknown as { store: Store }).store;
    return new AudioVariation(
      duration,
      region.factor,
      region.offset,
      region.smoothing,
      store,
    );
  }
  const clone = region.clone();
  clone.duration = duration;
  return clone;
};

// The window [t0, t1] of a lane as standalone regions.
export const sliceLaneWindow = (
  regions: Variation[],
  t0: number,
  t1: number,
): Variation[] => {
  const starts = regionStartTimes(regions);
  const out: Variation[] = [];
  regions.forEach((region, index) => {
    const start = starts[index];
    const end = start + region.duration;
    const from = Math.max(t0, start);
    const to = Math.min(t1, end);
    if (to - from < 1e-6) return;
    out.push(sliceRegion(region, from - start, to - start));
  });
  return out;
};

export const copyWindow = (
  block: Block,
  uniform: string,
  t0: number,
  t1: number,
  rangeMin: number,
  rangeMax: number,
) => {
  const regions = block.parameterVariations[uniform];
  if (!regions) return;
  const clip: RegionClip = {
    regions: sliceLaneWindow(regions, t0, t1),
    duration: t1 - t0,
    rangeMin,
    rangeMax,
  };
  regionClipboard.clip = clip;
  // The upstream app pastes text/plain arrays of serialized
  // variations; speak the same format outward.
  try {
    navigator.clipboard?.writeText(
      JSON.stringify(clip.regions.map((region) => region.serialize())),
    );
  } catch {}
};

// Delete bridges: the window's material is replaced by one straight
// curve connecting the values at its edges (never a ripple).
export const deleteWindow = (
  block: Block,
  uniform: string,
  t0: number,
  t1: number,
) => {
  const regions = block.parameterVariations[uniform];
  if (!regions) return;
  const v0 = laneValueAt(regions, t0);
  const v1 = laneValueAt(regions, Math.min(t1, laneTotalOf(regions)));
  block.insertRegion(uniform, t0, t1, (duration) =>
    CurveVariation.line(duration, v0, v1),
  );
};

const laneTotalOf = (regions: Variation[]) =>
  regions.reduce((sum, region) => sum + region.duration, 0);

// Map a value from the clip's source range into the destination's.
const mapValue = (
  value: number,
  clip: RegionClip,
  toMin: number,
  toMax: number,
) => {
  const span = clip.rangeMax - clip.rangeMin || 1;
  return toMin + ((value - clip.rangeMin) / span) * (toMax - toMin);
};

// Paste overwrites the window it covers, normalized into the
// destination lane's range (identity for same-range lanes). Their
// insertRegion clamps at the lane's end, so a paste never overhangs
// the block; the trailing material is trimmed instead.
export const pasteClipAt = (
  block: Block,
  uniform: string,
  at: number,
  toMin: number,
  toMax: number,
) => {
  const clip = regionClipboard.clip;
  if (!clip || clip.regions.length === 0) return;
  const scale = (toMax - toMin) / (clip.rangeMax - clip.rangeMin || 1);
  let offset = at;
  for (const source of clip.regions) {
    const region = source.clone();
    if (region instanceof CurveVariation) {
      for (const node of region.nodes) {
        node.value = mapValue(node.value, clip, toMin, toMax);
        node.handleIn = { dt: node.handleIn.dt, dv: node.handleIn.dv * scale };
        node.handleOut = {
          dt: node.handleOut.dt,
          dv: node.handleOut.dv * scale,
        };
      }
    } else if (region instanceof PeriodicVariation) {
      region.offset = mapValue(region.offset, clip, toMin, toMax);
      region.amplitude *= scale;
    } else if (region instanceof AudioVariation) {
      region.offset = mapValue(region.offset, clip, toMin, toMax);
      region.factor *= scale;
    }
    const start = offset;
    const end = offset + source.duration;
    block.insertRegion(uniform, start, end, () => region);
    offset = end;
  }
};
