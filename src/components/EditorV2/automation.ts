// Relative imports (not @/ aliases) so the ts-node test scripts, which
// have no path mapping, can exercise this module directly.
import { easings } from "../../utils/easings";
import { bezierValueAtX } from "../../utils/envelopeCurve";

// Same string union as the main app's EasingVariationType, derived from
// the shared easing table itself.
export type EasingName = keyof typeof easings;

// Automation curve data for one lane. Keyframes are sorted by time (a
// fraction 0..1 of the song). segments[i] describes the shape between
// keyframes i and i+1. The default "curve" segment uses a Schlick
// rational curve:
//   shaped(t) = t / (t + (1 - t) * bend)
// 1 is linear; below 1 bows toward the destination early; above 1 bows
// late. Unlike a power curve, the slope stays finite at both ends, so
// strong bends render rounded instead of vertical.
//
// The other segment types mirror the variations available in the main
// experience editor: flat, linear, wave (periodic sine/square/triangle),
// easing, and audio (the song's loudness envelope riding the keyframe
// line). Spline variations are not a segment type yet.
//
// Color and palette lanes automate the whole value, not a number: each
// keyframe carries a payload (an RGBA color or a serialized palette) that
// holds from its time until the next keyframe, like the main app's
// picking of palettes for periods of time. Their `value` field is unused.
export type AutomationKeyframe = {
  time: number;
  value: number;
  color?: [number, number, number, number];
  palette?: {
    a: [number, number, number];
    b: [number, number, number];
    c: [number, number, number];
    d: [number, number, number];
  };
  // Cubic-Bezier control handles, as (time, value) offsets from the
  // keyframe, matching the data model's CurveNode. dt is in the same
  // fraction-of-song units as `time`. Present only on keyframes that came
  // from (or are headed for) a Curve region: a segment whose endpoints
  // both carry handles is drawn as a Bezier rather than a Schlick bend,
  // which is what makes the pen-tool degree of freedom survive a round
  // trip through the data model. OUT points forward (dt >= 0), IN back.
  handleIn?: { dt: number; dv: number };
  handleOut?: { dt: number; dv: number };
  // Value lanes only: the far end of a gradient period. The data model's
  // color region is always linear4 from->to, so a period is structurally
  // always a gradient; `color` is the `from` and this is the `to`. Equal
  // values (or absence) read as a plain single color. See decision 23.
  colorTo?: [number, number, number, number];
};

export type ValuePayload = {
  color?: [number, number, number, number];
  palette?: {
    a: [number, number, number];
    b: [number, number, number];
    c: [number, number, number];
    d: [number, number, number];
  };
};

// The payload holding at the given time. Keyframes are boundaries: the
// region BEFORE the first keyframe is its own period, stored on the
// curve as leadIn; each keyframe's payload covers from its time to the
// next keyframe. N keyframes make N + 1 periods.
export const payloadAtTime = (
  curve: AutomationCurve,
  time: number,
): ValuePayload | null => {
  const { keyframes } = curve;
  if (keyframes.length === 0) return curve.leadIn ?? null;
  if (time < keyframes[0].time)
    return (
      curve.leadIn ?? {
        color: keyframes[0].color,
        palette: keyframes[0].palette,
      }
    );
  let holder = keyframes[0];
  for (const keyframe of keyframes) {
    if (keyframe.time > time) break;
    holder = keyframe;
  }
  return { color: holder.color, palette: holder.palette };
};

// Mirrors the data model's PeriodicVariationType, including the saw kinds
// added upstream after the merge plan was written.
export type WaveKind =
  | "sine"
  | "square"
  | "triangle"
  | "sawUp"
  | "sawDown";

export type SegmentSpec =
  | { type: "curve"; bend: number }
  | { type: "flat" }
  | { type: "linear" }
  | {
      type: "wave";
      wave: WaveKind;
      amplitude: number;
      // Full oscillations across the segment; phase is in cycles (0..1).
      cycles: number;
      phase: number;
    }
  | { type: "easing"; easing: EasingName }
  // Audio-reactive: the song's loudness at the ABSOLUTE song time, scaled
  // by factor and riding on the straight line between the keyframes (the
  // main app's AudioVariation semantics, fitted to the segment model).
  // Smoothing is a causal lookback window in seconds.
  | { type: "audio"; factor: number; smoothing: number };

