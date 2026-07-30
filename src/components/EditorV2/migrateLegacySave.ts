// One-time migration of Spell Crafter's own old saves into the upstream blob.
//
// The old format (SerializedEditorState) is an always-on stack of patterns with
// song-fraction automation curves in two localStorage slots. The new one is an
// experience row whose `data` holds layers of blocks with region lanes in
// block-local seconds. Decision 22: migrate rather than abandon.
//
// The mapping, decision by decision:
// - Every stack entry becomes a BLOCK spanning the whole song — startTime 0,
//   duration = song length (decision 24). That is what lets an always-on stack
//   keep behaving like one: identical spans generate no auto-crossfade, since
//   upstream's autoFadeWindows uses strict inequalities, so the blocks
//   composite additively exactly as CanopyPane already does.
// - All entries land in ONE layer, matching the shape upstream's own
//   loadEmptyExperience produces, so migrated output is indistinguishable from
//   experiences authored in their editor.
// - A parameter's manual value is not a field in the blob: every param
//   serializes as variations, so an un-automated value becomes a lone constant
//   region and IS the manual value (decision 7).
// - Effects become nested effectBlocks, in chain order. Their `effect:<id>:<u>`
//   lane keys disappear: the automation moves onto the effect block's own
//   parameterVariations (decision 20).
// - Per-pattern visibility is gone (decision 5). A hidden entry migrates to a
//   flat u_opacity of 0, which is the faithful reading of the intent, and a
//   `__visibility` lane migrates to real u_opacity regions. A visible entry
//   writes NO u_opacity at all, so it stays "auto" (decision 25).
// - Regions shorter than upstream's 0.1s editing minimum are dropped: fraction
//   times multiplied out to seconds can leave slivers, and the owner's call was
//   to exclude them from the migration.

import { Vector4 } from "three";
import { CurveVariation } from "@/src/types/Variations/CurveVariation";
import { LinearVariation4 } from "@/src/types/Variations/LinearVariation4";
import { PaletteVariation } from "@/src/params/palette/variation/PaletteVariation";
import { Palette } from "@/src/params/palette/Palette";
import { Variation } from "@/src/types/Variations/Variation";
import { Experience, EXPERIENCE_VERSION } from "@/src/types/Experience";
import { NO_SONG, Song } from "@/src/types/Song";
import { generateId } from "@/src/utils/id";
import type { Store } from "@/src/types/Store";
import {
  AutomationCurve,
  isCurveActive,
} from "@/src/components/EditorV2/automation";
import {
  curveToVariations,
  RegionContext,
} from "@/src/components/EditorV2/regionCurve";

/** Upstream's editing minimum; see the header note on slivers. */
const MINIMUM_REGION_DURATION = 0.1;

/** The lane key the old format used for the per-pattern visibility toggle. */
const LEGACY_VISIBILITY_PARAM = "__visibility";

/** Upstream's opacity channel, the only home per-pattern visibility has. */
const OPACITY_UNIFORM = "u_opacity";

/** With no song there is no seconds basis for fraction times; 60s is nominal. */
export const NO_SONG_DURATION_SECONDS = 60;

type LegacyEffect = {
  id?: number;
  pattern: string;
  params: Record<string, unknown>;
};

type LegacyEntry = {
  pattern: string;
  id?: number;
  params: Record<string, unknown>;
  effects?: LegacyEffect[];
  visible: boolean;
  expanded: boolean;
  automatedParams: string[];
  automation?: Record<string, AutomationCurve>;
};

export type LegacySave = {
  savedAt: number;
  song: Song | null;
  laneOrder?: string[];
  entries: LegacyEntry[];
};

const isVector4Tuple = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === "number");

const isSerializedPalette = (
  value: unknown,
): value is { a: number[]; b: number[]; c: number[]; d: number[] } =>
  !!value &&
  typeof value === "object" &&
  ["a", "b", "c", "d"].every((key) => Array.isArray((value as never)[key]));

/** A constant region carrying an un-automated param value (decision 7). */
const constantRegion = (
  value: unknown,
  duration: number,
): Variation | null => {
  if (typeof value === "number") return CurveVariation.flat(duration, value);
  if (isVector4Tuple(value)) {
    const vector = new Vector4(value[0], value[1], value[2], value[3]);
    // Structurally always a gradient upstream; equal ends read as one colour.
    return new LinearVariation4(duration, vector, vector);
  }
  if (isSerializedPalette(value))
    return new PaletteVariation(duration, Palette.deserialize(value as never));
  return null;
};

