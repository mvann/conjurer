import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AdditiveBlending,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderChunk,
  ShaderMaterial,
  WebGLRenderTarget,
} from "three";
import conjurerCommon from "@/src/shaders/conjurer_common.frag";
import dustFrag from "@/src/shaders/dust.frag";
import { Canopy } from "@/src/components/Canvas/CanopyView";
import { CameraControlsInner } from "@/src/components/CameraControlsInner";
import { CanvasErrorBoundary } from "@/src/components/EditorV2/CanvasErrorBoundary";
import { BlockNode } from "@/src/components/RenderPipeline/BlockNode";
import { MergeNode } from "@/src/components/RenderPipeline/MergeNode";
import { Pattern } from "@/src/types/Pattern";
import defaultVert from "@/src/shaders/default.vert";
import uvCheckerFrag from "@/src/shaders/uvChecker.frag";

// This enables `#include <conjurer_common>` in canopy.vert and the pattern
// shaders. The main app does this in BlockStackNode.tsx, which this
// standalone page never imports.
(ShaderChunk as any).conjurer_common = conjurerCommon;

const RENDER_TARGET_SIZE = 512;

// useFrame priority bands within the canopy canvas: time driver (1), pattern
// renders (2+), merge chain (100+), canopy composer (1000, in CanopyView).
const PATTERN_PRIORITY = 2;
const MERGE_PRIORITY = 100;

export type VisiblePattern = { id: number; pattern: Pattern };

// Fills the render target with the checkerboard placeholder. The canopy
// samples the target's texture every frame, so a single fill is enough.
function CheckerPlaceholder({
  renderTarget,
}: {
  renderTarget: WebGLRenderTarget;
}) {
  const { gl } = useThree();

  useEffect(() => {
    const scene = new Scene();
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geometry = new PlaneGeometry(2, 2);
    const material = new ShaderMaterial({
      vertexShader: defaultVert,
      fragmentShader: uvCheckerFrag,
    });
    scene.add(new Mesh(geometry, material));

    gl.setRenderTarget(renderTarget);
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    geometry.dispose();
    material.dispose();
  }, [gl, renderTarget]);

  return null;
}

// Renders the visible pattern stack into outputTarget: each pattern renders
// its shader to its own target, then a chain of MergeNodes adds them together
// pairwise — the same additive compositing the experience editor's render
// pipeline uses (see RenderPipelineV2). u_time free-runs for now; when the
// transport can actually play, time will come from the timeline instead.
function StackPipeline({
  entries,
  outputTarget,
}: {
  entries: VisiblePattern[];
  outputTarget: WebGLRenderTarget;
}) {
  const count = entries.length;

  // n pattern targets, and n-2 intermediates for the merge chain (the final
  // merge writes straight into outputTarget). A single pattern renders into
  // outputTarget directly with no merging.
  const targets = useMemo(
    () =>
      Array.from(
        { length: count >= 2 ? 2 * count - 2 : 0 },
        () => new WebGLRenderTarget(RENDER_TARGET_SIZE, RENDER_TARGET_SIZE),
      ),
    [count],
  );
  useEffect(
    () => () => targets.forEach((target) => target.dispose()),
    [targets],
  );

  useFrame(({ clock }) => {
    for (const { pattern } of entries)
      pattern.params.u_time.value = clock.elapsedTime;
  }, 1);

  if (count === 1)
    return (
      <BlockNode
        shaderMaterialKey={String(entries[0].id)}
        uniforms={entries[0].pattern.params}
        vertexShader={entries[0].pattern.vertexShader}
        fragmentShader={entries[0].pattern.fragmentShader}
        priority={PATTERN_PRIORITY}
        renderTargetOut={outputTarget}
      />
    );

  const patternTargets = targets.slice(0, count);
  const intermediateTargets = targets.slice(count);

  return (
    <>
      {entries.map(({ id, pattern }, index) => (
        <BlockNode
          key={id}
          shaderMaterialKey={String(id)}
          uniforms={pattern.params}
          vertexShader={pattern.vertexShader}
          fragmentShader={pattern.fragmentShader}
          priority={PATTERN_PRIORITY + index}
          renderTargetOut={patternTargets[index]}
        />
      ))}
      {entries.slice(1).map(({ id }, mergeIndex) => (
        <MergeNode
          key={id}
          priority={MERGE_PRIORITY + mergeIndex}
          renderTargetIn1={
            mergeIndex === 0
              ? patternTargets[0]
              : intermediateTargets[mergeIndex - 1]
          }
          renderTargetIn2={patternTargets[mergeIndex + 1]}
          renderTargetOut={
            mergeIndex === count - 2
              ? outputTarget
              : intermediateTargets[mergeIndex]
          }
        />
      ))}
    </>
  );
}