// The audio envelope audio segments follow: the loaded song's peak
// array, injected by the editor when peaks are ready. Injection keeps
// this module pure for the ts-node test suites, which supply synthetic
// envelopes. `version` stamps extremes memos so ranges refit when a
// song arrives after curves already exist.
const envelope: {
  peaks: Float32Array | null;
  durationSeconds: number;
  version: number;
} = { peaks: null, durationSeconds: 0, version: 0 };

export const setAudioEnvelope = (
  peaks: Float32Array | null,
  durationSeconds: number,
) => {
  envelope.peaks = peaks;
  envelope.durationSeconds = durationSeconds;
  envelope.version++;
};

// Loudness 0..1 at a fraction of the song, averaged over the trailing
// `smoothing` seconds. Zero with no song loaded.
export const sampleAudioEnvelope = (frac: number, smoothing: number) => {
  const { peaks, durationSeconds } = envelope;
  if (!peaks || peaks.length === 0) return 0;
  const to = Math.min(peaks.length - 1, Math.max(0, frac * peaks.length));
  const windowCols = durationSeconds
    ? (smoothing / durationSeconds) * peaks.length
    : 0;
  const from = Math.max(0, to - Math.max(0, windowCols));
  const first = Math.floor(from);
  const last = Math.floor(to);
  let sum = 0;
  for (let i = first; i <= last; i++) sum += peaks[i];
  return sum / (last - first + 1);
};

export type SegmentType = SegmentSpec["type"];

export type AutomationCurve = {
  keyframes: AutomationKeyframe[];
  // Legacy field: earlier curves stored one Schlick bend per segment.
  bends?: number[];
  segments?: SegmentSpec[];
  // A deactivated curve (false) stops driving its parameter: the
  // manual value takes over until the curve is edited again.
  // Undefined means active.
  active?: boolean;
  // Value lanes only: the color or palette of the period BEFORE the
  // first keyframe (keyframes are boundaries; N keyframes = N+1 periods).
  leadIn?: {
    color?: [number, number, number, number];
    palette?: {
      a: [number, number, number];
      b: [number, number, number];
      c: [number, number, number];
      d: [number, number, number];
    };
  };
};

export const isCurveActive = (curve: AutomationCurve | null | undefined) =>
  !!curve && curve.active !== false;

export const shapeSegment = (t: number, bend: number) =>
  t / (t + (1 - t) * bend);

// The segment list, sized to the keyframes, tolerating legacy curves that
// only stored bends and curves whose segment list is out of step.
export const getSegments = (curve: AutomationCurve): SegmentSpec[] => {
  const count = Math.max(0, curve.keyframes.length - 1);
  const source: SegmentSpec[] =
    curve.segments ??
    (curve.bends ?? []).map((bend) => ({ type: "curve", bend }));
  const segments = source.slice(0, count);
  while (segments.length < count) segments.push({ type: "curve", bend: 1 });
  return segments;
};

// A fresh segment of the given type between two keyframes, with defaults
// scaled to the endpoints where that helps.
export const defaultSegment = (
  type: SegmentType,
  a: AutomationKeyframe,
  b: AutomationKeyframe,
): SegmentSpec => {
  switch (type) {
    case "curve":
      return { type: "curve", bend: 1 };
    case "flat":
      return { type: "flat" };
    case "linear":
      return { type: "linear" };
    case "wave":
      return {
        type: "wave",
        wave: "sine",
        amplitude: Math.max(Math.abs(b.value - a.value) / 2, 0.25),
        cycles: 4,
        phase: 0,
      };
    case "easing":
      return { type: "easing", easing: "easeInOutSine" };
    case "audio":
      return {
        type: "audio",
        factor: Math.max(Math.abs(b.value - a.value), 0.5),
        smoothing: 0.05,
      };
  }
};

// Fraction of the way through the current cycle, in [0, 1).
const cyclePosition = (u: number) => ((u % 1) + 1) % 1;

const waveShape = (kind: WaveKind, u: number) => {
  switch (kind) {
    case "sine":
      return Math.sin(2 * Math.PI * u);
    case "square":
      return Math.sin(2 * Math.PI * u) >= 0 ? 1 : -1;
    case "triangle":
      // Exact triangle with sine's alignment: 0 at u=0, peak at u=0.25.
      return (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * u));
    // Ramp across one cycle then jump back, matching the data model's saws:
    // up runs -1 to 1, down runs 1 to -1. Direction is the kind, not the
    // sign of the amplitude, so min/max stay ordered.
    case "sawUp":
      return 2 * cyclePosition(u) - 1;
    case "sawDown":
      return 1 - 2 * cyclePosition(u);
  }
};

