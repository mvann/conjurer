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
import { saveBlockLanes } from "@/src/utils/laneStatePersistence";
import { AutomationCurve } from "@/src/components/EditorV2/automation";
import {
  curveToVariations,
  variationsToCurve,
  RegionContext,
} from "@/src/components/EditorV2/regionCurve";
import type { Variation } from "@/src/types/Variations/Variation";
import { LinearVariation4 } from "@/src/types/Variations/LinearVariation4";
import { PaletteVariation } from "@/src/params/palette/variation/PaletteVariation";
import { isVector4 } from "@/src/utils/object";
import { isPalette } from "@/src/params/palette/Palette";

// A nominal span for an experience with no song. The editor works perfectly
// well before one is loaded — its curves are fractions of the timeline, not
// seconds — so the projection needs SOME basis or every lane reads as empty.
// The value is arbitrary and cancels out: a block spanning it maps to
// fractions 0..1 either way. It matches the migration's basis for songless
// saves so the two agree.
export const NO_SONG_DURATION_SECONDS = 60;

// The song's length, shared the way the editor already shares transport state
// (see timeViewport): a tiny module-level store. Observable so the lane
// computeds re-derive when a song is loaded or swapped, since every keyframe
// time is a fraction of it.
const songDurationBox = observable.box(NO_SONG_DURATION_SECONDS);

// Whether a REAL song length has been adopted, as opposed to the nominal span
// standing in for one. The two are indistinguishable by value (a 60s song
// would read the same), and telling them apart matters: block timing measured
// against the nominal basis must never be rescaled as though it had been
// measured against a song.
const songDurationAdopted = observable.box(false);

export const setLaneSongDuration = (seconds: number) => {
  // Zero means "no song yet", not "a zero-length song": keep the nominal span
  // rather than collapsing every lane to nothing.
  const real = seconds > 0;
  const next = real ? seconds : NO_SONG_DURATION_SECONDS;
  runInAction(() => {
    if (songDurationAdopted.get() !== real) songDurationAdopted.set(real);
    if (songDurationBox.get() !== next) songDurationBox.set(next);
  });
};

export const getLaneSongDuration = () => songDurationBox.get();

/** True once a real song length is in play, not the nominal stand-in. */
export const hasRealSongDuration = () => songDurationAdopted.get();

// ------------------------------------------------------------- takeover
//
// Scrubbing an automated parameter suspends its curve: the manual value drives
// until the curve is edited again. Decision 6 keeps that behaviour but keeps it
// OUT of the data model — it is a live editing posture, not a property of the
// piece, so saving and reloading finds the curve driving again.
//
// Which means it cannot live on the block. It lives here, keyed by block and
// lane, and the lane projection folds it into the curve's `active` flag. That
// way every existing `isCurveActive(curve)` call keeps working untouched, and
// identity still only changes when the suspension actually does — the flag is
// read inside the computed, so mobx invalidates exactly once per toggle.
const suspended = observable.set<string>();

const suspensionKey = (blockId: string, laneKey: string) =>
  `${blockId}:${laneKey}`;

export const isLaneSuspended = (block: Block, laneKey: string) =>
  suspended.has(suspensionKey(block.id, laneKey));

export const suspendLane = (block: Block, laneKey: string) => {
  runInAction(() => suspended.add(suspensionKey(block.id, laneKey)));
};

export const resumeLane = (block: Block, laneKey: string) => {
  runInAction(() => suspended.delete(suspensionKey(block.id, laneKey)));
};

