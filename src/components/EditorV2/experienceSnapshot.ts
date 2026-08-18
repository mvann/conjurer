// The undo history's unit of state: the experience itself.
//
// The history used to hold a DERIVED projection of the document — a flat list
// of entries plus a song — and that is where every undo bug came from. A
// projection has to be kept in step with the document by hand, and it was not:
// layers were absent entirely, so restoring one rebuilt every block into the
// first layer and could give two blocks the same id; block opacity was absent,
// so an opacity edit produced an identical snapshot and ctrl-z silently undid
// the edit before it; block timing had to be re-added by hand and was rescaled
// against a basis that could not be known.
//
// So a snapshot is `store.serialize()` — the same blob a save writes — plus the
// few things upstream deliberately keeps OUT of the blob. Nothing derived,
// nothing hand-maintained: if it survives a save it is in the history, and the
// round trip is exact by construction rather than by diligence.
//
// What is deliberately NOT here:
//  - `expanded`: a collapsed pattern row is a view of the experience, not part
//    of it. Including it made clicking a caret its own undo step.
//  - takeover/suspension: memory-only by decision 6.

import { runInAction } from "mobx";
import type { Experience } from "@/src/types/Experience";
import type { Store } from "@/src/types/Store";
import type { Block } from "@/src/types/Block";
import type { Layer } from "@/src/types/Layer";
import { LayerV2 } from "@/src/types/Layer/LayerV2";
import { deserializeVariation } from "@/src/types/Variations/variations";
import { AutomationCurve } from "@/src/components/EditorV2/automation";
import {
  EffectEntry,
  StackEntry,
} from "@/src/components/EditorV2/PatternsPanel";
import { Block as BlockClass } from "@/src/types/Block";
import { adoptAllManualValues } from "@/src/components/EditorV2/blockStack";

export type EditorSnapshot = {
  savedAt: number;
  /** The document, exactly as a save would write it. */
  experience: Experience;
  /**
   * Which lanes are armed, per block, in arming order. Upstream keeps this in
   * localStorage rather than the blob, and the owner asked for it to be
   * undoable: "laned params, that can be something that's undoable."
   */
  lanedParams: Record<string, string[]>;
  /** Per-entry visibility. Not in the blob; the owner asked to keep it. */
  visibility: Record<string, boolean>;
  /** The visibility lane, which has no home in the blob yet (decision 5). */
  visibilityCurves: Record<string, AutomationCurve>;
  /** Lane display order, view state kept beside the blob (decision 21). */
  laneOrder: string[];
  /**
   * Params that had no regions at all, per block. `Block.serialize` backfills
   * a flat for those, which carries the manual value but would otherwise come
   * back as a real region on a lane the author had left empty.
   */
  emptyParams: Record<string, string[]>;
};

const blocksOfLayer = (layer: Layer): Block[] => layer.getAllBlocks();

const everyBlock = (store: Store): Block[] =>
  store.layers.flatMap((layer) => blocksOfLayer(layer));


const emptyParamsOf = (block: Block, into: Record<string, string[]>) => {
  const bare = Object.keys(block.pattern.params).filter(
    (uniform) => !(block.parameterVariations[uniform] as unknown[])?.length,
  );
  if (bare.length) into[block.id] = bare;
  for (const effect of block.effectBlocks) emptyParamsOf(effect, into);
};

const serializeBlockFaithfully = (block: Block): any => ({
  id: block.id,
  pattern: { name: block.pattern.name },
  startTime: block.startTime,
  duration: block.duration,
  locked: block.locked || undefined,
  parameterVariations: Object.fromEntries(
    Object.entries(block.parameterVariations)
      .filter(([, regions]) => (regions as unknown[])?.length)
      .map(([uniform, regions]) => [
        uniform,
        (regions as { serialize: () => unknown }[]).map((region) =>
          region.serialize(),
        ),
      ]),
  ),
  effectBlocks: block.effectBlocks.map(serializeBlockFaithfully),
});

/**
 * The document, assembled directly rather than through `store.serialize()`.
 *
 * `store.serialize()` throws without a signed-in user, and the history is
 * seeded while the login panel is still opening itself — so seeding returned
 * nothing, the first real edit became the baseline, and there was nothing to
 * undo back to. Nothing here needs a user.
 */
