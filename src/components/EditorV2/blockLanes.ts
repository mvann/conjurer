// The lane read model: a block's region lanes, presented as the curves the
// editor already knows how to draw and edit.
//
// This is the layer that lets AutomationPane and AutomationEditorView keep
// working unchanged. They take `curve: AutomationCurve` props; this module
// produces those from `Block.parameterVariations` and writes edits straight
// back. The block stays the single source of truth — there is no second copy
// of a curve living in React state to fall out of sync.
//
// Two things make that safe:
//
// 1. IDENTITY IS STABLE. Every read goes through a mobx `computed`, so the
//    same curve object comes back until the underlying regions actually
//    change. That matters more than it looks: `curveExtremes` memoizes on the
//    curve object in a WeakMap and callers hit it every animation frame, so a
//    freshly built curve per render would throw that cache away and re-sample
//    every wave and easing 60 times a second.
//
// 2. WRITES REPLACE, NEVER MUTATE. Block is observable but the Variation
//    classes are not, so mutating a node in place would be invisible to mobx
//    and the computed would serve a stale curve. Assigning a fresh array to
//    `parameterVariations[uniform]` is what makes invalidation work, and it is
//    also what keeps the projection stateless.
//
// Components that read lanes through here must be mobx observers, or they will
// not re-render when a lane changes.

import { computed, IComputedValue, observable, runInAction } from "mobx";
import type { Block } from "@/src/types/Block";
import type { Store } from "@/src/types/Store";
import { AutomationCurve } from "@/src/components/EditorV2/automation";
import {
  curveToVariations,
  variationsToCurve,
  RegionContext,
} from "@/src/components/EditorV2/regionCurve";

// The song's length, shared the way the editor already shares transport state
// (see timeViewport): a tiny module-level store. Observable so the lane
// computeds re-derive when a song is loaded or swapped, since every keyframe
// time is a fraction of it.
const songDurationBox = observable.box(0);

export const setLaneSongDuration = (seconds: number) => {
  if (songDurationBox.get() === seconds) return;
  runInAction(() => songDurationBox.set(seconds));
};

export const getLaneSongDuration = () => songDurationBox.get();

// ---------------------------------------------------------------- lane keys

const EFFECT_PREFIX = "effect:";

/**
 * Lane key for an effect block's parameter. Pattern params use the bare
 * uniform name; effect params carry the effect BLOCK's id, so a lane stays
 * attached through reordering and through duplicate effect types.
 */
export const effectLaneKey = (effectBlockId: string, uniform: string) =>
  `${EFFECT_PREFIX}${effectBlockId}:${uniform}`;

export type ResolvedLane = {
  /** The block that actually owns the regions: the block, or one of its effects. */
  owner: Block;
  uniform: string;
};

/** Which block and uniform a lane key refers to, or null if it is stale. */
export const resolveLaneOwner = (
  block: Block,
  laneKey: string,
): ResolvedLane | null => {
  if (!laneKey.startsWith(EFFECT_PREFIX)) {
    if (!(laneKey in block.pattern.params)) return null;
    return { owner: block, uniform: laneKey };
  }
  const [, effectId, uniform] = laneKey.split(":");
  const effect = block.effectBlocks.find(
    (candidate) => candidate.id === effectId,
  );
  if (!effect || !uniform || !(uniform in effect.pattern.params)) return null;
  return { owner: effect, uniform };
};

// ------------------------------------------------------------------ context

/**
 * The block's time frame, for converting between region-local seconds and the
 * song fractions the editor works in. Effect params run over their PARENT
 * block's timeline, so an effect lane takes the parent's frame.
 */
export const regionContextFor = (block: Block): RegionContext => {
  const frame = block.parentBlock ?? block;
  return {
    blockStartTime: frame.startTime,
    blockDuration: frame.duration,
    songDuration: songDurationBox.get(),
  };
};

// ------------------------------------------------------------- cached reads

type LaneCache = Map<string, IComputedValue<AutomationCurve | null>>;
const caches = new WeakMap<Block, LaneCache>();

const cacheFor = (block: Block): LaneCache => {
  let cache = caches.get(block);
  if (!cache) {
    cache = new Map();
    caches.set(block, cache);
  }
  return cache;
};

