import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import { action } from "mobx";
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
import { isVector4 } from "@/src/utils/object";
import { isPalette, Palette } from "@/src/params/palette/Palette";
import {
  ColorValueEditor,
  PaletteValueEditor,
  Rgba,
} from "@/src/components/EditorV2/ValueEditors";
import { effectLibrary } from "@/src/components/EditorV2/patternLibrary";
import { useStore } from "@/src/types/StoreContext";
import { Layer } from "@/src/types/Layer";
import { Block } from "@/src/types/Block";
import { CurveVariation } from "@/src/types/Variations/CurveVariation";
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

type Props = {
  // The page owns block timing (it knows the song's duration).
  onAddPattern: (layer: Layer, factory: () => Pattern) => void;
  // Right-clicking a param row arms its automation lane and opens the
  // editor on it (the promotion gesture, decision 8).
  onAddAutomation: (block: Block, uniform: string) => void;
};

// The layer list: the left dock now mirrors the data model exactly.
// Layers hold blocks; each block wears its pattern's name and carries
// its parameters and effect chain. Visibility lives on the layer (the
// eye), matching the main app: a runtime toggle, not serialized.
export const LayersPanel = observer(function LayersPanel({
  onAddPattern,
  onAddAutomation,
}: Props) {
  const store = useStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  // Which layer the add-pattern picker inserts into.
  const [pickerLayer, setPickerLayer] = useState<Layer | null>(null);
  // Block rows expanded to show parameters (UI state, memory only).
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(
    new Set(),
  );
  // Composite params (palette, color) render expanded by default; this
  // set tracks the ones collapsed, keyed by `blockId:uniform`.
  const [collapsedParams, setCollapsedParams] = useState<Set<string>>(
    new Set(),
  );
  // The block whose inline effect picker is open, if any.
  const [effectPickerFor, setEffectPickerFor] = useState<string | null>(null);
  // The layer being renamed (double-click on its name).
  const [renamingLayer, setRenamingLayer] = useState<Layer | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Right-click menu on a block row: Duplicate.
  const [blockMenu, setBlockMenu] = useState<{
    blockId: string;
    x: number;
    y: number;
  } | null>(null);
  // Right-click menu on a param row: Add Automation Lane (and, on the
  // opacity row, Reset to Auto).
  const [paramMenu, setParamMenu] = useState<{
    block: Block;
    uniform: string;
    isOpacity?: boolean;
    x: number;
    y: number;
  } | null>(null);
  const blockMenuRef = useRef<HTMLDivElement>(null);
  const paramMenuRef = useRef<HTMLDivElement>(null);
  // Color and palette values mutate in place; bump to re-render their
  // editors after an edit.
  const [, setEditorBump] = useState(0);
  const bumpEditors = () => setEditorBump((bump) => bump + 1);

  const toggleIn = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  // Click-away / Esc dismissal for the context menus.
  useEffect(() => {
    if (!blockMenu && !paramMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (blockMenuRef.current?.contains(event.target as Node)) return;
      if (paramMenuRef.current?.contains(event.target as Node)) return;
      setBlockMenu(null);
      setParamMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      setBlockMenu(null);
      setParamMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [blockMenu, paramMenu]);

  // Escape: close the picker first, then the dock.
  useEffect(() => {
    if (!isOpen && !isPicking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      if (isPicking) setIsPicking(false);
      else setIsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isOpen, isPicking]);

  const duplicateBlock = action((block: Block) => {
    const layer = block.layer;
    if (!layer) return;
    // A deep copy at the same timing, landing beside the original
    // (identical spans sum on the canopy, like the old stack).
    const copy = block.clone();
    copy.setTiming({ startTime: block.startTime, duration: block.duration });
    layer.addBlock(copy);
  });

  // The opacity pseudo-param (decision 25): u_opacity is a base
  // uniform their param lists hide, but every pattern block carries
  // it. Absent regions mean AUTO (upstream derives crossfades from
  // overlaps); clicking auto materializes a lone constant the scrub
  // then writes through to; right-click offers Reset to Auto.
  const renderOpacityRow = (block: Block) => {
    const param = block.pattern.params.u_opacity as
      | PatternParam<number>
      | undefined;
    if (!param) return null;
    const hasManual = (block.parameterVariations.u_opacity?.length ?? 0) > 0;
    const writeThrough = action(() => {
      const value = typeof param.value === "number" ? param.value : 1;
      block.parameterVariations.u_opacity = [
        CurveVariation.flat(block.duration, value),
      ];
      block.triggerVariationReactions("u_opacity");
    });
    return (
      <li
        key="u_opacity"
        data-doc="opacity-row"
        className={styles.paramRow}
        onContextMenu={(event) => {
          event.preventDefault();
          setParamMenu({
            block,
            uniform: "u_opacity",
            isOpacity: true,
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        <span className={styles.paramName}>Opacity</span>
        {hasManual ? (
          <ScrubbableNumber param={param} onUserEdit={writeThrough} />
        ) : (
          <button
            className={styles.opacityAutoButton}
            onClick={action(() => {
              param.value = 1;
              writeThrough();
            })}
          >
            auto
          </button>
        )}
      </li>
    );
  };

  const renderParamRows = (block: Block, pattern: Pattern) =>
    Object.entries(pattern.params)
      .filter(([uniform]) => !BASE_UNIFORMS.includes(uniform))
      .map(([uniform, param]) => {
        const openParamMenu = (event: React.MouseEvent) => {
          event.preventDefault();
          setParamMenu({ block, uniform, x: event.clientX, y: event.clientY });
        };
        const components = getParamComponents(param);
        if (!components)
          return (
            <li
              key={uniform}
              data-doc="param-row"
              className={styles.paramRow}
              onContextMenu={openParamMenu}
            >
              <span className={styles.paramName}>
                {formatDisplayName(param.name)}
              </span>
              {typeof param.value === "number" ? (
                <ScrubbableNumber param={param as PatternParam<number>} />
              ) : (
                <span className={styles.paramValue}>
                  {formatParamValue(param.value)}
                </span>
              )}
            </li>
          );

        // Composite param (color or palette): a caret row, then the
        // shared value editor.
        const collapseKey = `${block.id}:${uniform}`;
        const isCollapsed = collapsedParams.has(collapseKey);
        return (
          <li key={uniform}>
            <div
              data-doc="param-row"
              className={styles.paramRow}
              onContextMenu={openParamMenu}
            >
              <button
                className={styles.paramCaret}
                onClick={() =>
                  setCollapsedParams((set) => toggleIn(set, collapseKey))
                }
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
                      bumpEditors();
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
                      bumpEditors();
                    }}
                  />
                ) : null}
              </div>
            )}
          </li>
        );
      });

  const renderBlock = (block: Block) => {
    const expanded = !collapsedBlocks.has(block.id);
    return (
      <li key={block.id}>
        <div
          className={styles.patternRow}
          data-doc="pattern-row"
          onContextMenu={(event) => {
            event.preventDefault();
            setBlockMenu({
              blockId: block.id,
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          <button
            data-doc="pattern-expand"
            className={styles.rowButton}
            onClick={() => setCollapsedBlocks((set) => toggleIn(set, block.id))}
            aria-label={expanded ? "Collapse parameters" : "Expand parameters"}
          >
            {expanded ? <FaCaretDown /> : <FaCaretRight />}
          </button>
          <span className={styles.patternName}>
            {formatDisplayName(block.pattern.name)}
          </span>
          <button
            data-doc="pattern-remove"
            className={`${styles.rowButton} ${styles.trashButton}`}
            onClick={action(() => block.layer?.removeBlock(block))}
            aria-label="Remove pattern"
          >
            <FaTrashAlt />
          </button>
        </div>
        {expanded && (
          <>
            <ul className={styles.paramList}>
              {renderOpacityRow(block)}
              {renderParamRows(block, block.pattern)}
            </ul>
            {block.effectBlocks.map((effect, effectIndex) => (
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
                    onClick={action(() => block.reorderEffectBlock(effect, -1))}
                    aria-label="Move effect up"
                  >
                    <FaArrowUp size={10} />
                  </button>
                  <button
                    className={styles.rowButton}
                    disabled={effectIndex === block.effectBlocks.length - 1}
                    onClick={action(() => block.reorderEffectBlock(effect, 1))}
                    aria-label="Move effect down"
                  >
                    <FaArrowDown size={10} />
                  </button>
                  <button
                    className={`${styles.rowButton} ${styles.trashButton}`}
                    onClick={action(() => block.removeEffectBlock(effect))}
                    aria-label="Remove effect"
                  >
                    <FaTrashAlt />
                  </button>
                </div>
                <ul className={styles.paramList}>
                  {renderParamRows(effect, effect.pattern)}
                </ul>
              </div>
            ))}
            <button
              data-doc="add-effect"
              className={styles.addEffect}
              onClick={() =>
                setEffectPickerFor(
                  effectPickerFor === block.id ? null : block.id,
                )
              }
            >
              <FaPlus size={9} /> Add Effect
            </button>
            {effectPickerFor === block.id && (
              <ul className={styles.effectPicker}>
                {effectLibrary.map(({ name, factory }) => (
                  <li key={name}>
                    <button
                      className={styles.effectPickerItem}
                      onClick={action(() => {
                        block.addCloneOfEffect(factory());
                        setEffectPickerFor(null);
                      })}
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
  };

  const renderLayer = (layer: Layer, index: number) => (
    <li key={layer.id} className={layer.visible ? "" : styles.patternHidden}>
      <div className={styles.layerRow} data-doc="layer-row">
        {renamingLayer === layer ? (
          <input
            className={styles.layerNameInput}
            value={renameDraft}
            autoFocus
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={action(() => {
              if (renameDraft.trim())
                store.renameLayer(layer, renameDraft.trim());
              setRenamingLayer(null);
            })}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLElement).blur();
              if (event.key === "Escape") setRenamingLayer(null);
            }}
          />
        ) : (
          <span
            className={styles.layerName}
            onDoubleClick={() => {
              setRenamingLayer(layer);
              setRenameDraft(layer.name || `Layer ${index + 1}`);
            }}
          >
            {layer.name || `Layer ${index + 1}`}
          </span>
        )}
        <button
          data-doc="layer-visibility"
          className={styles.rowButton}
          onClick={action(() => (layer.visible = !layer.visible))}
          aria-label={layer.visible ? "Hide layer" : "Show layer"}
        >
          {layer.visible ? <FaEye /> : <FaEyeSlash />}
        </button>
        <button
          data-doc="layer-remove"
          className={`${styles.rowButton} ${styles.trashButton}`}
          disabled={store.layers.length <= 1}
          onClick={action(() => store.removeLayer(layer))}
          aria-label="Remove layer"
        >
          <FaTrashAlt />
        </button>
      </div>
      <ul className={styles.patternStack}>
        {layer.getAllBlocks().map(renderBlock)}
        <li>
          <button
            className={`${styles.addPattern} ${styles.addPatternInLayer}`}
            data-doc="add-pattern"
            onClick={() => {
              setPickerLayer(layer);
              setIsPicking(true);
            }}
          >
            <FaPlus size={11} /> Add Pattern
          </button>
        </li>
      </ul>
    </li>
  );

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

            <ul className={styles.layerList}>
              {store.layers.map(renderLayer)}
            </ul>

            <button
              className={styles.addPattern}
              data-doc="add-layer"
              onClick={action(() => {
                store.addLayer({
                  name: `Layer ${store.layers.length + 1}`,
                });
              })}
            >
              <FaPlus size={11} /> Add Layer
            </button>
          </div>

          <AddPatternPane
            isOpen={isPicking}
            onInsert={(factory) => {
              if (pickerLayer) onAddPattern(pickerLayer, factory);
              setIsPicking(false);
            }}
            onClose={() => setIsPicking(false)}
          />
        </div>
      </aside>

      <button
        data-doc="panel-toggle"
        className={`${styles.panelToggle} ${
          isOpen ? styles.panelToggleOpen : ""
        } ${isPicking ? styles.panelToggleWide : ""}`}
        onClick={() => {
          if (isOpen) setIsPicking(false);
          setIsOpen(!isOpen);
        }}
        aria-label={isOpen ? "Close pattern library" : "Open pattern library"}
      >
        {isOpen ? "❮" : "❯"}
      </button>

      {paramMenu && (
        <div
          ref={paramMenuRef}
          className={styles.contextMenu}
          style={{ left: paramMenu.x, top: paramMenu.y }}
        >
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              onAddAutomation(paramMenu.block, paramMenu.uniform);
              setParamMenu(null);
            }}
          >
            Add Automation Lane
          </button>
          {paramMenu.isOpacity && (
            <button
              className={styles.contextMenuItem}
              onClick={action(() => {
                delete paramMenu.block.parameterVariations.u_opacity;
                paramMenu.block.triggerVariationReactions("u_opacity");
                setParamMenu(null);
              })}
            >
              Reset to Auto
            </button>
          )}
        </div>
      )}

      {blockMenu && (
        <div
          ref={blockMenuRef}
          className={styles.contextMenu}
          style={{ left: blockMenu.x, top: blockMenu.y }}
        >
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              const block = store.layers
                .flatMap((layer) => layer.getAllBlocks())
                .find((candidate) => candidate.id === blockMenu.blockId);
              if (block) duplicateBlock(block);
              setBlockMenu(null);
            }}
          >
            Duplicate
          </button>
        </div>
      )}
    </>
  );
});
