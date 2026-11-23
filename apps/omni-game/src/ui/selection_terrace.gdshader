shader_type canvas_item;
render_mode unshaded;
// Authored #ff00ff backdrop, not a mask inferred from workshop paint colors.
void fragment() {
 vec4 source = texture(TEXTURE, UV);
 // The antialiased fringe contains diluted key color, not just saturated magenta.
 float excess = max(0.0, min(source.r, source.b) - source.g);
 float key = smoothstep(0.025, 0.38, excess);
 float alpha = 1.0 - key;
 vec3 paint = clamp((source.rgb - vec3(1.0, 0.0, 1.0) * key) / max(alpha, 0.001), vec3(0.0), vec3(1.0));
 // This authored warm-wood/green-leaf layer has no blue-violet foreground paint.
 // Despill only contaminated pixels; keep every uncontaminated pixel unchanged.
 paint.b = mix(paint.b, min(paint.b, paint.g), smoothstep(0.0, 0.025, excess));
 COLOR = vec4(paint, source.a * alpha);
}
