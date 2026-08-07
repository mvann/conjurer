import { useEffect, useRef, useState } from "react";
import styles from "@/styles/EditorV2.module.css";
import { PatternParam } from "@/src/params/shared/patternParam";
import { EDITOR_DIRTY_EVENT } from "@/src/components/EditorV2/experiencePersistence";

// Display with just enough precision to see fine (shift) drags move.
const formatNumber = (value: number) => String(parseFloat(value.toFixed(3)));

// Past this much vertical travel, the press counts as a drag, not a click.
const DRAG_THRESHOLD_PX = 3;
// A press shorter than this (without dragging) counts as a click.
const CLICK_MS = 250;

// A number that edits like Ableton/Blender fields: drag up/down to scrub it
// (hold shift for 10x finer steps), or click/double-click to type a value.
// A quick press with no movement is a click; sustained or moving presses
// scrub. Writes straight into param.value — the live uniforms object — so
// the canopy reflects the change as you drag. onUserEdit fires on every
// user-made commit (scrub step or typed value), never on outside changes.
export function ScrubbableNumber({
  param,
  onUserEdit,
  onCommitted,
  displayAs,
}: {
  param: PatternParam<number>;
  onUserEdit?: () => void;
  // Fires AFTER the new value has landed on the param, which onUserEdit
  // cannot do: it runs first, so that takeover can suspend a lane before the
  // value moves. Anything that needs to READ the committed value — writing a
  // manual value through to its region, say — belongs here.
  onCommitted?: (value: number) => void;
  // Shown in place of the number. For opacity in AUTO, which has no authored
  // value to show but must still drag: the first drag commits, which is what
  // turns auto into a real one (decision 25), and the word is replaced by the
  // number it just became.
  displayAs?: string;
}) {
  const [displayValue, setDisplayValue] = useState(param.value);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Per-pixel step: span the param's range over ~300px of drag, or a sane
  // default for unbounded params.
  const coarseStep =
    param.min !== undefined && param.max !== undefined
      ? (param.max - param.min) / 300
      : 0.01;

  const clamp = (value: number) => {
    if (param.min !== undefined) value = Math.max(value, param.min);
    if (param.max !== undefined) value = Math.min(value, param.max);
    return value;
  };

  // Scrubs land on multiples of the param's declared step; shift skips
  // the snap for fine adjustment. Typed values stay exact.
  const snap = (value: number, fine: boolean) => {
    const { step } = param;
    if (fine || typeof step !== "number" || step <= 0) return value;
    return Math.round(value / step) * step;
  };

  const commit = (value: number) => {
    onUserEdit?.();
    param.value = value;
    setDisplayValue(value);
    onCommitted?.(value);
    // Param mutations happen outside React state; tell the autosave.
    window.dispatchEvent(new Event(EDITOR_DIRTY_EVENT));
  };

  const startEditing = () => {
    setDraft(formatNumber(param.value));
    setIsEditing(true);
  };

  // End-of-drag cleanup lives on the ref so unmount mid-drag can't leak
  // listeners.
  const endDrag = useRef<() => void>();
  useEffect(() => () => endDrag.current?.(), []);

  // Params can change outside this field (automation driving the value
  // during playback), so the display follows param.value each frame when
  // not being typed into. Same-value updates bail out with no re-render.
  useEffect(() => {
    let frame: number;
    const sync = () => {
      frame = requestAnimationFrame(sync);
      if (typeof param.value === "number") setDisplayValue(param.value);
    };
    frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, [param]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || isEditing) return;
    event.preventDefault();

    const startedAt = performance.now();
    const drag = {
      value: param.value,
      lastY: event.clientY,
      traveled: 0,
    };

    // While scrubbing, the cursor sweeps across other text — suppress
    // selection document-wide for the duration of the drag only, so
    // everything stays normally selectable otherwise.
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: PointerEvent) => {
      const deltaY = moveEvent.clientY - drag.lastY;
      drag.lastY = moveEvent.clientY;
      drag.traveled += Math.abs(deltaY);
      if (drag.traveled < DRAG_THRESHOLD_PX) return;

      const perPixel = moveEvent.shiftKey ? coarseStep / 10 : coarseStep;
      // Drag up to increase. The raw value accumulates smoothly; the
      // committed value snaps to the declared step (shift bypasses).
      drag.value = clamp(drag.value - deltaY * perPixel);
      commit(clamp(snap(drag.value, moveEvent.shiftKey)));
    };
    const end = () => {
      endDrag.current = undefined;
      document.body.style.userSelect = previousUserSelect;
      window.getSelection()?.removeAllRanges();
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
    const onUp = () => {
      const wasClick =
        drag.traveled < DRAG_THRESHOLD_PX &&
        performance.now() - startedAt < CLICK_MS;
      end();
      if (wasClick) startEditing();
    };
    endDrag.current = end;
    // Pointer events end-to-end: canceling pointerdown (to stop text
    // selection) suppresses the compatibility MOUSE events in some browsers,
    // so a mouseup listener can miss the release and the drag never ends.
    // pointerup/pointercancel always fire; blur catches release outside the
    // window.
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
  };

  const commitDraft = () => {
    const parsed = parseFloat(draft);
    if (!isNaN(parsed)) commit(clamp(parsed));
    setIsEditing(false);
  };

  if (isEditing)
    return (
      <input
        className={styles.paramInput}
        value={draft}
        autoFocus
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitDraft();
          else if (event.key === "Escape") setIsEditing(false);
        }}
        onBlur={commitDraft}
      />
    );

  return (
    <span
      data-doc="param-value"
      className={`${styles.paramValue} ${styles.paramScrub}`}
      onPointerDown={onPointerDown}
      title="Drag to change · shift for fine · click to type"
    >
      {displayAs ?? formatNumber(displayValue)}
    </span>
  );
}
