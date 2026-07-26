import { useEffect, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ShaderChunk, WebGLRenderTarget } from "three";
import styles from "@/styles/EditorV2.module.css";
import conjurerCommon from "@/src/shaders/conjurer_common.frag";
import { patternLibrary } from "@/src/components/EditorV2/patternLibrary";
import { Pattern } from "@/src/types/Pattern";
import { Canopy } from "@/src/components/Canvas/CanopyView";
import { CameraControlsInner } from "@/src/components/CameraControlsInner";
import { BlockNode } from "@/src/components/RenderPipeline/BlockNode";
import { CanvasErrorBoundary } from "@/src/components/EditorV2/CanvasErrorBoundary";
import { SpaceView } from "@/src/components/EditorV2/SpaceView";
import { formatDisplayName } from "@/src/components/EditorV2/formatDisplayName";
import fromTexture from "@/src/shaders/fromTexture.frag";
import fromTextureToCanopySpace from "@/src/shaders/fromTextureToCanopySpace.frag";

// This enables `#include <conjurer_common>` in pattern shaders and
// canopy.vert. The main app does this in BlockStackNode.tsx, which this
// standalone page never imports.
(ShaderChunk as any).conjurer_common = conjurerCommon;

export type PreviewMode = "canopy" | "cartesianSpace" | "canopySpace";

const PREVIEW_MODES: { value: PreviewMode; label: string }[] = [
  { value: "canopy", label: "Canopy" },
  { value: "cartesianSpace", label: "Cartesian Space" },
  { value: "canopySpace", label: "Canopy Space" },
];

// The selected pattern's shader renders to a target each frame (a pattern's
// params object doubles as its uniforms; see BlockStackNode), then the
// chosen view displays the target: on the canopy geometry (orbitable, like
// the main canopy view), in cartesian space, or in canopy space.
function PatternPreview({
  pattern,
  mode,
}: {
  pattern: Pattern;
  mode: PreviewMode;
}) {
  const renderTarget = useMemo(() => new WebGLRenderTarget(512, 512), []);
  useEffect(() => () => renderTarget.dispose(), [renderTarget]);

  useFrame(({ clock }) => {
    pattern.params.u_time.value = clock.elapsedTime;
  }, 1);

  return (
    <>
      {mode === "canopy" && <CameraControlsInner />}
      <BlockNode
        shaderMaterialKey={pattern.name}
        uniforms={pattern.params}
        vertexShader={pattern.vertexShader}
        fragmentShader={pattern.fragmentShader}
        priority={2}
        renderTargetOut={renderTarget}
      />
      {mode === "canopy" && <Canopy renderTarget={renderTarget} />}
      {mode === "cartesianSpace" && (
        <SpaceView renderTarget={renderTarget} fragmentShader={fromTexture} />
      )}
      {mode === "canopySpace" && (
        <SpaceView
          renderTarget={renderTarget}
          fragmentShader={fromTextureToCanopySpace}
        />
      )}
    </>
  );
}

type Props = {
  isOpen: boolean;
  onInsert: (factory: () => Pattern) => void;
  onClose: () => void;
};

// The add-pattern column — the right column of the patterns panel, revealed
// when the panel extends: a live canopy preview of the selected pattern up
// top, the library as selectable tiles below, and an Insert button — the v2
// take on the main app's pattern drawer.
export function AddPatternPane({ isOpen, onInsert, onClose }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("canopy");

  // A private instance for the preview so u_time mutation never touches
  // the library or the stack.
  const previewPattern = useMemo(
    () => patternLibrary[selectedIndex].factory(),
    [selectedIndex],
  );

  return (
    <div className={styles.addColumn}>
      <div className={styles.panelSectionLabel}>Add Pattern</div>

      <div className={styles.previewBox} data-doc="pattern-preview">
        {isOpen && (
          <CanvasErrorBoundary>
            <Canvas>
              <PatternPreview pattern={previewPattern} mode={previewMode} />
            </Canvas>
          </CanvasErrorBoundary>
        )}
      </div>
      <div className={styles.previewModes} data-doc="preview-mode">
        {PREVIEW_MODES.map(({ value, label }) => (
          <button
            key={value}
            className={`${styles.previewModeOption} ${
              previewMode === value ? styles.previewModeSelected : ""
            }`}
            onClick={() => setPreviewMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={styles.previewName}>
        {formatDisplayName(patternLibrary[selectedIndex].name)}
      </div>

      <div className={styles.tileGrid}>
        {patternLibrary.map(({ name }, index) => (
          <button
            key={name}
            data-doc="pattern-tile"
            className={`${styles.tile} ${
              index === selectedIndex ? styles.tileSelected : ""
            }`}
            onClick={() => setSelectedIndex(index)}
          >
            {formatDisplayName(name)}
          </button>
        ))}
      </div>

      <div className={styles.panelFooter}>
        <button
          data-doc="insert-pattern"
          className={styles.footerCta}
          onClick={() => onInsert(patternLibrary[selectedIndex].factory)}
        >
          Insert
        </button>
        <button
          data-doc="cancel-add"
          className={styles.footerCancel}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
