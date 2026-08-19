#include <conjurer_common>

#ifdef GL_ES
precision mediump float;
#endif

uniform sampler2D u_texture;
// How much of the surrounding light the substrate throws back. Well under 1:
// the strip is lit BY the LEDs, so it must never compete with them.
uniform float u_spill;
// How far the blend reaches, in LEDs along the strip and strips across.
uniform float u_reach_along;
uniform float u_reach_across;

varying vec2 v_canopy_uv;
varying float v_intensity;

// One LED step in canopy uv. uv.x spans 96 strips, uv.y spans 151 LEDs, so a
// step is the reciprocal of each count.
#define STRIP_STEP 0.010416666
#define LED_STEP 0.006666666

vec3 sampleCanopy(vec2 canopyUv) {
    // Same path the LEDs take: arc position along the strip is not linear in
    // radius, so convert before projecting or the taps drift toward the apex.
    vec2 corrected = vec2(canopyUv.x, canopyArcToRadialFraction(clamp(canopyUv.y, 0.0, 1.0)));
    vec2 cartesian = canopyToCartesianProjection(corrected);
    return texture2D(u_texture, cartesian * 0.5 + 0.5).rgb;
}

void main() {
    // A weighted blend of the light around this point on the strip. Additive
    // rather than averaged in the sense that matters: a red LED one side and a
    // green the other give yellow here, and a third blue gives white, which is
    // exactly what the substrate does in the room.
    vec3 total = vec3(0.0);
    float weightSum = 0.0;

    for (int i = -3; i <= 3; i++) {
        for (int j = -1; j <= 1; j++) {
            float along = float(i);
            float across = float(j);
            // Gaussian-ish falloff, so nearby LEDs dominate and the glow fades
            // smoothly rather than ending in a hard band.
            float d2 = (along * along) / 9.0 + (across * across) / 1.5;
            float weight = exp(-d2 * 1.6);

            vec2 tap = v_canopy_uv + vec2(
                across * STRIP_STEP * u_reach_across,
                along * LED_STEP * u_reach_along
            );
            // Strips wrap around the canopy, so a tap off one edge is a real
            // neighbour on the other.
            tap.x = fract(tap.x + 1.0);

            total += sampleCanopy(tap) * weight;
            weightSum += weight;
        }
    }

    vec3 blended = total / max(weightSum, 0.0001);

    // The substrate is a diffuse surface, not an emitter: it returns a
    // fraction of what lands on it, and it never fully blacks out the way an
    // unlit LED does, so a lit canopy keeps a faint sense of the ribbon.
    gl_FragColor = vec4(blended * u_spill * v_intensity, 1.0);
}
