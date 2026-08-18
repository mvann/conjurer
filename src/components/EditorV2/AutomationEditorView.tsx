import { observer } from "mobx-react-lite";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { FaEye, FaEyeSlash } from "react-icons/fa";
import { MdOpacity } from "react-icons/md";
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
  ensureCurveHandles,
  handlesForBend,
  handlesThroughMidpoint,
  setSegmentHandles,
  setKeyframeHandle,
  generatorAtKeyframe,
  isGeneratorType,
  stackGeneratorBoundaries,
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
} from "@/src/components/EditorV2/ValueEditors";
import {
  currentValuePayload,
  isValueKind,
  laneKindOf,
  valueRegions,
} from "@/src/components/EditorV2/valueLane";
import {
  getLaneSongDuration,
  NO_SONG_DURATION_SECONDS,
} from "@/src/components/EditorV2/blockLanes";
import {
  TIME_VIEWPORT_EVENT,
  sharedWaveform,
  timeViewport,
  transportTime,
} from "@/src/components/EditorV2/timeViewport";
import { drawBars } from "@/src/components/EditorV2/waveformPeaks";
import { editorPrefs } from "@/src/components/EditorV2/editorPrefs";
import {
  computeTargetView,
  easeView,
  extremesOf,
  ViewRange,
} from "@/src/components/EditorV2/autoRange";
import { BpmAnalysis } from "@/src/components/EditorV2/bpm";
import { EDITOR_DIRTY_EVENT } from "@/src/components/EditorV2/experiencePersistence";

// The narrowest colour or palette period, as a fraction of the song. A period
// IS a region, and a zero duration region cannot be written, so the last
// keyframe on a value lane stops this far short of the block's end instead of
// landing on it and vanishing on the next write.
const MIN_VALUE_PERIOD = 0.002;

// The narrowest a generator may be squeezed, likewise as a fraction of the
// song. A zero-duration region is never written, so a wave collapsed onto its
// own far edge was deleted on the next save while the editor went on drawing
// it. Its edges stop just short of each other instead.
const MIN_GENERATOR_SPAN = 0.002;

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
// variation types of the main experience editor (spline is not available
// as a segment type yet).
const SEGMENT_TYPES: { type: SegmentType; label: string }[] = [
  { type: "curve", label: "Curve" },
  { type: "flat", label: "Flat" },
  { type: "linear", label: "Linear" },
  { type: "wave", label: "Wave" },
  { type: "easing", label: "Easing" },
  { type: "audio", label: "Audio" },
];

const WAVE_KINDS: { kind: WaveKind; label: string }[] = [
  { kind: "sine", label: "Sine" },
  { kind: "square", label: "Square" },
  { kind: "triangle", label: "Triangle" },
  { kind: "sawUp", label: "Saw up" },
  { kind: "sawDown", label: "Saw down" },
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
  // Omitted in horizontal orientation, where the editor is a permanent pane
  // rather than something opened over the canopy — there is nothing to close it
  // back to, so it has no close button.
  onClose?: () => void;
  // The block this lane belongs to, as fractions of the song. The view still
  // spans the whole song; everything outside this range is darkened and inert
  // (decision 11).
  blockRange?: { start: number; end: number } | null;
};

// The expanded automation lane over the canopy space. Shows the manual
// value line and the lane's automation curve. Double click adds a keyframe:
// the first is a constant; the outermost keyframes extend horizontally; in
// between, segments are straight lines that drag up or down into curves.
// Right click a segment to change its type (curve, flat, linear, wave,
// easing); a selected segment's parameters are edited in the inspector
// card. The scale on the right labels the value range; it manages itself.
const sameRgba = (a: Rgba, b: Rgba) =>
  a.every((component, index) => Math.abs(component - b[index]) < 1e-6);

// A second colour you can actually see is different from the first. The
// complement is the obvious choice and is right nearly everywhere; near
// mid-grey it collapses back onto the original, so that case takes a fixed
// contrasting colour instead.
const notablyDifferent = ([r, g, b, a]: Rgba): Rgba => {
  const complement: Rgba = [1 - r, 1 - g, 1 - b, a];
  const flat = [r, g, b].every((component) => Math.abs(component - 0.5) < 0.1);
  return flat ? [0.15, 0.55, 0.95, a] : complement;
};

