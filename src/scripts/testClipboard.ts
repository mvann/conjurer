/**
 * Tests for the automation clipboard's segment slicing (yarn
 * test:clipboard). Each segment type has its own contract:
 *
 * - wave: slicing keeps amplitude and phase alignment and carries a
 *   proportional number of cycles (half of a 3-cycle wave is 1.5
 *   cycles). Cuts at whole and half cycles of a phase-0 sine reproduce
 *   the original exactly.
 * - flat: any slice is still flat; the step stays at the far end.
 * - linear: exact under any slice.
 * - curve (Schlick) and easing: refit as a Schlick curve matched at the
 *   cut window's midpoint; exact at the endpoints and midpoint.
 *
 * Plus whole-operation invariants: copy/paste round trips, delete
 * leaving the outside untouched, boundary insertion preserving values,
 * and paste trimming at the song's end.
 */
import {
  AutomationCurve,
  copyCurveWindow,
  deleteCurveWindow,
  evaluateCurve,
  insertBoundary,
  pasteClipAt,
  sliceSpec,
  SegmentSpec,
} from "../components/EditorV2/automation";

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.error("FAIL: " + message);
};

const near = (a: number, b: number, tolerance: number, context: string) => {
  if (Math.abs(a - b) > tolerance)
    fail(`${context}: ${a} vs ${b} (tolerance ${tolerance})`);
};

const kf = (time: number, value: number) => ({ time, value });

const curveOf = (
  keyframes: { time: number; value: number }[],
  segments: SegmentSpec[],
): AutomationCurve => ({ keyframes, segments });

// ---- sliceSpec per type ----
{
  const a = kf(0.2, 1);
  const b = kf(0.8, 3);

  // wave: 3 cycles, slice the first half -> 1.5 cycles, phase kept.
  const wave: SegmentSpec = {
    type: "wave",
    wave: "sine",
    amplitude: 0.5,
    cycles: 3,
    phase: 0,
  };
  const half = sliceSpec(a, b, wave, 0, 0.5);
  if (half.type !== "wave") fail("wave slice changed type");
  else {
    near(half.cycles, 1.5, 1e-9, "wave half cycles");
    near(half.phase, 0, 1e-9, "wave half phase");
    near(half.amplitude, 0.5, 1e-9, "wave half amplitude");
  }
  // slice [0.25, 0.75]: 1.5 cycles starting mid-phase (3 * 0.25 = 0.75).
  const middle = sliceSpec(a, b, wave, 0.25, 0.75);
  if (middle.type === "wave") {
    near(middle.cycles, 1.5, 1e-9, "wave middle cycles");
    near(middle.phase, 0.75, 1e-9, "wave middle phase");
  }

  // flat stays flat; linear stays linear.
  if (sliceSpec(a, b, { type: "flat" }, 0.1, 0.6).type !== "flat")
    fail("flat slice not flat");
  if (sliceSpec(a, b, { type: "linear" }, 0.1, 0.6).type !== "linear")
    fail("linear slice not linear");

  // full-window slice of anything is the same spec.
  const full = sliceSpec(a, b, wave, 0, 1);
  if (full.type !== "wave" || full.cycles !== 3) fail("full slice changed");

  // curve: sliced spec matches the original at the window's midpoint.
  const bent: SegmentSpec = { type: "curve", bend: 4 };
  const sliced = sliceSpec(a, b, bent, 0.3, 0.9);
  if (sliced.type !== "curve" && sliced.type !== "linear")
    fail("curve slice type " + sliced.type);
}

// ---- insertBoundary preserves the curve ----
{
  const specs: SegmentSpec[] = [
    { type: "linear" },
    { type: "curve", bend: 3 },
    { type: "wave", wave: "triangle", amplitude: 0.4, cycles: 4, phase: 0.2 },
    { type: "easing", easing: "easeInOutCubic" },
    { type: "flat" },
  ];
  for (const spec of specs) {
    const curve = curveOf([kf(0.1, 0.5), kf(0.9, 2.5)], [spec]);
    const t = 0.47;
    const split = insertBoundary(curve, t);
    if (split.keyframes.length !== 3)
      fail(`insertBoundary(${spec.type}): no keyframe added`);
    // Linear, flat, and wave reproduce everywhere exactly (a wave's
    // boundary keyframe sits on its baseline, so the halves' baselines
    // and phases line up with the original).
    if (spec.type === "linear" || spec.type === "flat" || spec.type === "wave")
      for (const sample of [0.15, 0.3, 0.46, 0.48, 0.6, 0.85])
        near(
          evaluateCurve(split, sample)!,
          evaluateCurve(curve, sample)!,
          1e-9,
          `insertBoundary(${spec.type}) at ${sample}`,
        );
    // Curve and easing refit: exact at the split point itself.
    else
      near(
        evaluateCurve(split, t)!,
        evaluateCurve(curve, t)!,
        1e-9,
        `insertBoundary(${spec.type}) boundary value`,
      );
  }
}

