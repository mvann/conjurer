/**
 * Tests for the block lane read model (yarn test:blocklanes).
 *
 * The properties here are the ones whose failure would be a subtle, hard-to-see
 * editor bug rather than a crash:
 *
 * - IDENTITY IS STABLE across reads. `curveExtremes` memoizes on the curve
 *   object in a WeakMap and callers hit it every animation frame, so a new
 *   object per read would silently throw that cache away and re-sample every
 *   wave and easing continuously.
 * - WRITES INVALIDATE. Block is observable but the Variation classes are not,
 *   so a write that mutated in place would leave the computed serving a stale
 *   curve — the lane would simply stop updating.
 * - Effect lanes resolve to the effect block's own params, and a stale lane key
 *   resolves to nothing rather than throwing.
 * - laneKeysOf treats a lone constant region as the manual value, not a lane
 *   (decision 7), unless it has been explicitly armed (decisions 8 and 9).
 * - A block's automation BEGINS WHERE THE BLOCK DOES, and moving the block's
 *   left edge moves the start of the curve with it. This holds for free as long
 *   as resizing leaves region data alone, which is also what keeps a block
 *   resized here identical in upstream's editor.
 */
import { observable, runInAction } from "mobx";
import { CurveVariation, makeCurveNode } from "@/src/types/Variations/CurveVariation";
import { PeriodicVariation } from "@/src/types/Variations/PeriodicVariation";
import type { Block } from "@/src/types/Block";
import type { Store } from "@/src/types/Store";
import {
  laneCurve,
  laneKeysOf,
  writeLaneCurve,
  resolveLaneOwner,
  effectLaneKey,
  setLaneSongDuration,
  armLane,
  disarmLane,
  isConstantLane,
} from "@/src/components/EditorV2/blockLanes";

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
};

const stubStore = {
  audioStore: { getSmoothedPeakAtTime: () => 0.5 },
} as unknown as Store;

const SONG = 120;
setLaneSongDuration(SONG);

/**
 * A duck-typed block. blockLanes only ever reads pattern.params,
 * parameterVariations, effectBlocks, lanedParams, the timing, and parentBlock —
 * so this exercises the real logic without building shaders and materials, and
 * `observable` gives it the same invalidation semantics a real Block has.
 */
const makeBlock = (
  params: Record<string, unknown>,
  variations: Record<string, unknown[]>,
  effects: unknown[] = [],
) => {
  const block: Record<string, unknown> = observable({
    id: "block-1",
    pattern: { params },
    parameterVariations: variations,
    effectBlocks: effects,
    lanedParams: new Set<string>(),
    startTime: 0,
    duration: SONG,
    parentBlock: null,
    // Arming persists which lanes are open, keyed by experience and block, so
    // the block has to carry its store the way a real one does.
    store: { experienceName: "test" },
  });
  // Mirrors upstream's setParamLanes closely enough to hold blockLanes to its
  // real contract: arming both records the lane AND seeds a full-span region
  // for a parameter that has none, so the lane never opens onto nothing.
  (block as { setParamLanes: unknown }).setParamLanes = (
    uniforms: string[],
    on: boolean,
  ) => {
    for (const uniform of uniforms) {
      const laned = block.lanedParams as Set<string>;
      const regions = block.parameterVariations as Record<string, unknown[]>;
      if (!on) {
        laned.delete(uniform);
        continue;
      }
      laned.add(uniform);
      if (!regions[uniform]?.length) {
        const value = (params[uniform] as { value?: unknown })?.value;
        if (typeof value === "number")
          regions[uniform] = [CurveVariation.flat(SONG, value)];
      }
    }
  };
  return block as unknown as Block;
};

console.log("block lane read model\n");