// The value of one segment at local time t (0 at keyframe a, 1 at b).
// A curve segment carries Bezier handles when it came from (or is headed
// for) a Curve region, and the handles are what hold its shape. Segments
// without them fall back to the Schlick bend, which is how curves authored
// before the data model adopted handles still draw.
export const isBezierSegment = (
  a: AutomationKeyframe,
  b: AutomationKeyframe,
  spec: SegmentSpec,
) => spec.type === "curve" && !!a.handleOut && !!b.handleIn;

// Value of a handled curve segment at local t, evaluated exactly as the
// data model's CurveVariation does: solve X(s)=time, read Y(s).
const bezierSegmentValue = (
  a: AutomationKeyframe,
  b: AutomationKeyframe,
  t: number,
) => {
  const span = b.time - a.time;
  // Coincident keyframes are a step; the later value wins once reached.
  if (!(Math.abs(span) > 1e-12)) return t <= 0 ? a.value : b.value;
  const out = a.handleOut ?? { dt: 0, dv: 0 };
  const inn = b.handleIn ?? { dt: 0, dv: 0 };
  return bezierValueAtX(
    a.time,
    a.value,
    a.time + out.dt,
    a.value + out.dv,
    b.time + inn.dt,
    b.value + inn.dv,
    b.time,
    b.value,
    a.time + span * t,
  );
};

export const evaluateSegment = (
  a: AutomationKeyframe,
  b: AutomationKeyframe,
  spec: SegmentSpec,
  t: number,
): number => {
  switch (spec.type) {
    case "curve":
      if (isBezierSegment(a, b, spec)) return bezierSegmentValue(a, b, t);
      return a.value + (b.value - a.value) * shapeSegment(t, spec.bend);
    case "flat":
      return t < 1 ? a.value : b.value;
    case "linear":
      return a.value + (b.value - a.value) * t;
    case "wave":
      return (
        a.value +
        (b.value - a.value) * t +
        spec.amplitude * waveShape(spec.wave, spec.cycles * t + spec.phase)
      );
    case "easing": {
      const easing = easings[spec.easing] ?? easings.easeInOutSine;
      return a.value + (b.value - a.value) * easing(t);
    }
    case "audio":
      return (
        a.value +
        (b.value - a.value) * t +
        spec.factor *
          sampleAudioEnvelope(a.time + (b.time - a.time) * t, spec.smoothing)
      );
  }
};

// Sample positions for drawing one segment: local times paired with
// values, from just after t=0 through t=1. Curve samples are warped
// toward the steep end so strong bends stay smooth; flat is the exact
// step; waves sample densely enough for their cycle count.
export const sampleSegment = (
  a: AutomationKeyframe,
  b: AutomationKeyframe,
  spec: SegmentSpec,
  detail = 1,
): { t: number; value: number }[] => {
  if (spec.type === "flat")
    return [
      { t: 1, value: a.value },
      { t: 1, value: b.value },
    ];
  if (spec.type === "linear") return [{ t: 1, value: b.value }];

  let samples = Math.round(36 * detail);
  let gamma = 1;
  // Warping samples toward the steep end is a Schlick trick; a Bezier's
  // steepness lives in its handles, so sample it evenly and a bit denser.
  if (spec.type === "curve") {
    if (isBezierSegment(a, b, spec)) samples = Math.round(48 * detail);
    else gamma = 1 / Math.sqrt(spec.bend);
  }
  if (spec.type === "wave")
    // Enough samples for every cycle to stay smooth: the cap only guards
    // against runaway point counts, not normal use.
    samples = Math.min(4000, Math.round(Math.abs(spec.cycles) * 48 * detail));
  if (spec.type === "easing") samples = Math.round(60 * detail);
  // Audio follows the envelope, which is far denser than any shape:
  // sample generously (bounded), scaled by the caller's detail.
  if (spec.type === "audio") samples = Math.round(400 * detail);
  samples = Math.max(8, samples);

  const points: { t: number; value: number }[] = [];
  for (let i = 1; i <= samples; i++) {
    const t = Math.pow(i / samples, gamma);
    points.push({ t, value: evaluateSegment(a, b, spec, t) });
  }
  return points;
};

