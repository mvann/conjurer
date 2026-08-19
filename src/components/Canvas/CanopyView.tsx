import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Scene,
  WebGLRenderTarget,
} from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import canopyVert from "@/src/shaders/canopy.vert";
import canopyStripVert from "@/src/shaders/canopyStrip.vert";
import canopyStripFrag from "@/src/shaders/canopyStrip.frag";
import fromTextureCircularMask from "@/src/shaders/fromTextureCircularMask.frag";
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
} from "postprocessing";
import { CanopyGeometry } from "@/src/types/CanopyGeometry";
import { LED_COUNTS } from "@/src/utils/size";

// Half the ribbon's width, in feet. The real strip is about an inch across.
const STRIP_HALF_WIDTH = 0.04;

type CanopyProps = { renderTarget: WebGLRenderTarget };

export const Canopy = function Canopy({ renderTarget }: CanopyProps) {
  const [canopyGeometry, setCanopyGeometry] = useState<CanopyGeometry>();
  useEffect(() => {
    // Lazy load the canopy geometry
    import("@/src/data/canopyGeometry.json").then((data) =>
      setCanopyGeometry(data),
    );
  }, []);
  if (!canopyGeometry) return null;
  return (
    <CanopyView renderTarget={renderTarget} canopyGeometry={canopyGeometry} />
  );
};

type CanopyViewProps = {
  renderTarget: WebGLRenderTarget;
  canopyGeometry: CanopyGeometry;
};

const CanopyView = function CanopyView({
  renderTarget,
  canopyGeometry,
}: CanopyViewProps) {
  const { gl, camera } = useThree();
  const scene = useRef<Scene>(null);

  const canopyUniforms = useRef({
    u_view_vector: { value: camera.position },
    u_texture: { value: renderTarget.texture },
  });

  useEffect(() => {
    if (!canopyUniforms.current) return;
    canopyUniforms.current.u_texture.value = renderTarget.texture;
  }, [renderTarget.texture]);

  // The strips themselves: a ribbon per strip, following the same LEDs.
  //
  // The LEDs are points, so the substrate they are mounted on was never
  // drawn and the canopy read as lights floating in black. This builds a thin
  // quad strip through each run of LEDs, which the strip shader lights with a
  // blend of the LEDs around it.
  //
  // The geometry is laid out strip-major (see generateCanopy): LED (x, y) is
  // at index x * LED_COUNTS.y + y, so each strip is one contiguous run.
  const stripGeometry = useMemo(() => {
    const strips = LED_COUNTS.x;
    const perStrip = LED_COUNTS.y;
    const src = canopyGeometry.position;
    const srcNormal = canopyGeometry.normal;
    const srcUv = canopyGeometry.uv;

    const position: number[] = [];
    const normal: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];

    const at = (i: number, a: number[], stride: number) =>
      [a[i * stride], a[i * stride + 1], a[i * stride + 2]] as const;

    for (let x = 0; x < strips; x++) {
      const base = x * perStrip;
      for (let y = 0; y < perStrip; y++) {
        const i = base + y;
        const p = at(i, src, 3);
        const n = at(i, srcNormal, 3);
        // Tangent along the strip, from the neighbouring LEDs.
        const prev = at(base + Math.max(y - 1, 0), src, 3);
        const next = at(base + Math.min(y + 1, perStrip - 1), src, 3);
        const t = [next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]];
        // The ribbon lies across the strip: perpendicular to both its
        // direction and its facing.
        const side = [
          t[1] * n[2] - t[2] * n[1],
          t[2] * n[0] - t[0] * n[2],
          t[0] * n[1] - t[1] * n[0],
        ];
        const len = Math.hypot(side[0], side[1], side[2]) || 1;
        const w = STRIP_HALF_WIDTH / len;

        for (const sign of [-1, 1]) {
          position.push(
            p[0] + side[0] * w * sign,
            p[1] + side[1] * w * sign,
            p[2] + side[2] * w * sign,
          );
          normal.push(n[0], n[1], n[2]);
          uv.push(srcUv[i * 2], srcUv[i * 2 + 1]);
        }

        if (y < perStrip - 1) {
          const v = (base + y) * 2;
          index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        }
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(position), 3),
    );
    geometry.setAttribute(
      "normal",
      new BufferAttribute(new Float32Array(normal), 3),
    );
    geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
    geometry.setIndex(index);
    return geometry;
  }, [canopyGeometry]);

  const stripUniforms = useRef({
    u_view_vector: { value: camera.position },
    u_texture: { value: renderTarget.texture },
    // The substrate is WHITE plastic, so it is a good diffuse reflector and
    // returns the light's own colour rather than tinting it. These are the
    // three knobs worth touching: how much it throws back, and how far the
    // blend reaches along its own strip and across to its neighbours.
    u_spill: { value: 0.26 },
    u_reach_along: { value: 1.5 },
    u_reach_across: { value: 1.2 },
  });
  useEffect(() => {
    stripUniforms.current.u_texture.value = renderTarget.texture;
  }, [renderTarget.texture]);

  const bufferGeometry = useMemo(() => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(canopyGeometry.position), 3),
    );
    geometry.setAttribute(
      "uv",
      new BufferAttribute(new Float32Array(canopyGeometry.uv), 2),
    );
    geometry.setAttribute(
      "normal",
      new BufferAttribute(new Float32Array(canopyGeometry.normal), 3),
    );
    return geometry;
  }, [canopyGeometry]);

  // build an EffectComposer with imperative style three js because of shortcomings of
  // Drei <EffectComposer> (lack of render priority, ability to specify scene/singular mesh to render)
  const effectComposer = useMemo(() => {
    const effectComposer = new EffectComposer(gl);
    effectComposer.setSize(
      gl.domElement.clientWidth,
      gl.domElement.clientHeight,
    );

    return effectComposer;
  }, [gl]);

  useEffect(() => {
    if (!scene.current) return;

    effectComposer.addPass(new RenderPass(scene.current, camera));
    effectComposer.addPass(
      new EffectPass(
        camera,
        new BloomEffect({
          luminanceThreshold: 0.001,
          intensity: 0.7,
        }),
      ),
    );
  }, [effectComposer, camera]);

  // render the effect composer, including the canopy render pass and bloom effect
  useFrame(() => effectComposer.render(), 1000);

  return (
    <scene ref={scene}>
      {/* The strips first, so the LEDs draw over their own spill. */}
      <mesh>
        <primitive attach="geometry" object={stripGeometry} />
        <shaderMaterial
          uniforms={stripUniforms.current}
          fragmentShader={canopyStripFrag}
          vertexShader={canopyStripVert}
          side={DoubleSide}
        />
      </mesh>
      <points>
        <primitive attach="geometry" object={bufferGeometry} />
        <shaderMaterial
          uniforms={canopyUniforms.current}
          fragmentShader={fromTextureCircularMask}
          vertexShader={canopyVert}
        />
      </points>
    </scene>
  );
};