/** Clear every suspension — a fresh load is never mid-takeover. */
export const clearLaneSuspensions = () => {
  runInAction(() => suspended.clear());
};

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
        const curve = variationsToCurve(
          resolved.owner.parameterVariations[resolved.uniform],
          regionContextFor(resolved.owner),
        );
        if (!curve) return null;
        // Suspension is memory-only (see above), so it is applied here rather
        // than stored: the curve the editor sees carries `active: false` while
        // the manual value is driving.
        return suspended.has(suspensionKey(block.id, laneKey))
          ? { ...curve, active: false }
          : curve;
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
    // Armed lanes first, in the order they were armed. `lanedParams` is a Set,
    // so it preserves insertion order, and decision 21 makes that order the
    // per-block lane ordering — which is why it is read here rather than
    // walking the pattern's params in declaration order. Ordering by
    // declaration would silently reshuffle every author's lanes.
    for (const uniform of owner.lanedParams)
      if (uniform in owner.pattern.params) keys.push(keyOf(uniform));

    // Then anything carrying real automation that was never explicitly armed —
    // content authored elsewhere, or loaded from a save.
    for (const uniform of Object.keys(owner.pattern.params)) {
      if (owner.lanedParams.has(uniform)) continue;
      const regions = owner.parameterVariations[uniform];
      if (!regions || regions.length === 0) continue;
      // An unarmed lone constant is the manual value, not a lane (decision 7).
      if (isConstantLane(regions)) continue;
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
 * manual value, not automation" (decision 7).
 *
 * Decision 7 names three shapes, and they need different tests. The load
 * pipeline bakes scalars to curves, so a number lane is constant when its
 * domain does not move. A colour region is always linear4 from->to, so it is
 * constant when the ends match. A lone palette region holds one palette for
 * the whole block and is therefore always constant — asking it for a domain
 * gives [0, 1], which its own source calls "currently meaningless", and taking
 * that at face value made every palette parameter look automated and grow a
 * lane nobody asked for.
 */
export const isConstantLane = (regions: unknown[]): boolean => {
  if (regions.length !== 1) return false;
  const [region] = regions as [
    {
      type?: string;
      from?: { x: number; y: number; z: number; w: number };
      to?: { x: number; y: number; z: number; w: number };
      computeDomain?: () => [number, number];
    },
  ];

  if (region?.type === "palette") return true;

  if (region?.type === "linear4") {
    const { from, to } = region;
    if (!from || !to) return true;
    return (
      Math.abs(from.x - to.x) < 1e-9 &&
      Math.abs(from.y - to.y) < 1e-9 &&
      Math.abs(from.z - to.z) < 1e-9 &&
      Math.abs(from.w - to.w) < 1e-9
    );
  }

  const domain = region?.computeDomain?.();
  if (!domain) return false;
  return Math.abs(domain[1] - domain[0]) < 1e-9;
};

// ------------------------------------------------------------------- writes

/**
 * Write a lane back to its block. Replaces the region array rather than
 * mutating it, which is what mobx needs to see the change (see the header).
 */
/**
 * Write the parameter's CURRENT value as a lone constant region — the shape
 * decision 7 gives a manual value.
 *
 * Covers every kind a pattern param can hold, dispatching the way upstream's
 * own armParamLane does, so a colour or a palette keeps its manual value as
 * faithfully as a number does.
 */
export const writeManualConstant = (
  owner: Block,
  uniform: string,
  store: Store,
) => {
  const value = owner.pattern.params[uniform]?.value;
  const { blockDuration } = regionContextFor(owner);
  let constant: Variation[] | null = null;

  if (typeof value === "number")
    constant = curveToVariations(
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
  else if (isVector4(value))
    constant = [new LinearVariation4(blockDuration, value, value)];
  else if (isPalette(value))
    constant = [new PaletteVariation(blockDuration, value)];

  if (!constant) return;
  const regions = constant;
  runInAction(() => {
    owner.parameterVariations[uniform] = regions;
  });
};

/**
 * Keep a manual value's region in step with the value the author just set.
 *
 * The other half of adoptManualValues, and the other half of the same bug.
 * Once a param has a lone-constant region behind it — which every param gets
 * after one save and reopen — scrubbing it changed `param.value` and left the
 * region holding the old number. The editor showed the new value, the save
 * wrote the old one, and reopening threw the edit away.
 *
 * Only unarmed lone constants are touched. A real lane is the author's
 * automation and none of this function's business; a param with no region at
 * all needs none, since the save-time backfill writes one from the value.
 */
export const syncManualValue = (
  block: Block,
  laneKey: string,
  store: Store,
) => {
  const resolved = resolveLaneOwner(block, laneKey);
  if (!resolved) return;
  const { owner, uniform } = resolved;
  if (owner.lanedParams.has(uniform)) return;
  const regions = owner.parameterVariations[uniform];
  if (!regions || regions.length === 0) return;
  if (!isConstantLane(regions)) return;
  writeManualConstant(owner, uniform, store);
};

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
    writeManualConstant(owner, uniform, store);
    return;
  }

  const regions = curveToVariations(curve, regionContextFor(owner), store);
  runInAction(() => {
    owner.parameterVariations[uniform] = regions;
  });
};

