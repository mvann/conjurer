import { observer } from "mobx-react-lite";
import { useEffect, useId, useRef, useState } from "react";
import { FaEye, FaEyeSlash, FaPlus, FaTrashAlt } from "react-icons/fa";
import styles from "@/styles/EditorV2.module.css";
import {
  StackEntry,
  VISIBILITY_PARAM,
} from "@/src/components/EditorV2/PatternsPanel";
import { formatDisplayName } from "@/src/components/EditorV2/formatDisplayName";
import { getParamComponents } from "@/src/components/EditorV2/paramComponents";
import { PatternParam } from "@/src/params/shared/patternParam";
import {
  AutomationCurve,
  curveExtremes,
  evaluateCurve,
  getSegments,
  isCurveActive,
  sampleSegment,
} from "@/src/components/EditorV2/automation";
import {
  currentValuePayload,
  isValueKind,
  laneKindOf,
  valueRegions,
} from "@/src/components/EditorV2/valueLane";
import type { Layer } from "@/src/types/Layer";
import type { Block } from "@/src/types/Block";
import { getLaneSongDuration } from "@/src/components/EditorV2/blockLanes";
import {
  laneCurve,
  laneKeysOf,
} from "@/src/components/EditorV2/blockLanes";
import {
  TIME_VIEWPORT_EVENT,
  timeViewport,
  transportTime,
} from "@/src/components/EditorV2/timeViewport";
import {
  computeTargetView,
  extremesOf,
} from "@/src/components/EditorV2/autoRange";

const DEFAULT_HEIGHT = 160;
const MIN_HEIGHT = 48;
// Leave room for the header, canopy, and timeline above.
const maxHeight = () =>
  typeof window === "undefined" ? 480 : window.innerHeight * 0.6;

const clampHeight = (height: number) =>
  Math.min(Math.max(height, MIN_HEIGHT), maxHeight());

type Props = {
  entries: StackEntry[];
  // The layers, in the experience's order, so the lane groups match the layer
  // list on the left (decision 28).
  layers: Layer[];
  onBlockTimingChange: (
    block: Block,
    startTime: number,
    duration: number,
  ) => void;
  selectedLane: { entryId: string; uniform: string } | null;
  onSelectLane: (lane: { entryId: string; uniform: string }) => void;
  // Starts assign mode: the pattern editor opens and the next parameter
  // clicked gets an automation lane.
  onStartAssign: () => void;
  onToggleLaneActive: (entryId: string, laneKey: string) => void;
  onDeleteLane: (entryId: string, laneKey: string) => void;
  // Display order as `${entryId}/${laneKey}` keys; lanes not listed
  // follow in natural order. Dragging a label reorders and persists.
  laneOrder: string[];
  onReorderLanes: (nextOrder: string[]) => void;
};

// Resolves a lane's display name and param. Lane keys are a uniform name,
// a uniform plus a component path ("u_palette.a.x"), or the visibility
// sentinel (a 0/1 pseudo-param). Shared with the large automation editor
// view so both map values to the same vertical position.
export const resolveLane = (entry: StackEntry, laneKey: string) => {
  if (laneKey === VISIBILITY_PARAM)
    return {
      paramName: "Visibility",
      // Rebuilt on every toggle since entries state changes, so the
      // snapshot stays current.
      param: {
        name: "Visibility",
        value: entry.visible ? 1 : 0,
        min: 0,
        max: 1,
        // The boolean convention (0 or 1 in single steps): visibility
        // lanes get on/off automation like any other switch.
        step: 1,
      } as PatternParam,
    };

  // Effect params: effect:<id>:<uniform> (see effectLaneKey). The id
  // keeps lanes attached through reordering and duplicate effect types.
  if (laneKey.startsWith("effect:")) {
    const [, idPart, effectUniform] = laneKey.split(":");
    const effect = entry.effects.find(
      (candidate) => String(candidate.id) === idPart,
    );
    const param = effect?.pattern.params[effectUniform];
    if (!effect || !param) return null;
    return {
      paramName: formatDisplayName(param.name),
      effectName: formatDisplayName(effect.pattern.name),
      param,
    };
  }

  const [uniform, ...pathParts] = laneKey.split(".");
  const param = entry.pattern.params[uniform];
  if (!param) return null;
  if (pathParts.length === 0)
    return { paramName: formatDisplayName(param.name), param };

  const component = getParamComponents(param)?.find(
    (candidate) => candidate.path === pathParts.join("."),
  );
  if (!component) return null;
  return {
    paramName: `${formatDisplayName(param.name)} ${component.label}`,
    param: component.param,
  };
};

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