// The lowest and highest points of the CURVE itself, not just its
// keyframes: a wave's peaks, an overshooting easing (back, elastic), and a
// Bezier whose handles carry it past its endpoints all reach beyond the
// keyframe values and count toward the range. Schlick curves, flat, and
// linear never leave the span of their endpoints, so those are skipped.
// Memoized per curve object (edits always produce a new object), since
// callers run every animation frame.
const extremesMemo = new WeakMap<
  AutomationCurve,
  { version: number; extremes: { low: number; high: number } | null }
>();

export const curveExtremes = (
  curve: AutomationCurve,
): { low: number; high: number } | null => {
  // Stamped with the envelope version: audio segments' reach changes
  // when a song's envelope arrives after the curve already existed.
  const memo = extremesMemo.get(curve);
  if (memo && memo.version === envelope.version) return memo.extremes;
  const extremes = computeCurveExtremes(curve);
  extremesMemo.set(curve, { version: envelope.version, extremes });
  return extremes;
};

const computeCurveExtremes = (
  curve: AutomationCurve,
): { low: number; high: number } | null => {
  const { keyframes } = curve;
  if (keyframes.length === 0) return null;
  let low = Infinity;
  let high = -Infinity;
  const push = (value: number) => {
    if (value < low) low = value;
    if (value > high) high = value;
  };
  for (const keyframe of keyframes) push(keyframe.value);
  const segments = getSegments(curve);
  for (let i = 0; i < keyframes.length - 1; i++) {
    const spec = segments[i];
    const reaches =
      spec.type === "wave" ||
      spec.type === "easing" ||
      spec.type === "audio" ||
      isBezierSegment(keyframes[i], keyframes[i + 1], spec);
    if (!reaches) continue;
    for (const point of sampleSegment(keyframes[i], keyframes[i + 1], spec))
      push(point.value);
  }
  return { low, high };
};

// ---- Time-window clipboard operations ----
//
// A clip is a portion of a curve lifted out of time: keyframe times are
// relative to the clip's start. Cutting through the middle of a segment
// shortens it faithfully per type: waves keep their amplitude and phase
// and carry a proportional number of cycles (half of a three-cycle wave
// is one and a half cycles); flats stay flat; linears stay linear; curve
// bends and easings are re-fit as a Schlick curve matched at the cut
// window's midpoint (exact at the endpoints, approximate between).

export type AutomationClip = {
  duration: number;
  keyframes: AutomationKeyframe[];
  segments: SegmentSpec[];
};

// One clipboard for the whole editor, so a copied window can be pasted
// into a different lane.
export const automationClipboard: { clip: AutomationClip | null } = {
  clip: null,
};

const EPS = 1e-6;

// The spec for the restriction of a segment to the local interval
// [t0, t1] of its span.
export const sliceSpec = (
  a: AutomationKeyframe,
  b: AutomationKeyframe,
  spec: SegmentSpec,
  t0: number,
  t1: number,
): SegmentSpec => {
  if (t0 <= EPS && t1 >= 1 - EPS) return { ...spec };
  switch (spec.type) {
    case "flat":
      return { type: "flat" };
    case "linear":
      return { type: "linear" };
    // Audio reacts to the ABSOLUTE song time, so a slice needs no
    // adjustment: wherever it lands, it follows the audio there.
    case "audio":
      return { ...spec };
    case "wave":
      return {
        type: "wave",
        wave: spec.wave,
        amplitude: spec.amplitude,
        cycles: spec.cycles * (t1 - t0),
        phase: (((spec.phase + spec.cycles * t0) % 1) + 1) % 1,
      };
    case "curve":
    case "easing": {
      const start = evaluateSegment(a, b, spec, t0);
      const end = evaluateSegment(a, b, spec, t1);
      if (Math.abs(end - start) < 1e-9) return { type: "linear" };
      const mid = evaluateSegment(a, b, spec, (t0 + t1) / 2);
      const fraction = Math.min(
        Math.max((mid - start) / (end - start), 0.02),
        0.98,
      );
      let bend = (1 - fraction) / fraction;
      if (Math.abs(bend - 1) < 0.01) bend = 1;
      return { type: "curve", bend };
    }
  }
};

