import { Vector4 } from "three";
import { Song } from "@/src/types/Song";
import { BASE_UNIFORMS, Pattern } from "@/src/types/Pattern";
import { isVector4 } from "@/src/utils/object";
import { isPalette, Palette } from "@/src/params/palette/Palette";
import { StackEntry } from "@/src/components/EditorV2/PatternsPanel";
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
const EXPERIENCE_KEY = "untitled";
const SAVE_KEY = `editorV2:${EXPERIENCE_KEY}:save`;
const AUTOSAVE_KEY = `editorV2:${EXPERIENCE_KEY}:autosave`;

// Dispatched (on window) by controls that mutate state outside React, such
// as parameter scrubs, so the autosave still fires.
export const EDITOR_DIRTY_EVENT = "editorv2-dirty";

export type SerializedEditorState = {
  savedAt: number;
  song: Song | null;
  // Display order of the automation lanes, as `${entryId}/${laneKey}`
  // keys. Lanes missing from the list follow in their natural order.
  // Absent in older saves.
  laneOrder?: string[];
  entries: {
    pattern: string;
    // Runtime entry id, kept so undo/redo restores preserve identity
    // (selections keyed by id survive). Absent in older saves.
    id?: number;
    params: Record<string, unknown>;
    // The entry's effect chain, in render order. Absent in older saves.
    effects?: {
      id?: number;
      pattern: string;
      params: Record<string, unknown>;
    }[];
    visible: boolean;
    expanded: boolean;
    automatedParams: string[];
    automation?: Record<string, AutomationCurve>;
  }[];
};

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

export const serializeEditorState = (
  entries: StackEntry[],
  song: Song | null,
  laneOrder: string[] = [],
): SerializedEditorState => ({
  savedAt: Date.now(),
  song,
  laneOrder,
  entries: entries.map((entry) => ({
    pattern: entry.pattern.name,
    id: entry.id,
    params: serializeParams(entry.pattern),
    effects: entry.effects.map((effect) => ({
      id: effect.id,
      pattern: effect.pattern.name,
      params: serializeParams(effect.pattern),
    })),
    visible: entry.visible,
    expanded: entry.expanded,
    automatedParams: [...entry.automatedParams],
    automation: entry.automation,
  })),
});

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

export const restoreEntries = (
  state: SerializedEditorState,
  allocateId: () => number,
  currentEntries: StackEntry[] = [],
): StackEntry[] => {
  const currentById = new Map(currentEntries.map((entry) => [entry.id, entry]));
  return state.entries.flatMap((saved) => {
    const current =
      saved.id !== undefined ? currentById.get(saved.id) : undefined;
    let pattern: Pattern;
    if (current && current.pattern.name === saved.pattern) {
      pattern = current.pattern;
    } else {
      const factory = patternFactoryByName(saved.pattern);
      if (!factory) return [];
      pattern = factory();
    }
    applyParams(pattern, saved.params ?? {});

    // Effects reuse live instances by id too: their params are shared by
    // reference with the canopy's materials exactly like pattern params.
    const currentEffects = new Map(
      (current?.effects ?? []).map((effect) => [effect.id, effect]),
    );
    const effects = (saved.effects ?? []).flatMap((savedEffect) => {
      const currentEffect =
        savedEffect.id !== undefined
          ? currentEffects.get(savedEffect.id)
          : undefined;
      let effectPattern: Pattern;
      if (currentEffect && currentEffect.pattern.name === savedEffect.pattern) {
        effectPattern = currentEffect.pattern;
      } else {
        const factory = effectFactoryByName(savedEffect.pattern);
        if (!factory) return [];
        effectPattern = factory();
      }
      applyParams(effectPattern, savedEffect.params ?? {});
      return [{ id: savedEffect.id ?? allocateId(), pattern: effectPattern }];
    });

    return [
      {
        // Reuse the serialized id when present so restores (undo/redo in
        // particular) keep entry identity; allocateId still hands out
        // fresh ids for older saves without them.
        id: saved.id ?? allocateId(),
        pattern,
        effects,
        visible: saved.visible ?? true,
        expanded: saved.expanded ?? true,
        automatedParams: saved.automatedParams ?? [],
        automation: saved.automation ?? {},
      },
    ];
  });
};

// Deep-copies a stack entry: fresh pattern and effect instances carrying
// the same values, fresh ids, and the automation remapped onto the new
// effect ids. The copy shares nothing live with the source, so editing
// one never bleeds into the other.
export const duplicateStackEntry = (
  source: StackEntry,
  allocateId: () => number,
): StackEntry | null => {
  const factory = patternFactoryByName(source.pattern.name);
  if (!factory) return null;
  const pattern = factory();
  applyParams(pattern, serializeParams(source.pattern));

  const effectIds = new Map<number, number>();
  const effects = source.effects.flatMap((effect) => {
    const effectFactory = effectFactoryByName(effect.pattern.name);
    if (!effectFactory) return [];
    const effectPattern = effectFactory();
    applyParams(effectPattern, serializeParams(effect.pattern));
    const id = allocateId();
    effectIds.set(effect.id, id);
    return [{ id, pattern: effectPattern }];
  });

  // Effect lanes are keyed by effect id; point them at the copies.
  const remapLaneKey = (laneKey: string) => {
    const match = laneKey.match(/^effect:(\d+):(.*)$/);
    if (!match) return laneKey;
    const mapped = effectIds.get(Number(match[1]));
    return mapped === undefined ? null : `effect:${mapped}:${match[2]}`;
  };
  const automatedParams = source.automatedParams.flatMap((laneKey) => {
    const mapped = remapLaneKey(laneKey);
    return mapped ? [mapped] : [];
  });
  const automation: Record<string, AutomationCurve> = {};
  for (const [laneKey, curve] of Object.entries(source.automation)) {
    const mapped = remapLaneKey(laneKey);
    if (mapped) automation[mapped] = JSON.parse(JSON.stringify(curve));
  }

  return {
    id: allocateId(),
    pattern,
    effects,
    visible: source.visible,
    expanded: source.expanded,
    automatedParams,
    automation,
  };
};

const readSlot = (key: string): SerializedEditorState | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as SerializedEditorState) : null;
  } catch {
    return null;
  }
};

const writeSlot = (key: string, state: SerializedEditorState) => {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {}
};

export const loadSave = () => readSlot(SAVE_KEY);
export const loadAutosave = () => readSlot(AUTOSAVE_KEY);

// Static-demo seeding: the bundled starter experience lands in the save
// slots once, and only when both are empty, so a visitor's own edits
// always win on later visits.
export const seedDemoExperience = (state: SerializedEditorState) => {
  if (loadSave() || loadAutosave()) return;
  writeSave(state);
};
export const writeAutosave = (state: SerializedEditorState) =>
  writeSlot(AUTOSAVE_KEY, state);
export const writeSave = (state: SerializedEditorState) => {
  writeSlot(SAVE_KEY, state);
  // The save is now current; matching timestamps keep the autosave prompt
  // from firing on the next open.
  writeSlot(AUTOSAVE_KEY, state);
};
