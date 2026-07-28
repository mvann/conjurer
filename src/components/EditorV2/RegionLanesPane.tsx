import { observer } from "mobx-react-lite";
import { action } from "mobx";
import styles from "@/styles/EditorV2.module.css";
import { formatDisplayName } from "@/src/components/EditorV2/formatDisplayName";
import { transportTime } from "@/src/components/EditorV2/timeViewport";
import { useStore } from "@/src/types/StoreContext";
import { Block } from "@/src/types/Block";
import { Variation } from "@/src/types/Variations/Variation";
import { CurveVariation } from "@/src/types/Variations/CurveVariation";
import { LinearVariation4 } from "@/src/types/Variations/LinearVariation4";
import { PaletteVariation } from "@/src/params/palette/variation/PaletteVariation";
import { BASE_UNIFORMS } from "@/src/types/Pattern";

// The lanes area, re-based on the region model: one header lane per
// layer (its order mirrors the left pane), one header lane per block
// (the block's time extent as a bar; the way in for timing edits), and
// beneath each block a lane per parameter that HAS automation.
//
// What counts as automation follows the lone-flat convention: a lane
// whose regions reduce to a single constant is the manual value and
// shows no lane — unless the parameter is promoted (present in the
// block's lanedParams, the upstream open-lanes set). lanedParams also
// records which lanes are expanded; absent lanes render shrunk.

// A lane is constant when it holds one region whose output never
// changes: a flat/constant curve, a from==to linear4, or a lone
// palette tile.
export const isConstantLane = (variations: Variation[] | undefined) => {
  if (!variations || variations.length === 0) return true;
  if (variations.length > 1) return false;
  const only = variations[0];
  if (only instanceof CurveVariation)
    return only.nodes.every(
      (node) => Math.abs(node.value - only.nodes[0].value) < 1e-9,
    );
  if (only instanceof LinearVariation4) return only.from.equals(only.to);
  if (only instanceof PaletteVariation) return true;
  return false;
};

// Uniform names on a block that display a lane: non-constant regions
// always; constant ones only when promoted via lanedParams.
export const laneUniforms = (block: Block) =>
  Object.keys(block.parameterVariations).filter((uniform) => {
    if (BASE_UNIFORMS.includes(uniform) && uniform !== "u_opacity")
      return false;
    const regions = block.parameterVariations[uniform];
    if (!regions || regions.length === 0) return false;
    return !isConstantLane(regions) || block.lanedParams.has(uniform);
  });