/**
 * The curve for one lane, or null when the lane holds nothing.
 *
 * Reading `block.parameterVariations`, the owner's timing, and the song
 * duration all happens INSIDE the computed, so any of them changing
 * invalidates it and nothing has to be told to refresh.
 */
export const laneCurve = (
  block: Block,
  laneKey: string,
): AutomationCurve | null => {
  const cache = cacheFor(block);
  let entry = cache.get(laneKey);
  if (!entry) {
    entry = computed(
      () => {
        const resolved = resolveLaneOwner(block, laneKey);
        if (!resolved) return null;
        return variationsToCurve(
          resolved.owner.parameterVariations[resolved.uniform],
          regionContextFor(resolved.owner),
        );
      },
      { keepAlive: true },
    );
    cache.set(laneKey, entry);
  }
  return entry.get();
};

/**
 * Every lane this block currently has, pattern params first and then each
 * effect's, in chain order.
 *
 * A lane exists when the parameter holds real (non-constant) automation, or
 * when the author armed it explicitly — membership in upstream's `lanedParams`
 * (decisions 8 and 9). A lone constant region with no arming is the manual
 * value, not a lane, and gets no row (decision 7).
 */
export const laneKeysOf = (block: Block): string[] => {
  const keys: string[] = [];

  const collect = (owner: Block, keyOf: (uniform: string) => string) => {
    for (const uniform of Object.keys(owner.pattern.params)) {
      const regions = owner.parameterVariations[uniform];
      if (!regions || regions.length === 0) continue;
      const armed = owner.lanedParams.has(uniform);
      if (!armed && isConstantLane(regions)) continue;
      keys.push(keyOf(uniform));
    }
  };

  collect(block, (uniform) => uniform);
  for (const effect of block.effectBlocks)
    collect(effect, (uniform) => effectLaneKey(effect.id, uniform));

  return keys;
};

/**
 * Whether a lane is a lone constant — the fingerprint that means "this is the
 * manual value, not automation" (decision 7). Their load pipeline bakes
 * scalars to curves, so the shape to recognise is a single region whose
 * value never moves.
 */
export const isConstantLane = (
  regions: { type: string; computeDomain?: () => [number, number] }[],
): boolean => {
  if (regions.length !== 1) return false;
  const [region] = regions;
  const domain = region.computeDomain?.();
  if (!domain) return false;
  return Math.abs(domain[1] - domain[0]) < 1e-9;
};

// ------------------------------------------------------------------- writes

/**
 * Write a lane back to its block. Replaces the region array rather than
 * mutating it, which is what mobx needs to see the change (see the header).
 */
export const writeLaneCurve = (
  block: Block,
  laneKey: string,
  curve: AutomationCurve | null,
  store: Store,
) => {
  const resolved = resolveLaneOwner(block, laneKey);
  if (!resolved) return;
  const { owner, uniform } = resolved;

  if (!curve || curve.keyframes.length === 0) {
    // Emptying a lane leaves the parameter at its current value, which in this
    // data model means a lone constant region — the manual value.
    const value = owner.pattern.params[uniform]?.value;
    if (typeof value !== "number") return;
    const { blockDuration } = regionContextFor(owner);
    const constant = curveToVariations(
      {
        keyframes: [
          { time: 0, value },
          { time: 1, value },
        ],
        segments: [{ type: "flat" }],
      },
      { blockStartTime: 0, blockDuration, songDuration: blockDuration },
      store,
    );
    runInAction(() => {
      owner.parameterVariations[uniform] = constant;
    });
    return;
  }

  const regions = curveToVariations(curve, regionContextFor(owner), store);
  runInAction(() => {
    owner.parameterVariations[uniform] = regions;
  });
};

/** Arm a lane (decision 8): the gesture that promotes a constant to automation. */
export const armLane = (block: Block, laneKey: string) => {
  const resolved = resolveLaneOwner(block, laneKey);
  if (!resolved) return;
  runInAction(() => resolved.owner.lanedParams.add(resolved.uniform));
};

/** Disarm a lane. A constant lane returns to being the manual value. */
export const disarmLane = (block: Block, laneKey: string) => {
  const resolved = resolveLaneOwner(block, laneKey);
  if (!resolved) return;
  runInAction(() => resolved.owner.lanedParams.delete(resolved.uniform));
};