/** Drop sliver regions, giving their time to the previous region. */
const dropSlivers = (variations: Variation[]): Variation[] => {
  const kept: Variation[] = [];
  for (const variation of variations) {
    if (
      variation.duration < MINIMUM_REGION_DURATION &&
      kept.length > 0
    ) {
      const previous = kept[kept.length - 1];
      const grown = previous.duration + variation.duration;
      if (previous instanceof CurveVariation) previous.resizeEnd(grown);
      else previous.duration = grown;
      continue;
    }
    kept.push(variation);
  }
  return kept;
};

/**
 * The regions for one lane: its curve projected into block-local seconds, or
 * a lone constant region when the param has no (active) automation.
 */
const regionsForParam = (
  curve: AutomationCurve | undefined,
  manualValue: unknown,
  ctx: RegionContext,
  store: Store,
): Variation[] => {
  // A deactivated curve does not travel: takeover is a live editing posture,
  // not a property of the piece (decision 6), so the manual value is what the
  // experience means.
  if (curve && curve.keyframes.length > 0 && isCurveActive(curve)) {
    const projected = dropSlivers(curveToVariations(curve, ctx, store));
    if (projected.length > 0) return projected;
  }
  const constant = constantRegion(manualValue, ctx.blockDuration);
  return constant ? [constant] : [];
};

/** Visibility, as opacity regions (see the header note). */
const opacityRegions = (
  entry: LegacyEntry,
  ctx: RegionContext,
  store: Store,
): Variation[] | null => {
  const curve = entry.automation?.[LEGACY_VISIBILITY_PARAM];
  if (curve && curve.keyframes.length > 0 && isCurveActive(curve))
    return dropSlivers(curveToVariations(curve, ctx, store));
  // Visible with no lane: write nothing, so opacity stays "auto".
  if (entry.visible) return null;
  return [CurveVariation.flat(ctx.blockDuration, 0)];
};

const serializeRegions = (variations: Variation[]) =>
  variations.map((variation) => variation.serialize());

/**
 * A legacy save, as an experience row ready for `Store.deserialize`.
 *
 * `name` is the experience it becomes; the caller decides whether that lands
 * as a draft (decision: migrated saves arrive as unsaved work) or a row.
 */
export const migrateLegacySave = (
  save: LegacySave,
  options: { name: string; store: Store; user?: Experience["user"] },
): Experience => {
  const { name, store } = options;
  const song = save.song ?? null;
  const songDuration =
    song && typeof (song as never as { duration?: number }).duration === "number"
      ? (song as never as { duration: number }).duration
      : NO_SONG_DURATION_SECONDS;

  const ctx: RegionContext = {
    blockStartTime: 0,
    blockDuration: songDuration,
    songDuration,
  };

  const blockMap: Record<string, unknown> = {};

  for (const entry of save.entries) {
    const blockId = generateId();
    const parameterVariations: Record<string, unknown> = {};

    for (const [uniform, value] of Object.entries(entry.params)) {
      const regions = regionsForParam(
        entry.automation?.[uniform],
        value,
        ctx,
        store,
      );
      if (regions.length > 0)
        parameterVariations[uniform] = serializeRegions(regions);
    }

    const opacity = opacityRegions(entry, ctx, store);
    if (opacity && opacity.length > 0)
      parameterVariations[OPACITY_UNIFORM] = serializeRegions(opacity);

    // Effects become nested blocks; their lanes move onto their own params.
    const effectBlocks = (entry.effects ?? []).map((effect) => {
      const effectVariations: Record<string, unknown> = {};
      for (const [uniform, value] of Object.entries(effect.params)) {
        const laneKey = `effect:${effect.id}:${uniform}`;
        const regions = regionsForParam(
          entry.automation?.[laneKey],
          value,
          ctx,
          store,
        );
        if (regions.length > 0)
          effectVariations[uniform] = serializeRegions(regions);
      }
      return {
        id: generateId(),
        pattern: { name: effect.pattern },
        // Effect params run over the parent block's timeline.
        startTime: 0,
        duration: songDuration,
        parameterVariations: effectVariations,
        effectBlocks: [],
      };
    });

    blockMap[blockId] = {
      id: blockId,
      pattern: { name: entry.pattern },
      startTime: 0,
      duration: songDuration,
      parameterVariations,
      effectBlocks,
    };
  }

  return {
    id: undefined,
    name,
    user: options.user ??
      store.userStore.me ?? { id: -1, username: "" },
    song: song ?? NO_SONG,
    status: "inprogress",
    version: EXPERIENCE_VERSION,
    // One layer: the old stack was one always-on pile of patterns.
    data: { layers: [{ name: "", visible: true, blockMap }] },
    thumbnailURL: "",
  };
};
