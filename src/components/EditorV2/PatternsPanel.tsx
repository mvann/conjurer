import { runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import {
  FaArrowDown,
  FaArrowUp,
  FaCaretDown,
  FaCaretRight,
  FaEye,
  FaEyeSlash,
  FaPlus,
  FaTrashAlt,
} from "react-icons/fa";
import styles from "@/styles/EditorV2.module.css";
import { AddPatternPane } from "@/src/components/EditorV2/AddPatternPane";
import { ScrubbableNumber } from "@/src/components/EditorV2/ScrubbableNumber";
import { formatDisplayName } from "@/src/components/EditorV2/formatDisplayName";
import { BASE_UNIFORMS, Pattern } from "@/src/types/Pattern";
import { ParamType, PatternParam } from "@/src/params/shared/patternParam";
import { getParamComponents } from "@/src/components/EditorV2/paramComponents";
import {
  AutomationCurve,
  isCurveActive,
} from "@/src/components/EditorV2/automation";
import { isVector4 } from "@/src/utils/object";
import { isPalette, Palette } from "@/src/params/palette/Palette";
import {
  ColorValueEditor,
  PaletteValueEditor,
  Rgba,
} from "@/src/components/EditorV2/ValueEditors";
import { EDITOR_DIRTY_EVENT } from "@/src/components/EditorV2/experiencePersistence";
import { effectLibrary } from "@/src/components/EditorV2/patternLibrary";
import type { Block } from "@/src/types/Block";
import type { Layer } from "@/src/types/Layer";
import {
  armLane,
  disarmLane,
  laneCurve,
  laneKeysOf,
  resumeLane,
  suspendLane,
  syncManualValue,
  writeLaneCurve,
} from "@/src/components/EditorV2/blockLanes";
import { Vector4 } from "three";

const formatParamValue = (value: ParamType) => {
  if (typeof value === "number") return String(Math.round(value * 100) / 100);
  if (isVector4(value))
    return `(${[value.x, value.y, value.z, value.w]
      .map((component) => Math.round(component * 100) / 100)
      .join(", ")})`;
  if (isPalette(value)) return "Palette";
  return "—";
};

// Sentinel key in automatedParams for a pattern's visibility toggle, which
// is automatable like a param but is not a shader uniform. Uniform names in
// practice are u_-prefixed, so this cannot collide.
export const VISIBILITY_PARAM = "__visibility";

// Opacity's uniform, upstream's own. It is in BASE_UNIFORMS, so every param
// list filter inherited from them hides it — the row is a deliberate
// exception (decision 25).
export const OPACITY_PARAM = "u_opacity";

// An effect applied to a pattern: a Pattern whose shader transforms the
// previous render stage (u_texture). Chained in order after the pattern.
//
// `block` is the effect's nested block in the data model, and `pattern` is
// that block's own pattern object — the SAME reference, not a copy, so there
// is nothing to keep in sync.
export type EffectEntry = {
  id: string;
  pattern: Pattern;
  block: Block;
};

// Lane key for an effect's parameter. Pattern params use the bare
// uniform name; effect params carry the effect block's id so lanes survive
// reordering and duplicate effect types.
export const effectLaneKey = (effectId: string, uniform: string) =>
  `effect:${effectId}:${uniform}`;

// One pattern in the stack, which in the data model is a BLOCK spanning the
// whole song (decision 24).
//
// The block owns the automation: a lane's curve is projected from
// `block.parameterVariations` on read and written straight back on edit (see
// blockLanes), so no curve lives here to fall out of sync. `pattern` and each
// effect's `pattern` are the block's own live pattern objects by reference.
export type StackEntry = {
  id: string;
  block: Block;
  pattern: Pattern;
  effects: EffectEntry[];
  visible: boolean;
  expanded: boolean;
  // The one lane still held in React state: visibility is not a shader
  // uniform, so it has no home in the block's parameterVariations. It moves to
  // the layer and stops being automatable when decision 5 lands; until then it
  // stays here rather than being force-fitted onto u_opacity.
  visibilityCurve?: AutomationCurve;
};

type Props = {
  entries: StackEntry[];
  // The layers the stack is grouped into, in the experience's own order.
  layers: Layer[];
  onAdd: (factory: () => Pattern, layerId: string) => void;
  onAddLayer: () => void;
  onRemoveLayer: (layerId: string) => void;
  onRenameLayer: (layerId: string, name: string) => void;
  onMoveLayer: (layerId: string, toIndex: number) => void;
  onToggleLayerVisible: (layerId: string) => void;
  onToggleLayerCollapsed: (layerId: string) => void;
  onUpdate: (id: string, update: Partial<StackEntry>) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onAddEffect: (entryId: string, factory: () => Pattern) => void;
  onRemoveEffect: (entryId: string, effectId: string) => void;
  onMoveEffect: (entryId: string, effectId: string, delta: -1 | 1) => void;
  // Assign mode (Add Automation): clicking any parameter row gives
  // it a lane instead of its normal interaction.
  assigning: boolean;
  onAssignParam: (entryId: string, laneKey: string) => void;
  onCancelAssign: () => void;
};

// Slide-out pattern stack, after Beckon's sidebar: a bare chevron at the
// screen's left edge opens a frosted-glass panel over a dimmed backdrop.
// Patterns stack top to bottom; each row expands to reveal its parameters.
// Adding widens the panel to reveal the add column (AddPatternPane). The
// stack itself lives in EditorV2Page so the canopy can render it.
type PanelContextMenu = {
  entryId: string;
  // A lane key for a parameter row's menu; null for the pattern row's
  // own menu (Duplicate).
  uniform: string | null;
  x: number;
  y: number;
};

export const PatternsPanel = observer(function PatternsPanel({
  entries,
  layers,
  onAdd,
  onAddLayer,
  onRemoveLayer,
  onRenameLayer,
  onMoveLayer,
  onToggleLayerVisible,
  onToggleLayerCollapsed,
  onUpdate,
  onRemove,
  onDuplicate,
  onAddEffect,
  onRemoveEffect,
  onMoveEffect,
  assigning,
  onAssignParam,
  onCancelAssign,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  // Starting an assignment opens the dock; it stays open when the
  // assignment ends or cancels.
  useEffect(() => {
    if (assigning) setIsOpen(true);
  }, [assigning]);
  const [contextMenu, setContextMenu] = useState<PanelContextMenu | null>(null);
  // The entry whose inline effect picker is open, if any.
  const [effectPickerFor, setEffectPickerFor] = useState<string | null>(null);
  // Which layer the Add Pattern column is adding to, and which layer name is
  // being typed. Layer reorder is click-and-hold, so it rides HTML drag.
  const [pickingLayer, setPickingLayer] = useState<string | null>(null);
  const [renamingLayer, setRenamingLayer] = useState<string | null>(null);
  const [draggingLayer, setDraggingLayer] = useState<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // Which pattern's opacity just went from auto to manual, so the row can say
  // so for a moment. The transition is worth showing: it silently ends a live
  // crossfade, which no other manual value edit does.
  const [justMaterialized, setJustMaterialized] = useState<string | null>(null);
  const materializedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(materializedTimer.current), []);
  const flagMaterialized = (entryId: string) => {
    setJustMaterialized(entryId);
    clearTimeout(materializedTimer.current);
    materializedTimer.current = setTimeout(() => setJustMaterialized(null), 1400);
  };

  // Composite params (palette, color) render expanded by default; this set
  // tracks the ones collapsed, keyed by `entryId:uniform`. UI-only state.
  const [collapsedParams, setCollapsedParams] = useState<Set<string>>(
    new Set(),
  );
  const toggleParamCollapse = (key: string) =>
    setCollapsedParams((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Color and palette values mutate in place; bump to re-render their
  // editors after an edit.
  const [, setEditorBump] = useState(0);
  const bumpEditors = () => setEditorBump((bump) => bump + 1);

  // Click-away / Esc dismissal for the context menu.
  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Topmost layer: consume the Escape so lower layers stay open.
      event.stopImmediatePropagation();
      setContextMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [contextMenu]);

  // Lane access goes through the block: a lane's curve is projected from its
  // regions on read (see blockLanes). Visibility is the one exception — not a
  // shader uniform, so it has no home in the block and stays in React state
  // until decision 5 moves it to the layer.
  const lanesOf = (entry: StackEntry) => [
    ...laneKeysOf(entry.block),
    ...(entry.visibilityCurve ? [VISIBILITY_PARAM] : []),
  ];
  const curveOf = (entry: StackEntry, laneKey: string) =>
    laneKey === VISIBILITY_PARAM
      ? entry.visibilityCurve ?? null
      : laneCurve(entry.block, laneKey);

  // The colored edge on an automated param row: green while its curve is
  // active, red once deactivated (a lane with no keyframes counts as
  // active; there is nothing to suspend).
  const laneEdgeClass = (entry: StackEntry, laneKey: string) => {
    if (!lanesOf(entry).includes(laneKey)) return "";
    const curve = curveOf(entry, laneKey);
    const suspended =
      !!curve && curve.keyframes.length > 0 && !isCurveActive(curve);
    return `${styles.paramAutomated} ${
      suspended ? styles.laneEdgeInactive : styles.laneEdgeActive
    }`;
  };

  // A user edit on an automated param takes over: the value becomes the
  // manual value and the curve deactivates until it is edited again.
  const deactivateLane = (entry: StackEntry, laneKey: string) => () => {
    const curve = curveOf(entry, laneKey);
    if (!curve || curve.keyframes.length === 0 || !isCurveActive(curve)) return;
    // Takeover is memory-only (decision 6): suspend the lane rather than
    // writing an `active` flag no part of the data model has room for.
    if (laneKey === VISIBILITY_PARAM)
      onUpdate(entry.id, {
        visibilityCurve: { ...curve, active: false },
      });
    else suspendLane(entry.block, laneKey);
  };

  // The bar under an automated visibility eye: green while the curve
  // drives it, red while deactivated.
  const eyeBarClass = (entry: StackEntry) => {
    if (!entry.visibilityCurve) return "";
    const curve = entry.visibilityCurve;
    const suspended =
      !!curve && curve.keyframes.length > 0 && !isCurveActive(curve);
    return suspended ? styles.eyeBarInactive : styles.eyeBarActive;
  };

  // Opacity: a pseudo-param at the TOP of every pattern's list (decision 25).
  // The owner's words: "you can add it as an additional parameter for all
  // patterns at the top of the list. Just call opacity, and it will just be
  // auto. And then you can drag it up or down to create a new automation,
  // which is just flat."
  //
  // Three states, not two, because `u_opacity` is in upstream's BASE_UNIFORMS
  // and so has one more state below "lone flat": no entry at all.
  //   - absent    = AUTO. Upstream derives an equal-power crossfade from block
  //                 overlaps; identical spans get none and render full, which
  //                 is what makes the default full-song stack sum as before.
  //   - lone flat = MANUAL, the ordinary decision 7 manual value.
  //   - a lane    = authored automation, promoted through lanedParams.
  //
  // Patterns only. Upstream's own lanableParamNames excludes u_opacity on
  // effect blocks, since opacity applies once per pattern after its whole
  // effect chain.
  const renderOpacityRow = (entry: StackEntry) => {
    const param = entry.pattern.params[OPACITY_PARAM] as
      | PatternParam<number>
      | undefined;
    if (!param) return null;
    const isAuto = !entry.block.hasManualOpacity;

    return (
      <li
        data-doc="param-row"
        data-opacity-mode={isAuto ? "auto" : "manual"}
        className={`${styles.paramRow} ${
          assigning ? styles.paramRowAssign : ""
        } ${laneEdgeClass(entry, OPACITY_PARAM)} ${
          justMaterialized === entry.id ? styles.paramRowChanged : ""
        }`}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({
            entryId: entry.id,
            uniform: OPACITY_PARAM,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        {...(assigning
          ? { onClick: () => onAssignParam(entry.id, OPACITY_PARAM) }
          : {})}
      >
        <span className={styles.paramName}>Opacity</span>
        <ScrubbableNumber
          param={param}
          displayAs={isAuto ? "auto" : undefined}
          onUserEdit={() => {
            // The first drag is what turns auto into a real value. Upstream's
            // materialize copies the DERIVED fade into variations, so a block
            // that was mid-crossfade keeps its shape instead of jumping; the
            // drag then moves it from there. Flagged for a beat afterwards
            // because this transition kills a live crossfade, unlike an
            // ordinary silent write-through.
            if (!entry.block.hasManualOpacity) {
              runInAction(() => entry.block.materializeAutoOpacity());
              flagMaterialized(entry.id);
            }
            deactivateLane(entry, OPACITY_PARAM)();
          }}
          onCommitted={() =>
            syncManualValue(entry.block, OPACITY_PARAM, entry.block.store)
          }
        />
      </li>
    );
  };

  // One parameter list, used for the pattern's own params and for each
  // effect's params: keyFor maps a uniform name to its lane key (bare for
  // the pattern, effect-scoped for effects), and everything downstream
  // (lane edges, context menus, takeover) works purely on lane keys.
  const renderParamRows = (
    entry: StackEntry,
    pattern: Pattern,
    keyFor: (uniform: string) => string,
  ) =>
    Object.entries(pattern.params)
      .filter(([uniform]) => !BASE_UNIFORMS.includes(uniform))
      .map(([uniform, param]) => {
        const laneKey = keyFor(uniform);
        const openMenu = (event: React.MouseEvent) => {
          event.preventDefault();
          setContextMenu({
            entryId: entry.id,
            uniform: laneKey,
            x: event.clientX,
            y: event.clientY,
          });
        };
        // Assign mode: the whole row becomes one click target (children
        // stop intercepting) and a click gives the parameter its lane.
        const assignProps = assigning
          ? {
              onClick: () => onAssignParam(entry.id, laneKey),
            }
          : {};
        const assignClass = assigning ? styles.paramRowAssign : "";
        const components = getParamComponents(param);
        if (!components)
          return (
            <li
              key={laneKey}
              data-doc="param-row"
              className={`${styles.paramRow} ${assignClass} ${laneEdgeClass(entry, laneKey)}`}
              onContextMenu={openMenu}
              {...assignProps}
            >
              <span className={styles.paramName}>
                {formatDisplayName(param.name)}
              </span>
              {typeof param.value === "number" ? (
                <ScrubbableNumber
                  param={param as PatternParam<number>}
                  onUserEdit={deactivateLane(entry, laneKey)}
                  onCommitted={() => syncManualValue(entry.block, laneKey, entry.block.store)}
                />
              ) : (
                <span className={styles.paramValue}>
                  {formatParamValue(param.value)}
                </span>
              )}
            </li>
          );

        // Composite param (color or palette): a caret row, then the
        // shared value editor. The composite automates as a whole:
        // keyframes divide time into periods holding values.
        const collapseKey = `${entry.id}:${laneKey}`;
        const isCollapsed = collapsedParams.has(collapseKey);
        const onValueEdited = () => {
          deactivateLane(entry, laneKey)();
          syncManualValue(entry.block, laneKey, entry.block.store);
          window.dispatchEvent(new Event(EDITOR_DIRTY_EVENT));
          bumpEditors();
        };
        return (
          <li key={laneKey}>
            <div
              data-doc="param-row"
              className={`${styles.paramRow} ${assignClass} ${laneEdgeClass(entry, laneKey)}`}
              onContextMenu={openMenu}
              {...assignProps}
            >
              <button
                className={styles.paramCaret}
                onClick={() => toggleParamCollapse(collapseKey)}
                aria-label={
                  isCollapsed ? "Expand components" : "Collapse components"
                }
              >
                {isCollapsed ? <FaCaretRight /> : <FaCaretDown />}
              </button>
              <span className={styles.paramName}>
                {formatDisplayName(param.name)}
              </span>
            </div>
            {!isCollapsed && (
              <div className={styles.compositeEditorWrap}>
                {isPalette(param.value) ? (
                  <PaletteValueEditor
                    palette={param.value.serialize()}
                    onChange={(next) => {
                      (param.value as Palette).setFromSerialized(next);
                      onValueEdited();
                    }}
                  />
                ) : isVector4(param.value) ? (
                  <ColorValueEditor
                    rgba={
                      [
                        param.value.x,
                        param.value.y,
                        param.value.z,
                        param.value.w,
                      ] as Rgba
                    }
                    onChange={(rgba) => {
                      (param.value as Vector4).set(
                        rgba[0],
                        rgba[1],
                        rgba[2],
                        rgba[3],
                      );
                      onValueEdited();
                    }}
                  />
                ) : null}
              </div>
            )}
          </li>
        );
      });

  const menuEntry = contextMenu
    ? entries.find((entry) => entry.id === contextMenu.entryId)
    : undefined;
  const menuHasLane =
    contextMenu?.uniform != null &&
    !!menuEntry &&
    lanesOf(menuEntry).includes(contextMenu.uniform);
  const menuCurve =
    contextMenu?.uniform != null && menuHasLane && menuEntry
      ? curveOf(menuEntry, contextMenu.uniform) ?? undefined
      : undefined;
  // Only a curve with keyframes can be disabled; an empty lane drives
  // nothing.
  const menuCanToggleActive = !!menuCurve && menuCurve.keyframes.length > 0;

  const toggleAutomationActive = () => {
    const laneKey = contextMenu?.uniform;
    if (!contextMenu || laneKey == null || !menuEntry || !menuCurve) return;
    const nowActive = isCurveActive(menuCurve);
    if (laneKey === VISIBILITY_PARAM)
      onUpdate(contextMenu.entryId, {
        visibilityCurve: { ...menuCurve, active: !nowActive },
      });
    // Memory-only takeover (decision 6), not a stored flag.
    else if (nowActive) suspendLane(menuEntry.block, laneKey);
    else resumeLane(menuEntry.block, laneKey);
    setContextMenu(null);
  };

  const toggleAutomationLane = () => {
    const laneKey = contextMenu?.uniform;
    if (!contextMenu || laneKey == null || !menuEntry) return;
    if (laneKey === VISIBILITY_PARAM) {
      onUpdate(contextMenu.entryId, {
        visibilityCurve: menuHasLane ? undefined : { keyframes: [] },
      });
      setContextMenu(null);
      return;
    }
    if (menuHasLane) {
      // Deleting the lane discards its curve and returns the parameter to its
      // manual value — which in this data model is a lone constant region.
      resumeLane(menuEntry.block, laneKey);
      writeLaneCurve(menuEntry.block, laneKey, null, menuEntry.block.store);
      disarmLane(menuEntry.block, laneKey);
    } else {
      // Opacity has no empty state to open onto: absence already means auto.
      // So promoting it materializes first, and materializing copies the
      // DERIVED crossfade rather than a flat 1 — on an overlapped block the
      // lane then opens showing the fade that was really playing, instead of
      // erasing it (decision 25).
      if (laneKey === OPACITY_PARAM && !menuEntry.block.hasManualOpacity)
        runInAction(() => menuEntry.block.materializeAutoOpacity());
      // Arming seeds a full-span region so the lane never opens onto nothing.
      armLane(menuEntry.block, laneKey);
    }
    // Arming and disarming live on the block, so nothing in React state
    // changed and the page had no idea this happened: the edit missed the
    // autosave AND the undo history, which is why undo used to skip straight
    // past a lane being added. lanedParams IS undoable (decision 21).
    window.dispatchEvent(new Event(EDITOR_DIRTY_EVENT));
    setContextMenu(null);
  };

  // One pattern row, with its params, effects and menus. Extracted so the
  // layer list can wrap it: layers group the rows, they do not replace them.
  const renderEntry = (entry: StackEntry) => (
              <li
                key={entry.id}
                className={entry.visible ? "" : styles.patternHidden}
              >
                <div
                  className={styles.patternRow}
                  data-doc="pattern-row"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      entryId: entry.id,
                      uniform: null,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <button
                    data-doc="pattern-expand"
                    className={styles.rowButton}
                    onClick={() =>
                      onUpdate(entry.id, { expanded: !entry.expanded })
                    }
                    aria-label={
                      entry.expanded
                        ? "Collapse parameters"
                        : "Expand parameters"
                    }
                  >
                    {entry.expanded ? <FaCaretDown /> : <FaCaretRight />}
                  </button>
                  <span className={styles.patternName}>
                    {formatDisplayName(entry.pattern.name)}
                  </span>
                  <button
                    data-doc="pattern-visibility"
                    className={`${styles.rowButton} ${eyeBarClass(entry)}`}
                    onClick={() => {
                      // In assign mode the eye is a lane target, not a
                      // toggle: visibility automates like any param.
                      if (assigning) {
                        onAssignParam(entry.id, VISIBILITY_PARAM);
                        return;
                      }
                      // Toggling by hand takes over from an active
                      // visibility curve, like editing any automated
                      // parameter.
                      deactivateLane(entry, VISIBILITY_PARAM)();
                      onUpdate(entry.id, { visible: !entry.visible });
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      // Keep the row's own menu (Duplicate) from
                      // replacing the eye's lane menu as this bubbles.
                      event.stopPropagation();
                      setContextMenu({
                        entryId: entry.id,
                        uniform: VISIBILITY_PARAM,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    aria-label={
                      entry.visible ? "Hide pattern" : "Show pattern"
                    }
                  >
                    {entry.visible ? <FaEye /> : <FaEyeSlash />}
                  </button>
                  <button
                    data-doc="pattern-remove"
                    className={`${styles.rowButton} ${styles.trashButton}`}
                    onClick={() => onRemove(entry.id)}
                    aria-label="Remove pattern"
                  >
                    <FaTrashAlt />
                  </button>
                </div>
                {entry.expanded && (
                  <>
                    <ul className={styles.paramList}>
                      {renderOpacityRow(entry)}
                      {renderParamRows(entry, entry.pattern, (u) => u)}
                    </ul>
                    {entry.effects.map((effect, effectIndex) => (
                      <div
                        key={effect.id}
                        className={styles.effectBlock}
                        data-doc="effect-row"
                      >
                        <div className={styles.effectHeader}>
                          <span className={styles.effectName}>
                            {formatDisplayName(effect.pattern.name)}
                          </span>
                          <button
                            className={styles.rowButton}
                            disabled={effectIndex === 0}
                            onClick={() =>
                              onMoveEffect(entry.id, effect.id, -1)
                            }
                            aria-label="Move effect up"
                          >
                            <FaArrowUp size={10} />
                          </button>
                          <button
                            className={styles.rowButton}
                            disabled={
                              effectIndex === entry.effects.length - 1
                            }
                            onClick={() =>
                              onMoveEffect(entry.id, effect.id, 1)
                            }
                            aria-label="Move effect down"
                          >
                            <FaArrowDown size={10} />
                          </button>
                          <button
                            className={`${styles.rowButton} ${styles.trashButton}`}
                            onClick={() =>
                              onRemoveEffect(entry.id, effect.id)
                            }
                            aria-label="Remove effect"
                          >
                            <FaTrashAlt size={11} />
                          </button>
                        </div>
                        <ul className={styles.paramList}>
                          {renderParamRows(entry, effect.pattern, (u) =>
                            effectLaneKey(effect.id, u),
                          )}
                        </ul>
                      </div>
                    ))}
                    <button
                      data-doc="add-effect"
                      className={styles.addEffect}
                      onClick={() =>
                        setEffectPickerFor(
                          effectPickerFor === entry.id ? null : entry.id,
                        )
                      }
                    >
                      <FaPlus size={9} /> Add Effect
                    </button>
                    {effectPickerFor === entry.id && (
                      <ul className={styles.effectPicker}>
                        {effectLibrary.map(({ name, factory }) => (
                          <li key={name}>
                            <button
                              className={styles.effectPickerItem}
                              onClick={() => {
                                onAddEffect(entry.id, factory);
                                setEffectPickerFor(null);
                              }}
                            >
                              {formatDisplayName(name)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </li>
  );

  // The dock sits in normal flow beside the main column, so the info
  // strip below never needs to shrink for it (the songs panel, still an
  // overlay, keeps publishing its inset).

  useEffect(() => {
    if (!isOpen && !isPicking && !assigning) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Consume the Escape so layers below (the automation editor view)
      // stay open.
      event.stopImmediatePropagation();
      // An in-flight assignment cancels first; the dock stays open.
      if (assigning) onCancelAssign();
      else if (isPicking) setIsPicking(false);
      else setIsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isOpen, isPicking, assigning, onCancelAssign]);

  return (
    <>
      <aside
        data-panel="patterns"
        className={`${styles.patternsDock} ${
          isOpen ? styles.patternsDockOpen : ""
        } ${isPicking ? styles.patternsDockWide : ""}`}
      >
        {isPicking && (
          <button
            data-doc="sliver"
            className={styles.sliverCancel}
            onClick={() => setIsPicking(false)}
            aria-label="Back to pattern list"
          />
        )}
        <div className={styles.panelTrack}>
          <div className={styles.panelColumn}>
            <div className={styles.panelSectionLabel}>Layers</div>

            {entries.length === 0 && layers.length <= 1 && (
              <div className={styles.panelEmpty}>No patterns yet</div>
            )}

            {layers.map((layer, layerIndex) => {
              const layerEntries = entries.filter(
                (entry) => entry.block.layer === layer,
              );
              return (
                <div
                  key={layer.id}
                  className={styles.layerGroup}
                  data-doc="layer"
                  draggable
                  onDragStart={() => setDraggingLayer(layer.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (draggingLayer && draggingLayer !== layer.id)
                      onMoveLayer(draggingLayer, layerIndex);
                    setDraggingLayer(null);
                  }}
                >
                  <div className={styles.layerRow}>
                    <button
                      className={styles.caretButton}
                      aria-label={
                        layer.collapsed ? "Expand layer" : "Collapse layer"
                      }
                      onClick={() => onToggleLayerCollapsed(layer.id)}
                    >
                      {layer.collapsed ? (
                        <FaCaretRight size={12} />
                      ) : (
                        <FaCaretDown size={12} />
                      )}
                    </button>

                    {renamingLayer === layer.id ? (
                      <input
                        className={styles.layerNameInput}
                        autoFocus
                        defaultValue={layer.name}
                        aria-label="Layer name"
                        onBlur={(event) => {
                          onRenameLayer(layer.id, event.target.value);
                          setRenamingLayer(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter")
                            (event.target as HTMLInputElement).blur();
                          if (event.key === "Escape") setRenamingLayer(null);
                        }}
                      />
                    ) : (
                      <span
                        className={styles.layerName}
                        onDoubleClick={() => setRenamingLayer(layer.id)}
                      >
                        {layer.name || `Layer ${layerIndex + 1}`}
                      </span>
                    )}

                    <button
                      className={styles.layerEye}
                      aria-label={layer.visible ? "Hide layer" : "Show layer"}
                      onClick={() => onToggleLayerVisible(layer.id)}
                    >
                      {layer.visible ? (
                        <FaEye size={11} />
                      ) : (
                        <FaEyeSlash size={11} />
                      )}
                    </button>
                    {layers.length > 1 && (
                      <button
                        className={styles.layerTrash}
                        aria-label="Remove layer"
                        onClick={() => onRemoveLayer(layer.id)}
                      >
                        <FaTrashAlt size={10} />
                      </button>
                    )}
                  </div>

                  {!layer.collapsed && (
                    <>
                      <ul className={styles.patternStack}>
                        {layerEntries.map(renderEntry)}
                      </ul>
                      <button
                        data-doc="add-pattern"
                        className={styles.addPattern}
                        onClick={() => {
                          setPickingLayer(layer.id);
                          setIsPicking(!isPicking);
                        }}
                      >
                        <FaPlus size={9} /> Add Pattern
                      </button>
                    </>
                  )}
                </div>
              );
            })}

            <button
              data-doc="add-layer"
              className={styles.addLayer}
              onClick={onAddLayer}
            >
              <FaPlus size={11} /> Add Layer
            </button>
          </div>

          <AddPatternPane
            isOpen={isPicking}
            onInsert={(factory) => {
              onAdd(factory, pickingLayer ?? layers[0]?.id ?? "");
              setIsPicking(false);
            }}
            onClose={() => setIsPicking(false)}
          />
        </div>
      </aside>

      <button
        data-doc="panel-toggle"
        className={`${styles.panelToggle} ${isOpen ? styles.panelToggleOpen : ""} ${
          isPicking ? styles.panelToggleWide : ""
        }`}
        onClick={() => {
          if (isOpen) setIsPicking(false);
          setIsOpen(!isOpen);
        }}
        aria-label={isOpen ? "Close pattern library" : "Open pattern library"}
      >
        {isOpen ? "❮" : "❯"}
      </button>

      {contextMenu && menuEntry && (
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.uniform === null ? (
            <button
              className={styles.contextMenuItem}
              onClick={() => {
                onDuplicate(contextMenu.entryId);
                setContextMenu(null);
              }}
            >
              Duplicate
            </button>
          ) : (
            <>
              <button
                className={styles.contextMenuItem}
                onClick={toggleAutomationLane}
              >
                {menuHasLane ? "Delete Automation Lane" : "Add Automation Lane"}
              </button>
              {contextMenu.uniform === OPACITY_PARAM &&
                menuEntry.block.hasManualOpacity && (
                  <button
                    className={styles.contextMenuItem}
                    data-doc="reset-opacity"
                    onClick={() => {
                      // "Just right click to reset to auto works for opacity."
                      // Which is literally deleting the entry: absence IS auto,
                      // and it survives saves because u_opacity is a base
                      // uniform, so the save-time backfill skips it.
                      runInAction(() => {
                        menuEntry.block.resetOpacityToAuto();
                        menuEntry.block.lanedParams.delete(OPACITY_PARAM);
                      });
                      resumeLane(menuEntry.block, OPACITY_PARAM);
                      setContextMenu(null);
                    }}
                  >
                    Reset to Auto
                  </button>
                )}
              {menuCanToggleActive && (
                <button
                  className={styles.contextMenuItem}
                  onClick={toggleAutomationActive}
                >
                  {isCurveActive(menuCurve)
                    ? "Disable Automation"
                    : "Re-enable Automation"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
});