// The value range a lane maps through: the same range the expanded
// editor would settle on. Shared by the mini curve, the manual value
// line, and the time dot so they always agree. A deactivated lane keeps
// the manual value in range, since that line drives the parameter.
const laneViewRange = (curve: AutomationCurve | null, param: PatternParam) => {
  // A parameter that declares both bounds pins the lane to exactly that
  // range, matching the expanded editor.
  if (
    typeof param.min === "number" &&
    typeof param.max === "number" &&
    param.max > param.min
  )
    // The declared range sits at 10%..90%, matching the expanded editor.
    return {
      center: (param.min + param.max) / 2,
      span: (param.max - param.min) / 0.8,
    };
  const value = typeof param.value === "number" ? param.value : 0;
  if (!curve || curve.keyframes.length === 0)
    return computeTargetView(extremesOf([value]), null, false);
  let extremes = curveExtremes(curve);
  if (!isCurveActive(curve) && extremes)
    extremes = {
      low: Math.min(extremes.low, value),
      high: Math.max(extremes.high, value),
    };
  return computeTargetView(extremes, null, false);
};

// A lane's miniature automation curve, drawn with the same value range
// the expanded editor would settle on (zero centered, power-of-two pairs
// fitted to the curve) and the shared time viewport, so the preview is a
// scale model of the editor view. Dimmed while deactivated.
//
// A value lane (colour, palette) is this same component with three
// substitutions and nothing else: its keyframes sit at the vertical middle
// because it has no value axis (@@L5846), its body is a neutral baseline
// rather than a shaped path, and it carries a bordered chip per period
// (@@L6136). The keyframe dots, the dimming, the time mapping and the block's
// bounds are the numeric lane's own, shared rather than reimplemented — they
// were reimplemented, and the copy drifted: it drew no keyframe dots and
// tiled its periods across the whole view instead of across the block.
function LaneCurve({
  curve,
  param,
  timeView,
  blockRange,
}: {
  // Null or empty only on a value lane, which still draws: one chip of the
  // parameter's own value, the display-only period the editor shows too.
  curve: AutomationCurve | null;
  param: PatternParam;
  timeView: { left: number; width: number };
  // The block's span as fractions of the song. The curve is drawn only inside
  // it: outside, the block is not in LayerV2.activeBlocks, so nothing is
  // evaluating its parameters and there is no value to show. Null for a lane
  // with no block behind it.
  blockRange: { start: number; end: number } | null;
}) {
  const clipId = useId().replace(/:/g, "");
  const isValueLane = isValueKind(laneKindOf(param.value));
  const x = (time: number) => ((time - timeView.left) / timeView.width) * 100;

  // A value lane has no vertical meaning, so every keyframe sits at the
  // middle; a numeric lane maps through the range the editor would settle on.
  const view = isValueLane ? null : laneViewRange(curve, param);
  const top = view
    ? (v: number) => ((view.center + view.span / 2 - v) / view.span) * 100
    : () => 50;

  const dimmed = !isCurveActive(curve);
  const keyframes = curve?.keyframes ?? [];
  if (!isValueLane && keyframes.length === 0) return null;

  // The body: what stands in for the shape of the automation.
  const body = isValueLane ? (
    <>
      {/* A neutral straight line: a value lane has no curve to draw. */}
      <div className={styles.valueBaseline} />
      {valueRegions({
        curve,
        timeToX: x,
        blockRange,
        emptyPayload: currentValuePayload(param.value),
      }).map((region) => (
        <div
          key={region.index}
          className={`${styles.valueSwatch} ${styles.valueSwatchMini} ${
            dimmed ? styles.valueSwatchDimmed : ""
          } ${region.gradient ? styles.valueSwatchWide : ""}`}
          style={{
            left: `${(region.from + region.to) / 2}%`,
            background: region.css,
          }}
        />
      ))}
    </>
  ) : (
    (() => {
      const segments = getSegments(curve!);
      const first = keyframes[0];
      const last = keyframes[keyframes.length - 1];
      const parts = [
        `M ${blockRange ? x(blockRange.start) : 0} ${top(first.value)}`,
      ];
      for (let i = 0; i < keyframes.length - 1; i++) {
        const a = keyframes[i];
        const b = keyframes[i + 1];
        // Route through the starting keyframe explicitly, so a segment whose
        // shape ends off its endpoint (wave, flat) never bleeds into the next.
        parts.push(`L ${x(a.time)} ${top(a.value)}`);
        // Lower detail than the big editor: the lane is only ~30px tall.
        for (const point of sampleSegment(a, b, segments[i], 1 / 3))
          parts.push(
            `L ${x(a.time + (b.time - a.time) * point.t)} ${top(point.value)}`,
          );
      }
      parts.push(`L ${x(last.time)} ${top(last.value)}`);
      // The hold past the last keyframe exists only while that keyframe is
      // inside the block, and stops at the block's end. A keyframe beyond the
      // end (what a right-trim leaves) gets no hold: drawing one to the
      // block's end would run backwards. Mirrors buildFullPath in the editor.
      const holdEnd = blockRange
        ? last.time < blockRange.end
          ? x(blockRange.end)
          : null
        : 100;
      if (holdEnd !== null) parts.push(`L ${holdEnd} ${top(last.value)}`);

      // Anything past the block's end draws dotted, the same as in the editor.
      const overhangX =
        blockRange && last.time > blockRange.end ? x(blockRange.end) : null;
      const d = parts.join(" ");

      return (
        <svg
          className={`${styles.laneCurveSvg} ${dimmed ? styles.curveDimmed : ""}`}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {overhangX !== null && (
            <defs>
              <clipPath id={`${clipId}-in`}>
                <rect x="-500" y="-500" width={500 + overhangX} height="1100" />
              </clipPath>
              <clipPath id={`${clipId}-out`}>
                <rect x={overhangX} y="-500" width="1000" height="1100" />
              </clipPath>
            </defs>
          )}
          <path
            className={styles.curvePath}
            d={d}
            clipPath={overhangX !== null ? `url(#${clipId}-in)` : undefined}
          />
          {overhangX !== null && (
            <path
              className={`${styles.curvePath} ${styles.curvePathOutside}`}
              d={d}
              clipPath={`url(#${clipId}-out)`}
            />
          )}
        </svg>
      );
    })()
  );

  return (
    <>
      {body}
      {/* Scale-model keyframe dots (positioned divs, not svg circles: the
          stretched viewBox would deform them into ovals). Every lane kind
          gets them — "the automation preview curve should also show the
          keyframes but they should be smaller" (@@L776) — a value lane's
          simply sit on its baseline. */}
      {keyframes.map((keyframe, index) => {
        const left = x(keyframe.time);
        if (left < 0 || left > 100) return null;
        return (
          <div
            key={index}
            className={`${styles.laneKeyframeDot} ${
              dimmed ? styles.laneKeyframeDotDimmed : ""
            }`}
            style={{ left: `${left}%`, top: `${top(keyframe.value)}%` }}
          />
        );
      })}
    </>
  );
}

