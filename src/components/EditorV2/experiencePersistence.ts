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
  laneKeysOf,
  resumeLane,
  writeLaneCurve,
} from "@/src/components/EditorV2/blockLanes";
import {
  addEffectToBlock,
  addPatternBlock,
  ensureFirstLayer,
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
const EXPERIENCE_KEY = "untitled";
const SAVE_KEY = `editorV2:${EXPERIENCE_KEY}:save`;
const AUTOSAVE_KEY = `editorV2:${EXPERIENCE_KEY}:autosave`;

// Dispatched (on window) by controls that mutate state outside React, such
// as parameter scrubs, so the autosave still fires.
export const EDITOR_DIRTY_EVENT = "editorv2-dirty";

export type SerializedEditorState = {
  savedAt: number;
  song: Song | null;
  // The song length the block timings below were measured against. A snapshot
  // taken before a song loaded describes a nominal 60s timeline, and restoring
  // those seconds verbatim onto a song-spanned block would shrink it. Absent
  // in older saves, which carried no timings to misapply.
  songDurationSeconds?: number;
  // Display order of the automation lanes, as `${entryId}/${laneKey}`
  // keys. Lanes missing from the list follow in their natural order.
  // Absent in older saves.
  laneOrder?: string[];
  entries: {
    pattern: string;
    // The block's id. Older saves carry a numeric runtime id instead; both are
    // accepted and normalised to a string on restore.
    id?: string | number;
    params: Record<string, unknown>;
    // The entry's effect chain, in render order. Absent in older saves.
    effects?: {
      id?: string | number;
      pattern: string;
      params: Record<string, unknown>;
    }[];
    visible: boolean;
    expanded: boolean;
    // The block's span in seconds. Absent in older saves, which predate blocks
    // and are all full-song by decision 24 — so leaving it undefined restores
    // the block as it already is, which is exactly the old behaviour.
    startTime?: number;
    duration?: number;
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
  songDurationSeconds: getLaneSongDuration(),
  laneOrder,
  entries: entries.map((entry) => {
    // Lanes and curves are read out of the block, which owns them now. The
    // saved shape is unchanged, so an existing save still loads.
    const laneKeys = laneKeysOf(entry.block);
    const automation: Record<string, AutomationCurve> = {};
    for (const laneKey of laneKeys) {
      const curve = laneCurve(entry.block, laneKey);
      if (curve) automation[laneKey] = curve;
    }
    if (entry.visibilityCurve)
      automation[VISIBILITY_PARAM] = entry.visibilityCurve;
    return {
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
      // Block timing is part of the state now that blocks are the model, so
      // undo restores a resize and a save round-trips one.
      startTime: entry.block.startTime,
      duration: entry.block.duration,
      automatedParams: [
        ...laneKeys,
        ...(entry.visibilityCurve ? [VISIBILITY_PARAM] : []),
      ],
      automation,
    };
  }),
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
  store: Store,
  currentEntries: StackEntry[] = [],
): StackEntry[] => {
  const layer = ensureFirstLayer(store);
  const currentById = new Map(currentEntries.map((entry) => [entry.id, entry]));
  // Blocks the restore does not claim are stale (an undo that removes a
  // pattern, say) and are dropped at the end, so the store never drifts
  // ahead of what the editor shows.
  const claimed = new Set<string>();

  const entries = state.entries.flatMap((saved) => {
    const savedId = saved.id !== undefined ? String(saved.id) : undefined;
    const current = savedId ? currentById.get(savedId) : undefined;

    // Reuse the live block (and therefore the live Pattern) when the restore
    // is describing the same entry: object identity is load-bearing, since
    // the canopy's materials and the pattern list share pattern.params by
    // reference. Replacing the instance would leave them editing something
    // nothing renders.
    let block: Block;
    if (current && current.pattern.name === saved.pattern) {
      block = current.block;
    } else {
      const factory = patternFactoryByName(saved.pattern);
      if (!factory) return [];
      block = addPatternBlock(store, layer, factory);
      // Keep the saved id. Identity is not cosmetic here: lane display order is
      // stored as `${entryId}/${laneKey}` keys, and selections are keyed the
      // same way, so a fresh random id would silently drop the author's lane
      // ordering on every reload.
      if (savedId) runInAction(() => (block.id = savedId));
    }
    claimed.add(block.id);
    applyParams(block.pattern, saved.params ?? {});

    // Effects become nested effect blocks, reusing live ones by id.
    const currentEffects = new Map(
      (current?.effects ?? []).map((effect) => [effect.id, effect]),
    );
    // Saved lane keys carry the OLD effect id; map them onto the live blocks.
    const effectIdMap = new Map<string, string>();
    const effects: EffectEntry[] = (saved.effects ?? []).flatMap(
      (savedEffect) => {
        const savedEffectId =
          savedEffect.id !== undefined ? String(savedEffect.id) : undefined;
        const currentEffect = savedEffectId
          ? currentEffects.get(savedEffectId)
          : undefined;
        let effectBlock: Block | undefined;
        if (
          currentEffect &&
          currentEffect.pattern.name === savedEffect.pattern &&
          block.effectBlocks.includes(currentEffect.block)
        ) {
          effectBlock = currentEffect.block;
        } else {
          const factory = effectFactoryByName(savedEffect.pattern);
          if (!factory) return [];
          effectBlock = addEffectToBlock(block, factory);
          // Same reason as the block above: effect lane keys carry this id.
          if (savedEffectId && effectBlock) {
            const restored = effectBlock;
            runInAction(() => (restored.id = savedEffectId));
          }
        }
        if (!effectBlock) return [];
        applyParams(effectBlock.pattern, savedEffect.params ?? {});
        if (savedEffectId) effectIdMap.set(savedEffectId, effectBlock.id);
        return [
          {
            id: effectBlock.id,
            pattern: effectBlock.pattern,
            block: effectBlock,
          },
        ];
      },
    );

    // Effect blocks no longer described by the save go with it.
    for (const effectBlock of [...block.effectBlocks])
      if (!effects.some((effect) => effect.block === effectBlock))
        removeEffectFromBlock(block, effectBlock);

    // Block timing, rescaled if the song has changed length since the
    // snapshot. A block that covered the whole song still covers it, and one
    // that covered the middle third still does — the same proportional re-span
    // `applySongDuration` performs when a song first arrives. Older saves
    // carry no timings, and by decision 24 every block in one was full-song
    // anyway, so absence means "leave it as it is".
    const scale =
      state.songDurationSeconds && state.songDurationSeconds > 0
        ? getLaneSongDuration() / state.songDurationSeconds
        : 1;
    if (typeof saved.startTime === "number")
      runInAction(() => (block.startTime = (saved.startTime as number) * scale));
    if (typeof saved.duration === "number")
      runInAction(() => (block.duration = (saved.duration as number) * scale));

    // Write the saved curves back onto the block, remapping effect lane keys
    // onto the live effect block ids.
    let visibilityCurve: AutomationCurve | undefined;
    const savedAutomation = saved.automation ?? {};
    const savedLanes = saved.automatedParams ?? Object.keys(savedAutomation);

    // The lane set has to end up EXACTLY as the snapshot describes it, in the
    // snapshot's order. Arming alone only ever grows the set, so undoing an
    // arm used to leave the lane behind; and `lanedParams` is insertion
    // ordered, which IS lane order (decision 21), so a re-arm onto an existing
    // lane would not put it back where it was. Clearing first makes both
    // faithful. Curve regions are stored separately and survive the clear.
    const laneKeyByOwner = new Map<string, string[]>();
    const previousLanes = laneKeysOf(block);
    for (const owner of [block, ...block.effectBlocks])
      runInAction(() => owner.lanedParams.clear());

    for (const savedKey of savedLanes) {
      if (savedKey === VISIBILITY_PARAM) {
        visibilityCurve = savedAutomation[savedKey] ?? { keyframes: [] };
        continue;
      }
      let laneKey = savedKey;
      if (savedKey.startsWith("effect:")) {
        const [, oldId, uniform] = savedKey.split(":");
        const liveId = effectIdMap.get(oldId);
        if (!liveId || !uniform) continue;
        laneKey = effectLaneKey(liveId, uniform);
      }
      // Arm first so the lane exists even when the save had no curve for it,
      // then write whatever curve there was — INCLUDING an empty one. Skipping
      // the empty case left an armed-but-empty lane holding whatever curve it
      // happened to have, so undoing back to it never took the keyframes away.
      armLane(block, laneKey);
      const savedCurve = savedAutomation[savedKey];
      // An armed lane with no curve is EMPTY, and empty means no regions —
      // writing the manual constant instead would put a two-node flat there,
      // which projects straight back as two keyframes the author never placed.
      if (savedCurve && savedCurve.keyframes.length > 0)
        writeLaneCurve(block, laneKey, savedCurve, store);
      else clearLaneRegions(block, laneKey);
      // A save never carries takeover state (decision 6), so a restored lane
      // is always driving.
      resumeLane(block, laneKey);
      laneKeyByOwner.set(laneKey, []);
    }

    // A lane the snapshot does not describe is gone: return its parameter to
    // the manual value, the same thing deleting a lane does, so the data does
    // not keep driving a parameter that no longer has a lane.
    for (const laneKey of previousLanes)
      if (!laneKeyByOwner.has(laneKey)) {
        resumeLane(block, laneKey);
        writeLaneCurve(block, laneKey, null, store);
      }

    return [
      {
        id: block.id,
        block,
        pattern: block.pattern,
        effects,
        visible: saved.visible ?? true,
        expanded: saved.expanded ?? true,
        visibilityCurve,
      },
    ];
  });

  for (const block of layer.getAllBlocks())
    if (!claimed.has(block.id)) removePatternBlock(layer, block);

  return entries;
};

// Duplicates a stack entry. Upstream's own Block.clone carries the pattern,
// the timing, every region lane, and the effect chain, so the deep copy is
// theirs; this re-ids the copy and hands back an entry pointing at it. Lane
// keys need no remapping because they are derived from the new effect blocks'
// own ids rather than stored anywhere.
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
