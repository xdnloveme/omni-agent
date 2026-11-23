shader_type canvas_item;
render_mode unshaded;
void fragment() {
 // Layered ahead of the terrace but behind actors/UI: no actor texture changes.
 float lower = smoothstep(0.63, 1.0, UV.y) * 0.64;
 float trunk = (1.0 - smoothstep(0.0, 0.28, abs(UV.x - 0.47)))
             * smoothstep(0.15, 0.31, UV.y) * (1.0 - smoothstep(0.48, 0.63, UV.y)) * 0.12;
 COLOR = vec4(0.045, 0.11, 0.12, max(lower, trunk));
}
