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

// An effect applied to a pattern: a Pattern whose shader transforms the
// previous render stage (u_texture). Chained in order after the pattern.
export type EffectEntry = {
  id: number;
  pattern: Pattern;
};

// Lane key for an effect's parameter. Pattern params use the bare
// uniform name; effect params carry the effect's id so lanes survive
// reordering and duplicate effect types.
export const effectLaneKey = (effectId: number, uniform: string) =>
  `effect:${effectId}:${uniform}`;

export type StackEntry = {
  id: number;
  pattern: Pattern;
  effects: EffectEntry[];
  visible: boolean;
  expanded: boolean;
  // Lane keys of params that have an automation lane: bare uniform names
  // for pattern params, effect:<id>:<uniform> for effect params. May
  // also contain VISIBILITY_PARAM for the visibility toggle's lane.
  automatedParams: string[];
  // Keyframe curves keyed by lane key (see automation.ts).
  automation: Record<string, AutomationCurve>;
};

type Props = {
  entries: StackEntry[];
  onAdd: (factory: () => Pattern) => void;
  onUpdate: (id: number, update: Partial<StackEntry>) => void;
  onRemove: (id: number) => void;
  onAddEffect: (entryId: number, factory: () => Pattern) => void;
  onRemoveEffect: (entryId: number, effectId: number) => void;
  onMoveEffect: (entryId: number, effectId: number, delta: -1 | 1) => void;
};

// Slide-out pattern stack, after Beckon's sidebar: a bare chevron at the
// screen's left edge opens a frosted-glass panel over a dimmed backdrop.
// Patterns stack top to bottom; each row expands to reveal its parameters.
// Adding widens the panel to reveal the add column (AddPatternPane). The
// stack itself lives in EditorV2Page so the canopy can render it.
type ParamContextMenu = {
  entryId: number;
  uniform: string;
  x: number;
  y: number;
};

export function PatternsPanel({
  entries,
  onAdd,
  onUpdate,
  onRemove,
  onAddEffect,
  onRemoveEffect,
  onMoveEffect,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [contextMenu, setContextMenu] = useState<ParamContextMenu | null>(null);
  // The entry whose inline effect picker is open, if any.
  const [effectPickerFor, setEffectPickerFor] = useState<number | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
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

  // The colored edge on an automated param row: green while its curve is
  // active, red once deactivated (a lane with no keyframes counts as
  // active; there is nothing to suspend).
  const laneEdgeClass = (entry: StackEntry, laneKey: string) => {
    if (!entry.automatedParams.includes(laneKey)) return "";
    const curve = entry.automation[laneKey];
    const suspended =
      !!curve && curve.keyframes.length > 0 && !isCurveActive(curve);
    return `${styles.paramAutomated} ${
      suspended ? styles.laneEdgeInactive : styles.laneEdgeActive
    }`;
  };

  // A user edit on an automated param takes over: the value becomes the
  // underlying value and the curve deactivates until it is edited again.
  const deactivateLane = (entry: StackEntry, laneKey: string) => () => {
    const curve = entry.automation[laneKey];
    if (!curve || curve.keyframes.length === 0 || !isCurveActive(curve)) return;
    onUpdate(entry.id, {
      automation: {
        ...entry.automation,
        [laneKey]: { ...curve, active: false },
      },
    });
  };

  // The bar under an automated visibility eye: green while the curve
  // drives it, red while deactivated.
  const eyeBarClass = (entry: StackEntry) => {
    if (!entry.automatedParams.includes(VISIBILITY_PARAM)) return "";
    const curve = entry.automation[VISIBILITY_PARAM];
    const suspended =
      !!curve && curve.keyframes.length > 0 && !isCurveActive(curve);
    return suspended ? styles.eyeBarInactive : styles.eyeBarActive;
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
        const components = getParamComponents(param);
        if (!components)
          return (
            <li
              key={laneKey}
              data-doc="param-row"
              className={`${styles.paramRow} ${laneEdgeClass(entry, laneKey)}`}
              onContextMenu={openMenu}
            >
              <span className={styles.paramName}>
                {formatDisplayName(param.name)}
              </span>
              {typeof param.value === "number" ? (
                <ScrubbableNumber
                  param={param as PatternParam<number>}
                  onUserEdit={deactivateLane(entry, laneKey)}
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
          window.dispatchEvent(new Event(EDITOR_DIRTY_EVENT));
          bumpEditors();
        };
        return (
          <li key={laneKey}>
            <div
              data-doc="param-row"
              className={`${styles.paramRow} ${laneEdgeClass(entry, laneKey)}`}
              onContextMenu={openMenu}
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
    !!contextMenu && !!menuEntry?.automatedParams.includes(contextMenu.uniform);
  const menuCurve =
    contextMenu && menuHasLane
      ? menuEntry?.automation[contextMenu.uniform]
      : undefined;
  // Only a curve with keyframes can be disabled; an empty lane drives
  // nothing.
  const menuCanToggleActive = !!menuCurve && menuCurve.keyframes.length > 0;

  const toggleAutomationActive = () => {
    if (!contextMenu || !menuEntry || !menuCurve) return;
    onUpdate(contextMenu.entryId, {
      automation: {
        ...menuEntry.automation,
        [contextMenu.uniform]: {
          ...menuCurve,
          active: !isCurveActive(menuCurve),
        },
      },
    });
    setContextMenu(null);
  };

  const toggleAutomationLane = () => {
    if (!contextMenu || !menuEntry) return;
    if (menuHasLane) {
      // Deleting the lane also discards its curve.
      const automation = { ...menuEntry.automation };
      delete automation[contextMenu.uniform];
      onUpdate(contextMenu.entryId, {
        automatedParams: menuEntry.automatedParams.filter(
          (uniform) => uniform !== contextMenu.uniform,
        ),
        automation,
      });
    } else {
      onUpdate(contextMenu.entryId, {
        automatedParams: [...menuEntry.automatedParams, contextMenu.uniform],
      });
    }
    setContextMenu(null);
  };

  // The dock sits in normal flow beside the main column, so the info
  // strip below never needs to shrink for it (the songs panel, still an
  // overlay, keeps publishing its inset).

  useEffect(() => {
    if (!isOpen && !isPicking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Consume the Escape so layers below (the automation editor view)
      // stay open.
      event.stopImmediatePropagation();
      if (isPicking) setIsPicking(false);
      else setIsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isOpen, isPicking]);

  return (
    <>
      <aside
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
            <div className={styles.panelSectionLabel}>Patterns</div>

            {entries.length === 0 && (
              <div className={styles.panelEmpty}>No patterns yet</div>
            )}

            <ul className={styles.patternStack}>
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className={entry.visible ? "" : styles.patternHidden}
                >
                  <div className={styles.patternRow} data-doc="pattern-row">
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
                        // Toggling by hand takes over from an active
                        // visibility curve, like editing any automated
                        // parameter.
                        deactivateLane(entry, VISIBILITY_PARAM)();
                        onUpdate(entry.id, { visible: !entry.visible });
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
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
              ))}
            </ul>

            <button
              data-doc="add-pattern"
              className={styles.addPattern}
              onClick={() => setIsPicking(!isPicking)}
            >
              <FaPlus size={11} /> Add Pattern
            </button>
          </div>

          <AddPatternPane
            isOpen={isPicking}
            onInsert={(factory) => {
              onAdd(factory);
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
          <button
            className={styles.contextMenuItem}
            onClick={toggleAutomationLane}
          >
            {menuHasLane ? "Delete Automation Lane" : "Add Automation Lane"}
          </button>
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
        </div>
      )}
    </>
  );
}