// ---- identity stability
{
  const block = makeBlock(
    { u_intensity: { value: 0.5 } },
    {
      u_intensity: [
        new CurveVariation(SONG, [
          makeCurveNode(0, 0.1),
          makeCurveNode(SONG, 0.9),
        ]),
      ],
    },
  );
  const first = laneCurve(block, "u_intensity");
  const second = laneCurve(block, "u_intensity");
  check(!!first, "a populated lane projects to a curve");
  check(
    first === second,
    "repeated reads must return the SAME object, or the extremes memo is defeated",
  );

  // ---- invalidation on write
  writeLaneCurve(
    block,
    "u_intensity",
    {
      keyframes: [
        { time: 0, value: 0.4 },
        { time: 1, value: 0.4 },
      ],
      segments: [{ type: "flat" }],
    },
    stubStore,
  );
  const third = laneCurve(block, "u_intensity");
  check(
    third !== first,
    "a write must invalidate the computed — otherwise the lane stops updating",
  );
  check(
    !!third && Math.abs(third.keyframes[0].value - 0.4) < 1e-6,
    `the new curve must reflect the write, got ${third?.keyframes[0].value}`,
  );
  // And stable again afterwards.
  check(
    laneCurve(block, "u_intensity") === third,
    "identity settles again after a write",
  );
  console.log("  identity stable across reads, invalidated by writes");
}

// ---- effect lanes
{
  const effect = observable({
    id: "fx-9",
    store: { experienceName: "test" },
    pattern: { params: { u_hue: { value: 0 } } },
    parameterVariations: {
      u_hue: [new PeriodicVariation(SONG, "sine", 0.2, 10, 0, 0.5)],
    },
    effectBlocks: [],
    lanedParams: new Set<string>(),
    startTime: 0,
    duration: SONG,
  });
  const block = makeBlock(
    { u_intensity: { value: 0.5 } },
    { u_intensity: [CurveVariation.flat(SONG, 0.5)] },
    [effect],
  );
  // The effect's own timing must not be what frames its lane: effect params run
  // over the PARENT block's timeline.
  (effect as unknown as { parentBlock: unknown }).parentBlock = block;

  const key = effectLaneKey("fx-9", "u_hue");
  const resolved = resolveLaneOwner(block, key);
  check(
    resolved?.uniform === "u_hue" && (resolved?.owner as never) === (effect as never),
    "an effect lane resolves to the effect block and its uniform",
  );
  const curve = laneCurve(block, key);
  check(
    !!curve && curve.segments?.[0]?.type === "wave",
    `an effect wave lane projects as a wave segment, got ${curve?.segments?.[0]?.type}`,
  );
  check(
    resolveLaneOwner(block, effectLaneKey("fx-nope", "u_hue")) === null,
    "a stale effect lane key resolves to null rather than throwing",
  );
  check(
    resolveLaneOwner(block, "u_notAParam") === null,
    "a lane key for a param the pattern does not have resolves to null",
  );
  console.log("  effect lanes resolve to the effect block, framed by the parent");
}

// ---- lane existence: manual value vs automation
{
  const block = makeBlock(
    { u_flat: { value: 0.5 }, u_moving: { value: 0.5 } },
    {
      u_flat: [CurveVariation.flat(SONG, 0.5)],
      u_moving: [
        new CurveVariation(SONG, [
          makeCurveNode(0, 0.1),
          makeCurveNode(SONG, 0.9),
        ]),
      ],
    },
  );

  check(
    isConstantLane(block.parameterVariations.u_flat as never),
    "a lone flat region reads as constant",
  );
  check(
    !isConstantLane(block.parameterVariations.u_moving as never),
    "a moving curve does not read as constant",
  );

  let keys = laneKeysOf(block);
  check(
    keys.includes("u_moving"),
    "real automation always gets a lane",
  );
  check(
    !keys.includes("u_flat"),
    "an unarmed lone constant is the manual value, not a lane (decision 7)",
  );

  armLane(block, "u_flat");
  keys = laneKeysOf(block);
  check(
    keys.includes("u_flat"),
    "arming promotes a constant to a real lane (decisions 8 and 9)",
  );

  disarmLane(block, "u_flat");
  check(
    !laneKeysOf(block).includes("u_flat"),
    "disarming returns it to being the manual value",
  );
  console.log("  lane existence follows the lone-constant convention");
}

