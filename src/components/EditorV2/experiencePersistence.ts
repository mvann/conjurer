import { Vector4 } from "three";
import { Song } from "@/src/types/Song";
import { BASE_UNIFORMS, Pattern } from "@/src/types/Pattern";
import { isVector4 } from "@/src/utils/object";
import { isPalette, Palette } from "@/src/params/palette/Palette";
import { StackEntry } from "@/src/components/EditorV2/PatternsPanel";
import { AutomationCurve } from "@/src/components/EditorV2/automation";
import { patternFactoryByName } from "@/src/components/EditorV2/patternLibrary";

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
  entries: {
    pattern: string;
    // Runtime entry id, kept so undo/redo restores preserve identity
    // (selections keyed by id survive). Absent in older saves.
    id?: number;
    params: Record<string, unknown>;
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
): SerializedEditorState => ({
  savedAt: Date.now(),
  song,
  entries: entries.map((entry) => ({
    pattern: entry.pattern.name,
    id: entry.id,
    params: serializeParams(entry.pattern),
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
    for (const [uniform, value] of Object.entries(saved.params ?? {})) {
      const param = pattern.params[uniform];
      if (!param) continue;
      if (typeof value === "number") param.value = value;
      else if (Array.isArray(value) && value.length === 4) {
        // In place when possible, for the same identity reasons as above.
        if (isVector4(param.value))
          param.value.set(value[0], value[1], value[2], value[3]);
        else param.value = new Vector4(value[0], value[1], value[2], value[3]);
      } else if (value && typeof value === "object" && "a" in value) {
        if (isPalette(param.value)) param.value.setFromSerialized(value as any);
        else param.value = Palette.deserialize(value as any);
      }
    }
    return [
      {
        // Reuse the serialized id when present so restores (undo/redo in
        // particular) keep entry identity; allocateId still hands out
        // fresh ids for older saves without them.
        id: saved.id ?? allocateId(),
        pattern,
        visible: saved.visible ?? true,
        expanded: saved.expanded ?? true,
        automatedParams: saved.automatedParams ?? [],
        automation: saved.automation ?? {},
      },
    ];
  });
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
