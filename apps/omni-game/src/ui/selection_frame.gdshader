shader_type canvas_item;
render_mode unshaded;
uniform vec4 paper_tint : source_color = vec4(1.0);
uniform bool primary = false;
void fragment() {
 vec4 source = texture(TEXTURE, UV);
 // The original dossier corners are RGB on white, not true alpha. Only the
 // near-white exterior of the frame is keyed; the warm paper center is retained.
 float edge = 1.0 - step(0.04, UV.x) * step(0.04, UV.y) * step(UV.x, 0.96) * step(UV.y, 0.96);
 float white = smoothstep(0.94, 0.995, min(source.r, min(source.g, source.b)));
 vec3 paint = source.rgb * paper_tint.rgb;
 if (primary) {
  float paper = smoothstep(0.67, 0.89, min(source.r, source.g));
  vec3 green = paper_tint.rgb * (0.88 + 0.18 * source.g);
  paint = mix(source.rgb, green, paper);
 }
 COLOR = vec4(paint, source.a * (1.0 - white * edge) * paper_tint.a);
}