export const AutomationEditorView = observer(function AutomationEditorView({
  param,
  curve,
  beatGrid,
  transients,
  onCurveChange,
  onClose,
  blockRange,
}: Props) {
  const keyframes = curve?.keyframes ?? [];
  const segments = curve ? getSegments(curve) : [];
  // Unique per mounted editor, so two lanes' clip paths never collide.
  const clipId = useId().replace(/:/g, "");
  // A deactivated lane: the curve is drawn dimmed, a bright dashed line
  // marks the manual value that is actually driving the parameter,
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
  const laneKind = laneKindOf(param.value);
  const isValueLane = isValueKind(laneKind);

  // The periods, their chips and their colours all come from the shared
  // value-lane module, which is also what the lane preview draws from — the
  // same rule that binds the two to one time viewport and one value range.
  const regions = () =>
    valueRegions({
      curve,
      timeToX,
      blockRange: blockRange ?? null,
      emptyPayload: currentValuePayload(param.value),
    });

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

  // The manual value only drives the view when there is no automation;
  // with keyframes present, the curve IS the value and the manual
  // param value is not shown separately. The range fits the curve's real
  // extremes (wave peaks, easing overshoots), not just its keyframes
  // (curveExtremes memoizes per curve object). A deactivated lane also
  // keeps the manual value in range, since that line is what drives
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
  // Seeded from (and written back to) editorPrefs so the choice
  // survives closing and reopening the editor.
  const [snapMode, setSnapModeState] = useState(editorPrefs.snapMode);
  const setSnapMode = (mode: typeof editorPrefs.snapMode) => {
    editorPrefs.snapMode = mode;
    setSnapModeState(mode);
  };
  // The editor's backdrop layers, each an independent toggle in the
  // corner dropdown: Canopy thins the editor so the live canopy shows
  // through (on by default), Waveform draws the song's waveform behind
  // the curve. Both on stacks them; both off is the plain solid
  // backdrop.
  const [backdrop, setBackdrop] = useState({ canopy: true, waveform: false });
  const [backdropMenuOpen, setBackdropMenuOpen] = useState(false);
  const backdropMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!backdropMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (backdropMenuRef.current?.contains(event.target as Node)) return;
      setBackdropMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [backdropMenuOpen]);

  // Right-clicking a keyframe (or hovering it and pressing E) types its
  // value directly: a glowing field in the dot-label position, committed
  // on Enter or blur.
  const [keyframeValueEdit, setKeyframeValueEdit] = useState<{
    index: number;
    draft: string;
  } | null>(null);
  const hoveredKeyframe = useRef<number | null>(null);
  const openKeyframeValueEdit = (index: number) => {
    const keyframe = curveRef.current?.keyframes[index];
    if (!keyframe || isValueLane) return;
    setKeyframeValueEdit({
      index,
      draft: String(parseFloat(keyframe.value.toFixed(3))),
    });
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "e" && event.key !== "E") return;
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (hoveredKeyframe.current === null) return;
      event.preventDefault();
      openKeyframeValueEdit(hoveredKeyframe.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValueLane]);
  const commitKeyframeValueEdit = () => {
    if (!keyframeValueEdit) return;
    const current = curveRef.current;
    const parsed = parseFloat(keyframeValueEdit.draft);
    setKeyframeValueEdit(null);
    if (!current || !current.keyframes[keyframeValueEdit.index]) return;
    if (isNaN(parsed)) return;
    const value = clampToBounds(parsed);
    commitCurve({
      ...current,
      keyframes: current.keyframes.map((keyframe, i) =>
        i === keyframeValueEdit.index ? { ...keyframe, value } : keyframe,
      ),
    });
  };
  // How many beats apart the grid lines currently are.
  //
  // The stride escalates by fours — beat, bar, four bars — until lines are
  // comfortably spaced, so the grid gets finer as you zoom in. Snapping reads
  // the SAME number, because the owner's rule is that "whatever lines are
  // shown for the grid should be what is snapped to": snapping to beats that
  // are not drawn puts keyframes between the lines you can see.
  const gridStrideBeats = () => {
    if (!beatGrid || !beatGrid.durationSeconds) return 1;
    const areaWidth =
      areaRef.current?.clientWidth ??
      (typeof window === "undefined" ? 1200 : window.innerWidth - 72);
    const beatFracOfView =
      60 / beatGrid.bpm / beatGrid.durationSeconds / timeView.width;
    let stride = 1;
    while (areaWidth * beatFracOfView * stride < 9 && stride < 4096) stride *= 4;
    return stride;
  };

  // Which colour periods have had Gradient switched ON, by region index.
  //
  // Deliberately memory only, and the owner was explicit about why it has to
  // be: "Gradient, for me, will only be in memory as far as UI goes, which is
  // funny because in the data model, it's always there." Upstream stores every
  // colour period as linear4 from->to, so a gradient is not a distinct kind of
  // thing to persist — equal ends ARE what "one colour" means. The flag exists
  // only to keep the toggle on while someone drags the second colour towards
  // the first and back; on reload, equal ends read as one colour again, which
  // is exactly what he said should happen.
  const [gradientOn, setGradientOn] = useState<Set<number>>(new Set());

  // Nearest snap target to a time (song fraction); identity when off or
  // when the mode's targets are unavailable.
  const snapTime = (time: number): number => {
    if (snapMode === "grid") {
      if (!beatGrid || !beatGrid.durationSeconds) return time;
      const beat =
        (60 / beatGrid.bpm / beatGrid.durationSeconds) * gridStrideBeats();
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
    if (
      !segmentMenu &&
      selectedSegment === null &&
      !timeSelection &&
      !keyframeValueEdit &&
      !backdropMenuOpen
    )
      return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      if (keyframeValueEdit) setKeyframeValueEdit(null);
      else if (backdropMenuOpen) setBackdropMenuOpen(false);
      else if (segmentMenu) setSegmentMenu(null);
      else if (selectedSegment !== null) setSelectedSegment(null);
      else setTimeSelection(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    segmentMenu,
    selectedSegment,
    timeSelection,
    keyframeValueEdit,
    backdropMenuOpen,
  ]);

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
  // (or the live manual value) and ease the view toward it. Frozen
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
  // itself when fully zoomed out). The width is state because the ref has
  // no size on the first render: a layout effect measures it BEFORE the
  // first paint (a plain effect would paint one frame mapped through the
  // initial guess, visibly snapping), and a ResizeObserver keeps it
  // current through container changes a window resize never reports,
  // like the pattern dock animating open beside the editor.
  const [areaWidth, setAreaWidth] = useState(1280);
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const update = () => setAreaWidth(area.clientWidth || 1280);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  const labelPct = (120 / areaWidth) * 100;

  // Waveform backdrop: the song's peaks drawn dimly behind the curve,
  // through the same time mapping as everything else in the editor, so
  // automation lines up against the audio it rides on. Redrawn whenever
  // the viewport, the area size, or the mode changes.
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!backdrop.waveform) return;
    const canvas = waveformCanvasRef.current;
    const area = areaRef.current;
    if (!canvas || !area) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = area.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const peaks = sharedWaveform.peaks;
    if (!peaks) return;
    // The area spans [xFracToTime(0), xFracToTime(1)]: the visible window
    // plus the label strip's stretch of pre-window time on the left.
    const viewLeft =
      timeView.left - (labelPct * timeView.width) / (100 - labelPct);
    const viewWidth = (timeView.width * 100) / (100 - labelPct);
    drawBars(
      ctx,
      peaks,
      viewLeft,
      viewWidth,
      canvas.width,
      canvas.height,
      0,
      canvas.width,
      "rgba(232, 236, 244, 0.16)",
    );
  }, [backdrop.waveform, timeView, labelPct]);
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
      // the manual value instead.
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

  // The manual value line tracks param.value (mutated outside React by
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
    const shaped =
      isValueLane || isBooleanLane ? next : ensureCurveHandles(next);
    const revived = {
      ...(isBooleanLane ? quantizeBooleanCurve(shaped) : shaped),
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
    let next: AutomationCurve = { ...current, segments: nextSegments };
    // Bend is a symmetric shortcut for the two handles, so setting it has to
    // move them: with handles present they are what the curve is drawn from,
    // and a bend nothing reads would silently do nothing.
    const spec = nextSegments[index];
    if ("bend" in patch && spec?.type === "curve") {
      const a = next.keyframes[index];
      const b = next.keyframes[index + 1];
      if (a && b)
        next = setSegmentHandles(next, index, handlesForBend(a, b, spec.bend));
    }
    commitCurve(next);
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
    const retyped = { ...current, segments: nextSegments };
    // Becoming a generator gives it its own boundary keyframes, stacked on
    // the neighbours' (decision 14). Selection is by segment index, and the
    // stack shifts the generator right by one when a left bridge appears.
    if (isGeneratorType(type)) {
      const stacked = stackGeneratorBoundaries(retyped, index);
      const shifted =
        stacked.keyframes.length - retyped.keyframes.length > 0 &&
        index > 0 &&
        isGeneratorType(getSegments(stacked)[index + 1]?.type);
      commitCurve(stacked);
      if (shifted) setSelectedSegment(index + 1);
      return;
    }
    commitCurve(retyped);
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
        : currentValuePayload(param.value)
      : {};
    nextKeyframes.splice(insertAt, 0, { time, value, ...payload });
    // The very first keyframe on a value lane also pins the lead-in
    // period (the region before it) to the current value.
    const leadIn =
      isValueLane && currentKeyframes.length === 0
        ? currentValuePayload(param.value)
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
    // Outside the block, nothing happens — "double clicking or dragging
    // outside the block, I think it just shouldn't do anything".
    if (blockRange && (time < blockRange.start || time > blockRange.end))
      return;
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
      // A flat chord bends now too: handles can lift a curve off a level pair
      // of keyframes, which a Schlick bend could never express.
      if (!a || !b || spec?.type !== "curve") return;

      const onMove = (moveEvent: PointerEvent) => {
        const current = curveRef.current;
        if (!current) return;
        // The curve passes through the cursor at the segment's halfway point.
        // Moving the handles is the edit itself: the shape the editor draws is
        // the shape the data model stores, so nothing is refitted on save.
        commitCurve(
          setSegmentHandles(
            current,
            segmentIndex,
            handlesThroughMidpoint(a, b, clientYToValue(moveEvent.clientY)),
            { handlesOwnShape: true },
          ),
        );
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

  // Drag the manual value line up or down, unbounded. The pointer's
  // delta maps through the CURRENT span, so a wide range moves the value
  // a lot per pixel and a tight range moves it a little. The range is
  // frozen while dragging and refits around the new value on release
  // (the manual value drives the range only while it is the active
  // driver: no keyframes, or a deactivated curve).
  const onManualValuePointerDown = (event: React.PointerEvent) => {
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
    if (!timeSelection || !current || current.keyframes.length === 0) return;
    commitCurve(deleteCurveWindow(current, timeSelection.t0, timeSelection.t1));
    setTimeSelection(null);
  };

  const doPaste = () => {
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
      if (!dragging && Math.abs(moveEvent.clientX - startClientX) < 4) return;
      // Highlighting dismisses the cursor; the next plain click places
      // a fresh one.
      if (!dragging) setEditCursor(null);
      dragging = true;
      const time = snapTime(
        xFracToTime((moveEvent.clientX - rect.left) / rect.width),
      );
      // A highlight started inside the block stops at its edges rather than
      // running past them: "if I start a highlight within the block, and then
      // I drag to the end, it should just stop at the end of the block".
      const clamp = (value: number) =>
        blockRange
          ? Math.min(Math.max(value, blockRange.start), blockRange.end)
          : value;
      setTimeSelection({
        t0: clamp(Math.min(startTime, time)),
        t1: clamp(Math.max(startTime, time)),
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
        // A value lane's periods ARE regions, and a region cannot sit outside
        // the block, so a colour keyframe dragged past either edge could not
        // be stored and was silently dropped on the next write. Scalar lanes
        // keep their overhang on purpose (drawn dotted, not played), so only
        // value lanes are penned in.
        // A period needs real width to exist as a region, so the last
        // keyframe stops short of the end rather than landing exactly on it
        // and collapsing to nothing.
        const bounds = isValueLane
          ? {
              low: blockRange ? blockRange.start : 0,
              high: (blockRange ? blockRange.end : 1) - MIN_VALUE_PERIOD,
            }
          : { low: 0, high: 1 };
        // A generator either side of this keyframe keeps a span of its own.
        // Its boundary stack is a different thing: the bridge beside it is
        // zero-width by design and stays free to zip shut.
        const specs = getSegments(current);
        const previousTime = nextKeyframes[index - 1]?.time ?? bounds.low;
        const nextTime = nextKeyframes[index + 1]?.time ?? bounds.high;
        const minTime = isGeneratorType(specs[index - 1]?.type)
          ? previousTime + MIN_GENERATOR_SPAN
          : previousTime;
        const maxTime = isGeneratorType(specs[index]?.type)
          ? nextTime - MIN_GENERATOR_SPAN
          : nextTime;
        const time = clamp(
          // Snap first, then bound by the neighbors (a snap target
          // beyond a neighbor pins at the neighbor).
          snapTime(xFracToTime((moveEvent.clientX - rect.left) / rect.width)),
          Math.max(minTime, bounds.low),
          Math.min(Math.max(maxTime, minTime), bounds.high),
        );
        nextKeyframes[index] = {
          ...nextKeyframes[index],
          time,
          // Value lanes drag in time only; there is no vertical meaning.
          value: isValueLane ? nextKeyframes[index].value : rawValue,
        };

        const nextSegments = [...getSegments(current)];
        // A generator has no slope, so moving either of ITS OWN boundary
        // keyframes vertically moves the whole offset and the wave rides up
        // and down as one piece — "dragging the right edge keyframe up and
        // down does move the entire offset". A neighbour's stacked keyframe
        // is a different owner and moves alone, which is the decoupling.
        const generator = generatorAtKeyframe(current, index);
        if (generator !== null && !isValueLane) {
          nextKeyframes[generator] = {
            ...nextKeyframes[generator],
            value: rawValue,
          };
          nextKeyframes[generator + 1] = {
            ...nextKeyframes[generator + 1],
            value: rawValue,
          };
          // The wave never stretches (decision 15): its period is fixed in
          // seconds, so resizing the span reveals more or fewer cycles rather
          // than squeezing the ones it has.
          const spec = nextSegments[generator];
          if (spec?.type === "wave") {
            const was =
              current.keyframes[generator + 1].time -
              current.keyframes[generator].time;
            const now =
              nextKeyframes[generator + 1].time - nextKeyframes[generator].time;
            if (was > 1e-9 && now > 0)
              nextSegments[generator] = {
                ...spec,
                cycles: spec.cycles * (now / was),
              };
          }
        }
        commitCurve({
          ...current,
          keyframes: nextKeyframes,
          segments: nextSegments,
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

  // Drag a Bezier handle. The handle IS the curve's shape now, so moving one
  // is a direct edit: no refit, and the stored cubic is what gets drawn.
  const onHandlePointerDown =
    (index: number, which: "handleIn" | "handleOut") =>
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      isDraggingRef.current = true;
      const onMove = (moveEvent: PointerEvent) => {
        const rect = areaRef.current?.getBoundingClientRect();
        const current = curveRef.current;
        if (!rect || !current) return;
        const anchor = current.keyframes[index];
        if (!anchor) return;
        const time = xFracToTime((moveEvent.clientX - rect.left) / rect.width);
        const value = clientYToValue(moveEvent.clientY);
        // A handle stays on its own side of its keyframe: an out handle
        // reaches forward, an in handle back. Crossing over would turn the
        // cubic inside out and fold the curve back on itself.
        const rawDt = time - anchor.time;
        const dt =
          which === "handleOut" ? Math.max(rawDt, 0) : Math.min(rawDt, 0);
        commitCurve(
          setKeyframeHandle(current, index, which, {
            dt,
            dv: value - anchor.value,
          }),
        );
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

  // Every handle belonging to a curve segment, both sides of every keyframe.
  // A handle only means something where the adjacent segment is a curve: a
  // flat or a wave takes its shape from somewhere else entirely.
  const bezierHandles = () => {
    if (isValueLane || isBooleanLane) return [];
    const out: {
      index: number;
      which: "handleIn" | "handleOut";
      x: number;
      y: number;
      anchorX: number;
      anchorY: number;
    }[] = [];
    // A zero-width segment has no shape to control, and its handles would sit
    // exactly on top of the stacked keyframes they belong to, swallowing the
    // drag meant for those. Stacked pairs and generator boundary bridges are
    // both this shape.
    const spans = (i: number) =>
      !!keyframes[i] &&
      !!keyframes[i + 1] &&
      keyframes[i + 1].time - keyframes[i].time > 1e-6;

    for (let i = 0; i < keyframes.length; i++) {
      const keyframe = keyframes[i];
      const forward =
        segments[i]?.type === "curve" && !!keyframe.handleOut && spans(i);
      const back =
        segments[i - 1]?.type === "curve" &&
        !!keyframe.handleIn &&
        spans(i - 1);
      for (const which of ["handleOut", "handleIn"] as const) {
        if (which === "handleOut" ? !forward : !back) continue;
        const handle = keyframe[which]!;
        out.push({
          index: i,
          which,
          x: timeToX(keyframe.time + handle.dt),
          y: valueToTopPct(keyframe.value + handle.dv),
          anchorX: timeToX(keyframe.time),
          anchorY: valueToTopPct(keyframe.value),
        });
      }
    }
    return out;
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

  // Where the block ends, in the path's own coordinates — the boundary the
  // solid and dotted halves are split at. Null when there is nothing past it
  // to draw, which is the ordinary case.
  const blockOverhangX =
    blockRange && keyframes.length > 0 &&
    keyframes[keyframes.length - 1].time > blockRange.end
      ? timeToX(blockRange.end)
      : null;

  const buildFullPath = () => {
    if (keyframes.length === 0) return "";
    const first = keyframes[0];
    const last = keyframes[keyframes.length - 1];
    // The curve exists only where the BLOCK does. Outside it the block is not
    // in `LayerV2.activeBlocks` at all, so no BlockStackNode is mounted and
    // `updateParameters` is never called — there is no value out there to draw.
    // Falling back to the song's start keeps the old behaviour for a lane with
    // no block behind it (visibility).
    //
    // The holds INSIDE the block are real and stay: a Curve region returns its
    // first node's value before that node and its last node's value after, and
    // an under-filling region tiling holds the last value to the block's end.
    // So both ends clamp rather than disappear.
    const parts = [
      `M ${timeToX(blockRange ? blockRange.start : 0)} ${valueToTopPct(first.value)}`,
    ];
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
    parts.push(`L ${timeToX(last.time)} ${valueToTopPct(last.value)}`);
    // The hold after the last keyframe exists only if that keyframe is INSIDE
    // the block, and it stops at the block's end. When the last keyframe sits
    // past the end — which is what a right-trim leaves behind, since trimming
    // does not rewrite regions — there is no hold to draw at all. Drawing one
    // to the block's end would run backwards, leftward from the keyframe.
    const holdEnd = blockRange
      ? last.time < blockRange.end
        ? timeToX(blockRange.end)
        : null
      : 100;
    if (holdEnd !== null)
      parts.push(`L ${holdEnd} ${valueToTopPct(last.value)}`);
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
    key: "bend" | "amplitude" | "cycles" | "phase" | "factor" | "smoothing",
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

  /**
   * A wave's FREQUENCY, in hertz, which is what the owner asked the inspector
   * to speak: "I wanna start defining waves as having a frequency and a phase
   * in the little inspector window."
   *
   * The segment stores cycles ACROSS ITS SPAN, so frequency is cycles divided
   * by that span in seconds, which is exactly 1 / period. Storing cycles and
   * showing frequency is what makes the two behaviours agree: dragging the
   * segment wider rescales cycles to hold the period, so the frequency shown
   * here does not move, and "if you drag the right one out further, more
   * cycles are revealed" falls out.
   *
   * The bounds are real frequencies, NOT the old cycle limits converted. Those
   * limits capped cycles ACROSS THE SEGMENT, which as a frequency means a long
   * segment cannot oscillate quickly: a 125s span topped out under 0.5 Hz. A
   * rate should not depend on how wide the thing carrying it is, and a longer
   * segment should simply hold more cycles at the same rate.
   *
   * The ceiling is the frame rate's: the wave is evaluated once per rendered
   * frame, so past about 30 Hz it aliases against a 60 fps canopy rather than
   * oscillating. 20 leaves headroom under that. The drawn curve also aliases
   * past roughly 80 cycles across a segment, where sampleSegment's 4000 point
   * cap bites, but that is only the picture: playback still evaluates the real
   * function.
   */
  const FREQUENCY_MIN_HZ = 0.01;
  const FREQUENCY_MAX_HZ = 20;

  const segmentFrequencyParam = () => {
    const index = selectedSegment!;
    const spanSeconds = () => {
      const a = keyframes[index];
      const b = keyframes[index + 1];
      const song = getLaneSongDuration() || NO_SONG_DURATION_SECONDS;
      return Math.max((b.time - a.time) * song, 1e-6);
    };
    return {
      name: "Frequency",
      min: FREQUENCY_MIN_HZ,
      max: FREQUENCY_MAX_HZ,
      get value() {
        const spec = currentSegments()[index];
        const cycles = spec?.type === "wave" ? spec.cycles : 0;
        return cycles / spanSeconds();
      },
      set value(next: number) {
        updateSegment(index, {
          cycles: next * spanSeconds(),
        } as Partial<SegmentSpec>);
      },
    } as PatternParam<number>;
  };

  return (
    <div
      className={`${styles.automationEditor} ${
        backdrop.canopy ? styles.automationEditorSeeThrough : ""
      }`}
      data-doc="automation-editor"
    >
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
        {/* Outside the block, darkened. The view still spans the whole song —
            the block's live window is what stands out (decision 11). Purely
            visual: the guards that make the dim inert live on the handlers. */}
        {blockRange && (
          <>
            {blockRange.start > 0 && (
              <div
                className={styles.editorDimZone}
                data-doc="dim-before"
                style={{ left: 0, width: `${timeToX(blockRange.start)}%` }}
              />
            )}
            {blockRange.end < 1 && (
              <div
                className={styles.editorDimZone}
                data-doc="dim-after"
                style={{ left: `${timeToX(blockRange.end)}%`, right: 0 }}
              />
            )}
          </>
        )}
        {backdrop.waveform && (
          <canvas
            ref={waveformCanvasRef}
            className={styles.editorWaveformCanvas}
          />
        )}
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
            // Density adapts to the visible window (which follows the
            // minimap): the stride escalates by fours (beat, bar, four
            // bars, ...) until lines are comfortably spaced. Snapping shares
            // this exact number — see gridStrideBeats.
            const stride = gridStrideBeats();
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
            {/* The straight line that stands in for the curve, since a value
                lane has no vertical meaning — drawn like a curve, and dimmed
                like one while the lane is suspended. */}
            <div
              className={`${styles.valueBaseline} ${
                suspended ? styles.valueBaselineDimmed : ""
              }`}
            />
            {regions().map((region) => (
              <button
                key={region.index}
                className={`${styles.valueSwatch} ${
                  suspended ? styles.valueSwatchDimmed : ""
                } ${region.gradient ? styles.valueSwatchWide : ""} ${
                  selectedSegment === region.index
                    ? styles.valueSwatchSelected
                    : ""
                }`}
                data-gradient={region.gradient ? "true" : "false"}
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
            onPointerDown={onManualValuePointerDown}
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
            {/* Anything past the block's end is drawn dotted: it is real
                authored automation, but nothing evaluates it out there. The
                split is done with clip rects rather than by cutting the path
                data, so a segment straddling the boundary breaks at exactly
                the right pixel without having to be subdivided. */}
            {blockOverhangX !== null && (
              <defs>
                <clipPath id={`${clipId}-in`}>
                  <rect x="-500" y="-500" width={500 + blockOverhangX} height="1100" />
                </clipPath>
                <clipPath id={`${clipId}-out`}>
                  <rect x={blockOverhangX} y="-500" width="1000" height="1100" />
                </clipPath>
              </defs>
            )}
            <path
              className={styles.curvePath}
              d={buildFullPath()}
              clipPath={
                blockOverhangX !== null ? `url(#${clipId}-in)` : undefined
              }
            />
            {blockOverhangX !== null && (
              <path
                className={`${styles.curvePath} ${styles.curvePathOutside}`}
                d={buildFullPath()}
                clipPath={`url(#${clipId}-out)`}
              />
            )}
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

        {/* Bezier handles, with a leader line back to their keyframe.
            Drawn BEFORE the keyframe dots so a dot always wins the pointer:
            grabbing a keyframe matters more than grabbing its handle. */}
        {bezierHandles().length > 0 && (
          <svg
            className={styles.handleLineSvg}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {bezierHandles().map((handle) => (
              <line
                key={`${handle.index}-${handle.which}-line`}
                className={styles.bezierHandleLine}
                x1={handle.anchorX}
                y1={handle.anchorY}
                x2={handle.x}
                y2={handle.y}
              />
            ))}
          </svg>
        )}
        {bezierHandles().map((handle) => (
          <div
            key={`${handle.index}-${handle.which}`}
            className={styles.bezierHandle}
            data-doc="bezier-handle"
            style={{ left: `${handle.x}%`, top: `${handle.y}%` }}
            onPointerDown={onHandlePointerDown(handle.index, handle.which)}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        ))}

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
            onPointerEnter={() => (hoveredKeyframe.current = index)}
            onPointerLeave={() => {
              if (hoveredKeyframe.current === index)
                hoveredKeyframe.current = null;
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              deleteKeyframe(index);
            }}
            onContextMenu={(event) => {
              // Right click types a value for this keyframe (numeric
              // lanes; value lanes edit through the inspector instead).
              event.preventDefault();
              event.stopPropagation();
              openKeyframeValueEdit(index);
            }}
          />
        ))}

        {keyframeValueEdit && keyframes[keyframeValueEdit.index] && (
          <input
            className={styles.keyframeValueInput}
            data-doc="keyframe-value"
            style={{
              left: `${timeToX(keyframes[keyframeValueEdit.index].time)}%`,
              top: `${valueToTopPct(keyframes[keyframeValueEdit.index].value)}%`,
            }}
            value={keyframeValueEdit.draft}
            autoFocus
            onFocus={(event) => event.target.select()}
            onChange={(event) =>
              setKeyframeValueEdit({
                ...keyframeValueEdit,
                draft: event.target.value,
              })
            }
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitKeyframeValueEdit();
              else if (event.key === "Escape") {
                event.stopPropagation();
                setKeyframeValueEdit(null);
              }
            }}
            onBlur={commitKeyframeValueEdit}
          />
        )}

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
            colorTo?: [number, number, number, number];
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
                (() => {
                  const from = source.color ?? ([1, 1, 1, 1] as Rgba);
                  const to = source.colorTo;
                  const showing =
                    gradientOn.has(selectedSegment) ||
                    (!!to && !sameRgba(from, to));
                  return (
                    <>
                      <label className={styles.inspectorToggle}>
                        <input
                          type="checkbox"
                          data-doc="gradient-toggle"
                          checked={showing}
                          onChange={(event) => {
                            const next = new Set(gradientOn);
                            if (event.target.checked) {
                              next.add(selectedSegment);
                              // "it adds a second color different from the
                              // first color, notably" — a far end you can see
                              // is different, so the gradient is visible the
                              // moment it is switched on.
                              apply({ colorTo: notablyDifferent(from) });
                            } else {
                              next.delete(selectedSegment);
                              // Equal ends is how the data model says "one
                              // colour"; there is nothing else to clear.
                              apply({ colorTo: from });
                            }
                            setGradientOn(next);
                          }}
                        />
                        <span>Gradient</span>
                      </label>
                      <ColorValueEditor
                        rgba={from}
                        onChange={(rgba) => apply({ color: rgba })}
                      />
                      {showing && (
                        <>
                          <div className={styles.inspectorSubLabel}>To</div>
                          <ColorValueEditor
                            rgba={to ?? notablyDifferent(from)}
                            onChange={(rgba) => apply({ colorTo: rgba })}
                          />
                        </>
                      )}
                    </>
                  );
                })()
              ) : (
                <PaletteValueEditor
                  palette={source.palette ?? currentValuePayload(param.value).palette!}
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
          <div className={styles.snapMenuSection} data-doc="snap-menu">
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
                <span className={styles.inspectorLabel}>Frequency</span>
                <ScrubbableNumber
                  key={`frequency-${selectedSegment}`}
                  param={segmentFrequencyParam()}
                />
                <span className={styles.inspectorUnit}>Hz</span>
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

          {selectedSpec.type === "audio" && (
            <>
              <div className={styles.inspectorRow}>
                <span className={styles.inspectorLabel}>Amount</span>
                <ScrubbableNumber
                  key={`factor-${selectedSegment}`}
                  param={segmentNumberParam("Amount", "factor")}
                />
              </div>
              <div className={styles.inspectorRow}>
                <span className={styles.inspectorLabel}>Smoothing</span>
                <ScrubbableNumber
                  key={`smoothing-${selectedSegment}`}
                  param={segmentNumberParam("Smoothing", "smoothing", 0, 0.5)}
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

      {onClose && (
        <button
          className={styles.automationEditorClose}
          onClick={onClose}
          aria-label="Close automation editor"
        >
          ✕
        </button>
      )}

      <div
        ref={backdropMenuRef}
        className={styles.editorCornerToggle}
        data-doc="see-through"
      >
        {backdropMenuOpen && (
          <div className={styles.backdropMenu}>
            {/* Independent toggles: the menu stays open so both can be
                flipped in one visit. */}
            {(["canopy", "waveform"] as const).map((layer) => (
              <button
                key={layer}
                className={`${styles.backdropMenuItem} ${
                  backdrop[layer] ? styles.backdropMenuItemActive : ""
                }`}
                onClick={() =>
                  setBackdrop((current) => ({
                    ...current,
                    [layer]: !current[layer],
                  }))
                }
              >
                <span>{layer === "canopy" ? "Canopy" : "Waveform"}</span>
                {/* Fixed-width trailing column so the eyes align. */}
                <span className={styles.backdropMenuEye}>
                  {backdrop[layer] ? (
                    <FaEye size={12} />
                  ) : (
                    <FaEyeSlash size={12} />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
        <button
          className={`${styles.cornerButton} ${
            backdrop.canopy || backdrop.waveform
              ? styles.cornerButtonActive
              : ""
          }`}
          onClick={() => setBackdropMenuOpen((open) => !open)}
          aria-label="Backdrop"
        >
          <MdOpacity />
        </button>
      </div>
    </div>
  );
});
