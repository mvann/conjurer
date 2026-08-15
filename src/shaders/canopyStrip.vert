#include <conjurer_common>

// The LED strip's own substrate, lit by the LEDs mounted on it.
//
// The canopy's LEDs are drawn as points; the ribbon they are mounted on was
// never drawn at all, so the space between them read as pure black. In the
// room, that ribbon catches the spill of the LEDs around it, which is why a
// red, a green and a blue LED near one another wash the strip white.
//
// This is the same projection canopy.vert does, minus the point sizing: the
// canopy uv is passed through untouched so the fragment shader can take its
// own taps around it. The viewing-angle falloff is kept so the strip dims
// off-axis exactly as the LEDs do.

#define blackout_lower_bound 0.05
#define fullbright_lower_bound 0.90
#define minimum_brightness 0.02

uniform vec3 u_view_vector;
varying vec2 v_canopy_uv;
varying float v_intensity;

void main() {
    vec3 pixelNormal = normalize(normalMatrix * normal);
    vec3 cameraToPixelVector = (modelViewMatrix * vec4(position, 1.0)).xyz - u_view_vector;
    float normalizedItensity = 1. - dot(pixelNormal, normalize(cameraToPixelVector));
    float adjustedIntensity = pow(normalizedItensity, 2.0);
    v_intensity = clamp(smoothstep(blackout_lower_bound, fullbright_lower_bound, adjustedIntensity), minimum_brightness, 1.0);

    // Canopy coordinates, not cartesian: the fragment shader needs to walk
    // along the strip (uv.y) and across to its neighbours (uv.x) before
    // projecting, so the taps land on real neighbouring LEDs.
    v_canopy_uv = uv;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
