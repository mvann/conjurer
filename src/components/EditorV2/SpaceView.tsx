import { Mesh, WebGLRenderTarget } from "three";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { makeVertexShader } from "@/src/shaders/vertexShader";

// A store-free take on the main app's CartesianSpaceView/CanopySpaceView:
// draws the render target to the screen through the given fragment shader
// (fromTexture.frag for cartesian space, fromTextureToCanopySpace.frag for
// canopy space), at full intensity with no brightness limiting.
export function SpaceView({
  renderTarget,
  fragmentShader,
}: {
  renderTarget: WebGLRenderTarget;
  fragmentShader: string;
}) {
  const mesh = useRef<Mesh>(null);
  const uniforms = useRef({
    u_texture: { value: renderTarget.texture },
    u_intensity: { value: 1 },
    u_limiterGain: { value: 1 },
  });

  useEffect(() => {
    uniforms.current.u_texture.value = renderTarget.texture;
  }, [renderTarget.texture]);

  useFrame(({ gl, camera }) => {
    if (!mesh.current) return;
    gl.setRenderTarget(null);
    gl.render(mesh.current, camera);
  }, 1000);

  return (
    <mesh ref={mesh}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        uniforms={uniforms.current}
        fragmentShader={fragmentShader}
        vertexShader={makeVertexShader()}
      />
    </mesh>
  );
}