const serializeExperience = (store: Store): Experience =>
  ({
    id: store.experienceId,
    name: store.experienceName,
    user: store.userStore.me ?? { id: -1, username: "" },
    song: store.audioStore.selectedSong,
    status: store.experienceStatus,
    version: store.experienceVersion,
    // layer.serialize() reaches block.serialize(), which BACKFILLS a flat for
    // every param with no regions. That backfill is where a manual value
    // lives, so it is wanted here; `emptyParams` records which ones it
    // invented so the restore can put those lanes back to empty.
    data: { layers: store.layers.map((layer) => layer.serialize()) },
    thumbnailURL: store.experienceThumbnailURL,
  }) as Experience;

/** A snapshot of everything undo is responsible for. */
export const captureSnapshot = (
  store: Store,
  entries: StackEntry[],
  laneOrder: string[],
): EditorSnapshot => {
  const emptyParams: Record<string, string[]> = {};
  for (const block of everyBlock(store)) emptyParamsOf(block, emptyParams);

  const lanedParams: Record<string, string[]> = {};
  for (const block of everyBlock(store)) {
    const collect = (owner: Block) => {
      const armed = [...owner.lanedParams];
      if (armed.length) lanedParams[owner.id] = armed;
    };
    collect(block);
    for (const effect of block.effectBlocks) collect(effect);
  }

  const visibility: Record<string, boolean> = {};
  const visibilityCurves: Record<string, AutomationCurve> = {};
  for (const entry of entries) {
    visibility[entry.id] = entry.visible;
    // Deep enough to be immutable in practice: the curve's keyframes are
    // replaced rather than mutated everywhere, but the history must not share
    // an array with live state.
    if (entry.visibilityCurve)
      visibilityCurves[entry.id] = {
        ...entry.visibilityCurve,
        keyframes: entry.visibilityCurve.keyframes.map((k) => ({ ...k })),
        segments: entry.visibilityCurve.segments?.map((s) => ({ ...s })),
      };
  }

  return {
    savedAt: Date.now(),
    // The BACKFILLED blob, because that is where a manual value lives: a param
    // with no regions is serialized as a flat holding its current value
    // (decision 7). Dropping those would make undo unable to restore a value
    // the author had scrubbed.
    experience: JSON.parse(JSON.stringify(serializeExperience(store))) as Experience,
    // ...and which params genuinely had none, so restoring can put the lane
    // back to EMPTY after taking the value from the flat. Without this an
    // armed but empty lane comes back holding a two keyframe flat.
    emptyParams,
    lanedParams,
    visibility,
    visibilityCurves,
    laneOrder: [...laneOrder],
  };
};

/** Two snapshots describe the same state (ignoring when they were taken). */
export const snapshotsEqual = (a: EditorSnapshot, b: EditorSnapshot) =>
  JSON.stringify({ ...a, savedAt: 0 }) === JSON.stringify({ ...b, savedAt: 0 });

// ------------------------------------------------------------------ applying
//
// Reconciliation, not replacement. `store.deserialize` builds fresh Block and
// Pattern instances, and object identity is load-bearing here: the canopy's
// materials and the pattern editor share `pattern.params` BY REFERENCE, and the
// render pipeline's memo is keyed by block id, so it would not even notice the
// swap — it would keep rendering objects the store had thrown away. So this
// walks the blob and adopts it into the live graph, reusing every Block and
// Pattern whose id still matches.

// Adopt a serialized block into a LIVE one, keeping its Pattern instance.
//
// The blob carries no pattern params: a manual value IS a lone constant region
// (decision 7), so the regions below carry everything and `adoptManualValues`
// pushes them back into the live params afterwards.
const applyBlock = (store: Store, block: Block, data: any) => {
  runInAction(() => {
    block.setTiming({ startTime: data.startTime, duration: data.duration });
    block.locked = !!data.locked;

    const next: Record<string, unknown> = {};
    for (const [uniform, regions] of Object.entries<any>(
      data.parameterVariations ?? {},
    ))
      next[uniform] = (regions as any[]).map((region) =>
        deserializeVariation(store, region),
      );
    block.parameterVariations = next as typeof block.parameterVariations;
  });

  // Effects are an ordered list, reconciled by id so a live effect block (and
  // its pattern, shared by reference with the pattern editor) survives.
  const savedEffects: any[] = data.effectBlocks ?? [];
  const liveById = new Map(block.effectBlocks.map((e) => [e.id, e]));
  const nextEffects: Block[] = [];
  for (const savedEffect of savedEffects) {
    const live = liveById.get(savedEffect.id);
    if (live) {
      applyBlock(store, live, savedEffect);
      nextEffects.push(live);
      continue;
    }
    // Unknown pattern names are skipped rather than throwing, the same way the
    // main load path treats them.
    const rebuilt = BlockClass.deserialize(store, savedEffect, block);
    if (rebuilt) nextEffects.push(rebuilt);
  }
  runInAction(() => {
    block.effectBlocks = nextEffects;
  });
};

