#ifdef GL_ES
precision mediump float;
#endif

// Dust: a drifting fog layer over the canopy view, lit by the canopy's own
// output like a textured bloom. Fog field after Beckon's value-noise drift
// (h13/vnoise, coverage-gated) with pronounced horizontal movement, colored
// by a heavily blurred sample of the pattern composite so the dust glows
// with whatever the canopy shows.
varying vec2 v_normalized_uv;

uniform sampler2D u_texture;
uniform float u_time;
uniform float u_intensity;
// Camera zoom factor (1 at the default orbit distance); fog features scale
// with it so the dust reads as part of the scene when zooming.
uniform float u_zoom;

float h13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = h13(i), n100 = h13(i + vec3(1, 0, 0));
    float n010 = h13(i + vec3(0, 1, 0)), n110 = h13(i + vec3(1, 1, 0));
    float n001 = h13(i + vec3(0, 0, 1)), n101 = h13(i + vec3(1, 0, 1));
    float n011 = h13(i + vec3(0, 1, 1)), n111 = h13(i + vec3(1, 1, 1));
    return mix(
        mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
        mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
        f.z
    );
}

float fbm(vec3 p) {
    float sum = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 3; octave++) {
        sum += amplitude * vnoise(p);
        p *= 2.03;
        amplitude *= 0.5;
    }
    return sum;
}

void main() {
    if (u_intensity <= 0.001) discard;
    vec2 uv = v_normalized_uv;
    // Scale the fog field around the view center by camera zoom.
    vec2 fogUv = (uv - 0.5) / max(u_zoom, 0.05) + 0.5;

    // Drifting fog field: pronounced horizontal movement (x leads, y/z
    // trail), in two layers moving at different speeds for parallax.
    vec3 p = vec3(fogUv * vec2(5.0, 3.4), 0.7);
    p.x -= u_time * 0.7;
    p.y -= u_time * 0.06;
    p.z += u_time * 0.05;
    vec3 q = vec3(fogUv * vec2(8.0, 5.5), 3.1);
    q.x -= u_time * 1.3;
    q.y -= u_time * 0.09;
    q.z += u_time * 0.04;
    float field = 0.62 * fbm(p) + 0.46 * fbm(q);

    float coverage = 0.5 + 0.3 * u_intensity;
    float drift = clamp((field - 1.0 + coverage) * 3.0, 0.0, 1.0);

    // The fog's light: a wide blur of the canopy composite.
    vec3 glow = vec3(0.0);
    const float radius = 0.14;
    glow += texture2D(u_texture, uv).rgb;
    glow += texture2D(u_texture, uv + vec2(radius, 0.0)).rgb;
    glow += texture2D(u_texture, uv + vec2(-radius, 0.0)).rgb;
    glow += texture2D(u_texture, uv + vec2(0.0, radius)).rgb;
    glow += texture2D(u_texture, uv + vec2(0.0, -radius)).rgb;
    glow += texture2D(u_texture, uv + vec2(radius, radius) * 0.7).rgb;
    glow += texture2D(u_texture, uv + vec2(-radius, radius) * 0.7).rgb;
    glow += texture2D(u_texture, uv + vec2(radius, -radius) * 0.7).rgb;
    glow += texture2D(u_texture, uv + vec2(-radius, -radius) * 0.7).rgb;
    glow /= 9.0;

    // Lit dust, plus a faint neutral base so it reads over dark regions.
    vec3 color = glow * drift * u_intensity * 0.85;
    color += vec3(0.045, 0.052, 0.07) * drift * u_intensity;

    gl_FragColor = vec4(color, 1.0);
}