// The browser can evict a long-lived WebGL context (too many contexts,
// GPU pressure, driver reset). Three.js never recovers on its own — the
// canvas silently freezes on its last frame. Remounting the Canvas
// creates a fresh context and rebuilds the scene.
function ContextLossRecovery({ onLost }: { onLost: () => void }) {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    const canvas = gl.domElement;
    const handle = (event: Event) => {
      event.preventDefault();
      onLost();
    };
    canvas.addEventListener("webglcontextlost", handle);
    // Cleanup runs before r3f's own unmount-time forceContextLoss, so a
    // deliberate teardown never triggers a remount.
    return () => canvas.removeEventListener("webglcontextlost", handle);
  }, [gl, onLost]);

  return null;
}

// Drifting dust over the whole view, lit by the canopy composite (see
// dust.frag). Renders additively after the canopy composer.
function DustOverlay({
  renderTarget,
  dust,
}: {
  renderTarget: WebGLRenderTarget;
  dust: number;
}) {
  const mesh = useRef<Mesh>(null);
  const uniforms = useRef({
    u_texture: { value: renderTarget.texture },
    u_time: { value: 0 },
    u_intensity: { value: 0 },
    u_zoom: { value: 1 },
  });

  useEffect(() => {
    uniforms.current.u_texture.value = renderTarget.texture;
  }, [renderTarget.texture]);
  useEffect(() => {
    uniforms.current.u_intensity.value = dust;
  }, [dust]);

  useFrame(({ gl, camera, clock }) => {
    if (!mesh.current || uniforms.current.u_intensity.value <= 0.001) return;
    uniforms.current.u_time.value = clock.elapsedTime;
    // Default orbit distance is 20 (see CameraControlsInner).
    uniforms.current.u_zoom.value = 20 / Math.max(camera.position.length(), 1);
    const previousAutoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(null);
    gl.render(mesh.current, camera);
    gl.autoClear = previousAutoClear;
  }, 1100);

  return (
    <mesh ref={mesh}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        uniforms={uniforms.current}
        vertexShader={defaultVert}
        fragmentShader={dustFrag}
        blending={AdditiveBlending}
        depthTest={false}
        depthWrite={false}
        transparent
      />
    </mesh>
  );
}

export function CanopyPane({
  patterns,
  dust,
}: {
  patterns: VisiblePattern[];
  dust: number;
}) {
  const renderTarget = useMemo(
    () => new WebGLRenderTarget(RENDER_TARGET_SIZE, RENDER_TARGET_SIZE),
    [],
  );
  useEffect(() => () => renderTarget.dispose(), [renderTarget]);
  // Bumped when the WebGL context is lost; keys the Canvas so a fresh
  // context and scene replace the frozen ones.
  const [contextGeneration, setContextGeneration] = useState(0);

  return (
    <CanvasErrorBoundary>
      <Canvas key={contextGeneration}>
        <ContextLossRecovery
          onLost={() => setContextGeneration((generation) => generation + 1)}
        />
        <CameraControlsInner />
        {patterns.length === 0 ? (
          <CheckerPlaceholder renderTarget={renderTarget} />
        ) : (
          <StackPipeline entries={patterns} outputTarget={renderTarget} />
        )}
        <Canopy renderTarget={renderTarget} />
        <DustOverlay renderTarget={renderTarget} dust={dust} />
      </Canvas>
    </CanvasErrorBoundary>
  );
}