/**
 * Adopt a snapshot into the live store, then rebuild the editor's stack from
 * it. Returns the entries the panel should show.
 */
export const applySnapshot = (
  store: Store,
  snapshot: EditorSnapshot,
  currentEntries: StackEntry[],
): StackEntry[] => {
  const liveBlocks = new Map(everyBlock(store).map((b) => [b.id, b]));
  const liveLayers = new Map(store.layers.map((l) => [l.id, l]));
  const savedLayers: any[] = snapshot.experience.data?.layers ?? [];

  const nextLayers: Layer[] = [];
  for (const savedLayer of savedLayers) {
    let layer = liveLayers.get(savedLayer.id);
    if (!layer) {
      layer = new LayerV2(store);
      runInAction(() => (layer!.id = savedLayer.id));
    }
    runInAction(() => {
      layer!.name = savedLayer.name ?? "";
      layer!.visible = savedLayer.visible ?? true;
    });

    // Rebuild this layer's map so keys, ids and membership all agree. Blocks
    // are matched across the WHOLE store, so a block that moved between layers
    // moves rather than being duplicated.
    const wanted: Block[] = [];
    for (const [key, savedBlock] of Object.entries<any>(
      savedLayer.blockMap ?? {},
    )) {
      const id = savedBlock.id ?? key;
      const live = liveBlocks.get(id);
      if (live) {
        applyBlock(store, live, savedBlock);
        liveBlocks.delete(id);
        wanted.push(live);
      } else {
        const rebuilt = BlockClass.deserialize(store, { ...savedBlock, id });
        if (rebuilt) wanted.push(rebuilt);
      }
    }
    const target = layer;
    runInAction(() => {
      const map = (target as unknown as { blockMap: { map: Map<string, Block> } })
        .blockMap.map;
      map.clear();
      for (const block of wanted) {
        block.layer = target;
        map.set(block.id, block);
      }
    });
    nextLayers.push(layer);
  }

  runInAction(() => {
    store.layers = nextLayers;
    store.selectedLayer = nextLayers[0];
  });

  // Armed lanes, in the snapshot's order.
  runInAction(() => {
    for (const layer of store.layers)
      for (const block of blocksOfLayer(layer)) {
        const owners = [block, ...block.effectBlocks];
        for (const owner of owners) {
          owner.lanedParams.clear();
          for (const uniform of snapshot.lanedParams[owner.id] ?? [])
            owner.lanedParams.add(uniform);
        }
      }
  });

  // Manual values live as lone constant regions; push them back into the live
  // params so the pattern editor and the canopy see them.
  adoptAllManualValues(store);

  // Now take the value out of the regions that were only ever the serializer's
  // backfill, and drop them, so a lane the author left empty is empty again.
  // The value has to be read here rather than left to `adoptManualValues`,
  // which deliberately skips ARMED lanes: an armed lane takes its value from
  // its curve, so an armed EMPTY one would otherwise keep whatever the drive
  // loop last pushed into the param instead of what the author set.
  runInAction(() => {
    for (const layer of store.layers)
      for (const block of blocksOfLayer(layer))
        for (const owner of [block, ...block.effectBlocks])
          for (const uniform of snapshot.emptyParams[owner.id] ?? []) {
            if ((owner.parameterVariations[uniform] as unknown[])?.length)
              owner.updateParameter(uniform, 0);
            delete owner.parameterVariations[uniform];
          }
  });

  // The stack the panel shows, with the editor-only state layered back on.
  const currentById = new Map(currentEntries.map((e) => [e.id, e]));
  return store.layers.flatMap((layer) =>
    blocksOfLayer(layer).map((block) => {
      const current = currentById.get(block.id);
      const effects: EffectEntry[] = block.effectBlocks.map((effectBlock) => ({
        id: effectBlock.id,
        pattern: effectBlock.pattern,
        block: effectBlock,
      }));
      return {
        id: block.id,
        block,
        pattern: block.pattern,
        effects,
        visible: snapshot.visibility[block.id] ?? true,
        // Expansion is the author's current view and undo must not touch it.
        expanded: current?.expanded ?? true,
        visibilityCurve: snapshot.visibilityCurves[block.id],
      };
    }),
  );
};
