#ifdef GL_ES
precision mediump float;
#endif

varying vec2 v_normalized_uv;

// Photoshop-transparency-style checkerboard. Rendered once into the canopy
// render target as a placeholder so the LED layout reads clearly when no
// pattern is playing.
void main() {
    vec2 cell = floor(v_normalized_uv * 24.0);
    float checker = mod(cell.x + cell.y, 2.0);
    vec3 color = mix(vec3(0.16), vec3(0.42), checker);
    gl_FragColor = vec4(color, 1.0);
}