// Split the curve at time t: a keyframe appears exactly on the curve and
// the bisected segment becomes two sliced halves. No-op outside the
// keyframe span or on an existing keyframe.
export const insertBoundary = (
  curve: AutomationCurve,
  t: number,
): AutomationCurve => {
  const { keyframes } = curve;
  if (keyframes.length < 2) return curve;
  const segments = getSegments(curve);
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (t <= a.time + EPS || t >= b.time - EPS) continue;
    const localT = (t - a.time) / (b.time - a.time);
    // A wave's keyframes define its BASELINE; the oscillation rides on
    // top. The boundary keyframe therefore sits on the baseline, which
    // makes wave splitting exact: each half's baseline matches the
    // original and the offsets line up through the cycle/phase math.
    // Audio rides its baseline the same way (the envelope re-adds on
    // top, so a curve-value keyframe would double it). Other types
    // place the keyframe on the curve itself.
    const spec = segments[i];
    const value =
      spec.type === "wave" || spec.type === "audio"
        ? a.value + (b.value - a.value) * localT
        : evaluateSegment(a, b, spec, localT);
    const nextKeyframes = [...keyframes];
    nextKeyframes.splice(i + 1, 0, { time: t, value });
    const nextSegments = [...segments];
    nextSegments.splice(
      i,
      1,
      sliceSpec(a, b, segments[i], 0, localT),
      sliceSpec(a, b, segments[i], localT, 1),
    );
    return { ...curve, keyframes: nextKeyframes, segments: nextSegments };
  }
  return curve;
};

// The spec of the work curve's segment spanning exactly [tA, tB], or
// linear when that span lies in an extension (where the curve is
// horizontal anyway).
const specForSpan = (work: AutomationCurve, tA: number, tB: number) => {
  const { keyframes } = work;
  const segments = getSegments(work);
  for (let i = 0; i < keyframes.length - 1; i++)
    if (
      Math.abs(keyframes[i].time - tA) <= EPS * 2 &&
      Math.abs(keyframes[i + 1].time - tB) <= EPS * 2
    )
      return { ...segments[i] };
  return { type: "linear" } as SegmentSpec;
};

// Lift the window [w0, w1] out of the curve as a clip. Boundaries that
// bisect segments shorten them; the extensions beyond the outermost
// keyframes copy as the horizontal lines they are.
export const copyCurveWindow = (
  curve: AutomationCurve,
  w0: number,
  w1: number,
): AutomationClip | null => {
  if (curve.keyframes.length === 0 || w1 - w0 <= EPS) return null;
  const work = insertBoundary(insertBoundary(curve, w0), w1);
  // Boundary keyframes inserted above may sit on a wave's baseline
  // rather than the curve, so prefer the actual keyframe over a fresh
  // evaluation.
  const keyframeAt = (t: number) =>
    work.keyframes.find((keyframe) => Math.abs(keyframe.time - t) <= EPS * 2);
  const startValue = keyframeAt(w0)?.value ?? evaluateCurve(work, w0)!;
  const endValue = keyframeAt(w1)?.value ?? evaluateCurve(work, w1)!;
  const inner = work.keyframes.filter(
    (keyframe) => keyframe.time > w0 + EPS && keyframe.time < w1 - EPS,
  );
  const absolute = [
    { time: w0, value: startValue },
    ...inner,
    { time: w1, value: endValue },
  ];
  const segments: SegmentSpec[] = [];
  for (let i = 0; i < absolute.length - 1; i++)
    segments.push(specForSpan(work, absolute[i].time, absolute[i + 1].time));
  return {
    duration: w1 - w0,
    keyframes: absolute.map((keyframe) => ({
      time: keyframe.time - w0,
      value: keyframe.value,
    })),
    segments,
  };
};

// Remove the curve inside [w0, w1]: interior keyframes go away and the
// window becomes a straight bridge between its pinned edges. The curve
// outside the window is untouched. Deleting the whole keyframe span
// empties the curve.
export const deleteCurveWindow = (
  curve: AutomationCurve,
  w0: number,
  w1: number,
): AutomationCurve => {
  const { keyframes } = curve;
  if (keyframes.length === 0 || w1 - w0 <= EPS) return curve;
  const first = keyframes[0].time;
  const last = keyframes[keyframes.length - 1].time;
  if (w0 <= first + EPS && w1 >= last - EPS)
    return { ...curve, keyframes: [], segments: [] };
  if (w1 <= first + EPS || w0 >= last - EPS) return curve;
  const work = insertBoundary(insertBoundary(curve, w0), w1);
  const kept = work.keyframes.filter(
    (keyframe) => keyframe.time <= w0 + EPS || keyframe.time >= w1 - EPS,
  );
  const segments: SegmentSpec[] = [];
  for (let i = 0; i < kept.length - 1; i++) {
    const spansGap =
      kept[i].time <= w0 + EPS * 2 && kept[i + 1].time >= w1 - EPS * 2;
    segments.push(
      spansGap
        ? ({ type: "linear" } as SegmentSpec)
        : specForSpan(work, kept[i].time, kept[i + 1].time),
    );
  }
  return { ...curve, keyframes: kept, segments };
};

