import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import { action, runInAction } from "mobx";
import styles from "@/styles/EditorV2.module.css";
import { transportTime } from "@/src/components/EditorV2/timeViewport";
import { editorPrefs } from "@/src/components/EditorV2/editorPrefs";
import { BeatGrid } from "@/src/components/EditorV2/EditorV2Page";
import {
  ensureLaneRegions,
  laneKeyframes,
  laneSpans,
  laneTotal,
  laneValueAt,
  makeAudio,
  makeBakedCurve,
  makeWave,
  regionAt,
  splitGeneratorAt,
  ViewSpan,
} from "@/src/components/EditorV2/laneModel";
import { formatDisplayName } from "@/src/components/EditorV2/formatDisplayName";
import { Block } from "@/src/types/Block";
import { CurveVariation } from "@/src/types/Variations/CurveVariation";
import { PeriodicVariation } from "@/src/types/Variations/PeriodicVariation";
import { AudioVariation } from "@/src/types/Variations/AudioVariation";
import { useStore } from "@/src/types/StoreContext";

// The expanded editor, re-based on regions. The view spans the whole
// song; everywhere outside the block's extent is dimmed and inert
// (interactions there do nothing — decisions 11 and the dimmed-zone
// rule). Keyframes are curve nodes inside curve regions and boundary
// dots on generators (dragging either generator dot moves its offset,
// decision 14). Right-click a span to retype it (curve / wave /
// audio); right-click a curve node to type its value; right-click
// empty space for the snap menu.

type Props = {
  block: Block;
  uniform: string;
  beatGrid: BeatGrid | null;
  transients: number[] | null;
  // Horizontal orientation: the editor is a permanent fixture beside
  // the canopy, so the close X disappears (decision 32).
  hideClose?: boolean;
  onClose: () => void;
};

const SNAP_MODES = ["off", "grid", "transients"] as const;