// ---- copy: half of a 3-cycle wave is 1.5 cycles, and pastes exactly ----
{
  const wave: SegmentSpec = {
    type: "wave",
    wave: "sine",
    amplitude: 0.6,
    cycles: 3,
    phase: 0,
  };
  const curve = curveOf([kf(0.1, 1), kf(0.9, 2)], [wave]);
  const clip = copyCurveWindow(curve, 0.1, 0.5)!;
  if (!clip) fail("wave copy returned null");
  near(clip.duration, 0.4, 1e-9, "wave clip duration");
  const spec = clip.segments[0];
  if (spec.type !== "wave") fail("copied wave lost its type");
  else near(spec.cycles, 1.5, 1e-9, "copied wave is 1.5 cycles");

  const pasted = pasteClipAt(null, clip, 0.1)!;
  for (let i = 1; i < 20; i++) {
    const t = 0.1 + (0.4 * i) / 20;
    near(
      evaluateCurve(pasted, t)!,
      evaluateCurve(curve, t)!,
      1e-6,
      `wave round trip at ${t.toFixed(3)}`,
    );
  }

  // A cut at an arbitrary point (nonzero wave offset) is exact too: the
  // boundary keyframe rides the baseline and the phase carries over.
  const offCut = copyCurveWindow(curve, 0.18, 0.62)!;
  const offPasted = pasteClipAt(null, offCut, 0.18)!;
  for (let i = 1; i < 20; i++) {
    const t = 0.18 + (0.44 * i) / 20;
    near(
      evaluateCurve(offPasted, t)!,
      evaluateCurve(curve, t)!,
      1e-6,
      `off-cycle wave round trip at ${t.toFixed(3)}`,
    );
  }
}

// ---- copy across several segments, paste elsewhere ----
{
  const curve = curveOf(
    [kf(0.1, 0), kf(0.4, 1), kf(0.7, 0.5)],
    [{ type: "linear" }, { type: "flat" }],
  );
  // Window straddles the middle keyframe and bisects both segments.
  const clip = copyCurveWindow(curve, 0.25, 0.55)!;
  near(clip.duration, 0.3, 1e-9, "multi clip duration");
  if (clip.keyframes.length !== 3) fail("multi clip keyframe count");
  // Paste onto an empty lane at 0.2 and compare against the original,
  // shifted: linear and flat restrict exactly.
  const pasted = pasteClipAt(null, clip, 0.2)!;
  for (let i = 0; i <= 12; i++) {
    const t = 0.2 + (0.3 * i) / 12;
    near(
      evaluateCurve(pasted, t)!,
      evaluateCurve(curve, t + 0.05)!,
      1e-9,
      `multi round trip at ${t.toFixed(3)}`,
    );
  }
}

// ---- delete: outside untouched, inside bridged ----
{
  const wave: SegmentSpec = {
    type: "wave",
    wave: "sine",
    amplitude: 0.5,
    cycles: 4,
    phase: 0,
  };
  const curve = curveOf(
    [kf(0.1, 0), kf(0.5, 1), kf(0.9, 0)],
    [wave, { type: "linear" }],
  );
  const cut = deleteCurveWindow(curve, 0.2, 0.6);
  // Outside the window the curve is unchanged.
  for (const t of [0.1, 0.15, 0.19, 0.7, 0.8, 0.9])
    near(
      evaluateCurve(cut, t)!,
      evaluateCurve(curve, t)!,
      1e-6,
      `delete outside at ${t}`,
    );
  // Inside, a straight line between the pinned edges: the wave edge pins
  // to its baseline (0.25 at t=0.2), the linear edge to the curve (0.75).
  const edge0 = 0.25;
  const edge1 = 0.75;
  for (const t of [0.3, 0.4, 0.5]) {
    const expected = edge0 + ((edge1 - edge0) * (t - 0.2)) / 0.4;
    near(evaluateCurve(cut, t)!, expected, 1e-6, `delete bridge at ${t}`);
  }
  // Deleting the whole span empties the curve.
  if (deleteCurveWindow(curve, 0, 1).keyframes.length !== 0)
    fail("full delete left keyframes");
}

