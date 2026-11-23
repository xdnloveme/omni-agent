shader_type canvas_item;
render_mode unshaded;

// Registered to background source rect (285, 265, 550, 330). Blend only the
// outer room boundary; the walkable platform at source y=552 stays original.
void fragment() {
	vec2 source = UV * vec2(550.0, 330.0);
	float edge = smoothstep(0.0, 12.0, source.x)
		* (1.0 - smoothstep(538.0, 550.0, source.x))
		* smoothstep(0.0, 10.0, source.y)
		* (1.0 - smoothstep(278.0, 286.0, source.y));
	COLOR = texture(TEXTURE, UV) * vec4(1.0, 1.0, 1.0, edge);
}
