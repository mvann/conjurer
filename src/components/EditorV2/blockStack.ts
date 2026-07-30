// The block-side stack operations: layers, the patterns (blocks) inside them,
// and each block's effect chain.
//
// Thin orchestration over upstream's own methods — addBlock, removeBlock,
// insertCloneOfBlock, addCloneOfEffect, reorderEffectBlock, removeEffectBlock —
// so the behaviour is theirs and only the sizing and placement policy is Spell
// Crafter's. The editor's handlers call these instead of mutating React state,
// which is what makes store.layers the single source of truth.
//
// The one policy that matters is decision 24: **a new block spans the whole
// song** (startTime 0, duration = song length). That is what keeps an always-on
// stack feeling like one — the author never discovers blocks exist unless they
// grab an edge. Note this deliberately does NOT use upstream's
// getNextValidStartAndDuration, which hunts for a free gap: Spell Crafter WANTS
// fully overlapping blocks. That is safe because LayerV2.autoFadeWindows
// compares with strict inequalities, so identical spans generate no crossfade
// and the blocks composite additively — exactly CanopyPane's existing
// semantics.

import { runInAction } from "mobx";
import { Block } from "@/src/types/Block";
import { LayerV2 } from "@/src/types/Layer/LayerV2";
import type { Layer } from "@/src/types/Layer";
import type { Store } from "@/src/types/Store";
import type { Pattern } from "@/src/types/Pattern";
import { getLaneSongDuration } from "@/src/components/EditorV2/blockLanes";

/** Fallback span when no song is loaded, matching the migration's basis. */
const NO_SONG_DURATION_SECONDS = 60;

const fullSongDuration = () => getLaneSongDuration() || NO_SONG_DURATION_SECONDS;

// ------------------------------------------------------------------- layers

/** The blocks of a layer, in insertion order (the stack order the author sees). */
export const blocksOf = (layer: Layer): Block[] => layer.getAllBlocks();

/** Every block in the experience, layer by layer. */
export const allBlocks = (store: Store): Block[] =>
  store.layers.flatMap((layer) => blocksOf(layer));

/** The layer holding a block, or null if it has been detached. */
export const layerOf = (store: Store, block: Block): Layer | null =>
  store.layers.find((layer) =>
    layer.getAllBlocks().some((candidate) => candidate.id === block.id),
  ) ?? null;

/** Add Layer — the button under all the layers (decision 28). */
export const addLayer = (store: Store): Layer => {
  const layer = new LayerV2(store);
  runInAction(() => {
    store.layers.push(layer);
  });
  return layer;
};

/**
 * Remove a layer and everything in it.
 *
 * The owner never specified layer deletion, so this mirrors upstream: the last
 * layer is kept, since an experience with no layers has nowhere to add a
 * pattern. Confirmation is the caller's business.
 */
export const removeLayer = (store: Store, layer: Layer): boolean => {
  if (store.layers.length <= 1) return false;
  const index = store.layers.indexOf(layer);
  if (index < 0) return false;
  runInAction(() => {
    store.layers.splice(index, 1);
  });
  return true;
};

/** Rename — double-clicking the layer name, like a parameter value. */
export const renameLayer = (layer: Layer, name: string) => {
  runInAction(() => {
    layer.name = name;
  });
};

/**
 * Reorder — click and hold a layer, then drag.
 *
 * Layer order is REAL experience data (the blob's array order), unlike lane
 * order, so this is a save-worthy edit rather than view state.
 */
export const moveLayer = (store: Store, layer: Layer, toIndex: number) => {
  const from = store.layers.indexOf(layer);
  if (from < 0) return;
  const to = Math.min(Math.max(toIndex, 0), store.layers.length - 1);
  if (to === from) return;
  runInAction(() => {
    store.layers.splice(from, 1);
    store.layers.splice(to, 0, layer);
  });
};

// ------------------------------------------------------- blocks (patterns)

/**
 * Add Pattern — the button inside a layer, under its patterns (decision 28).
 * The block spans the whole song (decision 24).
 */
export const addPatternBlock = (
  store: Store,
  layer: Layer,
  factory: () => Pattern,
): Block => {
  const block = new Block(store, factory());
  runInAction(() => {
    block.startTime = 0;
    block.duration = fullSongDuration();
    layer.addBlock(block);
  });
  return block;
};

export const removePatternBlock = (layer: Layer, block: Block) => {
  runInAction(() => {
    layer.removeBlock(block);
  });
};

/**
 * Right-click a pattern (or its header lane) to duplicate it; the copy lands
 * directly beneath. Upstream's clone carries the pattern, timing, and every
 * region lane, then re-ids so the two blocks are independent.
 */
export const duplicatePatternBlock = (
  layer: Layer,
  block: Block,
): Block | null => {
  const copy = block.clone();
  runInAction(() => {
    copy.regenerateId();
    // Spell Crafter's blocks are full-song, so a duplicate sits on top of its
    // original rather than being nudged into the next gap. Overlapping
    // identical spans composite additively (see the header note).
    copy.startTime = block.startTime;
    copy.duration = block.duration;
    layer.addBlock(copy);
  });
  return copy;
};

/** Move a block to another layer, keeping its timing and lanes. */
export const moveBlockToLayer = (from: Layer, to: Layer, block: Block) => {
  if (from === to) return;
  runInAction(() => {
    from.removeBlock(block);
    to.addBlock(block);
  });
};

// ------------------------------------------------------------------ effects

/** Add an effect to a block's chain, at the end (render order). */
export const addEffectToBlock = (block: Block, factory: () => Pattern) => {
  runInAction(() => {
    block.addCloneOfEffect(factory());
  });
  return block.effectBlocks[block.effectBlocks.length - 1];
};

export const removeEffectFromBlock = (block: Block, effect: Block) => {
  runInAction(() => {
    block.removeEffectBlock(effect);
  });
};

/** Reorder within the chain; delta is -1 (earlier) or 1 (later). */
export const moveEffectInBlock = (
  block: Block,
  effect: Block,
  delta: -1 | 1,
) => {
  runInAction(() => {
    block.reorderEffectBlock(effect, delta);
  });
};

// -------------------------------------------------------------------- song

/**
 * Re-span every full-song block when the song changes.
 *
 * A Spell Crafter block is implicitly "the whole song", but that length is only
 * known once a song is loaded — and it changes when one is swapped. Blocks the
 * author has deliberately trimmed are left alone: only those still spanning the
 * previous full length follow.
 */
export const respanFullSongBlocks = (
  store: Store,
  previousDuration: number,
  nextDuration: number,
) => {
  if (!(nextDuration > 0) || previousDuration === nextDuration) return;
  runInAction(() => {
    for (const block of allBlocks(store)) {
      const spansEverything =
        block.startTime === 0 &&
        (previousDuration === 0 ||
          Math.abs(block.duration - previousDuration) < 1e-6);
      if (spansEverything) block.duration = nextDuration;
    }
  });
};
