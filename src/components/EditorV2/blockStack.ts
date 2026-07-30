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
import type { StackEntry } from "@/src/components/EditorV2/PatternsPanel";
import {
  getLaneSongDuration,
  laneCurve,
  laneKeysOf,
  NO_SONG_DURATION_SECONDS,
  setLaneSongDuration,
  writeLaneCurve,
} from "@/src/components/EditorV2/blockLanes";

const fullSongDuration = () =>
  getLaneSongDuration() || NO_SONG_DURATION_SECONDS;

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

/** The layer the stack lives in, created if the experience has none yet. */
export const ensureFirstLayer = (store: Store): Layer =>
  store.layers[0] ?? addLayer(store);

/**
 * The editor's stack, derived from the store.
 *
 * This is the direction the whole adaptation runs in: `store.layers` is the
 * document, and the pattern list is a view over it. Nothing is copied — an
 * entry's `pattern` IS its block's live pattern object, so the canopy's
 * materials and the pattern list share the same params by reference.
 *
 * `visible` and `expanded` are deliberately not read from anywhere: they are
 * editor UI state, which the owner put in memory ("any of that editor state
 * stuff is, like, the UI state that can just be thrown in memory"). Pattern
 * visibility is on its way to the layer entirely (decision 5).
 */
export const entriesFromStore = (store: Store): StackEntry[] =>
  store.layers.flatMap((layer) =>
    blocksOf(layer).map((block) => ({
      id: block.id,
      block,
      pattern: block.pattern,
      effects: block.effectBlocks.map((effectBlock) => ({
        id: effectBlock.id,
        pattern: effectBlock.pattern,
        block: effectBlock,
      })),
      visible: true,
      expanded: true,
    })),
  );

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
    // clone carries the regions but not which lanes are ARMED, and arming is
    // what makes a constant lane visible at all (decision 8). Without this a
    // duplicated pattern silently loses its lane rows.
    copy.lanedParams = new Set(block.lanedParams);
    copy.effectBlocks.forEach((effectCopy, index) => {
      const source = block.effectBlocks[index];
      if (source) effectCopy.lanedParams = new Set(source.lanedParams);
    });
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
 * Adopt a new song length: re-span the full-song blocks and move their lanes
 * with them.
 *
 * A Spell Crafter block is implicitly "the whole song", but that length is
 * unknown until a song loads and changes when one is swapped. Blocks the author
 * deliberately trimmed are left alone; only those still spanning the previous
 * full length follow.
 *
 * The lanes have to follow too. Regions are measured in SECONDS and tile the
 * block exactly, so growing the block without moving them would leave every
 * lane covering only the opening slice of the song — automation would appear to
 * stop partway through.
 *
 * Rather than rescaling each variation type by hand (a curve's node times and
 * handle widths, a wave's period, a triangle's seconds-valued phase), this
 * reads each lane out as a curve FIRST. The projected curve is in fractions of
 * the song, which are basis-independent, so writing it back against the new
 * length reproduces every one of those rescalings through the same code path
 * the round-trip tests already cover.
 */
export const applySongDuration = (
  store: Store,
  nextDuration: number,
  store2?: Store,
) => {
  void store2;
  const previous = getLaneSongDuration();
  if (!(nextDuration > 0) || previous === nextDuration) return;

  const following = allBlocks(store).filter(
    (block) =>
      block.startTime === 0 && Math.abs(block.duration - previous) < 1e-6,
  );

  // Capture at the OLD basis, before anything moves.
  const captured = following.map((block) => ({
    block,
    lanes: laneKeysOf(block).map((laneKey) => ({
      laneKey,
      curve: laneCurve(block, laneKey),
    })),
  }));

  setLaneSongDuration(nextDuration);
  runInAction(() => {
    for (const { block } of captured) block.duration = nextDuration;
  });

  // Write back at the new basis: the fractions are unchanged, the seconds are
  // not.
  for (const { block, lanes } of captured)
    for (const { laneKey, curve } of lanes)
      if (curve) writeLaneCurve(block, laneKey, curve, store);
};
