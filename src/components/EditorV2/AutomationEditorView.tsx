import { useEffect, useRef, useState } from "react";
import styles from "@/styles/EditorV2.module.css";
import { PatternParam } from "@/src/params/shared/patternParam";
import {
  AutomationCurve,
  AutomationKeyframe,
  EasingName,
  SegmentSpec,
  SegmentType,
  WaveKind,
  automationClipboard,
  copyCurveWindow,
  curveExtremes,
  defaultSegment,
  deleteCurveWindow,
  evaluateCurve,
  getSegments,
  isCurveActive,
  payloadAtTime,
  pasteClipAt,
  sampleSegment,
} from "@/src/components/EditorV2/automation";
import { ScrubbableNumber } from "@/src/components/EditorV2/ScrubbableNumber";
import {
  ColorValueEditor,
  PaletteValueEditor,
  Rgba,
  paletteToGradientCss,
  rgbaToCss,
} from "@/src/components/EditorV2/ValueEditors";
import { isVector4 } from "@/src/utils/object";
import { isPalette } from "@/src/params/palette/Palette";
import {
  TIME_VIEWPORT_EVENT,
  timeViewport,
  transportTime,
} from "@/src/components/EditorV2/timeViewport";
import {
  computeTargetView,
  easeView,
  extremesOf,
  ViewRange,
} from "@/src/components/EditorV2/autoRange";
import { BpmAnalysis } from "@/src/components/EditorV2/bpm";
import { EDITOR_DIRTY_EVENT } from "@/src/components/EditorV2/experiencePersistence";

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// Ranges are power-of-two pairs, so ticks land on binary steps (0.5, 1,
// 2, 4, ...) that divide every range evenly.
const niceStep = (rough: number) => Math.pow(2, Math.ceil(Math.log2(rough)));

const formatTick = (value: number, step: number) => {
  // Binary steps: 0.5 needs one decimal, 0.25 and 0.125 need two.
  const decimals = step >= 1 ? 0 : step >= 0.5 ? 1 : step >= 0.125 ? 2 : 3;
  return (Object.is(value, -0) ? 0 : value).toFixed(decimals);
};

// The segment types offered in the right-click menu, mirroring the
// variation types of the main experience editor (spline and audio are not
// available as segment types yet).
const SEGMENT_TYPES: { type: SegmentType; label: string }[] = [
  { type: "curve", label: "Curve" },
  { type: "flat", label: "Flat" },
  { type: "linear", label: "Linear" },
  { type: "wave", label: "Wave" },
  { type: "easing", label: "Easing" },
];

const WAVE_KINDS: { kind: WaveKind; label: string }[] = [
  { kind: "sine", label: "Sine" },
  { kind: "square", label: "Square" },
  { kind: "triangle", label: "Triangle" },
];

const EASING_FAMILIES = [
  "Sine",
  "Quad",
  "Cubic",
  "Quart",
  "Quint",
  "Expo",
  "Circ",
  "Back",
  "Elastic",
  "Bounce",
] as const;
const EASING_MODES = ["In", "Out", "InOut"] as const;

const parseEasing = (easing: EasingName) => {
  const match = /^ease(InOut|In|Out)(.+)$/.exec(easing);
  return {
    mode: (match?.[1] ?? "InOut") as (typeof EASING_MODES)[number],
    family: (match?.[2] ?? "Sine") as (typeof EASING_FAMILIES)[number],
  };
};

type Props = {
  param: PatternParam;
  curve: AutomationCurve | null;
  beatGrid: (BpmAnalysis & { durationSeconds: number }) | null;
  // Detected onset times as fractions of the song, sorted ascending.
  transients: number[] | null;
  onCurveChange: (curve: AutomationCurve) => void;
  onClose: () => void;
};