/**
 * Push every block's saved MANUAL VALUES back into its pattern params.
 *
 * Decision 7 says an unarmed lone-constant region IS the manual value, and
 * `laneKeysOf` therefore leaves it out — it is not a lane. But the editor's
 * drive loop only walks lanes, so nothing was ever reading those regions back:
 * on load a param would sit at its pattern DEFAULT while the value the author
 * saved sat in the data untouched. Set Warp to 2, save, reopen, and it read 0
 * again, in the panel and on the canopy both.
 *
 * The read half of the convention, in other words, was missing. This is it.
 *
 * Armed lanes are deliberately skipped: the drive loop owns those and will
 * overwrite this on the next frame anyway. Evaluation goes through upstream's
 * own `updateParameter` so every variation type — numbers, colours, palettes —
 * is read exactly the way their editor reads it.
 */
export const adoptManualValues = (block: Block) => {
  const seed = (owner: Block) => {
    for (const uniform of Object.keys(owner.pattern.params)) {
      if (owner.lanedParams.has(uniform)) continue;
      const regions = owner.parameterVariations[uniform];
      if (!regions || regions.length === 0) continue;
      if (!isConstantLane(regions)) continue;
      owner.updateParameter(uniform, 0);
    }
  };
  seed(block);
  for (const effect of block.effectBlocks) seed(effect);
};

/**
 * Which lanes are open is editor state, not experience data, so it does not go
 * in the blob — it goes where upstream already puts it, keyed by experience and
 * block (decision 9). Upstream's own toggle persists as a side effect of
 * arming; arming here does not go through that path, so the write is explicit.
 * Without it an armed but still-empty lane vanishes on reload, since nothing
 * else records that the author asked for it.
 */
export const persistLanes = (owner: Block) =>
  saveBlockLanes(owner.store.experienceName, owner.id, [...owner.lanedParams]);

/**
 * Arm a lane (decision 8): the gesture that expresses "automate this".
 *
 * Deliberately does NOT seed a region, which is where upstream's
 * setParamLanes differs. An armed lane with no regions is Spell Crafter's
 * EMPTY lane, and empty is a real state here: the editor draws the manual
 * value as a line and the first double-click lays down the first keyframe.
 * Seeding a flat region instead would erase that state, and with it the manual
 * value line and the takeover affordances built around it.
 *
 * Decision 7 is untouched by this: it governs LOADING — a parameter whose
 * saved variations are a lone constant gets no lane at all. Once armed, that
 * same constant shows as the flat line decision 8 describes, because the
 * region is already there from the load.
 */
export const armLane = (block: Block, laneKey: string) => {
  const resolved = resolveLaneOwner(block, laneKey);
  if (!resolved) return;
  runInAction(() => resolved.owner.lanedParams.add(resolved.uniform));
  persistLanes(resolved.owner);
};

/**
 * Empty a lane's regions without disarming it — Spell Crafter's EMPTY lane,
 * which upstream has no equivalent for.
 *
 * Not the same as `writeLaneCurve(..., null)`: that writes the manual constant,
 * a two-node flat region, which projects straight back as two keyframes. An
 * armed lane with nothing in it holds no regions at all; the manual value
 * lives on the pattern param. Restoring one any other way puts keyframes on a
 * lane the author had emptied.
 */
export const clearLaneRegions = (block: Block, laneKey: string) => {
  const resolved = resolveLaneOwner(block, laneKey);
  if (!resolved) return;
  runInAction(() => {
    delete resolved.owner.parameterVariations[resolved.uniform];
  });
};

/** Disarm a lane. A constant lane returns to being the manual value. */
export const disarmLane = (block: Block, laneKey: string) => {
  const resolved = resolveLaneOwner(block, laneKey);
  if (!resolved) return;
  runInAction(() => resolved.owner.lanedParams.delete(resolved.uniform));
  persistLanes(resolved.owner);
};