export const RegionEditorView = observer(function RegionEditorView({
  block,
  uniform,
  beatGrid,
  transients,
  hideClose,
  onClose,
}: Props) {
  const store = useStore();
  const areaRef = useRef<HTMLDivElement>(null);
  const param = block.pattern.params[uniform];
  const regions = block.parameterVariations[uniform] ?? [];

  // Re-render ticker for mutations that mobx misses (in-place node
  // moves during drags trigger reactions on commit only).
  const [, setBump] = useState(0);
  const bump = () => setBump((b) => b + 1);

  const [selectedSpan, setSelectedSpan] = useState<ViewSpan | null>(null);
  const [spanMenu, setSpanMenu] = useState<{
    span: ViewSpan;
    x: number;
    y: number;
  } | null>(null);
  const [snapMenu, setSnapMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [nodeValueEdit, setNodeValueEdit] = useState<{
    regionIndex: number;
    nodeId: string;
    draft: string;
    x: number;
    y: number;
  } | null>(null);

  // ---- Time and value mapping ----
  const songSeconds =
    transportTime.durationSeconds || block.endTime || block.duration || 1;
  const timeToPct = (songSec: number) => (songSec / songSeconds) * 100;
  const localToPct = (local: number) => timeToPct(block.startTime + local);

  const declaredMin = typeof param?.min === "number" ? param.min : undefined;
  const declaredMax = typeof param?.max === "number" ? param.max : undefined;
  let viewMin = declaredMin ?? 0;
  let viewMax = declaredMax ?? 1;
  if (declaredMin === undefined || declaredMax === undefined) {
    // Fit the range to the lane's values, padded, zero-anchored like
    // the legacy autorange.
    const samples: number[] = [];
    const total = laneTotal(regions);
    for (let i = 0; i <= 60; i++)
      samples.push(laneValueAt(regions, (i / 60) * total));
    const lo = Math.min(...samples, 0);
    const hi = Math.max(...samples, 1);
    const pad = (hi - lo) * 0.15 || 0.5;
    viewMin = declaredMin ?? lo - pad;
    viewMax = declaredMax ?? hi + pad;
  }
  const valueToPct = (value: number) =>
    (1 - (value - viewMin) / (viewMax - viewMin || 1)) * 100;
  const pctToValue = (pct: number) =>
    viewMin + (1 - pct / 100) * (viewMax - viewMin);

  // ---- Snap ----
  const snapLocal = (local: number) => {
    const mode = editorPrefs.snapMode;
    const songSec = block.startTime + local;
    const frac = songSec / songSeconds;
    let targets: number[] | null = null;
    if (mode === "grid" && beatGrid) {
      const beatSeconds = 60 / beatGrid.bpm;
      const first = beatGrid.offsetSeconds % beatSeconds;
      targets = [];
      for (let t = first; t <= songSeconds; t += beatSeconds)
        targets.push(t / songSeconds);
    } else if (mode === "transients" && transients) {
      targets = transients;
    }
    if (!targets || targets.length === 0) return local;
    let best = frac;
    let bestDist = Infinity;
    for (const target of targets) {
      const dist = Math.abs(target - frac);
      if (dist < bestDist) {
        bestDist = dist;
        best = target;
      }
    }
    // Snap within ~1% of the song, like the legacy editor.
    if (bestDist > 0.01) return local;
    return best * songSeconds - block.startTime;
  };

  // ---- Geometry helpers ----
  const eventToLocal = (clientX: number, clientY: number) => {
    const rect = areaRef.current!.getBoundingClientRect();
    const songSec = ((clientX - rect.left) / rect.width) * songSeconds;
    const value = pctToValue(((clientY - rect.top) / rect.height) * 100);
    return { local: songSec - block.startTime, value };
  };
  const insideBlock = (local: number) =>
    local >= -1e-9 && local <= block.duration + 1e-9;

  // ---- Curve path sampling ----
  const buildPath = () => {
    const total = laneTotal(regions);
    if (total <= 0) return "";
    const steps = 320;
    const points: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const local = (i / steps) * Math.min(total, block.duration);
      const value = laneValueAt(regions, local);
      points.push(
        `${i === 0 ? "M" : "L"} ${localToPct(local).toFixed(3)} ${valueToPct(
          value,
        ).toFixed(3)}`,
      );
    }
    return points.join(" ");
  };

  // ---- Gestures ----
  const commit = action(() => {
    block.triggerVariationReactions(uniform);
  });

  const onAreaDoubleClick = action((event: React.MouseEvent) => {
    const { local, value } = eventToLocal(event.clientX, event.clientY);
    if (!insideBlock(local)) return; // dimmed zones do nothing
    const lane = ensureLaneRegions(
      block,
      uniform,
      typeof param?.value === "number" ? param.value : 0,
    );
    const { index, start } = regionAt(lane, local);
    const region = lane[index];
    if (region instanceof CurveVariation) {
      const snapped = snapLocal(local);
      const node = region.addNodeAtTime(snapped - start);
      region.setNode(node.id, node.time, value);
    } else {
      splitGeneratorAt(block, uniform, local);
    }
    commit();
  });

  const onNodePointerDown =
    (regionIndex: number, nodeId: string) => (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const region = regions[regionIndex] as CurveVariation;
      const starts = (() => {
        let acc = 0;
        return regions.map((candidate) => {
          const s = acc;
          acc += candidate.duration;
          return s;
        });
      })();
      const regionStart = starts[regionIndex];
      const onMove = (moveEvent: PointerEvent) => {
        const { local, value } = eventToLocal(
          moveEvent.clientX,
          moveEvent.clientY,
        );
        const clampedValue =
          declaredMin !== undefined && declaredMax !== undefined
            ? Math.max(declaredMin, Math.min(declaredMax, value))
            : value;
        const localInRegion = snapLocal(local) - regionStart;
        runInAction(() => {
          region.setNode(
            nodeId,
            Math.max(0, Math.min(region.duration, localInRegion)),
            clampedValue,
          );
        });
        bump();
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        commit();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    };

  const onGeneratorDotPointerDown =
    (regionIndex: number) => (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const region = regions[regionIndex];
      const startY = event.clientY;
      const rect = areaRef.current!.getBoundingClientRect();
      const valuePerPx = (viewMax - viewMin) / rect.height;
      const startOffset =
        region instanceof PeriodicVariation || region instanceof AudioVariation
          ? region.offset
          : 0;
      const onMove = (moveEvent: PointerEvent) => {
        const deltaValue = (startY - moveEvent.clientY) * valuePerPx;
        runInAction(() => {
          if (
            region instanceof PeriodicVariation ||
            region instanceof AudioVariation
          )
            region.offset = startOffset + deltaValue;
        });
        bump();
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        commit();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    };

  const onNodeDoubleClick =
    (regionIndex: number, nodeId: string) => (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const region = regions[regionIndex];
      if (region instanceof CurveVariation) {
        runInAction(() => region.removeNode(nodeId));
        commit();
      }
    };

  const retypeSpan = action(
    (span: ViewSpan, type: "curve" | "wave" | "audio") => {
      const leftValue = laneValueAt(regions, span.from);
      const amplitude = (viewMax - viewMin) / 4 || 0.25;
      if (type === "curve") {
        const baked = makeBakedCurve(regions, span.from, span.to);
        block.insertRegion(uniform, span.from, span.to, () => baked);
      } else if (type === "wave") {
        block.insertRegion(uniform, span.from, span.to, (duration) =>
          makeWave(duration, leftValue, amplitude),
        );
      } else {
        block.insertRegion(uniform, span.from, span.to, (duration) =>
          makeAudio(store, duration, leftValue),
        );
      }
      setSpanMenu(null);
      setSelectedSpan(null);
    },
  );

  // ---- Escape chain ----
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      if (nodeValueEdit) setNodeValueEdit(null);
      else if (spanMenu) setSpanMenu(null);
      else if (snapMenu) setSnapMenu(null);
      else if (selectedSpan) setSelectedSpan(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [nodeValueEdit, spanMenu, snapMenu, selectedSpan, onClose]);

  // ---- Derived render model ----
  const keyframes = laneKeyframes(regions);
  const spans = laneSpans(regions);
  const blockLeftPct = timeToPct(block.startTime);
  const blockRightPct = timeToPct(block.endTime);
  const valueTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    pct: f * 100,
    label: pctToValue(f * 100).toFixed(2),
  }));

  const commitNodeValue = () => {
    if (!nodeValueEdit) return;
    const region = regions[nodeValueEdit.regionIndex];
    if (region instanceof CurveVariation) {
      const node = region.nodes.find((n) => n.id === nodeValueEdit.nodeId);
      const parsed = parseFloat(nodeValueEdit.draft);
      if (node && Number.isFinite(parsed)) {
        const clamped =
          declaredMin !== undefined && declaredMax !== undefined
            ? Math.max(declaredMin, Math.min(declaredMax, parsed))
            : parsed;
        runInAction(() => region.setNode(node.id, node.time, clamped));
        commit();
      }
    }
    setNodeValueEdit(null);
  };

  const inspectorRegion = selectedSpan
    ? regions[selectedSpan.regionIndex]
    : null;

  const numberField = (
    label: string,
    value: number,
    onChange: (next: number) => void,
    step = 0.01,
  ) => (
    <label className={styles.inspectorRow} key={label}>
      <span className={styles.inspectorLabel}>{label}</span>
      <input
        className={styles.paramInput}
        type="number"
        step={step}
        value={Number.isFinite(value) ? Number(value.toFixed(4)) : 0}
        onChange={(event) => {
          const parsed = parseFloat(event.target.value);
          if (!Number.isFinite(parsed)) return;
          runInAction(() => onChange(parsed));
          commit();
        }}
      />
    </label>
  );

  return (
    <div className={styles.automationEditor} data-doc="automation-editor">
      {!hideClose && (
        <button
          className={styles.automationEditorClose}
          onClick={onClose}
          aria-label="Close automation editor"
        >
          ✕
        </button>
      )}

      <div
        ref={areaRef}
        className={styles.editorLineArea}
        data-doc="editor-area"
        onDoubleClick={onAreaDoubleClick}
        onContextMenu={(event) => {
          event.preventDefault();
          const { local } = eventToLocal(event.clientX, event.clientY);
          if (!insideBlock(local)) return;
          setSnapMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <svg
          className={styles.gridSvg}
          width="100%"
          height="100%"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {/* Dimmed outside the block (decision 11). */}
          {blockLeftPct > 0 && (
            <rect
              x={0}
              y={0}
              width={blockLeftPct}
              height={100}
              className={styles.editorDimZone}
            />
          )}
          {blockRightPct < 100 && (
            <rect
              x={blockRightPct}
              y={0}
              width={100 - blockRightPct}
              height={100}
              className={styles.editorDimZone}
            />
          )}
          {/* Region boundaries. */}
          {spans.map((span, index) =>
            index === 0 ? null : (
              <line
                key={`boundary-${index}`}
                x1={localToPct(span.from)}
                x2={localToPct(span.from)}
                y1={0}
                y2={100}
                className={styles.regionBoundaryLine}
              />
            ),
          )}
          {/* The lane's curve. */}
          <path
            className={styles.curvePath}
            d={buildPath()}
            vectorEffect="non-scaling-stroke"
          />
          {/* Span hit strips: click selects, right-click retypes. */}
          {spans.map((span, index) => (
            <rect
              key={`span-${index}`}
              x={localToPct(span.from)}
              y={0}
              width={Math.max(0, localToPct(span.to) - localToPct(span.from))}
              height={100}
              className={styles.spanHit}
              data-doc="span-hit"
              onClick={(event) => {
                event.stopPropagation();
                setSelectedSpan(span);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                // On the curve: the segment menu. Far from it: the
                // snap menu (the strip covers the full height, so
                // distance decides what "empty area" means).
                const { local } = eventToLocal(event.clientX, event.clientY);
                const rect = areaRef.current!.getBoundingClientRect();
                const curvePct = valueToPct(laneValueAt(regions, local));
                const clickPct =
                  ((event.clientY - rect.top) / rect.height) * 100;
                if (Math.abs(curvePct - clickPct) > 15) {
                  setSnapMenu({ x: event.clientX, y: event.clientY });
                  return;
                }
                setSelectedSpan(span);
                setSpanMenu({
                  span,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            />
          ))}
        </svg>

        {/* Value scale. */}
        {valueTicks.map((tick) => (
          <div
            key={tick.pct}
            className={styles.valueTick}
            style={{ top: `${tick.pct}%` }}
          >
            <span className={styles.valueTickLabel}>{tick.label}</span>
          </div>
        ))}

        {/* Keyframe dots. */}
        {keyframes.map((keyframe, index) => (
          <div
            key={`${keyframe.regionIndex}:${keyframe.nodeId ?? keyframe.edge}:${index}`}
            className={styles.keyframeDot}
            data-doc="keyframe"
            style={{
              left: `${localToPct(keyframe.time)}%`,
              top: `${valueToPct(keyframe.value)}%`,
            }}
            onPointerDown={
              keyframe.nodeId
                ? onNodePointerDown(keyframe.regionIndex, keyframe.nodeId)
                : onGeneratorDotPointerDown(keyframe.regionIndex)
            }
            onDoubleClick={
              keyframe.nodeId
                ? onNodeDoubleClick(keyframe.regionIndex, keyframe.nodeId)
                : (event) => event.stopPropagation()
            }
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!keyframe.nodeId) return;
              const region = regions[keyframe.regionIndex];
              if (!(region instanceof CurveVariation)) return;
              const node = region.nodes.find((n) => n.id === keyframe.nodeId);
              if (!node) return;
              setNodeValueEdit({
                regionIndex: keyframe.regionIndex,
                nodeId: keyframe.nodeId,
                draft: String(parseFloat(node.value.toFixed(3))),
                x: event.clientX,
                y: event.clientY,
              });
            }}
          />
        ))}

        {/* Playhead. */}
        <div
          className={styles.editorPlayhead}
          style={{ left: `${timeToPct(transportTime.seconds)}%` }}
        />
      </div>

      {/* Node value entry. */}
      {nodeValueEdit && (
        <input
          className={styles.keyframeValueInput}
          data-doc="keyframe-value"
          style={{ left: nodeValueEdit.x, top: nodeValueEdit.y - 28 }}
          autoFocus
          value={nodeValueEdit.draft}
          onChange={(event) =>
            setNodeValueEdit({ ...nodeValueEdit, draft: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") commitNodeValue();
          }}
          onBlur={commitNodeValue}
        />
      )}

      {/* Retype menu. */}
      {spanMenu && (
        <div
          className={styles.contextMenu}
          data-doc="retype-menu"
          style={{ left: spanMenu.x, top: spanMenu.y }}
        >
          <div className={styles.contextMenuLabel}>Segment</div>
          <button
            className={styles.contextMenuItem}
            onClick={() => retypeSpan(spanMenu.span, "curve")}
          >
            Curve
          </button>
          <button
            className={styles.contextMenuItem}
            onClick={() => retypeSpan(spanMenu.span, "wave")}
          >
            Wave
          </button>
          <button
            className={styles.contextMenuItem}
            onClick={() => retypeSpan(spanMenu.span, "audio")}
          >
            Audio
          </button>
        </div>
      )}

      {/* Snap menu. */}
      {snapMenu && (
        <div
          className={styles.contextMenu}
          data-doc="snap-menu"
          style={{ left: snapMenu.x, top: snapMenu.y }}
        >
          <div className={styles.contextMenuLabel}>Snap to</div>
          {SNAP_MODES.map((mode) => (
            <button
              key={mode}
              className={`${styles.contextMenuItem} ${
                editorPrefs.snapMode === mode
                  ? styles.contextMenuItemActive
                  : ""
              }`}
              disabled={
                (mode === "grid" && !beatGrid) ||
                (mode === "transients" && !transients)
              }
              onClick={() => {
                editorPrefs.snapMode = mode;
                setSnapMenu(null);
              }}
            >
              {mode === "off"
                ? "Off"
                : mode === "grid"
                  ? "BPM Grid"
                  : "Transients"}
            </button>
          ))}
        </div>
      )}

      {/* Inspector for the selected span. */}
      {selectedSpan && inspectorRegion && (
        <div className={styles.segmentInspector} data-doc="segment-inspector">
          <div className={styles.inspectorTitle}>
            {formatDisplayName(
              inspectorRegion instanceof PeriodicVariation
                ? "Wave"
                : inspectorRegion instanceof AudioVariation
                  ? "Audio"
                  : "Curve",
            )}
          </div>
          {inspectorRegion instanceof PeriodicVariation && (
            <>
              {numberField(
                "Frequency",
                1 / inspectorRegion.period,
                (next) => (inspectorRegion.period = 1 / Math.max(next, 1e-4)),
              )}
              {numberField(
                "Amplitude",
                inspectorRegion.amplitude,
                (next) => (inspectorRegion.amplitude = next),
              )}
              {numberField(
                "Phase",
                inspectorRegion.phase,
                (next) => (inspectorRegion.phase = next),
              )}
              {numberField(
                "Offset",
                inspectorRegion.offset,
                (next) => (inspectorRegion.offset = next),
              )}
            </>
          )}
          {inspectorRegion instanceof AudioVariation && (
            <>
              {numberField(
                "Factor",
                inspectorRegion.factor,
                (next) => (inspectorRegion.factor = next),
              )}
              {numberField(
                "Offset",
                inspectorRegion.offset,
                (next) => (inspectorRegion.offset = next),
              )}
              {numberField(
                "Smoothing",
                inspectorRegion.smoothing,
                (next) => (inspectorRegion.smoothing = next),
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});