// Paste a clip with its start at time `at`, replacing whatever the curve
// held in [at, at + duration]. A clip running past the song's end is
// trimmed (through the same slicing, so a cut segment shortens).
export const pasteClipAt = (
  curve: AutomationCurve | null,
  clip: AutomationClip,
  at: number,
): AutomationCurve | null => {
  const duration = Math.min(clip.duration, 1 - at);
  if (duration <= EPS || clip.keyframes.length === 0) return curve;
  const trimmed =
    duration < clip.duration - EPS
      ? copyCurveWindow(
          { keyframes: clip.keyframes, segments: clip.segments },
          0,
          duration,
        )
      : clip;
  if (!trimmed) return curve;

  const base =
    curve && curve.keyframes.length > 0
      ? insertBoundary(insertBoundary(curve, at), at + duration)
      : {
          keyframes: [] as AutomationKeyframe[],
          segments: [] as SegmentSpec[],
        };
  const baseSegments = getSegments(base);
  // When the paste point bisects a segment (or lands on a keyframe), that
  // keyframe is KEPT, pinning the original value there so the curve to
  // the left stays exactly as it was; the paste stacks its first keyframe
  // at the exact same time (an instantaneous step, as stacked keyframes
  // are everywhere else), so the pasted content starts AT the paste point
  // with no gap. A pin whose value already matches the clip's start is
  // dropped: the junction is seamless and needs no step.
  const boundary = base.keyframes.find(
    (keyframe) => Math.abs(keyframe.time - at) <= EPS * 2,
  );
  const startPin =
    boundary && Math.abs(boundary.value - trimmed.keyframes[0].value) > 1e-9
      ? boundary
      : undefined;
  const left = [
    ...base.keyframes.filter((keyframe) => keyframe.time < at - EPS),
    ...(startPin ? [startPin] : []),
  ];
  const right = base.keyframes.filter(
    (keyframe) => keyframe.time > at + duration + EPS,
  );
  const pasted = trimmed.keyframes.map((keyframe) => ({
    time: Math.min(at + keyframe.time, 1),
    value: keyframe.value,
  }));

  const keyframes = [...left, ...pasted, ...right];
  const segments: SegmentSpec[] = [];
  // Segments between left keyframes are the base's own.
  for (let i = 0; i < left.length - 1; i++) segments.push(baseSegments[i]);
  // Junction into the paste: a flat step off the pinned keyframe when the
  // window edge cut a segment; otherwise the base segment that led toward
  // the window, or a straight line when pasting beyond the old span.
  if (left.length > 0)
    segments.push(
      startPin
        ? ({ type: "flat" } as SegmentSpec)
        : left.length - 1 < baseSegments.length
          ? baseSegments[left.length - 1]
          : ({ type: "linear" } as SegmentSpec),
    );
  segments.push(...trimmed.segments);
  // Junction out of the paste, then the base's remaining segments.
  if (right.length > 0) {
    const rightStart = base.keyframes.length - right.length;
    segments.push(
      rightStart - 1 >= 0 && rightStart - 1 < baseSegments.length
        ? baseSegments[rightStart - 1]
        : ({ type: "linear" } as SegmentSpec),
    );
    for (let i = rightStart; i < base.keyframes.length - 1; i++)
      segments.push(baseSegments[i]);
  }
  return { ...(curve ?? {}), keyframes, segments };
};

export const evaluateCurve = (
  curve: AutomationCurve,
  time: number,
): number | null => {
  const { keyframes } = curve;
  if (keyframes.length === 0) return null;
  if (time <= keyframes[0].time) return keyframes[0].value;
  const last = keyframes[keyframes.length - 1];
  if (time >= last.time) return last.value;
  const segments = getSegments(curve);
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    // At an exact keyframe time the LATER segment wins, so stacked
    // keyframes (a vertical jump) evaluate to the post-jump value at the
    // jump itself — the same convention as flat steps and payloadAtTime.
    if (time >= b.time && i < keyframes.length - 2) continue;
    const span = b.time - a.time;
    const t = span > 0 ? (time - a.time) / span : 1;
    return evaluateSegment(a, b, segments[i], t);
  }
  return last.value;
};
