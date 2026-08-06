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
 * - A LEFT-edge block resize holds the automation still in SONG time. Region
 *   times are block-local, so the naive thing — leaving them alone — slides
 *   every keyframe along with the edge. That failure is invisible in the data
 *   and only shows up as automation that drifts off its music.
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
  captureBlockLanes,
  rebaseBlockLanes,
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

// ---- the left edge moves the block's frame, not its automation
{
  // A block sitting from 30s to 90s of a 120s song, carrying a ramp that fills
  // it: 0.1 at song 30 (fraction 0.25) rising to 0.9 at song 90 (fraction
  // 0.75).
  const makeRamped = () => {
    const block = makeBlock(
      { u_intensity: { value: 0.5 } },
      {
        u_intensity: [
          new CurveVariation(60, [
            makeCurveNode(0, 0.1),
            makeCurveNode(60, 0.9),
          ]),
        ],
      },
    );
    runInAction(() => {
      block.startTime = 30;
      block.duration = 60;
    });
    return block;
  };

  const at = (curve: { keyframes: { time: number; value: number }[] } | null, time: number) =>
    curve?.keyframes.find((keyframe) => Math.abs(keyframe.time - time) < 1e-6);

  // Growing the front. The block starts 20s earlier and is 20s longer; the
  // ramp must still run from song 30 to song 90, with its opening value simply
  // holding across the new space.
  {
    const block = makeRamped();
    const captured = captureBlockLanes(block);
    runInAction(() => {
      block.startTime = 10;
      block.duration = 80;
    });
    rebaseBlockLanes(block, captured, stubStore);
    const curve = laneCurve(block, "u_intensity");
    check(
      !!at(curve, 0.25) && Math.abs(at(curve, 0.25)!.value - 0.1) < 1e-6,
      `growing the left edge must leave the ramp's start at song 30, got ${JSON.stringify(curve?.keyframes)}`,
    );
    check(
      !!at(curve, 0.75) && Math.abs(at(curve, 0.75)!.value - 0.9) < 1e-6,
      `growing the left edge must leave the ramp's end at song 90, got ${JSON.stringify(curve?.keyframes)}`,
    );
    console.log("  growing the left edge holds the automation still in song time");
  }

  // Trimming the front. The block now starts at song 50, a third of the way
  // along the ramp, so the surviving span must start at the value the ramp
  // actually held there — 0.1 + (20/60) * 0.8 — and NOT at 0.1 dragged onto
  // the new edge, which is what clamping alone would produce.
  {
    const block = makeRamped();
    const captured = captureBlockLanes(block);
    runInAction(() => {
      block.startTime = 50;
      block.duration = 40;
    });
    rebaseBlockLanes(block, captured, stubStore);
    const curve = laneCurve(block, "u_intensity");
    const cut = at(curve, 50 / 120);
    const expected = 0.1 + (20 / 60) * 0.8;
    check(
      !!cut && Math.abs(cut.value - expected) < 1e-3,
      `trimming the left edge must cut the ramp at the value it held there (${expected.toFixed(4)}), got ${cut?.value}`,
    );
    check(
      !!at(curve, 0.75) && Math.abs(at(curve, 0.75)!.value - 0.9) < 1e-6,
      `trimming the left edge must not disturb the held right edge, got ${JSON.stringify(curve?.keyframes)}`,
    );
    console.log("  trimming the left edge cuts the front without steepening what is left");
  }

  // Walking the edge out and back inside one gesture replays the same capture
  // every time, so it must land exactly where it started.
  {
    const block = makeRamped();
    const before = JSON.stringify(laneCurve(block, "u_intensity"));
    const captured = captureBlockLanes(block);
    for (const [startTime, duration] of [
      [10, 80],
      [55, 35],
      [30, 60],
    ]) {
      runInAction(() => {
        block.startTime = startTime;
        block.duration = duration;
      });
      rebaseBlockLanes(block, captured, stubStore);
    }
    check(
      JSON.stringify(laneCurve(block, "u_intensity")) === before,
      "dragging the left edge out and back within one gesture must be lossless",
    );
    console.log("  a left-edge drag walked back to where it began is lossless");
  }
}

console.log("");
if (failures > 0) {
  console.error(`FAIL: ${failures} block-lane failure(s)`);
  process.exit(1);
}
console.log("PASS: block lanes read stably, invalidate on write, and resolve effects");
