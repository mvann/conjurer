import { useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react-lite";
import { action } from "mobx";
import { useRouter } from "next/router";
import styles from "@/styles/EditorV2.module.css";
import { CanopyPane } from "@/src/components/EditorV2/CanopyPane";
import { RegionLanesPane } from "@/src/components/EditorV2/RegionLanesPane";
import { RegionEditorView } from "@/src/components/EditorV2/RegionEditorView";
import { formatDisplayName } from "@/src/components/EditorV2/formatDisplayName";
import { LayersPanel } from "@/src/components/EditorV2/LayersPanel";
import { transportTime } from "@/src/components/EditorV2/timeViewport";
import { TimelineStrip } from "@/src/components/EditorV2/TimelineStrip";
import { DocsStrip } from "@/src/components/EditorV2/DocsStrip";
import { CanopyControls } from "@/src/components/EditorV2/CanopyControls";
import { useStore } from "@/src/types/StoreContext";
import { Layer } from "@/src/types/Layer";
import { Block } from "@/src/types/Block";
import { Pattern } from "@/src/types/Pattern";
import { Song } from "@/src/types/Song";
import { BpmAnalysis } from "@/src/components/EditorV2/bpm";
import { autorun, runInAction } from "mobx";
import { useSaveExperience } from "@/src/hooks/experience";
import { LoginButton } from "@/src/components/LoginButton";
import { SaveExperienceModal } from "@/src/components/Menu/SaveExperienceModal";
import {
  draftIsAhead,
  migrateLegacyIfPresent,
  SpellDraft,
  writeDraft,
} from "@/src/components/EditorV2/spellPersistence";

export type BeatGrid = BpmAnalysis & { durationSeconds: number };

// New blocks span the whole song; without a song yet, a nominal basis
// that the block stretches from once one loads.
const DEFAULT_BLOCK_SECONDS = 60;

export const EditorV2Page = observer(function EditorV2Page() {
  // The shared main-app store: layers and blocks ARE the document.
  // Experiences load through the same pipeline the experience editor
  // uses (tRPC row -> Store.deserialize -> bake-to-curves).
  const store = useStore();
  const router = useRouter();
  useEffect(() => {
    if (store.initializationState !== "uninitialized" || !router.isReady)
      return;
    store.initializeClientSide(
      (router.query.experience as string) ?? "untitled",
    );
  }, [store, router.isReady, router.query.experience]);

  const { saveExperience } = useSaveExperience();
  const [draftPrompt, setDraftPrompt] = useState<SpellDraft | null>(null);

  // The draft channel: migrate any legacy save once, then write a
  // debounced draft on every model change; on load, offer a draft
  // that is ahead of the loaded row.
  useEffect(() => {
    migrateLegacyIfPresent();
  }, []);
  useEffect(() => {
    if (store.initializationState !== "initialized") return;
    setDraftPrompt(draftIsAhead(store));
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The just-loaded shape: drafts only write once the user actually
    // edits, so an untouched reload never clobbers a real draft with
    // the freshly loaded (possibly empty) document.
    let baseline: string | null = null;
    const dispose = autorun(() => {
      const serialized = JSON.stringify(
        store.layers.map((layer) => layer.serialize()),
      );
      if (baseline === null) {
        baseline = serialized;
        return;
      }
      if (serialized === baseline) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => writeDraft(store), 800);
    });
    return () => {
      dispose();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, store.initializationState, store.experienceName]);

  // Their keyboard set (decision 27b): save and save-as. Open joins
  // with the gear pane's browser.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (event.shiftKey)
        runInAction(() => {
          store.uiStore.showingSaveExperienceModal = true;
        });
      else saveExperience();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, saveExperience]);

  const [song, setSong] = useState<Song | null>(null);
  const [volume, setVolume] = useState(1);
  const [dust, setDust] = useState(0);
  const [beatGrid, setBeatGrid] = useState<BeatGrid | null>(null);
  // Detected onset times (fractions of the song), for snap-to-transient
  // editing.
  const [transients, setTransients] = useState<number[] | null>(null);
  // The lane open in the expanded editor, if any.
  const [selectedLane, setSelectedLane] = useState<{
    blockId: string;
    uniform: string;
  } | null>(null);
  const selectedBlock = selectedLane
    ? store.layers
        .flatMap((layer) => layer.getAllBlocks())
        .flatMap((block) => [block, ...block.effectBlocks])
        .find((block) => block.id === selectedLane.blockId)
    : undefined;

  const addPatternToLayer = action((layer: Layer, factory: () => Pattern) => {
    const block = new Block(store, factory());
    block.setTiming({
      startTime: 0,
      duration: transportTime.durationSeconds || DEFAULT_BLOCK_SECONDS,
    });
    layer.addBlock(block);
  });

  // Region automation drives the parameters: every frame, each active
  // block evaluates its variations at the block-local time, exactly as
  // the main app's playback does. Params are live uniform objects, so
  // writing needs no re-render.
  useEffect(() => {
    let frame: number;
    const apply = () => {
      frame = requestAnimationFrame(apply);
      const { seconds } = transportTime;
      for (const layer of store.layers) {
        if (!layer.visible) continue;
        for (const block of layer.getAllBlocks()) {
          if (seconds < block.startTime || seconds >= block.endTime) continue;
          block.updateParameters(seconds - block.startTime);
        }
      }
    };
    frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const changeSong = (nextSong: Song | null) => {
    setSong(nextSong);
    setBeatGrid(null);
    setTransients(null);
  };

  // Canopy inputs, keyed by block membership AND effect-chain structure
  // so param scrubs don't recreate the array (and churn the canopy
  // pipeline's render targets), while adding/removing/reordering does.
  const visibleKey = store.layers
    .filter((layer) => layer.visible)
    .flatMap((layer) => layer.getAllBlocks())
    .map(
      (block) =>
        `${block.id}[${block.effectBlocks.map((effect) => effect.id).join(",")}]`,
    )
    .join(",");
  const visiblePatterns = useMemo(
    () =>
      store.layers
        .filter((layer) => layer.visible)
        .flatMap((layer) => layer.getAllBlocks())
        .map((block) => ({
          id: block.id,
          pattern: block.pattern,
          effects: block.effectBlocks.map((effect) => ({
            id: effect.id,
            pattern: effect.pattern,
          })),
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleKey],
  );

  // Test hooks: e2e and diagnostics read live editor state through these.
  useEffect(() => {
    const hooks = window as unknown as Record<string, unknown>;
    hooks.__editorStore = store;
    hooks.__editorBlocks = store.layers.map((layer) =>
      layer.getAllBlocks().map((block) => block.id),
    );
    hooks.__editorBeatGrid = beatGrid;
    hooks.__editorTransients = transients;
  });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Conjurer</h1>
        <span className={styles.subtitle}>Spell Crafter</span>
        {store.initializationState === "initialized" && (
          <span className={styles.experienceBreadcrumb} data-doc="experience">
            {store.experienceName}
            {store.experienceUser?.username
              ? ` by ${store.experienceUser.username}`
              : ""}
          </span>
        )}
        <div className={styles.headerRight}>
          <LoginButton />
        </div>
      </header>
      <SaveExperienceModal />

      <div className={styles.contentRow}>
        <LayersPanel onAddPattern={addPatternToLayer} />
        <div className={styles.mainColumn}>
          <section className={styles.canopyPane} data-doc="canopy">
            <div className={styles.paneLabel}>
              {selectedLane && selectedBlock
                ? `Automation · ${formatDisplayName(
                    selectedBlock.pattern.name,
                  )} · ${formatDisplayName(
                    selectedBlock.pattern.params[selectedLane.uniform]?.name ??
                      selectedLane.uniform,
                  )}`
                : "Canopy"}
            </div>
            <CanopyPane patterns={visiblePatterns} dust={dust} />
            {selectedLane && selectedBlock && (
              <RegionEditorView
                key={`${selectedLane.blockId}:${selectedLane.uniform}`}
                block={selectedBlock}
                uniform={selectedLane.uniform}
                beatGrid={beatGrid}
                transients={transients}
                onClose={() => setSelectedLane(null)}
              />
            )}
            {!selectedLane && (
              <CanopyControls
                volume={volume}
                onVolumeChange={setVolume}
                dust={dust}
                onDustChange={setDust}
              />
            )}
            {draftPrompt && (
              <div className={styles.autosaveOverlay} data-doc="autosave">
                <span className={styles.autosaveText}>
                  An auto save was found that is ahead of your current save.
                  Would you like to open it?
                </span>
                <div className={styles.autosaveActions}>
                  <button
                    className={styles.bannerAction}
                    onClick={() => {
                      store.experienceStore.loadExperience(
                        draftPrompt.experience,
                      );
                      setDraftPrompt(null);
                    }}
                  >
                    Open Auto Save
                  </button>
                  <button
                    className={styles.bannerDismiss}
                    onClick={() => setDraftPrompt(null)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </section>

          <TimelineStrip
            song={song}
            onSongChange={changeSong}
            volume={volume}
            onBeatGridChange={setBeatGrid}
            onTransientsChange={setTransients}
          />

          <RegionLanesPane
            selectedLane={selectedLane}
            onSelectLane={(blockId, uniform) =>
              setSelectedLane((current) =>
                current?.blockId === blockId && current.uniform === uniform
                  ? null
                  : { blockId, uniform },
              )
            }
          />
        </div>
      </div>

      <DocsStrip />
    </div>
  );
});
