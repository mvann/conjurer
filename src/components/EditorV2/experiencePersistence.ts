import { runInAction } from "mobx";
import { Vector4 } from "three";
import { Song } from "@/src/types/Song";
import { BASE_UNIFORMS, Pattern } from "@/src/types/Pattern";
import { isVector4 } from "@/src/utils/object";
import { isPalette, Palette } from "@/src/params/palette/Palette";
import {
  EffectEntry,
  StackEntry,
  VISIBILITY_PARAM,
} from "@/src/components/EditorV2/PatternsPanel";
import type { Block } from "@/src/types/Block";
import type { Store } from "@/src/types/Store";
import {
  armLane,
  effectLaneKey,
  laneCurve,
  clearLaneRegions,
  getLaneSongDuration,
  hasRealSongDuration,
  laneKeysOf,
  resumeLane,
  writeLaneCurve,
} from "@/src/components/EditorV2/blockLanes";
import {
  addEffectToBlock,
  addPatternBlock,
  ensureFirstLayer,
  layerOf,
  removeEffectFromBlock,
  duplicatePatternBlock,
  removePatternBlock,
} from "@/src/components/EditorV2/blockStack";
import { AutomationCurve } from "@/src/components/EditorV2/automation";
import {
  effectFactoryByName,
  patternFactoryByName,
} from "@/src/components/EditorV2/patternLibrary";

// Client-side persistence for the spell crafter's editing state. Two
// localStorage slots per experience: `save` (written by the Save action)
// and `autosave` (written on every state change). On open, a newer
// autosave than the save triggers a prompt to restore it.
//
// The spell crafter edits a single implicit experience for now, so the
// slots are keyed by a placeholder identity; when real experience
// loading/saving lands, the key becomes the experience's identifier.

// Dispatched (on window) by controls that mutate state outside React, such
// as parameter scrubs, so the autosave still fires.
export const EDITOR_DIRTY_EVENT = "editorv2-dirty";

const serializeParams = (pattern: Pattern) => {
  const params: Record<string, unknown> = {};
  for (const [uniform, param] of Object.entries(pattern.params)) {
    if (BASE_UNIFORMS.includes(uniform)) continue;
    const { value } = param;
    if (typeof value === "number") params[uniform] = value;
    else if (isVector4(value))
      params[uniform] = [value.x, value.y, value.z, value.w];
    else if (isPalette(value)) params[uniform] = value.serialize();
  }
  return params;
};

// Rebuilds stack entries from a serialized state. Unknown patterns and
// params are skipped so an old autosave survives library changes.
//
// When current entries are passed, a restored entry with a matching id
// and pattern reuses the LIVE Pattern instance, writing the saved values
// into it in place. Object identity is load-bearing everywhere: the
// canopy's materials, the pattern list's scrub fields, and the drive
// loop all share `pattern.params` by reference, so replacing the
// instance on undo/redo would leave them editing an object nothing
// renders anymore.
// Write saved param values into a pattern instance, in place wherever
// possible (see the identity note on restoreEntries).
const applyParams = (pattern: Pattern, params: Record<string, unknown>) => {
  for (const [uniform, value] of Object.entries(params)) {
    const param = pattern.params[uniform];
    if (!param) continue;
    if (typeof value === "number") param.value = value;
    else if (Array.isArray(value) && value.length === 4) {
      if (isVector4(param.value))
        param.value.set(value[0], value[1], value[2], value[3]);
      else param.value = new Vector4(value[0], value[1], value[2], value[3]);
    } else if (value && typeof value === "object" && "a" in value) {
      if (isPalette(param.value)) param.value.setFromSerialized(value as any);
      else param.value = Palette.deserialize(value as any);
    }
  }
};

export const duplicateStackEntry = (
  store: Store,
  source: StackEntry,
): StackEntry | null => {
  const layer = ensureFirstLayer(store);
  const copy = duplicatePatternBlock(layer, source.block);
  if (!copy) return null;
  return {
    id: copy.id,
    block: copy,
    pattern: copy.pattern,
    effects: copy.effectBlocks.map((effectBlock) => ({
      id: effectBlock.id,
      pattern: effectBlock.pattern,
      block: effectBlock,
    })),
    visible: source.visible,
    expanded: source.expanded,
    visibilityCurve: source.visibilityCurve
      ? JSON.parse(JSON.stringify(source.visibilityCurve))
      : undefined,
  };
};

;