// The transport's current time on a lane's curve: the same gold
// keyframe-sized dot as the expanded editor, scaled into the lane's value
// range. Positioned imperatively each frame.
function LaneTimeDot({
  curve,
  param,
}: {
  curve: AutomationCurve | null;
  param: PatternParam;
}) {
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame: number;
    const update = () => {
      frame = requestAnimationFrame(update);
      const dot = dotRef.current;
      if (!dot) return;
      const { seconds, durationSeconds } = transportTime;
      // A deactivated curve is not driving the parameter: the dot follows
      // the manual value instead. Value lanes (color, palette) have
      // no numeric dot at all.
      const driving =
        !!curve &&
        curve.keyframes.length > 0 &&
        isCurveActive(curve) &&
        typeof param.value === "number";
      const value = driving
        ? evaluateCurve(curve!, clamp01(seconds / (durationSeconds || 1)))
        : typeof param.value === "number"
          ? param.value
          : null;
      if (!durationSeconds || value === null) {
        dot.style.opacity = "0";
        return;
      }
      const frac = clamp01(seconds / durationSeconds);
      const x = ((frac - timeViewport.left) / timeViewport.width) * 100;
      const view = laneViewRange(curve, param);
      const viewMax = view.center + view.span / 2;
      const top = ((viewMax - value) / view.span) * 100;
      dot.style.opacity = x < -1 || x > 101 ? "0" : "1";
      dot.style.left = `${x}%`;
      dot.style.top = `${top}%`;
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [curve, param]);

  return <div ref={dotRef} className={styles.timeDot} />;
}