// The expanded automation lane over the canopy space. Shows the underlying
// value line and the lane's automation curve. Double click adds a keyframe:
// the first is a constant; the outermost keyframes extend horizontally; in
// between, segments are straight lines that drag up or down into curves.
// Right click a segment to change its type (curve, flat, linear, wave,
// easing); a selected segment's parameters are edited in the inspector
// card. The scale on the right labels the value range; it manages itself.
export function AutomationEditorView({
  param,
  curve,
  beatGrid,
  transients,
  onCurveChange,
  onClose,
}: Props) {
  const keyframes = curve?.keyframes ?? [];
  const segments = curve ? getSegments(curve) : [];
  // A deactivated lane: the curve is drawn dimmed, a bright dashed line
  // marks the underlying value that is actually driving the parameter,
  // and any curve edit reactivates.
  const suspended = !!curve && keyframes.length > 0 && !isCurveActive(curve);

  // A switch (0 or 1 in single steps, the main app's boolean convention)
  // gets Ableton-style on/off automation: the scale reads On and Off,
  // every edit quantizes to the two states, and segments are always flat
  // steps. No curves, no bends, no inspector.
  const isBooleanLane = param.min === 0 && param.max === 1 && param.step === 1;

  // Color and palette lanes automate the whole value: keyframes divide
  // time into periods, each holding the color or palette of the keyframe
  // that starts it (like picking palettes in the main app). The lane has
  // no vertical meaning: no scale, no guides, no curve shapes; the strip
  // shows each period's color, and the inspector edits it.
  const laneKind: "number" | "color" | "palette" = isPalette(param.value)
    ? "palette"
    : isVector4(param.value)
      ? "color"
      : "number";
  const isValueLane = laneKind !== "number";

  const payloadCss = (payload: {
    color?: [number, number, number, number];
    palette?: NonNullable<AutomationCurve["leadIn"]>["palette"];
  }) =>
    payload.color
      ? rgbaToCss(payload.color)
      : payload.palette
        ? paletteToGradientCss(payload.palette)
        : "rgba(232, 236, 244, 0.4)";

  // Value-lane periods: region 0 runs from the view's start to the first
  // keyframe (its value is the curve's leadIn), region i (>= 1) from
  // keyframe i-1 onward. N keyframes make N+1 regions. With no
  // keyframes at all, one display-only region shows the current value.
  const valueRegions = () => {
    const regions: {
      index: number;
      from: number;
      to: number;
      css: string;
      selectable: boolean;
    }[] = [];
    const clampPct = (pct: number) => Math.min(Math.max(pct, 0), 100);
    if (keyframes.length === 0) {
      regions.push({
        index: 0,
        from: clampPct(Math.max(timeToX(0), 0)),
        to: 100,
        css: payloadCss(currentValuePayload()),
        selectable: false,
      });
      return regions;
    }
    const leadIn = curve?.leadIn ?? {
      color: keyframes[0].color,
      palette: keyframes[0].palette,
    };
    const boundaries = [
      clampPct(Math.max(timeToX(0), 0)),
      ...keyframes.map((keyframe) => clampPct(timeToX(keyframe.time))),
      100,
    ];
    const payloads = [leadIn, ...keyframes];
    for (let i = 0; i < payloads.length; i++) {
      const from = boundaries[i];
      const to = boundaries[i + 1];
      if (to - from < 0.5) continue;
      regions.push({
        index: i,
        from,
        to,
        css: payloadCss(payloads[i]),
        selectable: true,
      });
    }
    return regions;
  };

  const currentValuePayload = (): Partial<AutomationKeyframe> => {
    const value = param.value;
    if (isVector4(value))
      return { color: [value.x, value.y, value.z, value.w] as Rgba };
    if (isPalette(value)) return { palette: value.serialize() };
    return {};
  };

  // A parameter that declares both bounds pins the view to exactly that
  // range; the self-managing zero-centered range only applies to
  // unbounded parameters. Bounded lanes also clamp edits into range.
  const paramBounds =
    typeof param.min === "number" &&
    typeof param.max === "number" &&
    param.max > param.min
      ? { min: param.min, max: param.max }
      : null;
  // The declared range sits at 10%..90% of the view, so the bounds are
  // never flush against the editor's edges.
  const boundedView: ViewRange | null = paramBounds
    ? {
        center: (paramBounds.min + paramBounds.max) / 2,
        span: (paramBounds.max - paramBounds.min) / 0.8,
      }
    : null;
  const clampToBounds = (value: number) =>
    paramBounds ? clamp(value, paramBounds.min, paramBounds.max) : value;

  // Commits build on this ref, updated eagerly, so rapid successive edits
  // (before React re-renders with the new prop) never overwrite each other.
  const curveRef = useRef(curve);
  curveRef.current = curve;

  // The underlying value only drives the view when there is no automation;
  // with keyframes present, the curve IS the value and the underlying
  // param value is not shown separately. The range fits the curve's real
  // extremes (wave peaks, easing overshoots), not just its keyframes
  // (curveExtremes memoizes per curve object). A deactivated lane also
  // keeps the underlying value in range, since that line is what drives
  // the parameter.
  const currentExtremes = () => {
    const current = curveRef.current;
    if (!current || current.keyframes.length === 0)
      return typeof param.value === "number" ? extremesOf([param.value]) : null;
    const extremes = curveExtremes(current);
    if (!isCurveActive(current) && typeof param.value === "number" && extremes)
      return {
        low: Math.min(extremes.low, param.value),
        high: Math.max(extremes.high, param.value),
      };
    return extremes;
  };

  // The range is FROZEN during drags (it refits, growing or shrinking,
  // only on release), and dragged values only change on actual pointer
  // movement (incremental deltas), so the view can never remap a
  // stationary cursor into a new value. The active drag's cleanup lives on
  // a ref so a lost pointerup (window blur, unmount mid-drag) never leaks
  // listeners or strands the dragging flag.
  const isDraggingRef = useRef(false);
  const activeDragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => activeDragCleanup.current?.(), []);
  // The last target, for grow/shrink thresholds and hysteresis.
  const lastTarget = useRef<ViewRange | null>(null);

  const [view, setView] = useState(() => {
    const target =
      boundedView ?? computeTargetView(currentExtremes(), null, false);
    lastTarget.current = target;
    return target;
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const lineRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);

  // Segment interaction state: the selected segment (highlighted, edited
  // in the inspector) and the right-click menu. The menu opens on a
  // segment (index set: segment types plus snap options) or on empty
  // space (index null: snap options only).
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null);
  const [segmentMenu, setSegmentMenu] = useState<{
    index: number | null;
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Snap mode for time edits: keyframe drags and creation, the edit
  // cursor, and time-selection edges all land on the chosen targets.
  const [snapMode, setSnapMode] = useState<"off" | "grid" | "transients">(
    "off",
  );
  // Nearest snap target to a time (song fraction); identity when off or
  // when the mode's targets are unavailable.
  const snapTime = (time: number): number => {
    if (snapMode === "grid") {
      if (!beatGrid || !beatGrid.durationSeconds) return time;
      const beat = 60 / beatGrid.bpm / beatGrid.durationSeconds;
      const offset = beatGrid.offsetSeconds / beatGrid.durationSeconds;
      const k = Math.max(0, Math.round((time - offset) / beat));
      return Math.min(1, Math.max(0, offset + k * beat));
    }
    if (snapMode === "transients") {
      if (!transients || transients.length === 0) return time;
      // Binary search for the nearest onset (transients are fractions,
      // sorted).
      let lo = 0;
      let hi = transients.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (transients[mid] < time) lo = mid + 1;
        else hi = mid;
      }
      const after = transients[lo];
      const before = transients[lo - 1];
      const nearest =
        before !== undefined && time - before < after - time ? before : after;
      return Math.min(1, Math.max(0, nearest));
    }
    return time;
  };

  // A highlighted window of time, made by dragging horizontally across
  // empty space. Copy lifts the curve inside it to the clipboard; Delete
  // flattens the window to a straight bridge. A plain click instead
  // places the cursor: a marked position in time where Paste lands (the
  // transport's gold playhead is untouched by clicks here).
  const [timeSelection, setTimeSelection] = useState<{
    t0: number;
    t1: number;
  } | null>(null);
  const [editCursor, setEditCursor] = useState<number | null>(null);
  // Bumped after copy so the Paste control appears without a re-render
  // from elsewhere.
  const [, setClipVersion] = useState(0);

  // Clamp the selection when segments disappear (keyframe removed, lane
  // switched).
  useEffect(() => {
    const selectableCount = isValueLane
      ? keyframes.length + 1
      : segments.length;
    if (selectedSegment !== null && selectedSegment >= selectableCount)
      setSelectedSegment(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSegment, segments.length, keyframes.length, isValueLane]);

  // Escape peels layers inside the editor before the editor itself closes:
  // first the type menu, then the segment selection, then the time
  // selection. Capture phase, so the page-level close handler (bubble)
  // never sees the consumed press.
  useEffect(() => {
    if (!segmentMenu && selectedSegment === null && !timeSelection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      if (segmentMenu) setSegmentMenu(null);
      else if (selectedSegment !== null) setSelectedSegment(null);
      else setTimeSelection(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [segmentMenu, selectedSegment, timeSelection]);

  // The menu closes on any press outside it.
  useEffect(() => {
    if (!segmentMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setSegmentMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [segmentMenu]);

  // Persistent loop: each frame, recompute the target range from the curve
  // (or the live underlying value) and ease the view toward it. Frozen
  // while dragging; renders only happen while the view is moving.
  useEffect(() => {
    let frame: number;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const target =
        boundedView ??
        computeTargetView(
          currentExtremes(),
          lastTarget.current,
          isDraggingRef.current,
        );
      lastTarget.current = target;
      const { next, settled } = easeView(viewRef.current, target);
      if (settled) {
        if (
          viewRef.current.center !== target.center ||
          viewRef.current.span !== target.span
        )
          setView(next);
        return;
      }
      setView(next);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param]);

  // The visible time window follows the timeline's minimap viewport.
  const [timeView, setTimeView] = useState({
    left: timeViewport.left,
    width: timeViewport.width,
  });
  useEffect(() => {
    const onViewport = () =>
      setTimeView({ left: timeViewport.left, width: timeViewport.width });
    window.addEventListener(TIME_VIEWPORT_EVENT, onViewport);
    return () => window.removeEventListener(TIME_VIEWPORT_EVENT, onViewport);
  }, []);
  // The drawing area spans the full editor width, but the visible time
  // window maps onto the region right of the lanes' label column, so a
  // given time lines up vertically with the timeline and lanes below.
  // The leftmost 120px show time from before the window (before the song
  // itself when fully zoomed out). The width is state, refreshed on mount
  // and resize, because the ref has no size on the first render.
  const [areaWidth, setAreaWidth] = useState(1280);
  useEffect(() => {
    const update = () => setAreaWidth(areaRef.current?.clientWidth ?? 1280);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const labelPct = (120 / areaWidth) * 100;
  const timeToX = (timeFrac: number) =>
    labelPct + ((timeFrac - timeView.left) / timeView.width) * (100 - labelPct);
  const xFracToTime = (frac: number) =>
    clamp(
      timeView.left +
        ((frac * 100 - labelPct) / (100 - labelPct)) * timeView.width,
      0,
      1,
    );

  const viewMax = view.center + view.span / 2;
  const valueToTopPct = (value: number) =>
    ((viewMax - value) / view.span) * 100;
  const clientYToValue = (clientY: number) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return (
      viewMax - ((clientY - rect.top) / rect.height) * viewRef.current.span
    );
  };

  // A gold dot the size of a keyframe rides the curve at the transport's
  // current time, with the current value printed just above and to the
  // right. Position is written imperatively each frame: the transport
  // time lives outside React, and the dot follows the curve, the value
  // range, and the time window all at once.
  const timeDotRef = useRef<HTMLDivElement>(null);
  const timeDotLabelRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame: number;
    const update = () => {
      frame = requestAnimationFrame(update);
      const dot = timeDotRef.current;
      const label = timeDotLabelRef.current;
      const playhead = playheadRef.current;
      if (!dot || !label) return;
      const { seconds, durationSeconds } = transportTime;
      const areaWidth = areaRef.current?.clientWidth ?? 1280;
      const lp = (120 / areaWidth) * 100;
      const frac = durationSeconds ? clamp(seconds / durationSeconds, 0, 1) : 0;
      const x =
        lp + ((frac - timeViewport.left) / timeViewport.width) * (100 - lp);
      // The gold playhead line: only needs a time, not a value.
      if (playhead) {
        playhead.style.opacity =
          !durationSeconds || x < 0 || x > 100 ? "0" : "1";
        playhead.style.left = `${x}%`;
      }
      const current = curveRef.current;
      // A deactivated curve is not driving the parameter: the dot follows
      // the underlying value instead.
      const value = isValueLane
        ? null
        : current && current.keyframes.length > 0 && isCurveActive(current)
          ? evaluateCurve(
              current,
              clamp(seconds / (durationSeconds || 1), 0, 1),
            )
          : typeof param.value === "number"
            ? param.value
            : null;
      if (!durationSeconds || value === null) {
        dot.style.opacity = "0";
        label.style.opacity = "0";
        return;
      }
      const { center, span } = viewRef.current;
      const top = ((center + span / 2 - value) / span) * 100;
      const opacity = x < -1 || x > 101 || top < -2 || top > 102 ? "0" : "1";
      dot.style.opacity = opacity;
      dot.style.left = `${x}%`;
      dot.style.top = `${top}%`;
      label.style.opacity = opacity;
      label.style.left = `${x}%`;
      label.style.top = `${top}%`;
      const text = isBooleanLane
        ? value >= 0.5
          ? "On"
          : "Off"
        : String(parseFloat(value.toFixed(3)));
      if (label.textContent !== text) label.textContent = text;
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [param]);

  // The underlying value line tracks param.value (mutated outside React by
  // scrubs) through the current view range.
  useEffect(() => {
    let frame: number;
    const update = () => {
      const { value } = param;
      if (typeof value === "number" && lineRef.current) {
        const { center, span } = viewRef.current;
        const top = ((center + span / 2 - value) / span) * 100;
        lineRef.current.style.top = `${clamp(top, -2, 102)}%`;
        lineRef.current.style.opacity = top < -1 || top > 101 ? "0" : "1";
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [param]);

  // Boolean lanes quantize every edit at the single commit chokepoint:
  // keyframes snap to 0 or 1 and every segment becomes a flat step, no
  // matter how the change arrived (add, drag, paste, delete).
  const quantizeBooleanCurve = (next: AutomationCurve): AutomationCurve => ({
    ...next,
    keyframes: next.keyframes.map((keyframe) => ({
      ...keyframe,
      value: keyframe.value >= 0.5 ? 1 : 0,
    })),
    segments: getSegments(next).map(() => ({ type: "flat" }) as SegmentSpec),
  });

  const commitCurve = (next: AutomationCurve) => {
    // Any edit to the curve reactivates a deactivated lane.
    const revived = {
      ...(isBooleanLane ? quantizeBooleanCurve(next) : next),
      active: true,
    };
    curveRef.current = revived;
    onCurveChange(revived);
    window.dispatchEvent(new Event(EDITOR_DIRTY_EVENT));
  };

  const currentSegments = () => {
    const current = curveRef.current;
    return current ? getSegments(current) : [];
  };

  const updateSegment = (index: number, patch: Partial<SegmentSpec>) => {
    const current = curveRef.current;
    if (!current) return;
    const nextSegments = [...currentSegments()];
    nextSegments[index] = { ...nextSegments[index], ...patch } as SegmentSpec;
    commitCurve({ ...current, segments: nextSegments });
  };

  const setSegmentType = (index: number, type: SegmentType) => {
    const current = curveRef.current;
    if (!current) return;
    const nextSegments = [...currentSegments()];
    if (nextSegments[index]?.type === type) return;
    const a = current.keyframes[index];
    const b = current.keyframes[index + 1];
    if (!a || !b) return;
    nextSegments[index] = defaultSegment(type, a, b);
    commitCurve({ ...current, segments: nextSegments });
  };

  const addKeyframe = (time: number, value: number) => {
    const current = curveRef.current;
    const currentKeyframes = current?.keyframes ?? [];
    const existingSegments = current ? getSegments(current) : [];
    const index = currentKeyframes.findIndex(
      (keyframe) => keyframe.time > time,
    );
    const insertAt = index === -1 ? currentKeyframes.length : index;
    const nextKeyframes = [...currentKeyframes];
    // Value lanes: the new keyframe starts a period holding whatever the
    // lane held at that time (or the parameter's current value on an
    // empty lane), ready to be recolored in the inspector.
    const payload = isValueLane
      ? current && currentKeyframes.length > 0
        ? (payloadAtTime(current, time) ?? {})
        : currentValuePayload()
      : {};
    nextKeyframes.splice(insertAt, 0, { time, value, ...payload });
    // The very first keyframe on a value lane also pins the lead-in
    // period (the region before it) to the current value.
    const leadIn =
      isValueLane && currentKeyframes.length === 0
        ? currentValuePayload()
        : undefined;

    let nextSegments: SegmentSpec[];
    const linear: SegmentSpec = { type: "curve", bend: 1 };
    if (currentKeyframes.length === 0) nextSegments = [];
    else if (insertAt === 0) nextSegments = [linear, ...existingSegments];
    else if (insertAt === currentKeyframes.length)
      nextSegments = [...existingSegments, linear];
    else {
      // Splitting a segment: both halves inherit the split segment's type
      // and parameters.
      nextSegments = [...existingSegments];
      const split = existingSegments[insertAt - 1] ?? linear;
      nextSegments.splice(insertAt - 1, 1, { ...split }, { ...split });
    }
    commitCurve({
      ...(current ?? {}),
      ...(leadIn ? { leadIn } : {}),
      keyframes: nextKeyframes,
      segments: nextSegments,
    });
  };

  const onAreaDoubleClick = (event: React.MouseEvent) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const time = snapTime(
      xFracToTime((event.clientX - rect.left) / rect.width),
    );
    addKeyframe(time, clampToBounds(clientYToValue(event.clientY)));
  };

  // The mirror of adding: double click a keyframe to delete it. The two
  // segments around an interior keyframe merge into one, keeping the
  // left segment's shape.
  const deleteKeyframe = (index: number) => {
    const current = curveRef.current;
    if (!current) return;
    const existingSegments = getSegments(current);
    const nextKeyframes = current.keyframes.filter((_, i) => i !== index);
    const nextSegments = [...existingSegments];
    if (index === 0) nextSegments.shift();
    else if (index === current.keyframes.length - 1) nextSegments.pop();
    else nextSegments.splice(index - 1, 2, { ...existingSegments[index - 1] });
    commitCurve({
      ...current,
      keyframes: nextKeyframes,
      segments: nextSegments,
    });
  };

  // Dragging a curve segment bends it toward the cursor: the bend is
  // solved so the curve's midpoint passes at the cursor's fraction between
  // the two endpoint values. Other segment types just select on press.
  const onSegmentPointerDown =
    (segmentIndex: number) => (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedSegment(segmentIndex);
      setSegmentMenu(null);

      const a = keyframes[segmentIndex];
      const b = keyframes[segmentIndex + 1];
      const spec = segments[segmentIndex];
      if (
        !a ||
        !b ||
        spec?.type !== "curve" ||
        Math.abs(b.value - a.value) < 1e-9
      )
        return;

      const onMove = (moveEvent: PointerEvent) => {
        const cursorValue = clientYToValue(moveEvent.clientY);
        const fraction = clamp(
          (cursorValue - a.value) / (b.value - a.value),
          0.02,
          0.98,
        );
        // Schlick bend whose midpoint passes exactly at the cursor's
        // fraction: shaped(0.5) = 1 / (1 + bend) = fraction.
        let bend = (1 - fraction) / fraction;
        if (Math.abs(bend - 1) < 0.06) bend = 1;
        updateSegment(segmentIndex, { bend });
      };
      const onUp = () => {
        isDraggingRef.current = false;
        activeDragCleanup.current = null;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        window.removeEventListener("blur", onUp);
      };
      activeDragCleanup.current = onUp;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
      window.addEventListener("blur", onUp);
    };

  const onSegmentContextMenu =
    (segmentIndex: number) => (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setSelectedSegment(segmentIndex);
      setSegmentMenu({
        index: segmentIndex,
        x: event.clientX,
        y: event.clientY,
      });
    };

  // Drag the underlying value line up or down, unbounded. The pointer's
  // delta maps through the CURRENT span, so a wide range moves the value
  // a lot per pixel and a tight range moves it a little. The range is
  // frozen while dragging and refits around the new value on release
  // (the underlying value drives the range only while it is the active
  // driver: no keyframes, or a deactivated curve).
  const onUnderlyingPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || typeof param.value !== "number") return;
    event.preventDefault();
    event.stopPropagation();
    isDraggingRef.current = true;
    let lastClientY = event.clientY;
    // Accumulate the raw drag separately so boolean quantization cannot
    // trap the value at one state.
    let raw = typeof param.value === "number" ? param.value : 0;
    const onMove = (moveEvent: PointerEvent) => {
      const rect = areaRef.current?.getBoundingClientRect();
      if (!rect || typeof param.value !== "number") return;
      const delta =
        ((lastClientY - moveEvent.clientY) / rect.height) *
        viewRef.current.span;
      lastClientY = moveEvent.clientY;
      raw = clampToBounds(raw + delta);
      param.value = isBooleanLane ? (raw >= 0.5 ? 1 : 0) : raw;
      window.dispatchEvent(new Event(EDITOR_DIRTY_EVENT));
    };
    const onUp = () => {
      isDraggingRef.current = false;
      activeDragCleanup.current = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
    };
    activeDragCleanup.current = onUp;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  };

  // ---- Time selection, playhead, and the clipboard ----

  // A keyframe's payload (its period's color or palette), edited from
  // the inspector.
  const updateKeyframePayload = (
    index: number,
    patch: Partial<AutomationKeyframe>,
  ) => {
    const current = curveRef.current;
    if (!current) return;
    commitCurve({
      ...current,
      keyframes: current.keyframes.map((keyframe, i) =>
        i === index ? { ...keyframe, ...patch } : keyframe,
      ),
    });
  };

  const doCopy = () => {
    const current = curveRef.current;
    if (isValueLane) return;
    if (!timeSelection || !current || current.keyframes.length === 0) return;
    automationClipboard.clip = copyCurveWindow(
      current,
      timeSelection.t0,
      timeSelection.t1,
    );
    setClipVersion((version) => version + 1);
  };

  const doDelete = () => {
    const current = curveRef.current;
    if (isValueLane) return;
    if (!timeSelection || !current || current.keyframes.length === 0) return;
    commitCurve(deleteCurveWindow(current, timeSelection.t0, timeSelection.t1));
    setTimeSelection(null);
  };

  const doPaste = () => {
    if (isValueLane) return;
    const clip = automationClipboard.clip;
    if (!clip || editCursor === null) return;
    const next = pasteClipAt(curveRef.current, clip, editCursor);
    if (next && next !== curveRef.current) commitCurve(next);
  };

  // Dragging horizontally across empty space selects a window of time; a
  // plain click sets the playhead there instead (and drops any
  // selection).
  const onAreaPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    setSelectedSegment(null);
    setSegmentMenu(null);
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startClientX = event.clientX;
    const startTime = snapTime(
      xFracToTime((startClientX - rect.left) / rect.width),
    );
    let dragging = false;
    const onMove = (moveEvent: PointerEvent) => {
      // Value lanes have no window operations; clicks still place the
      // cursor but drags select nothing.
      if (isValueLane) return;
      if (!dragging && Math.abs(moveEvent.clientX - startClientX) < 4) return;
      // Highlighting dismisses the cursor; the next plain click places
      // a fresh one.
      if (!dragging) setEditCursor(null);
      dragging = true;
      const time = snapTime(
        xFracToTime((moveEvent.clientX - rect.left) / rect.width),
      );
      setTimeSelection({
        t0: Math.min(startTime, time),
        t1: Math.max(startTime, time),
      });
    };
    const onUp = () => {
      activeDragCleanup.current = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      if (!dragging) {
        setTimeSelection(null);
        setEditCursor(startTime);
      }
    };
    activeDragCleanup.current = onUp;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  };

  // Standard clipboard keys; typed inputs keep their native behavior.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const withMeta = event.metaKey || event.ctrlKey;
      if (withMeta && event.key === "c") doCopy();
      else if (withMeta && event.key === "v") doPaste();
      else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        timeSelection
      ) {
        event.preventDefault();
        doDelete();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Drag a keyframe to move it in time (bounded by its neighbors) and
  // value.
  const onKeyframePointerDown =
    (index: number) => (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      isDraggingRef.current = true;
      let lastClientY = event.clientY;
      // The raw value accumulates separately from the committed one, so
      // clamping and boolean quantization cannot trap the drag (a
      // committed 1 would otherwise re-seed every move).
      let rawValue = curveRef.current?.keyframes[index]?.value ?? 0;
      const onMove = (moveEvent: PointerEvent) => {
        const rect = areaRef.current?.getBoundingClientRect();
        const current = curveRef.current;
        if (!rect || !current) return;
        // Value moves by the pointer's DELTA through the current span, so
        // the auto-ranging view animating underneath never moves the
        // keyframe on its own.
        const deltaValue =
          ((lastClientY - moveEvent.clientY) / rect.height) *
          viewRef.current.span;
        lastClientY = moveEvent.clientY;
        rawValue = clampToBounds(rawValue + deltaValue);
        const nextKeyframes = [...current.keyframes];
        // Neighbors bound the drag inclusively: keyframes may stack at the
        // exact same time (a vertical step, as in Ableton), and the first
        // and last can reach 0 and 1 exactly. Zero-duration segments are
        // safe throughout (evaluateCurve guards the division; sampling
        // just draws the vertical).
        const minTime = nextKeyframes[index - 1]?.time ?? 0;
        const maxTime = nextKeyframes[index + 1]?.time ?? 1;
        nextKeyframes[index] = {
          ...nextKeyframes[index],
          // Snap first, then bound by the neighbors (a snap target
          // beyond a neighbor pins at the neighbor).
          time: clamp(
            snapTime(xFracToTime((moveEvent.clientX - rect.left) / rect.width)),
            minTime,
            Math.max(maxTime, minTime),
          ),
          // Value lanes drag in time only; there is no vertical meaning.
          value: isValueLane ? nextKeyframes[index].value : rawValue,
        };
        commitCurve({
          ...current,
          keyframes: nextKeyframes,
          segments: getSegments(current),
        });
      };
      const onUp = () => {
        isDraggingRef.current = false;
        activeDragCleanup.current = null;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        window.removeEventListener("blur", onUp);
      };
      activeDragCleanup.current = onUp;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
      window.addEventListener("blur", onUp);
    };

  // Path building in a 0..100 x 0..100 viewBox stretched to the area.
  const segmentPathFrom = (segmentIndex: number) => {
    const a = keyframes[segmentIndex];
    const b = keyframes[segmentIndex + 1];
    return sampleSegment(a, b, segments[segmentIndex])
      .map(
        (point) =>
          `L ${timeToX(a.time + (b.time - a.time) * point.t)} ${valueToTopPct(
            point.value,
          )}`,
      )
      .join(" ");
  };

  const buildFullPath = () => {
    if (keyframes.length === 0) return "";
    const first = keyframes[0];
    const last = keyframes[keyframes.length - 1];
    // The curve exists only from the song's start: the left extension
    // begins at the start line, not the view edge.
    const parts = [`M ${timeToX(0)} ${valueToTopPct(first.value)}`];
    for (let i = 0; i < keyframes.length - 1; i++) {
      // Route through the starting keyframe explicitly: a segment whose
      // shape does not end on its endpoint (a wave with fractional
      // cycles or a phase, a flat hold) steps back to the keyframe
      // instead of handing its stray endpoint to the next segment.
      parts.push(
        `L ${timeToX(keyframes[i].time)} ${valueToTopPct(keyframes[i].value)}`,
      );
      parts.push(segmentPathFrom(i));
    }
    parts.push(
      `L ${timeToX(last.time)} ${valueToTopPct(last.value)}`,
      `L 100 ${valueToTopPct(last.value)}`,
    );
    return parts.join(" ");
  };

  // Scale ticks at nice values across the view range. A bounded lane only
  // labels values inside its declared range; the 10% margins around it
  // stay unlabeled.
  const viewMin = view.center - view.span / 2;
  const step = niceStep(view.span / 6);
  const tickMin = paramBounds ? Math.max(viewMin, paramBounds.min) : viewMin;
  const tickMax = paramBounds ? Math.min(viewMax, paramBounds.max) : viewMax;
  const ticks: number[] = [];
  for (
    let tick = Math.ceil(tickMin / step - 1e-9) * step;
    tick <= tickMax + 1e-9 && ticks.length < 40;
    tick += step
  )
    ticks.push(tick);

  const selectedSpec =
    selectedSegment !== null ? segments[selectedSegment] : null;

  // Adapter params so the inspector's numbers reuse the pattern editor's
  // scrubbable number fields, writing straight into the segment.
  const segmentNumberParam = (
    name: string,
    key: "bend" | "amplitude" | "cycles" | "phase",
    min?: number,
    max?: number,
  ) => {
    const index = selectedSegment!;
    return {
      name,
      min,
      max,
      get value() {
        const spec = currentSegments()[index] as
          | Record<string, unknown>
          | undefined;
        const value = spec?.[key];
        return typeof value === "number" ? value : 0;
      },
      set value(next: number) {
        updateSegment(index, { [key]: next } as Partial<SegmentSpec>);
      },
    } as PatternParam<number>;
  };

  return (
    <div className={styles.automationEditor} data-doc="automation-editor">
      <div
        ref={areaRef}
        className={styles.editorLineArea}
        onDoubleClick={onAreaDoubleClick}
        onPointerDown={onAreaPointerDown}
        onContextMenu={(event) => {
          // Right-clicking empty space opens the snap menu; segments
          // intercept their own context menu (types plus snap).
          event.preventDefault();
          setSegmentMenu({ index: null, x: event.clientX, y: event.clientY });
        }}
      >
        {(() => {
          // Dashed horizontal guides at value multiples of the magnitude
          // step (an eighth of the settled radius: 0.125 in the -1..1
          // view, 0.25 in -2..2, ...). They are pinned to VALUES, so
          // while the range animates they travel with the scale numbers;
          // like the beat grid, the step escalates (by twos) whenever
          // lines would crowd together. The view edges get no line. A
          // boolean lane has only two states, so no guides at all, and a
          // value lane has no vertical meaning at all.
          if (isBooleanLane || isValueLane) return null;
          const areaHeight = areaRef.current?.clientHeight ?? 400;
          let step = Math.pow(
            2,
            Math.floor(Math.log2((view.span / 2) * (1 + 1e-9))) - 3,
          );
          while ((areaHeight * step) / view.span < 14) step *= 2;
          const lines: JSX.Element[] = [];
          for (
            let k = Math.ceil(-viewMax / step);
            k * step <= viewMax && lines.length < 60;
            k++
          ) {
            const value = k * step;
            // Bounded lanes only guide inside the declared range; the
            // margin around it stays clean.
            if (
              paramBounds &&
              (value < paramBounds.min - 1e-9 || value > paramBounds.max + 1e-9)
            )
              continue;
            const top = valueToTopPct(value);
            if (top <= 0.5 || top >= 99.5) continue;
            lines.push(
              <div
                key={k}
                className={styles.magnitudeLine}
                style={{ top: `${top}%` }}
              />,
            );
          }
          return lines;
        })()}
        {beatGrid &&
          (() => {
            const beatDuration = 60 / beatGrid.bpm;
            const total = beatGrid.durationSeconds;
            if (!total) return null;
            const areaWidth =
              areaRef.current?.clientWidth ??
              (typeof window === "undefined" ? 1200 : window.innerWidth - 72);
            // Density adapts to the visible window (which follows the
            // minimap): the stride escalates by fours (beat, bar, four
            // bars, ...) until lines are comfortably spaced.
            const beatFracOfView = beatDuration / total / timeView.width;
            let stride = 1;
            while (areaWidth * beatFracOfView * stride < 9 && stride < 4096)
              stride *= 4;
            // The grid covers the full drawing area, including the strip
            // left of the visible window (which shows earlier song time
            // when zoomed in), stopping only at the song's start.
            const timeAtLeftEdge =
              timeView.left - (labelPct / (100 - labelPct)) * timeView.width;
            const viewStartSeconds = Math.max(0, timeAtLeftEdge) * total;
            const viewEndSeconds = (timeView.left + timeView.width) * total;
            const firstK =
              Math.max(
                0,
                Math.floor(
                  (viewStartSeconds - beatGrid.offsetSeconds) /
                    (beatDuration * stride),
                ),
              ) * stride;
            const lines: JSX.Element[] = [];
            for (
              let k = firstK, t = beatGrid.offsetSeconds + k * beatDuration;
              t <= viewEndSeconds && t <= total;
              k += stride, t = beatGrid.offsetSeconds + k * beatDuration
            ) {
              const isMajor = (k / stride) % 4 === 0;
              const x = timeToX(t / total);
              lines.push(
                <line
                  key={k}
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={100}
                  className={isMajor ? styles.gridBar : styles.gridBeat}
                />,
              );
            }
            return (
              <svg
                className={styles.gridSvg}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                {lines}
              </svg>
            );
          })()}
        {/* The song's start: the curve begins at this line. */}
        <div
          className={styles.songStartLine}
          style={{ left: `${timeToX(0)}%` }}
        />

        {timeSelection && (
          <div
            className={styles.timeSelection}
            data-doc="time-selection"
            style={{
              left: `${timeToX(timeSelection.t0)}%`,
              width: `${Math.max(
                timeToX(timeSelection.t1) - timeToX(timeSelection.t0),
                0,
              )}%`,
            }}
          />
        )}

        {/* The transport's position: a gold playhead line. */}
        <div
          ref={playheadRef}
          className={styles.editorPlayhead}
          data-doc="editor-playhead"
        />

        {/* The cursor: a clicked position in time, where Paste lands. */}
        {editCursor !== null && (
          <div
            className={styles.editCursor}
            data-doc="edit-cursor"
            style={{ left: `${timeToX(editCursor)}%` }}
          />
        )}
        {isValueLane && (
          <>
            {/* A neutral straight line: value lanes have no vertical
                meaning. */}
            <div className={styles.valueBaseline} />
            {valueRegions().map((region) => (
              <button
                key={region.index}
                className={`${styles.valueSwatch} ${
                  suspended ? styles.valueSwatchDimmed : ""
                } ${
                  selectedSegment === region.index
                    ? styles.valueSwatchSelected
                    : ""
                }`}
                data-doc="value-swatch"
                style={{
                  left: `${(region.from + region.to) / 2}%`,
                  background: region.css,
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  if (region.selectable) {
                    setSelectedSegment(region.index);
                    setSegmentMenu(null);
                  }
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              />
            ))}
          </>
        )}

        {!isValueLane && (keyframes.length === 0 || suspended) && (
          <div
            ref={lineRef}
            className={styles.valueLineHandle}
            style={{ left: `${Math.max(timeToX(0), 0)}%` }}
            onPointerDown={onUnderlyingPointerDown}
          >
            <div
              className={`${styles.laneValueLine} ${
                suspended ? styles.laneValueLineDashed : ""
              }`}
            />
          </div>
        )}

        {keyframes.length > 0 && !isValueLane && (
          <svg
            className={`${styles.curveSvg} ${
              suspended ? styles.curveDimmed : ""
            }`}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <path className={styles.curvePath} d={buildFullPath()} />
            {selectedSegment !== null && keyframes[selectedSegment + 1] && (
              <path
                className={styles.segmentHighlight}
                d={`M ${timeToX(keyframes[selectedSegment].time)} ${valueToTopPct(
                  keyframes[selectedSegment].value,
                )} ${segmentPathFrom(selectedSegment)}`}
              />
            )}
            {/* Boolean lanes have nothing to select or retype: steps
                only, so no segment hit strokes. */}
            {!isBooleanLane &&
              keyframes
                .slice(0, -1)
                .map((keyframe, index) => (
                  <path
                    key={`${keyframe.time}-${index}`}
                    className={styles.curveHit}
                    d={`M ${timeToX(keyframe.time)} ${valueToTopPct(keyframe.value)} ${segmentPathFrom(index)}`}
                    onPointerDown={onSegmentPointerDown(index)}
                    onContextMenu={onSegmentContextMenu(index)}
                  />
                ))}
          </svg>
        )}

        <div ref={timeDotRef} className={styles.timeDot} data-doc="time-dot" />
        <div ref={timeDotLabelRef} className={styles.timeDotLabel} />

        {keyframes.map((keyframe, index) => (
          <div
            key={index}
            className={`${styles.keyframeDot} ${
              suspended ? styles.keyframeDotDimmed : ""
            }`}
            style={{
              left: `${timeToX(keyframe.time)}%`,
              top: isValueLane ? "50%" : `${valueToTopPct(keyframe.value)}%`,
            }}
            onPointerDown={onKeyframePointerDown(index)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              deleteKeyframe(index);
            }}
          />
        ))}

        {timeSelection && (
          <div
            className={styles.selectionActions}
            style={{
              left: `${
                (timeToX(timeSelection.t0) + timeToX(timeSelection.t1)) / 2
              }%`,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <button className={styles.selectionAction} onClick={doCopy}>
              Copy
            </button>
            <button className={styles.selectionAction} onClick={doDelete}>
              Delete
            </button>
          </div>
        )}
      </div>

      {!isValueLane && (
        <div className={styles.valueScale} data-doc="automation-scale">
          {isBooleanLane
            ? [
                { value: 1, label: "On" },
                { value: 0, label: "Off" },
              ].map((state) => (
                <div
                  key={state.label}
                  className={styles.valueTick}
                  style={{ top: `${valueToTopPct(state.value)}%` }}
                >
                  <span className={styles.valueTickLabel}>{state.label}</span>
                  <span className={styles.valueTickMark} />
                </div>
              ))
            : ticks.map((tick) => (
                <div
                  key={tick}
                  className={styles.valueTick}
                  style={{ top: `${valueToTopPct(tick)}%` }}
                >
                  <span className={styles.valueTickLabel}>
                    {formatTick(tick, step)}
                  </span>
                  <span className={styles.valueTickMark} />
                </div>
              ))}
        </div>
      )}

      {isValueLane &&
        selectedSegment !== null &&
        keyframes.length > 0 &&
        selectedSegment <= keyframes.length &&
        (() => {
          // Region 0 edits the curve's lead-in period; region i edits
          // keyframe i-1's payload.
          const editsLeadIn = selectedSegment === 0;
          const source = editsLeadIn
            ? (curve?.leadIn ?? {
                color: keyframes[0].color,
                palette: keyframes[0].palette,
              })
            : keyframes[selectedSegment - 1];
          const apply = (patch: {
            color?: [number, number, number, number];
            palette?: NonNullable<AutomationCurve["leadIn"]>["palette"];
          }) => {
            const current = curveRef.current;
            if (!current) return;
            if (editsLeadIn)
              commitCurve({
                ...current,
                leadIn: { ...current.leadIn, ...patch },
              });
            else updateKeyframePayload(selectedSegment - 1, patch);
          };
          return (
            <div
              className={styles.segmentInspector}
              data-doc="segment-inspector"
            >
              <div className={styles.inspectorTitle}>
                {laneKind === "color" ? "Color" : "Palette"}
              </div>
              {laneKind === "color" ? (
                <ColorValueEditor
                  rgba={source.color ?? [1, 1, 1, 1]}
                  onChange={(rgba) => apply({ color: rgba })}
                />
              ) : (
                <PaletteValueEditor
                  palette={source.palette ?? currentValuePayload().palette!}
                  onChange={(palette) => apply({ palette })}
                />
              )}
            </div>
          );
        })()}

      {segmentMenu && (
        <div
          ref={menuRef}
          className={styles.contextMenu}
          style={{ left: segmentMenu.x, top: segmentMenu.y }}
          data-doc="segment-menu"
        >
          {segmentMenu.index !== null && (
            <>
              {SEGMENT_TYPES.map((option) => (
                <button
                  key={option.type}
                  className={`${styles.contextMenuItem} ${
                    segments[segmentMenu.index!]?.type === option.type
                      ? styles.contextMenuItemActive
                      : ""
                  }`}
                  onClick={() => {
                    setSegmentType(segmentMenu.index!, option.type);
                    setSegmentMenu(null);
                  }}
                >
                  {option.label}
                </button>
              ))}
              <div className={styles.contextMenuSeparator} />
            </>
          )}
          <div data-doc="snap-menu">
            <div className={styles.contextMenuLabel}>Snap to</div>
            {(
              [
                { mode: "off", label: "Off", available: true },
                { mode: "grid", label: "BPM Grid", available: !!beatGrid },
                {
                  mode: "transients",
                  label: "Transients",
                  available: !!transients && transients.length > 0,
                },
              ] as const
            ).map((option) => (
              <button
                key={option.mode}
                className={`${styles.contextMenuItem} ${
                  snapMode === option.mode ? styles.contextMenuItemActive : ""
                }`}
                disabled={!option.available}
                onClick={() => {
                  setSnapMode(option.mode);
                  setSegmentMenu(null);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isValueLane && selectedSpec && selectedSegment !== null && (
        <div className={styles.segmentInspector} data-doc="segment-inspector">
          <div className={styles.inspectorTitle}>Segment</div>
          <div className={styles.inspectorRow}>
            {SEGMENT_TYPES.map((option) => (
              <button
                key={option.type}
                className={`${styles.pill} ${
                  selectedSpec.type === option.type ? styles.pillActive : ""
                }`}
                onClick={() => setSegmentType(selectedSegment, option.type)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {selectedSpec.type === "curve" && (
            <div className={styles.inspectorRow}>
              <span className={styles.inspectorLabel}>Bend</span>
              <ScrubbableNumber
                key={`bend-${selectedSegment}`}
                param={segmentNumberParam("Bend", "bend", 0.02, 50)}
              />
            </div>
          )}

          {selectedSpec.type === "wave" && (
            <>
              <div className={styles.inspectorRow}>
                {WAVE_KINDS.map((option) => (
                  <button
                    key={option.kind}
                    className={`${styles.pill} ${
                      selectedSpec.wave === option.kind ? styles.pillActive : ""
                    }`}
                    onClick={() =>
                      updateSegment(selectedSegment, { wave: option.kind })
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className={styles.inspectorRow}>
                <span className={styles.inspectorLabel}>Amplitude</span>
                <ScrubbableNumber
                  key={`amplitude-${selectedSegment}`}
                  param={segmentNumberParam("Amplitude", "amplitude", 0)}
                />
              </div>
              <div className={styles.inspectorRow}>
                <span className={styles.inspectorLabel}>Cycles</span>
                <ScrubbableNumber
                  key={`cycles-${selectedSegment}`}
                  param={segmentNumberParam("Cycles", "cycles", 0.25, 64)}
                />
              </div>
              <div className={styles.inspectorRow}>
                <span className={styles.inspectorLabel}>Phase</span>
                <ScrubbableNumber
                  key={`phase-${selectedSegment}`}
                  param={segmentNumberParam("Phase", "phase", 0, 1)}
                />
              </div>
            </>
          )}

          {selectedSpec.type === "easing" && (
            <>
              <div className={styles.inspectorRow}>
                {EASING_MODES.map((mode) => (
                  <button
                    key={mode}
                    className={`${styles.pill} ${
                      parseEasing(selectedSpec.easing).mode === mode
                        ? styles.pillActive
                        : ""
                    }`}
                    onClick={() =>
                      updateSegment(selectedSegment, {
                        easing: `ease${mode}${
                          parseEasing(selectedSpec.easing).family
                        }` as EasingName,
                      })
                    }
                  >
                    {mode === "InOut" ? "In Out" : mode}
                  </button>
                ))}
              </div>
              <div className={styles.inspectorRow}>
                {EASING_FAMILIES.map((family) => (
                  <button
                    key={family}
                    className={`${styles.pill} ${
                      parseEasing(selectedSpec.easing).family === family
                        ? styles.pillActive
                        : ""
                    }`}
                    onClick={() =>
                      updateSegment(selectedSegment, {
                        easing: `ease${
                          parseEasing(selectedSpec.easing).mode
                        }${family}` as EasingName,
                      })
                    }
                  >
                    {family}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className={styles.editorCornerActions}>
        {automationClipboard.clip && editCursor !== null && (
          <button
            className={styles.cornerActionText}
            data-doc="paste-action"
            onClick={doPaste}
          >
            Paste
          </button>
        )}
      </div>

      {suspended && (
        <button
          className={styles.reenableTopRight}
          onClick={() => {
            const current = curveRef.current;
            if (current) commitCurve({ ...current });
          }}
        >
          Re-enable automation
        </button>
      )}

      <button
        className={styles.automationEditorClose}
        onClick={onClose}
        aria-label="Close automation editor"
      >
        ✕
      </button>
    </div>
  );
}
