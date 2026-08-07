// The value lane — colour and palette — as a VARIATION of the numeric lane,
// not a parallel implementation of it.
//
// A value lane automates the whole value rather than a number, so it differs
// from a numeric lane in exactly three ways, all of them stated by the owner:
// it has no vertical meaning (@@L5846 "that animation curve should just be a
// straight line, and there should be no range on the right side"), it shows a
// bordered chip per period instead of a curve shape (@@L6136 "just a tiny
// rectangle with the color inside of it and a border... that just sits in the
// middle of the segment"), and it has no golden value dot (@@L6141).
//
// Everything else — the time viewport, keyframe dots, selection, suspension,
// the block's bounds — is the numeric lane's, unchanged. This module holds
// only the difference, so that the lane preview and the expanded editor read
// their period geometry from ONE place. They previously each computed their
// own, which is how the preview came to disagree with the editor about where
// a period ends ("color automation preview doesnt fit to block").

import type { AutomationCurve, ValuePayload } from "./automation";
import { isGradientPayload } from "./automation";
import { paletteToGradientCss, rgbaToCss } from "./ValueEditors";
import { isVector4 } from "@/src/utils/object";
import { isPalette } from "@/src/params/palette/Palette";

export type LaneKind = "number" | "color" | "palette";

/** Which kind of lane a parameter's value calls for. */
export const laneKindOf = (value: unknown): LaneKind =>
  isPalette(value) ? "palette" : isVector4(value) ? "color" : "number";

export const isValueKind = (kind: LaneKind) => kind !== "number";

export const payloadCss = (payload: ValuePayload) =>
  payload.color
    ? isGradientPayload(payload)
      ? `linear-gradient(90deg, ${rgbaToCss(payload.color)}, ${rgbaToCss(
          payload.colorTo!,
        )})`
      : rgbaToCss(payload.color)
    : payload.palette
      ? paletteToGradientCss(payload.palette)
      : "rgba(232, 236, 244, 0.4)";

/** A parameter's own current value as a period payload, for an empty lane. */
export const currentValuePayload = (value: unknown): ValuePayload => {
  if (isVector4(value))
    return {
      color: [value.x, value.y, value.z, value.w] as [
        number,
        number,
        number,
        number,
      ],
    };
  if (isPalette(value)) return { palette: value.serialize() };
  return {};
};

/** The period holding before the first keyframe. */
export const leadInPayload = (
  curve: Pick<AutomationCurve, "keyframes" | "leadIn">,
): ValuePayload =>
  curve.leadIn ?? {
    color: curve.keyframes[0]?.color,
    colorTo: curve.keyframes[0]?.colorTo,
    palette: curve.keyframes[0]?.palette,
  };

export type ValueRegion = {
  /** Region 0 is the lead-in; region i edits keyframe i-1's payload. */
  index: number;
  /** Percentages of the lane's width, in the caller's own time mapping. */
  from: number;
  to: number;
  css: string;
  gradient: boolean;
  /** False only for the display-only region an empty lane shows. */
  selectable: boolean;
};

const clampPct = (pct: number) => Math.min(Math.max(pct, 0), 100);

// A period narrower than this cannot hold a chip, so it draws none.
const MIN_REGION_PCT = 0.5;

/**
 * The periods of a value lane, as percentages of the lane's width.
 *
 * Keyframes are boundaries: N keyframes make N + 1 periods. The tiling is
 * bounded by the BLOCK, not by the view — outside the block nothing evaluates
 * the parameter, so a period has no meaning there, and a chip centred over a
 * span running to the view's edge sits in the wrong place.
 *
 * `timeToX` is the caller's own time mapping, which is what keeps the preview
 * a scale model of the editor: they pass the same shared viewport in different
 * pixel widths and get the same proportions out.
 */
export const valueRegions = ({
  curve,
  timeToX,
  blockRange,
  emptyPayload,
}: {
  curve: Pick<AutomationCurve, "keyframes" | "leadIn"> | null;
  timeToX: (time: number) => number;
  blockRange: { start: number; end: number } | null;
  /** Shown as one display-only period when the lane has no keyframes. */
  emptyPayload?: ValuePayload;
}): ValueRegion[] => {
  const start = clampPct(
    blockRange ? timeToX(blockRange.start) : Math.max(timeToX(0), 0),
  );
  const end = clampPct(blockRange ? timeToX(blockRange.end) : 100);
  const keyframes = curve?.keyframes ?? [];

  if (keyframes.length === 0) {
    if (!emptyPayload || end - start < MIN_REGION_PCT) return [];
    return [
      {
        index: 0,
        from: start,
        to: end,
        css: payloadCss(emptyPayload),
        gradient: isGradientPayload(emptyPayload),
        selectable: false,
      },
    ];
  }

  // Boundaries are pinned inside the block: a keyframe dragged past the
  // block's end collapses its period to nothing rather than tiling past it.
  const pin = (pct: number) => Math.min(Math.max(pct, start), end);
  const boundaries = [
    start,
    ...keyframes.map((keyframe) => pin(clampPct(timeToX(keyframe.time)))),
    end,
  ];
  const payloads: ValuePayload[] = [leadInPayload(curve!), ...keyframes];

  const regions: ValueRegion[] = [];
  for (let i = 0; i < payloads.length; i++) {
    const from = boundaries[i];
    const to = boundaries[i + 1];
    if (to - from < MIN_REGION_PCT) continue;
    regions.push({
      index: i,
      from,
      to,
      css: payloadCss(payloads[i]),
      gradient: isGradientPayload(payloads[i]),
      selectable: true,
    });
  }
  return regions;
};

