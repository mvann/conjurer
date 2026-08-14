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
  curveExtremes,
  deleteCurveWindow,
  evaluateCurve,
  evaluateSegment,
  generatorAtKeyframe,
  getSegments,
  insertBoundary,
  pasteClipAt,
  payloadAtTime,
  setAudioEnvelope,
  sliceSpec,
  stackGeneratorBoundaries,
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
  // Inside, a straight line between the pinned edges: the wave edge pins to
  // its baseline, the linear edge to the curve (0.75). A generator's baseline
  // is CONSTANT at its offset (decision 14) rather than riding the endpoints,
  // so the wave edge pins to 0 wherever in the wave the cut falls — it used
  // to read 0.25 here, interpolated along a slope the data model cannot store.
  const edge0 = 0;
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
  // The pasted window is EXACTLY the clip: it starts flush at the
  // cursor (the pin stacks under it as an instantaneous step).
  near(evaluateCurve(pasted, 0.45)!, 2.25, 1e-9, "paste window quarter");
  near(evaluateCurve(pasted, 0.5)!, 2.5, 1e-9, "paste window middle");
  near(evaluateCurve(pasted, 0.55)!, 2.75, 1e-9, "paste window late");
  // Outside the bisected segment the original survives exactly.
  for (const t of [0.15, 0.25, 0.75, 0.85])
    near(
      evaluateCurve(pasted, t)!,
      evaluateCurve(target, t)!,
      1e-9,
      `paste outside at ${t}`,
    );
  // LEFT of the cursor the bisected segment is pinned and unchanged
  // right up to the cursor; AT the cursor the paste takes over.
  near(
    evaluateCurve(pasted, 0.35)!,
    evaluateCurve(target, 0.35)!,
    1e-9,
    "left of cursor unchanged",
  );
  near(
    evaluateCurve(pasted, 0.4 - 1e-6)!,
    1,
    1e-5,
    "pinned value just before the cursor",
  );
  near(evaluateCurve(pasted, 0.4)!, 2, 1e-9, "paste starts at the cursor");
  near(evaluateCurve(pasted, 0.41)!, 2.05, 1e-9, "clip shape from the cursor");
  // The right junction still bridges toward the surviving keyframes.
  near(evaluateCurve(pasted, 0.65)!, 2, 0.03, "junction out of paste");
}