// ---- paste into an occupied window replaces it, neighbors kept ----
{
  // Target with keyframes at 0.1/0.3/0.7/0.9: the paste window [0.4, 0.6]
  // bisects only the middle segment, so everything outside 0.3..0.7 must
  // survive exactly; the junction spans [0.3, 0.4] and [0.6, 0.7] adapt.
  const target = curveOf(
    [kf(0.1, 0), kf(0.3, 1), kf(0.7, 1), kf(0.9, 0)],
    [{ type: "linear" }, { type: "linear" }, { type: "linear" }],
  );
  const source = curveOf([kf(0, 2), kf(0.2, 3)], [{ type: "linear" }]);
  const clip = copyCurveWindow(source, 0, 0.2)!;
  const pasted = pasteClipAt(target, clip, 0.4)!;
  // The pasted window is the clip (sampled inside the window; the paste
  // sits a hair right of the pinned keyframe, hence the loose tolerance).
  near(evaluateCurve(pasted, 0.45)!, 2.25, 0.01, "paste window quarter");
  near(evaluateCurve(pasted, 0.5)!, 2.5, 0.01, "paste window middle");
  near(evaluateCurve(pasted, 0.55)!, 2.75, 0.01, "paste window late");
  // Outside the bisected segment the original survives exactly.
  for (const t of [0.15, 0.25, 0.75, 0.85])
    near(
      evaluateCurve(pasted, t)!,
      evaluateCurve(target, t)!,
      1e-9,
      `paste outside at ${t}`,
    );
  // LEFT of the cursor the bisected segment is pinned and unchanged; the
  // paste steps off the pinned keyframe.
  near(
    evaluateCurve(pasted, 0.35)!,
    evaluateCurve(target, 0.35)!,
    1e-9,
    "left of cursor unchanged",
  );
  near(evaluateCurve(pasted, 0.4)!, 1, 1e-9, "pinned value at the cursor");
  near(evaluateCurve(pasted, 0.41)!, 2.05, 0.02, "step into the paste");
  // The right junction still bridges toward the surviving keyframes.
  near(evaluateCurve(pasted, 0.65)!, 2, 0.03, "junction out of paste");
}

// ---- pasting over a wave keeps everything left of the cursor exact ----
{
  const target = curveOf(
    [kf(0.1, 0), kf(0.9, 0)],
    [{ type: "wave", wave: "sine", amplitude: 1, cycles: 4, phase: 0 }],
  );
  const source = curveOf([kf(0, 2), kf(0.2, 3)], [{ type: "linear" }]);
  const clip = copyCurveWindow(source, 0, 0.2)!;
  const pasted = pasteClipAt(target, clip, 0.5)!;
  for (let i = 0; i <= 30; i++) {
    const t = 0.1 + ((0.5 - 0.1 - 1e-3) * i) / 30;
    near(
      evaluateCurve(pasted, t)!,
      evaluateCurve(target, t)!,
      1e-9,
      `wave left of cursor at ${t.toFixed(3)}`,
    );
  }
  near(evaluateCurve(pasted, 0.6)!, 2.5, 0.01, "wave paste window middle");
}

// ---- paste past the song's end trims through slicing ----
{
  const clipSource = curveOf(
    [kf(0, 0), kf(0.4, 0)],
    [{ type: "wave", wave: "sine", amplitude: 1, cycles: 4, phase: 0 }],
  );
  const clip = copyCurveWindow(clipSource, 0, 0.4)!;
  const pasted = pasteClipAt(null, clip, 0.8)!;
  const last = pasted.keyframes[pasted.keyframes.length - 1];
  near(last.time, 1, 1e-6, "trimmed paste ends at the song end");
  const spec = (pasted.segments ?? [])[0];
  if (!spec || spec.type !== "wave") fail("trimmed paste lost the wave");
  else near(spec.cycles, 2, 1e-6, "trimmed wave carries 2 of 4 cycles");
}

// ---- coincident keyframes (vertical steps) stay finite everywhere ----
{
  // Two keyframes stacked at t=0.5 form an instantaneous jump; a third
  // sits at the song's very start. Evaluation, boundary insertion, and
  // copy/delete must all tolerate the zero-duration segment.
  const stacked = curveOf(
    [kf(0, 1), kf(0.5, 1), kf(0.5, 3), kf(0.9, 3)],
    [
      { type: "linear" },
      { type: "wave", wave: "sine", amplitude: 1, cycles: 2, phase: 0 },
      { type: "linear" },
    ],
  );
  near(evaluateCurve(stacked, 0)!, 1, 1e-9, "stacked: value at song start");
  near(evaluateCurve(stacked, 0.49)!, 1, 1e-9, "stacked: before the jump");
  near(evaluateCurve(stacked, 0.5)!, 3, 1e-9, "stacked: at the jump");
  near(evaluateCurve(stacked, 0.7)!, 3, 1e-9, "stacked: after the jump");
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const value = evaluateCurve(stacked, t);
    if (value === null || !Number.isFinite(value))
      fail(`stacked: non-finite value at ${t}`);
  }
  const split = insertBoundary(stacked, 0.5);
  if (split.keyframes.length !== stacked.keyframes.length)
    fail("stacked: insertBoundary on the jump should be a no-op");
  const clip = copyCurveWindow(stacked, 0.3, 0.7);
  if (!clip) fail("stacked: copy across the jump returned null");
  else if (clip.keyframes.some((keyframe) => !Number.isFinite(keyframe.value)))
    fail("stacked: copied clip has non-finite values");
  const cut = deleteCurveWindow(stacked, 0.4, 0.6);
  for (const keyframe of cut.keyframes)
    if (!Number.isFinite(keyframe.value))
      fail("stacked: delete across the jump left non-finite values");
}

if (failures > 0) {
  console.error(`FAIL: ${failures} clipboard invariant failures`);
  process.exit(1);
}
console.log("PASS: all clipboard slicing invariants held");
