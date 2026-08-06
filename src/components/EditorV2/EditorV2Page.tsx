import { useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import { runInAction } from "mobx";
import { useRouter } from "next/router";
import { useStore } from "@/src/types/StoreContext";
import {
  captureDraft,
  DEFAULT_EXPERIENCE_NAME,
  draftIsAhead,
  loadExperienceIntoStore,
  readDraft,
  readLaneOrder,
  restoreDraft,
  saveStoreToExperience,
  writeLaneOrder,
  type Draft,
} from "@/src/components/EditorV2/editorExperience";
import {
  migrateLegacySave,
  type LegacySave,
} from "@/src/components/EditorV2/migrateLegacySave";
import {
  armLane,
  disarmLane,
  laneCurve,
  laneKeysOf,
  rebaseBlockLanes,
  resumeLane,
  suspendLane,
  writeLaneCurve,
  type CapturedLanes,
} from "@/src/components/EditorV2/blockLanes";
import {
  addEffectToBlock,
  addPatternBlock,
  ensureFirstLayer,
  layerOf,
  moveEffectInBlock,
  removeEffectFromBlock,
  removePatternBlock,
  addLayer,
  applySongDuration,
  entriesFromStore,
  moveLayer,
  removeLayer,
  renameLayer,
} from "@/src/components/EditorV2/blockStack";
import {
  EditorLoginButton,
  EditorLoginPanel,
} from "@/src/components/EditorV2/EditorLoginPanel";
import { GearButton, GearPane } from "@/src/components/EditorV2/GearPane";
import {
  getOrientation,
  initializeOrientation,
} from "@/src/components/EditorV2/orientation";
import { listExperiences } from "@/src/components/EditorV2/experienceClient";
import styles from "@/styles/EditorV2.module.css";
import { CanopyPane } from "@/src/components/EditorV2/CanopyPane";
import {
  AutomationPane,
  resolveLane,
} from "@/src/components/EditorV2/AutomationPane";
import { AutomationEditorView } from "@/src/components/EditorV2/AutomationEditorView";
import {
  PatternsPanel,
  StackEntry,
  VISIBILITY_PARAM,
} from "@/src/components/EditorV2/PatternsPanel";
import {
  AutomationCurve,
  evaluateCurve,
  isCurveActive,
  payloadAtTime,
} from "@/src/components/EditorV2/automation";
import { isVector4 } from "@/src/utils/object";
import { isPalette } from "@/src/params/palette/Palette";
import { transportTime } from "@/src/components/EditorV2/timeViewport";
import { TimelineStrip } from "@/src/components/EditorV2/TimelineStrip";
import { DocsStrip } from "@/src/components/EditorV2/DocsStrip";
import { CanopyControls } from "@/src/components/EditorV2/CanopyControls";
import {
  duplicateStackEntry,
  EDITOR_DIRTY_EVENT,
  restoreEntries,
  SerializedEditorState,
  serializeEditorState,
} from "@/src/components/EditorV2/experiencePersistence";
import { IS_DEMO } from "@/src/utils/demo";
import demoExperience from "@/src/components/EditorV2/demoExperience.json";
import { Pattern } from "@/src/types/Pattern";
import type { Block } from "@/src/types/Block";
import { NO_SONG, Song } from "@/src/types/Song";
import { formatDisplayName } from "@/src/components/EditorV2/formatDisplayName";
import { BpmAnalysis } from "@/src/components/EditorV2/bpm";

export type BeatGrid = BpmAnalysis & { durationSeconds: number };

const AUTOSAVE_DEBOUNCE_MS = 800;

export const EditorV2Page = observer(function EditorV2Page() {
  // The shared main-app store. Experiences load into it through upstream's
  // own pipeline (row -> deserialize -> v1 migration -> bake to curves), so
  // both editors hold identical in-memory data (decision 26).
  //
  // Nothing below reads it yet: the legacy state still drives every part of
  // the UI, and each part moves over to a projection of store.layers one at
  // a time. Loading first, and switching the UI second, is deliberate — the
  // editor keeps working at every commit in between.
  const store = useStore();
  const router = useRouter();
  useEffect(() => {
    if (store.initializationState !== "uninitialized" || !router.isReady)
      return;
    const experienceName = (router.query.experience as string) ?? "untitled";
    // Upstream's own init wires up the user, ui, and audio stores and the
    // role; it is called WITHOUT a name so it does not reach for tRPC, which
    // the static demo has no backend for. Spell Crafter loads the experience
    // itself, through the transport seam that demo mode can swap.
    initializeOrientation();
    store.initializeClientSide().then(async () => {
      await loadExperienceIntoStore(store, experienceName);
      // Only now does the store know which experience this is. Anything that
      // keys off its name — the draft, the lane order — has to wait for this,
      // not merely for initializeClientSide, which resolves earlier.
      setExperienceLoaded(true);
      // Whatever the experience carries is the song; mirror it into the
      // editor's own state so the transport and the song panel show it.
      const loaded = store.audioStore.selectedSong;
      if (loaded && loaded.id !== NO_SONG.id) setSong(loaded);
    });
  }, [store, router.isReady, router.query.experience]);

  const [entries, setEntries] = useState<StackEntry[]>([]);
  const [song, setSong] = useState<Song | null>(null);

  // The song belongs to the EXPERIENCE, not just to this component: it is what
  // Store.serialize writes out. Every path that changes it goes through here so
  // the store and the UI can never disagree — the disagreement is exactly the
  // "add a song, save, reopen, no song" bug.
  const applySong = (nextSong: Song | null) => {
    setSong(nextSong);
    runInAction(() => {
      store.audioStore.selectedSong = nextSong ?? NO_SONG;
    });
  };
  const [volume, setVolume] = useState(1);
  const [dust, setDust] = useState(0);
  const [beatGrid, setBeatGrid] = useState<BeatGrid | null>(null);
  // Detected onset times (fractions of the song), for snap-to-transient
  // editing.
  const [transients, setTransients] = useState<number[] | null>(null);
  const [autosavePrompt, setAutosavePrompt] = useState<Draft | null>(null);
  // True once the experience itself is in the store, which is later than the
  // store reporting itself initialised.
  const [experienceLoaded, setExperienceLoaded] = useState(false);
  // Why the last save did not happen, shown beside the gear.
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [gearOpen, setGearOpen] = useState(false);
  const orientation = getOrientation();
  // Names available to Open, fetched when the pane opens.
  const [experienceNames, setExperienceNames] = useState<string[]>([]);

  const openGear = () => {
    setGearOpen(true);
    void listExperiences(store.usingLocalData)
      .then((rows) => setExperienceNames(rows.map((row) => row.name)))
      .catch(() => setExperienceNames([]));
  };

  // Open (or start) an experience by name. A full reload is the honest move:
  // every pane, the transport, and the undo history are seeded from the
  // experience at mount, so re-entering through the URL is what makes them all
  // agree rather than re-deriving each by hand.
  const openExperience = (name: string) => {
    if (typeof window === "undefined") return;
    window.location.href = `/editor?experience=${encodeURIComponent(name)}`;
  };

  // Save as: name it, save it, then continue editing under the new name.
  const saveAs = async (name: string) => {
    runInAction(() => {
      store.experienceName = name;
      store.experienceId = undefined;
    });
    await save();
    openExperience(name);
  };
  // True when the latest autosave is ahead of the last save; the Save
  // button glows only then.
  const [isDirty, setIsDirty] = useState(false);
  const [selectedLane, setSelectedLane] = useState<{
    entryId: string;
    uniform: string;
  } | null>(null);
  // Assign mode (the Add Automation lane): the pattern editor opens
  // and the next parameter clicked gets a lane. Escape or a click
  // outside the pattern editor cancels; the editor stays open either
  // way.
  const [assigningLane, setAssigningLane] = useState(false);

  // Display order of the automation lanes (see SerializedEditorState).
  const [laneOrder, setLaneOrder] = useState<string[]>([]);

  // The song length the lanes were last projected against, so a change can
  // re-span the full-song blocks exactly once.
  const lastSongDuration = useRef(0);

  // Latest state for the debounced writer and the dirty-event listener.
  const latest = useRef({ entries, song, laneOrder });
  latest.current = { entries, song, laneOrder };

  // Automation drives the parameters: every frame, each automated param
  // takes its curve's value at the transport's current time, so the
  // canopy and the pattern editor both show what the gold dot shows.
  // Params are live uniform objects, so writing needs no re-render.
  // (Visibility lanes are React state, not a uniform; not driven yet.)
  useEffect(() => {
    let frame: number;
    const apply = () => {
      frame = requestAnimationFrame(apply);
      const { seconds, durationSeconds } = transportTime;
      if (!durationSeconds) return;
      // The region projection needs the song's length: every keyframe time is a
      // fraction of it, so with a length of zero every lane reads as empty.
      // Mirrored from the transport rather than plumbed separately, since this
      // is already the one place that watches it; the setter no-ops when
      // unchanged, so the cost per frame is a comparison.
      if (lastSongDuration.current !== durationSeconds) {
        lastSongDuration.current = durationSeconds;
        // Adopting a song length re-spans the full-song blocks AND carries
        // their lanes with them; see applySongDuration.
        applySongDuration(store, durationSeconds);
      }
      const frac = Math.min(Math.max(seconds / durationSeconds, 0), 1);
      for (const entry of latest.current.entries) {
        const lanes = [
          ...laneKeysOf(entry.block),
          ...(entry.visibilityCurve ? [VISIBILITY_PARAM] : []),
        ];
        for (const uniform of lanes) {
          const curve =
            uniform === VISIBILITY_PARAM
              ? entry.visibilityCurve ?? null
              : laneCurve(entry.block, uniform);
          if (!curve || curve.keyframes.length === 0 || !isCurveActive(curve))
            continue;
          if (uniform === VISIBILITY_PARAM) {
            // Visibility is React state, not a live uniform: flip it only
            // when the curve crosses the threshold, without touching the
            // autosave or history (automation is not a user edit).
            const value = evaluateCurve(curve, frac);
            if (value === null) continue;
            const desired = value >= 0.5;
            if (desired !== entry.visible)
              setEntries((current) =>
                current.map((candidate) =>
                  candidate.id === entry.id
                    ? { ...candidate, visible: desired }
                    : candidate,
                ),
              );
            continue;
          }
          const resolved = resolveLane(entry, uniform);
          if (!resolved) continue;
          const target = resolved.param.value;
          if (typeof target === "number") {
            const value = evaluateCurve(curve, frac);
            if (value !== null) resolved.param.value = value;
          } else if (isVector4(target) || isPalette(target)) {
            // Whole-value lanes: the period covering the current time
            // supplies the color or palette, copied in place so the
            // live uniform object keeps its identity.
            const payload = payloadAtTime(curve, frac);
            if (!payload) continue;
            if (isVector4(target) && payload.color)
              target.set(
                payload.color[0],
                payload.color[1],
                payload.color[2],
                payload.color[3],
              );
            else if (isPalette(target) && payload.palette)
              target.setFromSerialized(payload.palette);
          }
        }
      }
    };
    frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, []);

  // ---- Undo history: debounced snapshots of the whole editor state. ----
  // Every change flows through scheduleAutosave, so history rides the
  // same chokepoint. The debounce coalesces a scrub or drag stream into
  // a single undo step; snapshots identical to the current one are
  // skipped, which also keeps undo/redo restores from re-entering the
  // stack.
  const history = useRef<{ stack: SerializedEditorState[]; index: number }>({
    stack: [],
    index: -1,
  });
  const historyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore a snapshot's entries. Identity comes from the blocks now, so
  // there is no id counter to keep ahead of anything.
  const restoreSnapshot = (snapshot: SerializedEditorState) =>
    // Live entries flow in so pattern instances survive the restore:
    // materials and scrub fields keep the same param objects.
    restoreEntries(snapshot, store, latest.current.entries);

  // Snapshots carry a savedAt timestamp (autosave metadata); comparisons
  // must ignore it or no two snapshots ever match.
  const snapshotsEqual = (a: SerializedEditorState, b: SerializedEditorState) =>
    JSON.stringify({ ...a, savedAt: 0 }) ===
    JSON.stringify({ ...b, savedAt: 0 });

  const captureHistoryNow = () => {
    historyTimer.current = null;
    const snapshot = serializeEditorState(
      latest.current.entries,
      latest.current.song,
      latest.current.laneOrder,
    );
    const state = history.current;
    const current = state.index >= 0 ? state.stack[state.index] : null;
    if (current && snapshotsEqual(current, snapshot)) return;
    state.stack = state.stack.slice(0, state.index + 1);
    state.stack.push(snapshot);
    if (state.stack.length > 100) state.stack.shift();
    state.index = state.stack.length - 1;
  };

  const scheduleHistoryCapture = () => {
    if (historyTimer.current) clearTimeout(historyTimer.current);
    historyTimer.current = setTimeout(captureHistoryNow, 400);
  };

  const timeTravel = (direction: -1 | 1) => {
    // Flush a half-debounced edit first so it isn't lost off the top.
    if (historyTimer.current) {
      clearTimeout(historyTimer.current);
      captureHistoryNow();
    }
    const state = history.current;
    const nextIndex = state.index + direction;
    if (nextIndex < 0 || nextIndex >= state.stack.length) return;
    state.index = nextIndex;
    const snapshot = state.stack[nextIndex];
    setEntries(restoreSnapshot(snapshot));
    applySong(snapshot.song ?? null);
    setLaneOrder(snapshot.laneOrder ?? []);
    // Persist the restored state directly rather than through
    // scheduleAutosave, which would capture it as a fresh history entry.
    // Edits made right after an undo therefore capture normally: there
    // is no suppression window to swallow them.
    setIsDirty(true);
    captureDraft(store);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      timeTravel(event.shiftKey ? 1 : -1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosaves are scheduled by user mutations (and the dirty event), never
  // by state observation: an effect on [entries, song] would fire on mount
  // and mark a freshly loaded editor dirty.
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutosave = () => {
    setIsDirty(true);
    scheduleHistoryCapture();
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      // Unsaved work is a DRAFT of the experience, local to this browser until
      // an explicit Save (decision 17). Upstream has no autosave concept, and
      // quietly writing a shared row would violate its UX and its permissions.
      captureDraft(store);
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const layerById = (layerId: string) =>
    store.layers.find((layer) => layer.id === layerId);

  // ---- Layers (decision 28). The operations live in blockStack; these wire
  // them to the panel and keep the derived entry list in step. ----

  const addLayerToStack = () => {
    addLayer(store);
    scheduleAutosave();
  };

  const removeLayerFromStack = (layerId: string) => {
    const layer = layerById(layerId);
    if (!layer || !removeLayer(store, layer)) return;
    setEntries(entriesFromStore(store));
    scheduleAutosave();
  };

  const renameLayerInStack = (layerId: string, name: string) => {
    const layer = layerById(layerId);
    if (!layer) return;
    renameLayer(layer, name);
    scheduleAutosave();
  };

  const moveLayerInStack = (layerId: string, toIndex: number) => {
    const layer = layerById(layerId);
    if (!layer) return;
    moveLayer(store, layer, toIndex);
    setEntries(entriesFromStore(store));
    scheduleAutosave();
  };

  // Layer visibility is a runtime toggle on the layer, not automation
  // (decision 5). Collapsed is editor-only and never serialized.
  const toggleLayerVisible = (layerId: string) => {
    const layer = layerById(layerId);
    if (!layer) return;
    runInAction(() => (layer.visible = !layer.visible));
    scheduleAutosave();
  };

  const toggleLayerCollapsed = (layerId: string) => {
    const layer = layerById(layerId);
    if (!layer) return;
    runInAction(() => (layer.collapsed = !layer.collapsed));
  };

  // Block timing (decisions 10 and 16).
  //
  // Moving the block, and resizing its RIGHT edge, leave regions untouched: a
  // trimmed block leaves them overhanging and unplayed, an extended one holds
  // its last value, and a wave keeps its size — which is exactly what upstream
  // does, so a block resized that way behaves the same in their editor.
  //
  // A LEFT-edge resize arrives with the lanes captured before the drag began,
  // and replaying them against the new frame holds the automation still in song
  // time — the front of the automation grows or trims, rather than the whole
  // thing sliding. See BlockBar for why.
  const changeBlockTiming = (
    block: Block,
    startTime: number,
    duration: number,
    rebaseFrom?: CapturedLanes,
  ) => {
    runInAction(() => {
      block.startTime = Math.max(0, startTime);
      block.duration = Math.max(0.05, duration);
    });
    if (rebaseFrom) rebaseBlockLanes(block, rebaseFrom, store);
    scheduleAutosave();
  };

  const addPattern = (factory: () => Pattern, layerId?: string) => {
    // A new pattern is a block spanning the whole song (decision 24), so the
    // stack still behaves like an always-on pile of patterns.
    const target =
      (layerId ? layerById(layerId) : undefined) ?? ensureFirstLayer(store);
    const block = addPatternBlock(store, target, factory);
    setEntries((current) => [
      ...current,
      {
        id: block.id,
        block,
        pattern: block.pattern,
        effects: [],
        visible: true,
        expanded: true,
      },
    ]);
    scheduleAutosave();
  };

  const updateEntry = (id: string, update: Partial<StackEntry>) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === id ? { ...entry, ...update } : entry,
      ),
    );
    scheduleAutosave();
  };

  const removeEntry = (id: string) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry) {
      const layer = layerOf(store, entry.block) ?? ensureFirstLayer(store);
      removePatternBlock(layer, entry.block);
    }
    setEntries((current) => current.filter((candidate) => candidate.id !== id));
    scheduleAutosave();
  };

  // Deep copy of a pattern entry (params, effects, automation), inserted
  // right below the original.
  const duplicateEntry = (id: string) => {
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const copy = duplicateStackEntry(store, entries[index]);
    if (!copy) return;
    setEntries((current) => [
      ...current.slice(0, index + 1),
      copy,
      ...current.slice(index + 1),
    ]);
    scheduleAutosave();
  };

  // ---- Effects: a chain of texture-transforming patterns per entry. ----

  const addEffect = (entryId: string, factory: () => Pattern) => {
    const target = entries.find((entry) => entry.id === entryId);
    if (!target) return;
    const effectBlock = addEffectToBlock(target.block, factory);
    if (!effectBlock) return;
    setEntries((current) =>
      current.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              effects: [
                ...entry.effects,
                {
                  id: effectBlock.id,
                  pattern: effectBlock.pattern,
                  block: effectBlock,
                },
              ],
            }
          : entry,
      ),
    );
    scheduleAutosave();
  };

  const removeEffect = (entryId: string, effectId: string) => {
    const prefix = `effect:${effectId}:`;
    const target = entries.find((entry) => entry.id === entryId);
    const effect = target?.effects.find(
      (candidate) => candidate.id === effectId,
    );
    // Removing the effect block takes its lanes and their regions with it:
    // the automation lived on the effect block, not beside it.
    if (target && effect) removeEffectFromBlock(target.block, effect.block);
    setEntries((current) =>
      current.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              effects: entry.effects.filter(
                (candidate) => candidate.id !== effectId,
              ),
            }
          : entry,
      ),
    );
    setSelectedLane((current) =>
      current?.entryId === entryId && current.uniform.startsWith(prefix)
        ? null
        : current,
    );
    scheduleAutosave();
  };

  const moveEffect = (entryId: string, effectId: string, delta: -1 | 1) => {
    const owner = entries.find((entry) => entry.id === entryId);
    const effect = owner?.effects.find((candidate) => candidate.id === effectId);
    if (!owner || !effect) return;
    // Chain order is the effect blocks' array order, so reorder there and let
    // the entry mirror it.
    moveEffectInBlock(owner.block, effect.block, delta);
    setEntries((current) =>
      current.map((entry) => {
        if (entry.id !== entryId) return entry;
        const index = entry.effects.findIndex(
          (candidate) => candidate.id === effectId,
        );
        const target = index + delta;
        if (index < 0 || target < 0 || target >= entry.effects.length)
          return entry;
        const effects = [...entry.effects];
        [effects[index], effects[target]] = [effects[target], effects[index]];
        return { ...entry, effects };
      }),
    );
    scheduleAutosave();
  };

  const changeSong = (nextSong: Song | null) => {
    applySong(nextSong);
    scheduleAutosave();
  };

  // ---- Lane controls shared by the pane and the pattern editor. ----

  const deleteLane = (entryId: string, laneKey: string) => {
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    if (laneKey === VISIBILITY_PARAM) {
      updateEntry(entryId, { visibilityCurve: undefined });
    } else {
      // Deleting a lane returns the parameter to its manual value, which in
      // this data model is a lone constant region (decision 7).
      resumeLane(entry.block, laneKey);
      writeLaneCurve(entry.block, laneKey, null, store);
      disarmLane(entry.block, laneKey);
      scheduleAutosave();
    }
    setSelectedLane((current) =>
      current?.entryId === entryId && current.uniform === laneKey
        ? null
        : current,
    );
  };

  // The lane's eye: whether the curve drives the parameter. Only a
  // curve with keyframes can toggle; an empty lane drives nothing.
  const toggleLaneActive = (entryId: string, laneKey: string) => {
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    const curve =
      laneKey === VISIBILITY_PARAM
        ? entry.visibilityCurve ?? null
        : laneCurve(entry.block, laneKey);
    if (!curve || curve.keyframes.length === 0) return;
    const nowActive = isCurveActive(curve);
    if (laneKey === VISIBILITY_PARAM)
      updateEntry(entryId, {
        visibilityCurve: { ...curve, active: !nowActive },
      });
    // Takeover never reaches the data model (decision 6).
    else if (nowActive) suspendLane(entry.block, laneKey);
    else resumeLane(entry.block, laneKey);
  };

  const reorderLanes = (nextOrder: string[]) => {
    setLaneOrder(nextOrder);
    // Lane order is view state and lives beside upstream's own lane state
    // rather than in the experience (decision 21), so it is written where it
    // changes — the draft carries the experience, not the view.
    writeLaneOrder(store.experienceName || DEFAULT_EXPERIENCE_NAME, nextOrder);
    scheduleAutosave();
  };

  // ---- Assign mode plumbing. ----

  const assignLane = (entryId: string, laneKey: string) => {
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (entry) {
      if (laneKey === VISIBILITY_PARAM) {
        if (!entry.visibilityCurve)
          updateEntry(entryId, { visibilityCurve: { keyframes: [] } });
      } else if (!laneKeysOf(entry.block).includes(laneKey)) {
        // Arming seeds a full-span region, so the new lane opens onto the
        // parameter's current value rather than onto nothing.
        armLane(entry.block, laneKey);
        scheduleAutosave();
      }
    }
    setAssigningLane(false);
  };

  // A click outside the pattern editor cancels the assignment (the
  // pattern editor itself stays open). The listener attaches after the
  // starting click, so that click never cancels its own mode.
  useEffect(() => {
    if (!assigningLane) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-panel="patterns"]')) return;
      if (target.closest('[data-doc="add-lane"]')) return;
      setAssigningLane(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [assigningLane]);

  // The badge riding beside the cursor while assigning: positioned
  // imperatively (a re-render per mousemove would be noise).
  const assignCursorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!assigningLane) return;
    const onMove = (event: PointerEvent) => {
      const badge = assignCursorRef.current;
      if (!badge) return;
      badge.style.left = `${event.clientX + 14}px`;
      badge.style.top = `${event.clientY - 24}px`;
      badge.style.opacity = "1";
      // Green over anything automatable: parameter rows and the
      // visibility eye (a lane target like any param).
      const hot = !!(event.target as HTMLElement | null)?.closest?.(
        '[data-doc="param-row"], [data-doc="pattern-visibility"]',
      );
      badge.classList.toggle(styles.assignCursorHot, hot);
    };
    document.addEventListener("pointermove", onMove);
    return () => document.removeEventListener("pointermove", onMove);
  }, [assigningLane]);

  // ---- Automation editor view: a lane, expanded over the canopy space. ----

  const selectedEntry = selectedLane
    ? entries.find((entry) => entry.id === selectedLane.entryId)
    : undefined;
  const selectedResolved =
    selectedLane &&
    selectedEntry &&
    (selectedLane.uniform === VISIBILITY_PARAM
      ? !!selectedEntry.visibilityCurve
      : laneKeysOf(selectedEntry.block).includes(selectedLane.uniform))
      ? resolveLane(selectedEntry, selectedLane.uniform)
      : null;

  // Deselect when the lane's pattern or automation is removed.
  useEffect(() => {
    if (selectedLane && !selectedResolved) setSelectedLane(null);
  }, [selectedLane, selectedResolved]);

  // Escape closes the automation editor view. The docs overlay's Escape is
  // captured before this and stops propagation.
  useEffect(() => {
    if (!selectedLane) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedLane(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedLane]);

  const toggleLane = (lane: { entryId: string; uniform: string }) =>
    setSelectedLane((current) =>
      current?.entryId === lane.entryId && current?.uniform === lane.uniform
        ? null
        : lane,
    );

  // ---- Persistence: restore on open, autosave on every change. ----

  const didRestore = useRef(false);
  useEffect(() => {
    // Wait for the store to finish loading before restoring. store.deserialize
    // REPLACES store.layers wholesale, so restoring first would leave every
    // entry pointing at a block that is no longer in any layer — the editor
    // would look right and save nothing.
    if (!experienceLoaded || didRestore.current) return;
    const experienceName = store.experienceName || DEFAULT_EXPERIENCE_NAME;

    // The static demo ships a starter experience for first-time visitors. It
    // was authored in the old save format, so it arrives through the same
    // migration any of the owner's own old saves would (decision 22).
    if (IS_DEMO && store.layers.every((layer) => !layer.getAllBlocks().length)) {
      store.deserialize(
        migrateLegacySave(demoExperience as unknown as LegacySave, {
          name: experienceName,
          store,
        }),
      );
    }

    // The row is already in the store; the stack is a view over it.
    setEntries(entriesFromStore(store));
    const loaded = store.audioStore.selectedSong;
    if (loaded && loaded.id !== NO_SONG.id) setSong(loaded);
    setLaneOrder(readLaneOrder(experienceName));

    // Unsaved work from a previous visit, offered rather than applied.
    const draft = readDraft(experienceName);
    if (draftIsAhead(draft)) {
      setAutosavePrompt(draft);
      setIsDirty(true);
    }

    // Seed the undo history with the opening state, so the very first
    // change can be undone back to it.
    history.current = {
      stack: [
        serializeEditorState(
          entriesFromStore(store),
          store.audioStore.selectedSong,
        ),
      ],
      index: 0,
    };
    // Test hook: e2e reads the live history through this.
    (window as unknown as Record<string, unknown>).__editorHistory =
      history.current;
    didRestore.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experienceLoaded]);

  useEffect(() => {
    const onDirty = () => scheduleAutosave();
    window.addEventListener(EDITOR_DIRTY_EVENT, onDirty);
    return () => {
      window.removeEventListener(EDITOR_DIRTY_EVENT, onDirty);
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    // Saving writes a ROW, which has an owner; the log in panel guarantees one
    // by opening itself when nobody is signed in.
    if (!store.userStore.me) {
      runInAction(() => (store.uiStore.showingUserPickerModal = true));
      return;
    }
    // An experience references a song, and the server refuses without one
    // ("Please select a song before saving this experience"). Say so here
    // rather than letting the save fail silently and leave Save glowing with
    // no explanation.
    if (store.audioStore.selectedSong.id === NO_SONG.id) {
      setSaveNotice("Select a song before saving");
      return;
    }
    writeLaneOrder(
      store.experienceName || DEFAULT_EXPERIENCE_NAME,
      latest.current.laneOrder,
    );
    try {
      await saveStoreToExperience(store);
      setIsDirty(false);
      setSaveNotice(null);
    } catch (error) {
      // A rejected save leaves the draft in place, so nothing is lost and Save
      // keeps glowing; the reason is worth showing rather than swallowing.
      setSaveNotice(
        error instanceof Error ? error.message : "Could not save",
      );
    }
  };

  const openAutosave = () => {
    if (!autosavePrompt) return;
    restoreDraft(store, autosavePrompt);
    setEntries(entriesFromStore(store));
    const restored = store.audioStore.selectedSong;
    setSong(restored && restored.id !== NO_SONG.id ? restored : null);
    setAutosavePrompt(null);
    // The restored draft is the new baseline for undo.
    history.current = {
      stack: [
        serializeEditorState(
          entriesFromStore(store),
          store.audioStore.selectedSong,
        ),
      ],
      index: 0,
    };
  };

  // Keyed by membership AND effect-chain structure so expand/collapse
  // clicks don't recreate the array (and churn the canopy pipeline's
  // render targets), while adding/removing/reordering an effect does.
  const visibleKey = entries
    .filter((entry) => entry.visible)
    .map(
      (entry) =>
        `${entry.id}[${entry.effects.map((effect) => effect.id).join(",")}]`,
    )
    .join(",");
  const visiblePatterns = useMemo(
    () =>
      entries
        .filter((entry) => entry.visible)
        .map(({ id, pattern, effects }) => ({ id, pattern, effects })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleKey],
  );

  // Test hooks: e2e and diagnostics read live editor state through these.
  //
  // The snapshot is built during RENDER, not inside the effect. Lanes and their
  // suspension are mobx state, and only what an observer touches while
  // rendering is tracked — reading them in an effect would leave the hook
  // showing stale automation after any change that does not also move React
  // state, such as disabling a lane.
  const entriesSnapshot = entries.map((entry) => {
    const automation: Record<string, AutomationCurve> = {};
    for (const laneKey of laneKeysOf(entry.block)) {
      const curve = laneCurve(entry.block, laneKey);
      if (curve) automation[laneKey] = curve;
    }
    if (entry.visibilityCurve)
      automation[VISIBILITY_PARAM] = entry.visibilityCurve;
    return {
      id: entry.id,
      pattern: entry.pattern,
      effects: entry.effects,
      visible: entry.visible,
      expanded: entry.expanded,
      automatedParams: Object.keys(automation),
      automation,
    };
  });

  useEffect(() => {
    const hooks = window as unknown as Record<string, unknown>;
    hooks.__editorEntries = entriesSnapshot;
    hooks.__editorBeatGrid = beatGrid;
    // The store itself, so tests can assert what the EXPERIENCE holds rather
    // than only what the editor is showing.
    hooks.__editorStore = store;
    hooks.__editorTransients = transients;
  });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Conjurer</h1>
        <span className={styles.subtitle}>Spell Crafter</span>
        <GearButton isDirty={isDirty} onOpen={openGear} />
        {saveNotice && (
          <span className={styles.saveNotice} data-doc="save-notice">
            {saveNotice}
          </span>
        )}
        <EditorLoginButton />
      </header>

      <EditorLoginPanel />
      <GearPane
        isOpen={gearOpen}
        onClose={() => setGearOpen(false)}
        onSave={save}
        onNewExperience={openExperience}
        onOpenExperience={openExperience}
        onSaveAs={saveAs}
        experienceNames={experienceNames}
      />

      <div className={styles.contentRow}>
        <PatternsPanel
          entries={entries}
          layers={store.layers}
          onAdd={addPattern}
          onAddLayer={addLayerToStack}
          onRemoveLayer={removeLayerFromStack}
          onRenameLayer={renameLayerInStack}
          onMoveLayer={moveLayerInStack}
          onToggleLayerVisible={toggleLayerVisible}
          onToggleLayerCollapsed={toggleLayerCollapsed}
          onUpdate={updateEntry}
          onRemove={removeEntry}
          onDuplicate={duplicateEntry}
          onAddEffect={addEffect}
          onRemoveEffect={removeEffect}
          onMoveEffect={moveEffect}
          assigning={assigningLane}
          onAssignParam={assignLane}
          onCancelAssign={() => setAssigningLane(false)}
        />
        <div
          className={`${styles.mainColumn} ${
            orientation === "horizontal" ? styles.mainColumnHorizontal : ""
          }`}
          data-orientation={orientation}
        >
          <section className={styles.canopyPane} data-doc="canopy">
            <div className={styles.paneLabel}>
              {selectedResolved && selectedEntry
                ? `Automation · ${formatDisplayName(selectedEntry.pattern.name)}${
                    "effectName" in selectedResolved &&
                    selectedResolved.effectName
                      ? ` · ${selectedResolved.effectName}`
                      : ""
                  } · ${selectedResolved.paramName}`
                : "Canopy"}
            </div>
            <CanopyPane patterns={visiblePatterns} dust={dust} />
            {selectedResolved && selectedLane && selectedEntry && (
              <AutomationEditorView
                key={`${selectedLane.entryId}:${selectedLane.uniform}`}
                param={selectedResolved.param}
                beatGrid={beatGrid}
                transients={transients}
                curve={
                  selectedLane.uniform === VISIBILITY_PARAM
                    ? selectedEntry.visibilityCurve ?? null
                    : laneCurve(selectedEntry.block, selectedLane.uniform)
                }
                onCurveChange={(curve) => {
                  if (selectedLane.uniform === VISIBILITY_PARAM) {
                    updateEntry(selectedLane.entryId, {
                      visibilityCurve: curve,
                    });
                    return;
                  }
                  // Editing a curve reactivates its lane: a suspended lane
                  // resumes the moment the curve itself is touched.
                  resumeLane(selectedEntry.block, selectedLane.uniform);
                  writeLaneCurve(
                    selectedEntry.block,
                    selectedLane.uniform,
                    curve,
                    store,
                  );
                  scheduleAutosave();
                }}
                blockRange={(() => {
                  // The block's window, as fractions of the song, for the
                  // dimmed zones outside it.
                  const total = transportTime.durationSeconds || 0;
                  if (!(total > 0)) return null;
                  const block = selectedEntry.block;
                  const frame = block.parentBlock ?? block;
                  return {
                    start: frame.startTime / total,
                    end: (frame.startTime + frame.duration) / total,
                  };
                })()}
                onClose={() => setSelectedLane(null)}
              />
            )}
            {autosavePrompt && (
              <div className={styles.autosaveOverlay} data-doc="autosave">
                <span className={styles.autosaveText}>
                  An auto save was found that is ahead of your current save.
                  Would you like to open it?
                </span>
                <div className={styles.autosaveActions}>
                  <button
                    className={styles.bannerAction}
                    onClick={openAutosave}
                  >
                    Open Auto Save
                  </button>
                  <button
                    className={styles.bannerDismiss}
                    onClick={() => setAutosavePrompt(null)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {!selectedResolved && (
              <CanopyControls
                volume={volume}
                onVolumeChange={setVolume}
                dust={dust}
                onDustChange={setDust}
              />
            )}
          </section>

          <TimelineStrip
            song={song}
            onSongChange={changeSong}
            volume={volume}
            onBeatGridChange={setBeatGrid}
            onTransientsChange={setTransients}
          />

          <AutomationPane
            entries={entries}
            layers={store.layers}
            onBlockTimingChange={changeBlockTiming}
            selectedLane={selectedLane}
            onSelectLane={toggleLane}
            onStartAssign={() => setAssigningLane(true)}
            onToggleLaneActive={toggleLaneActive}
            onDeleteLane={deleteLane}
            laneOrder={laneOrder}
            onReorderLanes={reorderLanes}
          />
        </div>
      </div>

      {assigningLane && (
        <div ref={assignCursorRef} className={styles.assignCursor}>
          {/* A miniature automation lane: two keyframes and their curve. */}
          <svg width="20" height="12" viewBox="0 0 20 12">
            <path
              d="M 2 10 C 8 10 12 2 18 2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <circle cx="2" cy="10" r="2" fill="currentColor" />
            <circle cx="18" cy="2" r="2" fill="currentColor" />
          </svg>
        </div>
      )}

      <DocsStrip />
    </div>
  );
});
