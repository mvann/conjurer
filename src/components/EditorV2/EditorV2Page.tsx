import { useEffect, useMemo, useRef, useState } from "react";
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
  EDITOR_DIRTY_EVENT,
  loadAutosave,
  loadSave,
  restoreEntries,
  seedDemoExperience,
  SerializedEditorState,
  serializeEditorState,
  writeAutosave,
  writeSave,
} from "@/src/components/EditorV2/experiencePersistence";
import { IS_DEMO } from "@/src/utils/demo";
import demoExperience from "@/src/components/EditorV2/demoExperience.json";
import { Pattern } from "@/src/types/Pattern";
import { Song } from "@/src/types/Song";
import { formatDisplayName } from "@/src/components/EditorV2/formatDisplayName";
import { BpmAnalysis } from "@/src/components/EditorV2/bpm";

export type BeatGrid = BpmAnalysis & { durationSeconds: number };

const AUTOSAVE_DEBOUNCE_MS = 800;

export function EditorV2Page() {
  const [entries, setEntries] = useState<StackEntry[]>([]);
  const [song, setSong] = useState<Song | null>(null);
  const [volume, setVolume] = useState(1);
  const [dust, setDust] = useState(0);
  const [beatGrid, setBeatGrid] = useState<BeatGrid | null>(null);
  // Detected onset times (fractions of the song), for snap-to-transient
  // editing.
  const [transients, setTransients] = useState<number[] | null>(null);
  const [autosavePrompt, setAutosavePrompt] =
    useState<SerializedEditorState | null>(null);
  // True when the latest autosave is ahead of the last save; the Save
  // button glows only then.
  const [isDirty, setIsDirty] = useState(false);
  const [selectedLane, setSelectedLane] = useState<{
    entryId: number;
    uniform: string;
  } | null>(null);
  // Assign mode (the Add New Automation lane): the pattern editor opens
  // and the next parameter clicked gets a lane. Escape or a click
  // outside the pattern editor cancels; the editor stays open either
  // way.
  const [assigningLane, setAssigningLane] = useState(false);
  const nextId = useRef(1);
  const allocateId = () => nextId.current++;

  // Latest state for the debounced writer and the dirty-event listener.
  const latest = useRef({ entries, song });
  latest.current = { entries, song };

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
      const frac = Math.min(Math.max(seconds / durationSeconds, 0), 1);
      for (const entry of latest.current.entries) {
        for (const uniform of entry.automatedParams) {
          const curve = entry.automation[uniform];
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

  // Restore a snapshot's entries, keeping the id counter ahead of any
  // reused ids so future allocations cannot collide.
  const restoreSnapshot = (snapshot: SerializedEditorState) => {
    // Live entries flow in so pattern instances survive the restore:
    // materials and scrub fields keep the same param objects.
    const restored = restoreEntries(
      snapshot,
      allocateId,
      latest.current.entries,
    );
    nextId.current = Math.max(
      nextId.current,
      ...restored.map((entry) => entry.id + 1),
      ...restored.flatMap((entry) =>
        entry.effects.map((effect) => effect.id + 1),
      ),
    );
    return restored;
  };

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
    setSong(snapshot.song ?? null);
    // Persist the restored state directly rather than through
    // scheduleAutosave, which would capture it as a fresh history entry.
    // Edits made right after an undo therefore capture normally: there
    // is no suppression window to swallow them.
    setIsDirty(true);
    writeAutosave(snapshot);
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
      writeAutosave(
        serializeEditorState(latest.current.entries, latest.current.song),
      );
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const addPattern = (factory: () => Pattern) => {
    setEntries((current) => [
      ...current,
      {
        id: allocateId(),
        pattern: factory(),
        effects: [],
        visible: true,
        expanded: true,
        automatedParams: [],
        automation: {},
      },
    ]);
    scheduleAutosave();
  };

  const updateEntry = (id: number, update: Partial<StackEntry>) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === id ? { ...entry, ...update } : entry,
      ),
    );
    scheduleAutosave();
  };

  const removeEntry = (id: number) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    scheduleAutosave();
  };

  // ---- Effects: a chain of texture-transforming patterns per entry. ----

  const addEffect = (entryId: number, factory: () => Pattern) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              effects: [
                ...entry.effects,
                { id: allocateId(), pattern: factory() },
              ],
            }
          : entry,
      ),
    );
    scheduleAutosave();
  };

  const removeEffect = (entryId: number, effectId: number) => {
    const prefix = `effect:${effectId}:`;
    setEntries((current) =>
      current.map((entry) => {
        if (entry.id !== entryId) return entry;
        // The effect's lanes and curves go with it.
        const automation = Object.fromEntries(
          Object.entries(entry.automation).filter(
            ([laneKey]) => !laneKey.startsWith(prefix),
          ),
        );
        return {
          ...entry,
          effects: entry.effects.filter((effect) => effect.id !== effectId),
          automatedParams: entry.automatedParams.filter(
            (laneKey) => !laneKey.startsWith(prefix),
          ),
          automation,
        };
      }),
    );
    setSelectedLane((current) =>
      current?.entryId === entryId && current.uniform.startsWith(prefix)
        ? null
        : current,
    );
    scheduleAutosave();
  };

  const moveEffect = (entryId: number, effectId: number, delta: -1 | 1) => {
    setEntries((current) =>
      current.map((entry) => {
        if (entry.id !== entryId) return entry;
        const index = entry.effects.findIndex(
          (effect) => effect.id === effectId,
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
    setSong(nextSong);
    scheduleAutosave();
  };

  // ---- Assign mode plumbing. ----

  const assignLane = (entryId: number, laneKey: string) => {
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (entry && !entry.automatedParams.includes(laneKey))
      updateEntry(entryId, {
        automatedParams: [...entry.automatedParams, laneKey],
      });
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
    selectedEntry.automatedParams.includes(selectedLane.uniform)
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

  const toggleLane = (lane: { entryId: number; uniform: string }) =>
    setSelectedLane((current) =>
      current?.entryId === lane.entryId && current?.uniform === lane.uniform
        ? null
        : lane,
    );

  // ---- Persistence: restore on open, autosave on every change. ----

  const didRestore = useRef(false);
  useEffect(() => {
    // The static demo ships a starter experience for first-time visitors.
    if (IS_DEMO)
      seedDemoExperience(demoExperience as unknown as SerializedEditorState);
    const saved = loadSave();
    if (saved) {
      setEntries(restoreSnapshot(saved));
      setSong(saved.song);
    }
    const autosave = loadAutosave();
    if (autosave && autosave.savedAt > (saved?.savedAt ?? 0)) {
      setAutosavePrompt(autosave);
      setIsDirty(true);
    }
    // Seed the undo history with the opening state, so the very first
    // change can be undone back to it.
    history.current = {
      stack: [saved ?? serializeEditorState([], null)],
      index: 0,
    };
    // Test hook: e2e reads the live history through this.
    (window as unknown as Record<string, unknown>).__editorHistory =
      history.current;
    didRestore.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onDirty = () => scheduleAutosave();
    window.addEventListener(EDITOR_DIRTY_EVENT, onDirty);
    return () => {
      window.removeEventListener(EDITOR_DIRTY_EVENT, onDirty);
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = () => {
    writeSave(
      serializeEditorState(latest.current.entries, latest.current.song),
    );
    setIsDirty(false);
  };

  const openAutosave = () => {
    if (!autosavePrompt) return;
    setEntries(restoreSnapshot(autosavePrompt));
    setSong(autosavePrompt.song);
    setAutosavePrompt(null);
    // The restored autosave is the new baseline for undo.
    history.current = { stack: [autosavePrompt], index: 0 };
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
  useEffect(() => {
    const hooks = window as unknown as Record<string, unknown>;
    hooks.__editorEntries = entries;
    hooks.__editorBeatGrid = beatGrid;
    hooks.__editorTransients = transients;
  });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Conjurer</h1>
        <span className={styles.subtitle}>Spell Crafter</span>
        <button
          className={`${styles.saveButton} ${
            isDirty ? styles.saveButtonDirty : ""
          }`}
          data-doc="save"
          onClick={save}
        >
          Save
        </button>
      </header>

      <div className={styles.contentRow}>
        <PatternsPanel
          entries={entries}
          onAdd={addPattern}
          onUpdate={updateEntry}
          onRemove={removeEntry}
          onAddEffect={addEffect}
          onRemoveEffect={removeEffect}
          onMoveEffect={moveEffect}
          assigning={assigningLane}
          onAssignParam={assignLane}
          onCancelAssign={() => setAssigningLane(false)}
        />
        <div className={styles.mainColumn}>
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
                curve={selectedEntry.automation[selectedLane.uniform] ?? null}
                onCurveChange={(curve) =>
                  updateEntry(selectedLane.entryId, {
                    automation: {
                      ...selectedEntry.automation,
                      [selectedLane.uniform]: curve,
                    },
                  })
                }
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
            selectedLane={selectedLane}
            onSelectLane={toggleLane}
            onStartAssign={() => setAssigningLane(true)}
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
}
