import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
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

export type VisiblePattern = {
  id: string | number;
  pattern: Pattern;
  effects: { id: string | number; pattern: Pattern }[];
};

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

  // Targets: one per entry (its composited pattern-plus-effects output),
  // one scratch per entry that has effects (the chain ping-pongs between
  // scratch and final), and n-2 intermediates for the merge chain (the
  // final merge writes straight into outputTarget). A single pattern
  // composites into outputTarget directly with no merging. Keyed by the
  // chain STRUCTURE so parameter edits never churn targets; adding or
  // removing an effect rebuilds them (rare, and the checkerboard never
  // flashes because the same frame re-renders every stage).
  const structureKey = `${count}|${entries
    .map((entry) => entry.effects.length)
    .join(",")}`;
  const { patternTargets, scratchTargets, intermediateTargets } =
    useMemo(() => {
      const make = () =>
        new WebGLRenderTarget(RENDER_TARGET_SIZE, RENDER_TARGET_SIZE);
      return {
        patternTargets:
          count >= 2 ? entries.map(make) : ([] as WebGLRenderTarget[]),
        scratchTargets: entries.map((entry) =>
          entry.effects.length > 0 ? make() : null,
        ),
        intermediateTargets: Array.from(
          { length: Math.max(0, count - 2) },
          make,
        ),
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [structureKey]);
  useEffect(
    () => () => {
      [...patternTargets, ...scratchTargets, ...intermediateTargets].forEach(
        (target) => target?.dispose(),
      );
    },
    [patternTargets, scratchTargets, intermediateTargets],
  );

  useFrame(({ clock }) => {
    for (const { pattern, effects } of entries) {
      pattern.params.u_time.value = clock.elapsedTime;
      for (const effect of effects)
        effect.pattern.params.u_time.value = clock.elapsedTime;
    }
  }, 1);

  // Sequential priorities: each entry occupies a band wide enough for its
  // pattern plus its effect chain, all before the merges at 100.
  const priorityBases: number[] = [];
  {
    let priority = PATTERN_PRIORITY;
    for (const entry of entries) {
      priorityBases.push(priority);
      priority += 1 + entry.effects.length;
    }
  }

  // One entry's pattern, then its effects ping-ponging between the
  // scratch and final targets, arranged (as the main app's BlockStackNode
  // does) so the LAST effect always lands in finalTarget.
  const renderChain = (
    entry: VisiblePattern,
    index: number,
    finalTarget: WebGLRenderTarget,
  ) => {
    const effectCount = entry.effects.length;
    const evenEffects = effectCount % 2 === 0;
    const scratch = scratchTargets[index];
    return (
      <group key={entry.id}>
        <BlockNode
          shaderMaterialKey={String(entry.id)}
          uniforms={entry.pattern.params}
          vertexShader={entry.pattern.vertexShader}
          fragmentShader={entry.pattern.fragmentShader}
          priority={priorityBases[index]}
          renderTargetOut={evenEffects || !scratch ? finalTarget : scratch}
        />
        {scratch &&
          entry.effects.map((effect, effectIndex) => {
            const swap = evenEffects === (effectIndex % 2 === 0);
            return (
              <BlockNode
                key={effect.id}
                shaderMaterialKey={String(effect.id)}
                uniforms={effect.pattern.params}
                vertexShader={effect.pattern.vertexShader}
                fragmentShader={effect.pattern.fragmentShader}
                priority={priorityBases[index] + 1 + effectIndex}
                renderTargetIn={swap ? finalTarget : scratch}
                renderTargetOut={swap ? scratch : finalTarget}
              />
            );
          })}
      </group>
    );
  };

  if (count === 1) return renderChain(entries[0], 0, outputTarget);

  return (
    <>
      {entries.map((entry, index) =>
        renderChain(entry, index, patternTargets[index]),
      )}
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

const Perf = lazy(() =>
  import("r3f-perf").then((module) => ({ default: module.Perf })),
);

export function CanopyPane({
  patterns,
  dust,
  showPerformance,
}: {
  patterns: VisiblePattern[];
  dust: number;
  showPerformance?: boolean;
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
        {showPerformance && (
          <Suspense fallback={null}>
            <Perf />
          </Suspense>
        )}
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