// Sampled preview polyline for a lane's regions, normalized to the
// value range the regions actually occupy.
const lanePreviewPoints = (
  regions: Variation[],
  width: number,
  height: number,
) => {
  const total = regions.reduce((sum, region) => sum + region.duration, 0);
  if (total <= 0) return "";
  const samples: { t: number; v: number }[] = [];
  let elapsed = 0;
  for (const region of regions) {
    const count = Math.max(
      8,
      Math.min(64, Math.round((region.duration / total) * 120)),
    );
    for (let i = 0; i <= count; i++) {
      const local = (i / count) * region.duration;
      const value = region.valueAtTime(local, elapsed + local);
      if (typeof value === "number" && Number.isFinite(value))
        samples.push({ t: elapsed + local, v: value });
    }
    elapsed += region.duration;
  }
  if (samples.length === 0) return "";
  const values = samples.map((sample) => sample.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  return samples
    .map(
      (sample) =>
        `${((sample.t / total) * width).toFixed(1)},${(
          pad +
          (1 - (sample.v - min) / span) * (height - 2 * pad)
        ).toFixed(1)}`,
    )
    .join(" ");
};

const LanePreview = observer(function LanePreview({
  block,
  uniform,
  expanded,
}: {
  block: Block;
  uniform: string;
  expanded: boolean;
}) {
  const regions = block.parameterVariations[uniform] ?? [];
  const height = expanded ? 44 : 12;
  const numeric = regions.every(
    (region) => typeof region.valueAtTime(0, 0) === "number",
  );
  return (
    <div
      className={`${styles.laneCurveArea} ${expanded ? "" : styles.laneShrunk}`}
      style={{ height }}
    >
      {numeric ? (
        <svg
          className={styles.lanePreviewSvg}
          width="100%"
          height={height}
          preserveAspectRatio="none"
          viewBox={`0 0 400 ${height}`}
        >
          <polyline
            className={styles.lanePreviewLine}
            fill="none"
            points={lanePreviewPoints(regions, 400, height)}
          />
        </svg>
      ) : (
        <div className={styles.laneValueTiles}>
          {regions.map((region, index) => (
            <div
              key={index}
              className={styles.laneValueTile}
              style={{
                flexGrow: region.duration,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
});

// The block's own lane: its time extent as a bar across the song.
// Dragging the left edge moves the start (right edge holds); the right
// edge changes the duration; the bar's body moves the whole block,
// keyframes and all. Regions are never touched by timing edits
// (decision 16, matching upstream): extending holds the last value,
// trimming leaves regions overhanging unplayed.
const EDGE_GRAB_PX = 7;

const BlockHeaderLane = observer(function BlockHeaderLane({
  block,
}: {
  block: Block;
}) {
  const songSeconds = transportTime.durationSeconds || block.endTime || 1;
  const leftPct = Math.min(100, (block.startTime / songSeconds) * 100);
  const widthPct = Math.max(
    0,
    Math.min(100 - leftPct, (block.duration / songSeconds) * 100),
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const bar = event.currentTarget;
    const area = bar.parentElement!;
    const areaRect = area.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const secondsPerPx = songSeconds / areaRect.width;
    const mode =
      event.clientX - barRect.left <= EDGE_GRAB_PX
        ? "left"
        : barRect.right - event.clientX <= EDGE_GRAB_PX
          ? "right"
          : "move";
    const startX = event.clientX;
    const startTime = block.startTime;
    let lastLeftDelta = 0;
    let lastRightDelta = 0;

    const onMove = action((moveEvent: PointerEvent) => {
      const deltaSeconds = (moveEvent.clientX - startX) * secondsPerPx;
      const layer = block.layer;
      if (!layer) return;
      if (mode === "move") {
        layer.attemptMoveBlock(block, Math.max(0, startTime + deltaSeconds));
      } else if (mode === "left") {
        // Their resize APIs take incremental deltas; feed the change
        // since the last move so the math matches upstream exactly.
        layer.resizeBlockLeftBound(block, deltaSeconds - lastLeftDelta);
        lastLeftDelta = deltaSeconds;
      } else {
        layer.resizeBlockRightBound(block, deltaSeconds - lastRightDelta);
        lastRightDelta = deltaSeconds;
      }
    });
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div className={styles.blockBarArea}>
      <div
        className={styles.blockBar}
        data-doc="block-bar"
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        onPointerDown={onPointerDown}
      />
      <div
        className={styles.blockBarEdge}
        style={{ left: `calc(${leftPct}% - 1px)` }}
      />
      <div
        className={styles.blockBarEdge}
        style={{ left: `calc(${leftPct + widthPct}% - 1px)` }}
      />
    </div>
  );
});

const MIN_PANE_HEIGHT = 140;
const maxPaneHeight = () =>
  typeof window === "undefined" ? 480 : window.innerHeight * 0.45;

type Props = {
  selectedLane: { blockId: string; uniform: string } | null;
  onSelectLane: (blockId: string, uniform: string) => void;
};

export const RegionLanesPane = observer(function RegionLanesPane({
  selectedLane,
  onSelectLane,
}: Props) {
  const store = useStore();

  // The pane sizes to its rows (like the legacy pane): layer headers,
  // block headers, and lanes at their expanded or shrunk heights,
  // clamped so the canopy always keeps most of the screen.
  const rowHeights = store.layers.reduce((sum, layer) => {
    let height = sum + 25; // layer header
    for (const block of layer.getAllBlocks()) {
      height += 30; // block header lane
      for (const uniform of laneUniforms(block))
        height += block.lanedParams.has(uniform) ? 48 : 18;
    }
    return height;
  }, 0);
  const height = Math.min(
    Math.max(rowHeights + 44, MIN_PANE_HEIGHT),
    maxPaneHeight(),
  );

  return (
    <section
      className={styles.automationPane}
      data-doc="automation-lanes"
      style={{ height }}
    >
      <div className={`${styles.paneLabel} ${styles.paneLabelGlow}`}>
        Automation
      </div>
      <div className={styles.lanes}>
        {store.layers.map((layer, layerIndex) => (
          <div key={layer.id} data-doc="lane-layer-group">
            <div className={styles.laneLayerRow} data-doc="lane-layer">
              <span className={styles.laneLayerName}>
                {layer.name || `Layer ${layerIndex + 1}`}
              </span>
            </div>
            {layer.getAllBlocks().map((block) => (
              <div key={block.id} data-doc="lane-block-group">
                <div
                  className={styles.laneRow}
                  data-doc="lane-block"
                  style={{ height: 30 }}
                >
                  <span className={styles.laneLabel}>
                    <span className={styles.laneLabelText}>
                      {formatDisplayName(block.pattern.name)}
                    </span>
                  </span>
                  <BlockHeaderLane block={block} />
                </div>
                {laneUniforms(block).map((uniform) => {
                  const expanded = block.lanedParams.has(uniform);
                  const param = block.pattern.params[uniform];
                  return (
                    <div
                      key={uniform}
                      className={`${styles.laneRow} ${
                        selectedLane?.blockId === block.id &&
                        selectedLane.uniform === uniform
                          ? styles.laneRowSelected
                          : ""
                      }`}
                      data-lane-key={`${block.id}/${uniform}`}
                      data-doc="lane-row"
                      style={{ height: expanded ? 48 : 18 }}
                      onClick={() => onSelectLane(block.id, uniform)}
                    >
                      <span className={styles.laneLabel}>
                        <span className={styles.laneLabelText}>
                          {formatDisplayName(param?.name ?? uniform)}
                        </span>
                        <button
                          className={styles.laneControlButton}
                          onClick={action((event: React.MouseEvent) => {
                            event.stopPropagation();
                            block.toggleParamLane(uniform);
                          })}
                          aria-label={expanded ? "Shrink lane" : "Expand lane"}
                        >
                          {expanded ? "–" : "+"}
                        </button>
                      </span>
                      <LanePreview
                        block={block}
                        uniform={uniform}
                        expanded={expanded}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
});