// The "manual value": what the param is when no automation is active —
// i.e. the value set in the pattern editor. Rendered as a constant horizontal
// line across the lane, mapped through the lane's shared value range.
// Dashed and bright when it overlays a deactivated curve, since it is the
// line actually driving the parameter then. Scrubs in the pattern editor
// mutate param.value outside React, so the line tracks it with a per-frame
// read and writes style.top directly — no re-renders.
export function ManualValueLine({
  param,
  curve = null,
  dashed = false,
}: {
  param: PatternParam;
  curve?: AutomationCurve | null;
  dashed?: boolean;
}) {
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame: number;
    const update = () => {
      const { value } = param;
      if (typeof value === "number" && lineRef.current) {
        const view = laneViewRange(curve, param);
        const viewMax = view.center + view.span / 2;
        lineRef.current.style.top = `${((viewMax - value) / view.span) * 100}%`;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [param, curve]);

  if (typeof param.value !== "number") return null;
  return (
    <div
      ref={lineRef}
      className={`${styles.laneValueLine} ${
        dashed ? styles.laneValueLineDashed : ""
      }`}
    />
  );
}

// Ableton-style automation lanes: one row per automated param (added via
// right-click in the pattern editor). Each row's label box is the same width
// as the timeline's transport box so the lane areas align with the timeline
// ticks. Lane content itself is still to come. The pane is resized by
// dragging its top edge.
export const AutomationPane = observer(function AutomationPane({
  entries,
  layers,
  onBlockTimingChange,
  selectedLane,
  onSelectLane,
  onStartAssign,
  onToggleLaneActive,
  onDeleteLane,
  laneOrder,
  onReorderLanes,
}: Props) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  // Lanes share the timeline's visible time window.
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
  const dragState = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );

  const unorderedLanes = entries.flatMap((entry) =>
    // The block's lanes, plus visibility if it has one — visibility is not a
    // shader uniform so it has no home in the block (see StackEntry).
    [
      ...laneKeysOf(entry.block),
      ...(entry.visibilityCurve ? [VISIBILITY_PARAM] : []),
    ].flatMap((uniform: string) => {
      const resolved = resolveLane(entry, uniform);
      if (!resolved) return [];
      // The block's span, for clipping the curve to it. An effect's params run
      // over the parent block's timeline, and `entry.block` IS that parent, so
      // one range covers every lane of the entry.
      const songDuration = getLaneSongDuration();
      const blockRange =
        songDuration > 0
          ? {
              start: entry.block.startTime / songDuration,
              end: (entry.block.startTime + entry.block.duration) / songDuration,
            }
          : null;
      return [
        {
          key: `${entry.id}-${uniform}`,
          entryId: entry.id,
          uniform,
          blockRange,
          // The block's own header lane carries the pattern name now, so a
          // parameter lane no longer repeats it — "on the left of it, it'll say
          // nebula for that pattern, then underneath that will be all of the
          // parameters for that block". An effect's params still name their
          // effect, since that is what distinguishes them within the block.
          patternName:
            "effectName" in resolved && resolved.effectName
              ? resolved.effectName
              : "",
          paramName: resolved.paramName,
          param: resolved.param,
          curve:
            uniform === VISIBILITY_PARAM
              ? entry.visibilityCurve ?? null
              : laneCurve(entry.block, uniform),
        },
      ];
    }),
  );

  // The block's time range, drawn in the header lane's plot area (decision 10).
  //
  // Grabbing the BAR moves the block, and its keyframes travel with it for
  // free: region times are block-local, so shifting startTime shifts every
  // keyframe's song position without touching a single region.
  //
  // The edges resize with the un-grabbed edge held: dragging the LEFT edge
  // earlier moves the start AND grows the duration; dragging the RIGHT edge
  // only grows the duration. Regions are deliberately left alone (decision 16,
  // matching upstream) — a trimmed block leaves them overhanging and unplayed,
  // an extended one holds its last value, and a wave keeps its size rather
  // than oscillating on into the new space.
  //
  // Leaving regions alone is also what makes the left edge carry the curve's
  // START with it, which is the owner's rule: "the curve should start at the
  // start of the block." The alternative — rewriting region times so the
  // automation held still in song time — was built to his spec, tried, and
  // reversed for this. Don't rebuild it; see testBlockLanes.ts.
  const BlockBar = ({
    block,
    timeView,
    onChange,
  }: {
    block: Block;
    timeView: { left: number; width: number };
    onChange: (block: Block, startTime: number, duration: number) => void;
  }) => {
    const songDuration = getLaneSongDuration();
    if (!(songDuration > 0)) return null;
    const startFrac = block.startTime / songDuration;
    const endFrac = (block.startTime + block.duration) / songDuration;
    const toPct = (frac: number) =>
      ((frac - timeView.left) / timeView.width) * 100;

    const drag =
      (mode: "move" | "left" | "right") =>
      (event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const area = (event.currentTarget as HTMLElement).closest(
          `.${styles.blockLaneArea}`,
        ) as HTMLElement | null;
        const areaWidth = area?.getBoundingClientRect().width ?? 1;
        const startX = event.clientX;
        const originStart = block.startTime;
        const originDuration = block.duration;
        // Pixels to seconds, through the visible window rather than the whole
        // song: the lanes draw the viewport, not the timeline entire.
        const perPixel = (timeView.width * songDuration) / areaWidth;

        const onMove = (moveEvent: PointerEvent) => {
          const delta = (moveEvent.clientX - startX) * perPixel;
          if (mode === "move") {
            // "Blocks shouldn't be able to be dragged such that their right
            // side goes past the end of the timeline." Moving is bounded at
            // both ends, so the block stays inside the song. A block longer
            // than the song pins to the start rather than jittering.
            const latest = Math.max(0, songDuration - originDuration);
            const next = Math.min(Math.max(0, originStart + delta), latest);
            onChange(block, next, originDuration);
          } else if (mode === "left") {
            // The right edge holds: an earlier start is a longer block.
            const next = Math.min(
              Math.max(0, originStart + delta),
              originStart + originDuration - 0.05,
            );
            onChange(block, next, originStart + originDuration - next);
          } else {
            // Growing the right edge stops at the end of the song.
            const longest = Math.max(0.05, songDuration - originStart);
            onChange(
              block,
              originStart,
              Math.min(Math.max(0.05, originDuration + delta), longest),
            );
          }
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      };

    return (
      <div
        className={styles.blockBar}
        data-doc="block-bar"
        style={{
          left: `${toPct(startFrac)}%`,
          width: `${toPct(endFrac) - toPct(startFrac)}%`,
        }}
        onPointerDown={drag("move")}
      >
        <div
          className={styles.blockEdge}
          data-doc="block-edge-left"
          onPointerDown={drag("left")}
        />
        <div
          className={`${styles.blockEdge} ${styles.blockEdgeRight}`}
          data-doc="block-edge-right"
          onPointerDown={drag("right")}
        />
      </div>
    );
  };

  // One parameter lane. Extracted so the layer and block headers can group
  // them (decision 3): the rows themselves are unchanged.
  const renderLane = (lane: (typeof lanes)[number]) => (
        <div
          key={lane.key}
          className={`${styles.laneRow} ${
            selectedLane?.entryId === lane.entryId &&
            selectedLane?.uniform === lane.uniform
              ? styles.laneRowSelected
              : ""
          } ${draggingKey === orderKey(lane) ? styles.laneRowDragging : ""}`}
          data-doc="automation-lane"
          data-lane-key={orderKey(lane)}
          onClick={() => {
            // A completed label drag must not also expand the editor.
            if (dragJustEnded.current) {
              dragJustEnded.current = false;
              return;
            }
            onSelectLane({ entryId: lane.entryId, uniform: lane.uniform });
          }}
        >
          <div className={styles.laneLabel}>
            <div
              className={styles.laneLabelText}
              onPointerDown={onLabelPointerDown(orderKey(lane))}
            >
              <span className={styles.laneLabelPattern}>
                {lane.patternName}
              </span>
              <span className={styles.laneLabelParam}>{lane.paramName}</span>
            </div>
            <div className={styles.laneControls}>
              {(() => {
                // An empty lane is inert, not suspended: it shows an
                // open eye, disabled. Only a curve with keyframes
                // toggles.
                const suspended =
                  !!lane.curve &&
                  lane.curve.keyframes.length > 0 &&
                  !isCurveActive(lane.curve);
                return (
                  <button
                    className={`${styles.laneControlButton} ${
                      suspended ? styles.laneControlSuspended : ""
                    }`}
                    data-doc="lane-visibility"
                    disabled={
                      !lane.curve || lane.curve.keyframes.length === 0
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleLaneActive(lane.entryId, lane.uniform);
                    }}
                    aria-label={suspended ? "Enable lane" : "Disable lane"}
                  >
                    {suspended ? (
                      <FaEyeSlash size={11} />
                    ) : (
                      <FaEye size={11} />
                    )}
                  </button>
                );
              })()}
              <button
                className={styles.laneControlButton}
                data-doc="lane-delete"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteLane(lane.entryId, lane.uniform);
                }}
                aria-label="Delete lane"
              >
                <FaTrashAlt size={10} />
              </button>
            </div>
          </div>
          <div className={styles.laneArea}>
            {(() => {
              // A value lane always draws, keyframes or not: with none it
              // shows one chip of the parameter's own value. A numeric lane
              // with no curve shows its manual value line instead, and shows
              // it over a suspended curve, where that line is what actually
              // drives the parameter. A value lane has no such line: it has
              // no vertical axis to draw one on.
              const isValueLane = isValueKind(laneKindOf(lane.param.value));
              const automated = !!lane.curve && lane.curve.keyframes.length > 0;
              if (!isValueLane && !automated)
                return <ManualValueLine param={lane.param} />;
              return (
                <>
                  <LaneCurve
                    curve={lane.curve}
                    param={lane.param}
                    timeView={timeView}
                    blockRange={lane.blockRange}
                  />
                  {!isValueLane && !isCurveActive(lane.curve) && (
                    <ManualValueLine
                      param={lane.param}
                      curve={lane.curve}
                      dashed
                    />
                  )}
                </>
              );
            })()}
            <LaneTimeDot curve={lane.curve} param={lane.param} />
          </div>
        </div>
  );

  // Sort by the persisted order; lanes not yet listed keep their natural
  // position after the listed ones (sort is stable).
  const orderKey = (lane: { entryId: string; uniform: string }) =>
    `${lane.entryId}/${lane.uniform}`;
  const orderIndex = new Map(laneOrder.map((key, index) => [key, index]));
  const lanes = [...unorderedLanes].sort((a, b) => {
    const ai = orderIndex.get(orderKey(a));
    const bi = orderIndex.get(orderKey(b));
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return 0;
  });

  // Drag a label to reorder: live while dragging (each crossing commits
  // the new order), with the row click suppressed after a real drag so
  // releasing does not also expand the editor.
  const lanesRef = useRef<HTMLDivElement>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const dragJustEnded = useRef(false);
  const onLabelPointerDown =
    (laneKey: string) => (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      let dragging = false;
      const onMove = (moveEvent: PointerEvent) => {
        if (!dragging && Math.abs(moveEvent.clientY - startY) < 5) return;
        if (!dragging) {
          dragging = true;
          setDraggingKey(laneKey);
        }
        const container = lanesRef.current;
        if (!container) return;
        const rows = Array.from(container.querySelectorAll("[data-lane-key]"));
        const keys = rows.map(
          (row) => row.getAttribute("data-lane-key") as string,
        );
        const from = keys.indexOf(laneKey);
        if (from === -1) return;
        // Target slot: how many OTHER rows sit above the pointer.
        let to = 0;
        for (const row of rows) {
          if (row.getAttribute("data-lane-key") === laneKey) continue;
          const rect = row.getBoundingClientRect();
          if (moveEvent.clientY >= rect.top + rect.height / 2) to++;
        }
        if (to !== from) {
          const next = keys.filter((key) => key !== laneKey);
          next.splice(to, 0, laneKey);
          onReorderLanes(next);
        }
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        if (dragging) {
          dragJustEnded.current = true;
          setDraggingKey(null);
        }
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    };

  return (
    <section
      className={styles.automationPane}
      style={{ height }}
      data-doc="automation-pane"
    >
      <div
        data-doc="automation-resize"
        className={styles.resizeHandle}
        onPointerDown={(event) => {
          event.preventDefault();
          // Track the pointer even when it leaves the 9px handle mid-drag.
          // Can throw (NotFoundError) if the pointer is no longer active;
          // the drag still works for as long as the pointer stays over the
          // handle, so don't let that abort it.
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {}
          dragState.current = { startY: event.clientY, startHeight: height };
        }}
        onPointerMove={(event) => {
          if (!dragState.current) return;
          const { startY, startHeight } = dragState.current;
          setHeight(clampHeight(startHeight + startY - event.clientY));
        }}
        onPointerUp={() => (dragState.current = null)}
        onPointerCancel={() => (dragState.current = null)}
      />
      <div className={`${styles.paneLabel} ${styles.paneLabelGlow}`}>
        Automation
      </div>
      <div className={styles.lanes} ref={lanesRef}>
        {layers.map((layer, layerIndex) => {
          const layerEntries = entries.filter(
            (entry) => entry.block.layer === layer,
          );
          return (
            <div key={layer.id} className={styles.laneLayerGroup}>
              {/* The layer's own lane: a header like a parameter's name lane,
                  ordered to match the layer list on the left. */}
              <div className={styles.laneLayerHeader} data-doc="lane-layer">
                <span className={styles.laneLayerName}>
                  {layer.name || `Layer ${layerIndex + 1}`}
                </span>
              </div>

              {layerEntries.map((entry) => (
                <div key={entry.id} className={styles.laneBlockGroup}>
                  {/* The block's own lane. It carries no curve yet — its job is
                      to group and label, and it is where block timing will be
                      grabbed (decisions 3 and 4). */}
                  <div className={styles.laneBlockHeader} data-doc="lane-block">
                    {/* The label keeps the left column, as every lane does, so
                        the bar beside it starts where every plot area does. */}
                    <div className={styles.laneLabel}>
                      <span className={styles.laneBlockName}>
                        {formatDisplayName(entry.pattern.name)}
                      </span>
                    </div>
                    <div className={styles.blockLaneArea}>
                      <BlockBar
                        block={entry.block}
                        timeView={timeView}
                        onChange={onBlockTimingChange}
                      />
                    </div>
                  </div>
                  {lanes
                    .filter((lane) => lane.entryId === entry.id)
                    .map(renderLane)}
                </div>
              ))}
            </div>
          );
        })}
        {/* The final lane is the way in: click, then pick a parameter
            in the pattern editor. Styled exactly like Add Pattern. */}
        <button
          className={`${styles.addPattern} ${styles.addLaneSpacing}`}
          data-doc="add-lane"
          onClick={onStartAssign}
        >
          <FaPlus size={11} /> Add Automation
        </button>
      </div>
    </section>
  );
});