// ---- paste lands flush: copy four "beats", paste right after them ----
{
  // Regression: the paste used to shift its content right by a small
  // step gap to make room for the junction, which read as extra space
  // at the front of everything pasted on a snapped grid.
  const target = curveOf(
    [kf(0.1, 0), kf(0.2, 1), kf(0.3, 0.5), kf(0.9, 0.5)],
    [{ type: "linear" }, { type: "curve", bend: 3 }, { type: "linear" }],
  );
  const clip = copyCurveWindow(target, 0.1, 0.3)!;
  const pasted = pasteClipAt(target, clip, 0.3)!;
  if (!pasted.keyframes.some((keyframe) => keyframe.time === 0.3))
    fail("flush paste: no keyframe exactly at the paste point");
  // The pasted stretch reproduces the copied stretch with zero offset.
  for (let i = 0; i <= 20; i++) {
    const offset = (0.2 * i) / 20;
    near(
      evaluateCurve(pasted, 0.3 + offset)!,
      evaluateCurve(target, 0.1 + offset)!,
      1e-9,
      `flush paste at +${offset.toFixed(3)}`,
    );
  }
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

// ---- audio segments: absolute-time envelope, exact under slicing ----
{
  // A synthetic envelope: a ramp from 0 at the song's start to 1 at its
  // end, 1000 columns, "duration" 100 seconds.
  const ramp = new Float32Array(1000);
  for (let i = 0; i < ramp.length; i++) ramp[i] = i / (ramp.length - 1);
  setAudioEnvelope(ramp, 100);

  const spec: SegmentSpec = { type: "audio", factor: 2, smoothing: 0 };
  const a = kf(0.2, 1);
  const b = kf(0.6, 1);
  // Flat baseline of 1, so value = 1 + 2 * envelope(absolute time).
  near(
    evaluateSegment(a, b, spec, 0.5),
    1 + 2 * 0.4,
    0.01,
    "audio: envelope at the absolute song time",
  );

  // Smoothing averages the trailing window: at t=0.4 with 20s lookback,
  // the ramp's mean over [0.2, 0.4] is 0.3.
  const smoothed: SegmentSpec = { type: "audio", factor: 1, smoothing: 20 };
  near(
    evaluateSegment(a, b, smoothed, 0.5),
    1 + 0.3,
    0.01,
    "audio: smoothing averages the trailing window",
  );

  // Slicing keeps the spec verbatim: pasted elsewhere it reacts to the
  // audio THERE, so a copy of [0.3, 0.5] pasted at 0.7 follows the
  // envelope at 0.7 onward.
  const curve = curveOf([a, b], [spec]);
  const clip = copyCurveWindow(curve, 0.3, 0.5)!;
  const pasted = pasteClipAt(curve, clip, 0.7)!;
  near(
    evaluateCurve(pasted, 0.75)!,
    1 + 2 * 0.75,
    0.02,
    "audio: pasted slice reacts to the audio at its new position",
  );

  // Extremes include the envelope's reach, and refit when the envelope
  // version changes.
  const reach = curveExtremes(curve)!;
  near(reach.high, 1 + 2 * 0.6, 0.02, "audio: extremes reach the envelope");
  setAudioEnvelope(null, 0);
  const flat = curveExtremes(curve)!;
  near(flat.high, 1, 1e-9, "audio: extremes refit when the envelope clears");
}

// ---- value lanes go through the same window operations ----
//
// A colour or palette lane is a variation of the numeric lane, not a separate
// one, so copy/delete/paste are the SAME functions. What they have to carry
// extra is the period payload: keyframes delimit periods, and a keyframe with
// no payload starts a period with no colour.
{
  type Rgba = [number, number, number, number];
  const RED: Rgba = [1, 0, 0, 1];
  const GREEN: Rgba = [0, 1, 0, 1];
  const BLUE: Rgba = [0, 0, 1, 1];

  const sameColor = (
    actual: Rgba | undefined,
    expected: Rgba,
    context: string,
  ) => {
    if (!actual) return fail(`${context}: no colour at all`);
    for (let i = 0; i < 4; i++) near(actual[i], expected[i], 1e-6, context);
  };

  // Three periods: lead-in red, green from 0.3, blue from 0.6.
  const colourCurve = (): AutomationCurve => ({
    keyframes: [
      { time: 0.3, value: 0, color: GREEN },
      { time: 0.6, value: 0, color: BLUE },
    ],
    segments: [{ type: "flat" }],
    leadIn: { color: RED },
  });

  // A boundary inside a period continues that period's colour, rather than
  // starting a colourless one.
  const split = insertBoundary(colourCurve(), 0.45);
  const added = split.keyframes.find((k) => Math.abs(k.time - 0.45) < 1e-6);
  if (!added) fail("value: no boundary inserted at 0.45");
  else sameColor(added.color as Rgba, GREEN, "value: boundary continues green");

  // Copy carries payloads, including at the window's own edges — the edge at
  // 0.15 falls in the lead-in, which no keyframe carries.
  const clip = copyCurveWindow(colourCurve(), 0.15, 0.7)!;
  sameColor(clip.keyframes[0].color as Rgba, RED, "value: clip starts red");
  const clipGreen = clip.keyframes.find(
    (k) => Math.abs(k.time - (0.3 - 0.15)) < 1e-6,
  );
  if (!clipGreen) fail("value: clip lost its interior keyframe");
  else sameColor(clipGreen.color as Rgba, GREEN, "value: clip keeps green");

  // Delete leaves the window holding the colour that showed at its start,
  // and leaves everything outside untouched — the numeric contract exactly.
  const deleted = deleteCurveWindow(colourCurve(), 0.35, 0.5);
  sameColor(
    payloadAtTime(deleted, 0.4)?.color as Rgba,
    GREEN,
    "value: deleted window holds the colour at its start",
  );
  sameColor(
    payloadAtTime(deleted, 0.8)?.color as Rgba,
    BLUE,
    "value: delete leaves the outside untouched",
  );

  // Paste lands the copied periods at the cursor, and the original colour
  // resumes at the window's end rather than the pasted one bleeding past it.
  const target: AutomationCurve = {
    keyframes: [{ time: 0.5, value: 0, color: BLUE }],
    segments: [],
    leadIn: { color: RED },
  };
  const greenClip = copyCurveWindow(colourCurve(), 0.35, 0.55)!;
  const pastedValue = pasteClipAt(target, greenClip, 0.1)!;
  sameColor(
    payloadAtTime(pastedValue, 0.2)?.color as Rgba,
    GREEN,
    "value: paste puts green at the cursor",
  );
  sameColor(
    payloadAtTime(pastedValue, 0.05)?.color as Rgba,
    RED,
    "value: paste leaves the lead-in alone",
  );
  sameColor(
    payloadAtTime(pastedValue, 0.6)?.color as Rgba,
    BLUE,
    "value: paste does not bleed past its window",
  );

  // A gradient period cut in half reads the same as it did whole: the cut
  // lands on the interpolated colour, and the left half ends there.
  const gradient: AutomationCurve = {
    keyframes: [
      { time: 0.2, value: 0, color: RED, colorTo: BLUE },
      { time: 0.6, value: 0, color: GREEN },
    ],
    segments: [{ type: "flat" }],
    leadIn: { color: RED },
  };
  const cut = insertBoundary(gradient, 0.4);
  const left = cut.keyframes[cut.keyframes.length - 3];
  const mid = cut.keyframes.find((k) => Math.abs(k.time - 0.4) < 1e-6);
  const halfway: Rgba = [0.5, 0, 0.5, 1];
  sameColor(
    left.colorTo as Rgba,
    halfway,
    "value: gradient's left half ends at the cut",
  );
  if (!mid) fail("value: gradient not cut");
  else {
    sameColor(mid.color as Rgba, halfway, "value: gradient cut starts at the cut");
    sameColor(mid.colorTo as Rgba, BLUE, "value: gradient's right half keeps its end");
  }
}

// ---- generator boundary stacks, unzip and zip (decision 14) ----
//
// "When you create a wave, it will create two additional keyframe UI elements
//  on the left and the right side that are on the same time point as whatever
//  other keyframes are there... the wave will be decoupled from whatever value
//  the one on the left or the right is."
{
  const gen = (): AutomationCurve => ({
    keyframes: [kf(0.1, 0), kf(0.4, 1), kf(0.7, 0.2), kf(0.9, 0.5)],
    segments: [
      { type: "flat" },
      { type: "wave", wave: "sine", amplitude: 0.5, cycles: 4, phase: 0 },
      { type: "flat" },
    ],
  });

  const stacked = stackGeneratorBoundaries(gen(), 1);
  // Two neighbours, so two new keyframes and two zero-width bridges.
  if (stacked.keyframes.length !== 6)
    fail(`stack: expected 6 keyframes, got ${stacked.keyframes.length}`);
  const specs = getSegments(stacked).map((s) => s.type);
  if (specs.join(",") !== "flat,curve,wave,curve,flat")
    fail(`stack: segments are ${specs.join(",")}`);

  // Each new keyframe is coincident in TIME with the neighbour's.
  near(stacked.keyframes[1].time, stacked.keyframes[2].time, 1e-12, "stack: left pair coincident");
  near(stacked.keyframes[3].time, stacked.keyframes[4].time, 1e-12, "stack: right pair coincident");

  // The generator owns both its endpoints at one constant offset, seeded from
  // the LEFT boundary; the neighbours keep their own values. That is the
  // decoupling: the pair sits at the same time with different values.
  const offset = gen().keyframes[1].value;
  near(stacked.keyframes[2].value, offset, 1e-12, "stack: generator start is the offset");
  near(stacked.keyframes[3].value, offset, 1e-12, "stack: generator end is the offset");
  near(stacked.keyframes[1].value, offset, 1e-12, "stack: left neighbour keeps its value");
  near(stacked.keyframes[4].value, 0.2, 1e-12, "stack: right neighbour keeps its value");

  // Idempotent: re-typing an existing generator must not pile up bridges.
  const twice = stackGeneratorBoundaries(stacked, 2);
  if (twice.keyframes.length !== stacked.keyframes.length)
    fail(`stack: not idempotent (${twice.keyframes.length} keyframes)`);

  // A boundary with no neighbour gets no stack: nothing else owns that value.
  const lone: AutomationCurve = {
    keyframes: [kf(0.2, 1), kf(0.8, 3)],
    segments: [{ type: "wave", wave: "sine", amplitude: 0.5, cycles: 3, phase: 0 }],
  };
  const loneStacked = stackGeneratorBoundaries(lone, 0);
  if (loneStacked.keyframes.length !== 2)
    fail(`stack: lone generator gained keyframes (${loneStacked.keyframes.length})`);

  // A generator is ABSOLUTE: it oscillates around its own offset and never
  // sits on an angle, so the endpoints do not tilt the baseline.
  const sloped: AutomationCurve = {
    keyframes: [kf(0, 1), kf(1, 5)],
    segments: [{ type: "wave", wave: "sine", amplitude: 0.5, cycles: 1, phase: 0 }],
  };
  const a = sloped.keyframes[0];
  const b = sloped.keyframes[1];
  const spec = getSegments(sloped)[0];
  near(evaluateSegment(a, b, spec, 0), 1, 1e-9, "absolute: starts on the offset");
  near(evaluateSegment(a, b, spec, 0.5), 1, 1e-9, "absolute: half a sine cycle returns to it");
  near(evaluateSegment(a, b, spec, 0.25), 1.5, 1e-9, "absolute: peak is offset + amplitude");
  near(evaluateSegment(a, b, spec, 0.75), 0.5, 1e-9, "absolute: trough is offset - amplitude");

  // Splitting a generator keeps that constant centre.
  const split = insertBoundary(sloped, 0.5);
  near(split.keyframes[1].value, 1, 1e-9, "absolute: boundary sits on the offset");

  // ZIP: a zero-width bridge is never written as a region. The stack itself
  // encodes the step, and a zero-duration region is data-model junk.
  const zipped: AutomationCurve = {
    keyframes: [kf(0.2, 1), kf(0.5, 1), kf(0.5, 3), kf(0.8, 3)],
    segments: [{ type: "flat" }, { type: "curve", bend: 1 }, { type: "flat" }],
  };
  for (const keyframe of zipped.keyframes)
    if (!Number.isFinite(keyframe.value)) fail("zip: bad fixture");
  near(
    evaluateCurve(zipped, 0.5)!,
    3,
    1e-9,
    "zip: the later side wins at a stacked time",
  );
}

if (failures > 0) {
  console.error(`FAIL: ${failures} clipboard invariant failures`);
  process.exit(1);
}
console.log("PASS: all clipboard slicing invariants held");