// ---- emptying a lane leaves the manual value behind
{
  const block = makeBlock(
    { u_intensity: { value: 0.75 } },
    {
      u_intensity: [
        new CurveVariation(SONG, [
          makeCurveNode(0, 0.1),
          makeCurveNode(SONG, 0.9),
        ]),
      ],
    },
  );
  writeLaneCurve(block, "u_intensity", null, stubStore);
  const regions = block.parameterVariations.u_intensity;
  check(
    Array.isArray(regions) && regions.length === 1,
    "clearing a lane leaves exactly one region",
  );
  check(
    isConstantLane(regions as never),
    "and that region is constant — the parameter's manual value",
  );
  console.log("  clearing a lane leaves the manual value as a constant region");
}

// ---- a song change re-derives every lane
{
  const block = makeBlock(
    { u_intensity: { value: 0.5 } },
    {
      u_intensity: [
        new CurveVariation(SONG, [
          makeCurveNode(0, 0.1),
          makeCurveNode(SONG, 0.9),
        ]),
      ],
    },
  );
  const before = laneCurve(block, "u_intensity");
  setLaneSongDuration(240);
  const after = laneCurve(block, "u_intensity");
  check(
    before !== after,
    "changing the song length must re-derive lanes — every keyframe time is a fraction of it",
  );
  check(
    !!after && Math.abs(after.keyframes[after.keyframes.length - 1].time - 0.5) < 1e-9,
    `a 120s lane in a 240s song must end at fraction 0.5, got ${after?.keyframes[after.keyframes.length - 1].time}`,
  );
  setLaneSongDuration(SONG);
  console.log("  a song-length change re-derives lanes");
}

// ---- a block's automation begins where the block does
{
  // The invariant, in the owner's words: "the curve should start at the start
  // of the block. So moving the left side of the block should move the start of
  // the curve." It holds for free — region time is block-local, so region 0
  // begins at the block's origin no matter where that origin is — and the way
  // to keep it holding is to leave regions ALONE when the frame moves.
  //
  // This test exists because the branch once did the opposite: it rewrote
  // region times on a left-edge resize so the automation held still in song
  // time. That was built to spec, tried, and reversed. The version that
  // survives is upstream's, so a block resized here behaves the same in their
  // editor.
  const block = makeBlock(
    { u_intensity: { value: 0.5 } },
    {
      u_intensity: [
        new CurveVariation(60, [makeCurveNode(0, 0.1), makeCurveNode(60, 0.9)]),
      ],
    },
  );
  runInAction(() => {
    block.startTime = 30;
    block.duration = 60;
  });

  const regionsBefore = block.parameterVariations.u_intensity;
  const startsAtBlock = () => {
    const curve = laneCurve(block, "u_intensity");
    return curve ? curve.keyframes[0].time * SONG - block.startTime : NaN;
  };
  check(
    Math.abs(startsAtBlock()) < 1e-6,
    `the curve must begin at the block's start, off by ${startsAtBlock()}s`,
  );

  // Drag the left edge earlier: the right edge is held, so the block grows.
  runInAction(() => {
    block.startTime = 10;
    block.duration = 80;
  });
  check(
    Math.abs(startsAtBlock()) < 1e-6,
    `the curve's start must follow the left edge, off by ${startsAtBlock()}s`,
  );
  check(
    block.parameterVariations.u_intensity === regionsBefore,
    "resizing must not rewrite region data — untouched regions are what make the slide free, and what keeps the block identical in upstream's editor",
  );

  // The curve slid whole: it keeps its length, so it now ends 20s short of the
  // block's right edge and the last value holds across the rest.
  const curve = laneCurve(block, "u_intensity");
  const endsAt = curve!.keyframes[curve!.keyframes.length - 1].time * SONG;
  check(
    Math.abs(endsAt - 70) < 1e-6,
    `the curve must keep its length rather than stretching, ends at ${endsAt}s (expected 70)`,
  );
  console.log("  a block's automation starts where the block starts, and slides with it");
}

console.log("");
if (failures > 0) {
  console.error(`FAIL: ${failures} block-lane failure(s)`);
  process.exit(1);
}
console.log("PASS: block lanes read stably, invalidate on write, and resolve effects");
